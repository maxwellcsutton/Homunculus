# Prompt layering

The prompt is assembled to keep the model's KV cache warm: a **byte-stable prefix** that rarely changes, a
**rolling history**, and a **volatile tail** folded into the final user turn. This is the single biggest
performance lever — get it wrong and every turn cold-prefills the whole base.

## The three layers

```
┌─ SYSTEM (the "warm base") ──────────────────────────────────────────────┐  byte-stable, baked once
│  STATIC_HEAD   — neutral framing: who you are, agency, tools, modes      │  (src/prompt/staticBase.ts)
│  Your memory   — the FULL memory list, baked in                         │  (src/prompt/baseSnapshot.ts)
│  STATIC_CLOSING                                                          │
├─ HISTORY ───────────────────────────────────────────────────────────────┤  append-only rolling window
│  the last ~N chat turns (AGENT_HISTORY_MAX)                              │
├─ USER TURN (the volatile "tail") ───────────────────────────────────────┤  re-rendered every turn (cheap)
│  self-image · opinions · focus · felt state · memory categories         │  (src/prompt/selfTail.ts)
│  memory DIFF (added/removed since the base was baked)                    │  (src/prompt/identityDiff.ts)
│  + the pending message / game state ("# Now …")                         │
└──────────────────────────────────────────────────────────────────────────┘
```

### Why this split
- **Memory is baked + diffed.** The base bakes the full memory list; when the agent remembers/forgets, the
  base stays byte-identical and the tail shows just the delta. The periodic rebake folds the day's edits
  back into a fresh base. (`docs/WARM_BASE_CACHING.md`)
- **Volatile self-state rides the tail.** Self-image, opinions, focus, and felt state change often, so they
  are NEVER baked — re-rendering them in the tail each turn is cheap and keeps the base stable.
- **History is append-only.** Each new turn only adds tokens; prior turns reuse cached KV.
- **Game mode shares the base.** The game system prompt IS the same warm base (byte-identical), so game and
  chat passes share the cached prefix even when they interleave. Game-situational framing rides the game
  tail (`src/prompt/gameTail.ts`).

## Tail conventions (so the cache survives)
- **Absolute timestamps only.** A relative "3 min ago" rewrites old lines every turn and destroys reuse.
  Stamps come from a fixed `createdAt` (`src/loop/timeFmt.ts`).
- **The base is served VERBATIM** from the stored snapshot — never re-rendered per turn.
- **Tools render at the FRONT** of the prompt on this model, so a changed tool set = a cold re-prefill.
  Keep each mode's tool list stable; the game catalog is frozen for this reason (`src/game/remote.ts`).

## Extending the base (giving your agent a character)
`src/prompt/staticBase.ts` ships **blank** — neutral framing, no personality. To give your agent a starting
character, domain knowledge, or house style, edit `STATIC_HEAD` there. It's baked, so it stays cache-warm;
a code edit triggers a rebake on boot (`rebakeIfStaticChanged`). Keep volatile or fast-changing content OUT
of the base — put it in the tail.
