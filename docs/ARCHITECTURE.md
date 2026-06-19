# Architecture

`homunculus` is a **brain**: one continuous agentic loop + a local model + a shared identity store. It
talks to a game (over an abstract adapter) and to a user (a chat mode). The game can be any type it can
keep pace with — turn-based, idle, text-based, and the like (see `docs/GAME_TYPES.md`). Everything is
local-native; there is no hosted API and no public internet surface.

## The one loop (`src/loop/engine.ts`)

```
runLoop(mode, event):
  messages = [system: mode.systemPrompt, ...history, user: event.text]
  loop (bounded by maxSteps / wall-clock):
    resp = model.chat(messages, mode.tools)
    if resp has no tool calls: return resp.content        # final answer
    for each tool call: execute → append result to messages
  done(): sanitize the final text, recover any text-form tool calls, return
```

A **mode** (`src/modes/`) is just a `{ systemPrompt, tools }` pair. The caller (never the model) picks it.

- **chat** — `src/loop/chatTick.ts`. A user message fires a tick (not a synchronous reply). The agent sees
  the latest over a warm history window + its own self-state, and MAY reply (its prose, or `message_user`)
  or stay busy.
- **game** — `src/loop/gameLoop.ts`. A game event renders the state into the user turn; the agent acts
  through the game's remote tools.

## The clock — one heartbeat PER LANE (`src/loop/scheduler.ts`, `heartbeat.ts`)

Each lane runs its own free-running heartbeat on its own cadence, so the agent's playing time and its
chat/self time tick independently (both fall back to `AGENT_HEARTBEAT_MS`, default 60s):

```
chat heartbeat (AGENT_CHAT_HEARTBEAT_MS) → tier-1 self triage on the chat lane: what's new + your focus →
   engage social (reach out) | reflect (tend self-image/opinions/journal) | PASS  ·  every Nth tick → reflect
game heartbeat (AGENT_GAME_HEARTBEAT_MS) → a voluntary play pass on the game lane (only when GAME_OPEN_URL
   is set); the agent reads the state and plays, or stops immediately (= pass)
```

Passing is the common case and a valid choice — the code never forces engagement (the agency invariant). The
cadence is plumbing; what the agent does each tick is its own. See `docs/LANES.md` for tuning the two clocks.

## Concurrency (`src/loop/queue.ts`, `lock.ts`)

All work flows through a priority queue + a Postgres advisory lock, so a live turn (ChatForced/GameForced)
jumps ahead of an idle tick and they never hit the model at once. With a second model instance configured
(`MODEL_BASE_URL_GAME`), chat and game run as separate lanes (separate queues + locks + instances) and go
concurrently; with one instance they serialize. See `docs/MODEL_SERVING.md` + `docs/LANES.md`.

## The chat path (end to end)

1. UI → `POST /api/chat/message` → persist the user turn (+ caption any images) → fire `submitChatTick()`
   fire-and-forget → return an ack.
2. The tick runs through the queue; if the agent replies, the reply is persisted and queued as outbound.
3. UI polls `GET /api/outbound/pending` → renders + acks (`POST /api/outbound/ack`).

## The game path

`POST /api/event` (from the game) → `submitGameEvent` → a game pass on the game lane → each tool the agent
calls is POSTed back to the game's `execUrl` → the final text is returned. The game also posts its latest
state to `/api/game-context` and salient events to `/api/experience` (which the heartbeat then perceives).
See `docs/GAME_ADAPTER.md`.

## Where identity lives

The Postgres identity store (`prisma/schema.prisma`, `src/store/`) is the agent's self across time: memory,
self-image, opinions, priorities, felt state, journals. Everything starts empty; the agent fills it. The
store is the irreplaceable part — back it up.
