# Game types — what this brain can drive, and the levers that make each work

The brain is genre-agnostic. It does not know or care whether it's playing a roguelike, an idle game, or a
text adventure — it only ever does three things through the `GameAdapter` contract (`src/game/adapter.ts`):

1. **observe** — read a text snapshot of the current state (`buildSnapshotText`),
2. **see its options** — read a catalog of callable actions (`buildCatalog`),
3. **act** — call one action and read what happened (`executeTool`).

So "can it play game X?" is **not** a question about genre. It reduces to two requirements:

- **A control surface** — some reliable, programmatic way to (a) read state into text and (b) inject an
  action. See `docs/GAME_ADAPTER.md` for the contract; an API, hookable source, a headless-browser driver,
  or even screen-capture + input-injection all qualify, in decreasing order of niceness.
- **A tempo the local model can keep.** This is the real constraint, and the rest of this doc is about it.

---

## Why tempo is the axis (not text vs. graphics, not genre)

One observe→act cycle costs **one local-model pass** — prompt prefill + reasoning + the tool call. On a
warm KV cache that's typically low single-digit seconds; on a cold prefill or a long reasoning budget it's
longer (`docs/WARM_BASE_CACHING.md`, `docs/MODEL_SERVING.md`). Call that latency `T_act`.

A game is in-scope when **the agent gets to act in a window ≥ `T_act`**, either because:

