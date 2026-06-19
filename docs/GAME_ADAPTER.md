# Wiring a game (the GameAdapter contract)

This repo has **no working game by design** — only the contract. The brain knows nothing about any specific
game; it speaks an HTTP contract. To wire a game, implement these endpoints on the game's side. The shapes
live in `src/game/adapter.ts`; a documented placeholder is `src/game/stubAdapter.ts`.

Before you wire one, check that it *fits*: `docs/GAME_TYPES.md` covers which game types this brain can drive
(turn-based, idle, text-based, and other paced/pausable types) and the levers — heartbeat, session pause,
event-driven turns, the game lane — that make each work.

Observation in, action out. The "snapshot" is free-form text the brain renders verbatim into the agent's
turn — the brain never parses game state.

## game → brain

### `POST /api/event` — ask the agent to take a turn
```jsonc
{
  "type": "your_turn",                 // free-form label
  "text": "Location: a clearing…\nExits: north, east.\nYou see: a lantern.",  // the agent's view this turn
  "gameTools": {
    "catalog": [                       // the tools the agent may call this turn (JSON-Schema params)
      { "name": "move", "description": "Move in a direction.",
        "parameters": { "type": "object", "properties": { "direction": { "type": "string" } }, "required": ["direction"] } }
    ],
    "execUrl": "http://localhost:4000/ai/exec",  // brain POSTs each tool call here
    "sessionId": "abc123",             // opaque; binds calls to game state
    "headers": { "Authorization": "Bearer …" }   // optional
  },
  "forceFirstTool": true,              // optional — force an action on step 1
  "maxSteps": 40, "wallClockMs": 120000
}
```
Response: `{ finalText, stopReason, steps, toolCalls: [{name, args}] }`.

### `POST /api/game-context` — keep the chat-self aware of the game
`{ "body": "<rendered current state>", "meta": { … } }` — stored as a singleton; surfaced to chat.

### `POST /api/experience` — push a salient event
`{ "kind": "outcome", "content": "You defeated the troll after three tries." }` — recorded and perceived on
the next (off-cadence) heartbeat. This is how the agent forms opinions from what happens (`docs/SELF_FORMATION.md`).

## brain → game

### each tool call → `POST {execUrl}`
`{ "name": "move", "args": { "direction": "north" }, "sessionId": "abc123" }` →
`{ "result": "You move north into a dim corridor." }` or `{ "error": "you can't go that way" }`.
**Never throw to the brain** — return `{ error }`; the model adapts.

### catalog refresh (optional) — `GET {GAME_CATALOG_URL}`
`{ "catalog": [ …RemoteToolSpec ] }` — fetched at boot + on the rebake cadence so a tool-list change is
picked up at a cache-cold moment. The catalog is frozen byte-stable to keep the work-lane prefix warm.

### voluntary play (optional) — `POST {GAME_OPEN_URL}` / `POST {GAME_CLOSE_URL}`
For when the agent CHOOSES to play on its own time (`engage("game")`). Open returns
`{ sessionId, execUrl, catalog, snapshotText, maxSteps?, wasPaused? }`; close gets
`{ sessionId, finalText, wasPaused }`. Omit these endpoints (leave `GAME_OPEN_URL` unset) to disable
voluntary play — then `engage("game")` is a clean no-op.

## Env
`GAME_EXEC_URL`/`GAME_CATALOG_URL`/`GAME_OPEN_URL`/`GAME_CLOSE_URL` point the brain at your game;
`GAME_AI_EXEC_TOKEN` is an optional shared bearer. Local self-tools (memory/journal/opinions) WIN a
name collision with a game tool — expose mechanical ops only.
