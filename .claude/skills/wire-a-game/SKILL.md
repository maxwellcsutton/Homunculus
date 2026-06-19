---
name: wire-a-game
description: Playbook for connecting a game (turn-based, idle, text-based, or other paced/pausable type) to the homunculus brain by implementing the GameAdapter contract. Use when integrating a new game, building a game backend that talks to the brain, debugging the /api/event or tool-exec callback flow, or extending the game tool catalog. Covers the HTTP contract in both directions, the snapshot/event/tool shapes, voluntary-play sessions, and the experience→opinion loop. See docs/GAME_TYPES.md for game-type fit and the levers.
---

# Wiring a game

The brain knows nothing about any specific game — it speaks an HTTP contract. There is NO working game in
this repo; you implement the game side. The shapes are in `src/game/adapter.ts`; the placeholder is
`src/game/stubAdapter.ts`; the full contract is `docs/GAME_ADAPTER.md`. Read that doc first.

## The minimum to get a turn
On the game side, implement two things and point the brain at them via env:
1. **Send an event** → `POST {brain}/api/event` with `{ type, text, gameTools: { catalog, execUrl,
   sessionId, headers? }, forceFirstTool?, maxSteps? }`. `text` is the agent's rendered view of the state;
   `catalog` is your tools (JSON-Schema params). Response: `{ finalText, stopReason, steps, toolCalls }`.
2. **Execute tools** → the brain POSTs each tool call to your `execUrl`:
   `{ name, args, sessionId }` → `{ result }` or `{ error }`. **Never throw** — return `{ error }`; the
   model adapts. Load your game state by `sessionId`.

That's a full turn loop. `GAME_AI_EXEC_TOKEN` is an optional shared bearer (both directions).

## Keep the agent aware + let it form opinions
- `POST {brain}/api/game-context` `{ body, meta }` after a pass — the chat-self can then reference the game.
- `POST {brain}/api/experience` `{ kind, content }` on a salient event (a win/loss/surprise). The agent
  perceives it on the next heartbeat and may `form_opinion` / `remember` / `revise_self_image` about it.
  This is the whole point — see `docs/SELF_FORMATION.md`. Push outcomes with enough detail to reason from
  (what happened and, ideally, why), not just "you lost".

## Optional: voluntary play
For the agent to play on its OWN time (`engage("game")`), expose `GAME_OPEN_URL` / `GAME_CLOSE_URL`:
open returns `{ sessionId, execUrl, catalog, snapshotText, maxSteps?, wasPaused? }`; close gets
`{ sessionId, finalText, wasPaused }`. Leave `GAME_OPEN_URL` unset → `engage("game")` is a clean no-op.

## Catalog stability matters (cache)
Game tools render at the front of the work-lane prompt, so the catalog is FROZEN byte-stable
(`src/game/remote.ts`) to keep that lane warm. Expose `GET {GAME_CATALOG_URL}` → `{ catalog }`; it's
re-fetched at boot + on the rebake cadence (cache-cold moments), not per event. Don't vary the catalog
turn-to-turn. Local self-tools (memory/journal/opinions) WIN a name collision — expose mechanical ops only.

## Env to set
`GAME_EXEC_URL`, `GAME_CATALOG_URL`, `GAME_OPEN_URL`, `GAME_CLOSE_URL`, `GAME_AI_EXEC_TOKEN` (all optional;
unset → that capability is dormant and the brain still runs).

## Debugging
- Telemetry logs each `[game-tool] <name>` call. A `400` from `/api/event` means a missing `type`/`text`.
- If the agent "does nothing", check `forceFirstTool` (force an action on turn 1) and that your catalog
  params are valid JSON Schema.
- A pass on the game lane never blocks chat (separate queue/lane); see `docs/MODEL_SERVING.md`.