- the game is **turn-based** (it waits for the agent's move), or
- the game can be **paused** while the agent thinks (`openSession` with `wasPaused`), or
- the game is **slow enough** that acting every `T_act`–`T_heartbeat` is fine (idle/incremental).

A game is out-of-scope when a good decision must be made **faster than `T_act`** and the world **can't be
paused** — a real-time twitch game. Nothing about the adapter is impossible to write there; the agent just
can't think fast enough, and its snapshot is stale the moment it acts. Don't fight this with engineering;
pick games on the right side of it.

Non-text games are fine on the same axis: a graphical state becomes text by captioning frames through the
**vision lane** (Qwen-VL + mmproj; `VISION_BASE_URL`, `docs/MODEL_SERVING.md`). Vision adds latency to
`T_act`, which only matters for the tempo test above — it does not change what's possible.

---

## Fit by game type

| Game type | Fit | Why / how |
|-----------|-----|-----------|
| **Turn-based** (roguelikes, strategy, card/board, tactics) | ✅ excellent | The game waits for the move. The natural shape: game POSTs `/api/event` on the agent's turn; brain acts; repeat. Bound a runaway turn with `maxSteps` / `wallClockMs`. |
| **Idle / incremental** | ✅ excellent | State drifts slowly; the **heartbeat IS the play loop**. The agent wakes every `AGENT_HEARTBEAT_MS`, reads state, makes a few buys/prestiges, sleeps. Tune the heartbeat to the game's pace. |
| **Interactive fiction / MUDs / text adventures** | ✅ excellent | Text-native; the snapshot is the passage, the catalog is the available commands/links. The original target shape. |
| **Visual novels / choice games** | ✅ good | Choice-paced (waits on the reader). If graphical, caption the screen via the vision lane; the catalog is the choice set. |
| **Pausable real-time** (CRPGs with active-pause, many sims/builders, RTS-with-pause) | ✅ workable | Use `openSession`/`closeSession` to **pause on each decision** so `T_act` stops mattering. Acceptable cadence; not twitch-precise. |
| **Slow real-time** (4X on long ticks, async/play-by-email, persistent browser games) | ⚠️ depends | Works if a meaningful decision interval ≥ `T_act`. Lengthen the heartbeat; lean on event-driven turns. |
| **Real-time twitch** (FPS, fighting, platformers, fast action) | ❌ poor | Decisions due faster than `T_act` with no pause. Out of scope by design — don't wire it. |

---

## The levers

These are the knobs that move a game across the tempo line. Most live in `.env` (`.env.example`); a few are
per-event fields the **game** sets when it POSTs `/api/event` (`GameEventInput` in `src/game/adapter.ts`).

### 1. `openSession` / `closeSession` — *pause the world* (the biggest lever)
The single most powerful tool for any game with a clock. When the agent chooses to play on its own time, the
brain asks the game to open a session: **pause**, hand back the snapshot + catalog + a session token; after
the pass the brain closes it (apply results, unpause). `OpenedSession.wasPaused` lets close restore the prior
run state. With pause, `T_act` is irrelevant — a pausable real-time game behaves like a turn-based one. A
game that can't pause simply omits the open endpoint (`GAME_OPEN_URL` unset) → voluntary play is a clean
no-op and the game drives purely via events.

### 2. `AGENT_GAME_HEARTBEAT_MS` — the game lane's clock (defaults to `AGENT_HEARTBEAT_MS`, 60000)
How often the agent's voluntary-play heartbeat ticks on the game lane. This is the play cadence for
**idle/slow** games. (There's a separate `AGENT_CHAT_HEARTBEAT_MS` for the chat/self clock — see
`docs/LANES.md`; both fall back to `AGENT_HEARTBEAT_MS`.)
- **Idle/incremental:** lower it (e.g. 10–30s) so the agent acts often enough to matter — or raise it if the
  game rewards patience and you want fewer passes.
- **Slow real-time:** raise it (minutes) so the agent isn't burning passes on an unchanged world.
- The game heartbeat only runs when the game supports voluntary sessions (`GAME_OPEN_URL`); turn-based games
  drive via pushed events (lever #3) instead.
- It is **plumbing/cadence only** — *what* the agent does each tick is its own choice (the agency invariant,
  `CLAUDE.md`). The lever sets how often it gets the *opportunity*, never the decision.

### 3. Event-driven turns — `POST /api/event` (push vs. the heartbeat's pull)
For **turn-based** games, don't wait on the heartbeat: have the game **push** an event the instant it's the
agent's turn. `GameEventInput.type` labels the pass ("your_turn", "combat"); the event also carries the
snapshot `text` and the `gameTools` catalog + callback. This is the lowest-latency path and the right default
for anything turn-based.

### 4. `forceFirstTool` — guarantee an action when one is required
On action-required events, set `forceFirstTool: true` so the first step must be a tool call. This is a
**responsiveness guarantee for game/system events** (always handled), not a constraint on the agent's
autonomous time. [AGENCY: code-fixed — reliability for a called event, not autonomous behavior.]

### 5. `maxSteps` / `wallClockMs` — bound a single pass
Per-event soft caps on iterations and wall-clock. Keep a slow or looping turn from starving the chat lane or
overrunning a real-time window. Set tighter for time-pressured games, looser for deliberate ones.

### 6. The game lane — `MODEL_BASE_URL_GAME`
Run a **separate llama-server instance** for game/heartbeat passes so a long game turn never evicts the chat
lane's warm KV cache (`docs/MODEL_SERVING.md`, `docs/LANES.md`). For latency-sensitive games you can point
the game lane at a **smaller/faster model** to cut `T_act` for actions, keeping the larger model for chat.
Unset → the game lane falls back to the chat lane (single instance; fully serialized).

### 7. Reasoning budget — `LLAMA_REASONING_BUDGET_GAME` / `MODEL_MAX_TOKENS_GAME`
A bounded `<think>` block keeps tool-call latency predictable. Lower the game reasoning budget for fast turns
(less deliberation, quicker action); raise it for games where a turn genuinely needs planning. Keep it well
below `MODEL_MAX_TOKENS` or you get empty answers (`docs/ENGINEERING_LESSONS.md`).

### 8. Vision lane — `VISION_BASE_URL`
Turns a **non-text** game into a text snapshot by captioning frames. Required for graphical games; adds to
`T_act`, so weigh it against the tempo test. Caption only what the agent needs to decide — a full-screen
description every turn is slow and noisy.

### 9. Catalog stability — keep the action set cache-warm
Game tools render at the front of the game-lane prompt, so a **changing catalog is a cold re-prefill**
(`docs/ENGINEERING_LESSONS.md`). Prefer a **stable, frozen** catalog (`src/game/remote.ts` freezes it). For
games whose options change every passage (e.g. link-driven Twine), expose a **single generic tool**
(`choose({option})`) rather than a per-turn-varying tool list, so the prefix stays warm.

### 10. Snapshot granularity — how much state per turn
The snapshot is the agent's whole view; bigger snapshots cost more prefill and bury the signal. Render the
**decision-relevant** state, not the entire game dump. This is the cheapest latency win on most games.

---

## Choosing levers by game type

| Game type | Primary levers |
|-----------|----------------|
| Turn-based | event-driven `/api/event` (#3) · `forceFirstTool` (#4) · `maxSteps`/`wallClockMs` (#5) · frozen catalog (#9) |
| Idle / incremental | `AGENT_GAME_HEARTBEAT_MS` (#2, tuned to pace) · lean snapshot (#10) |
| Interactive fiction / MUD | event-driven (#3) · frozen or generic-`choose` catalog (#9) |
| Visual novel / choice | event-driven (#3) · vision lane if graphical (#8) · generic-`choose` catalog (#9) |
| Pausable real-time | `openSession`/`closeSession` pause (#1) · game lane (#6) · tight `wallClockMs` (#5) |
| Slow real-time | long `AGENT_GAME_HEARTBEAT_MS` (#2) · event-driven for key moments (#3) |
| Non-text (any of the above) | vision lane (#8) · generous-but-bounded reasoning (#7) · lean captions (#10) |

---

## The hard limit (when to walk away)

If a good decision is due **faster than one model pass** and the game **cannot be paused**, no lever fixes
it — that's the real-time twitch case, and it's out of scope on purpose. Everything else is a tuning
exercise across the levers above. When in doubt, measure `T_act` on your hardware (one warm chat turn is a
good proxy) and compare it to the game's decision interval; that comparison, not the genre, is the answer.
