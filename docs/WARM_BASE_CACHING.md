# Warm-base caching

llama.cpp reuses the KV cache for the longest **byte-identical prefix** of a prompt it has already seen. The
agent's system prompt is large (framing + the full memory list), so re-prefilling it every turn is the
dominant cost. The fix: bake it once into a byte-stable "base" and serve it VERBATIM until a periodic
rebake. (`src/prompt/baseSnapshot.ts`, `src/prompt/identityDiff.ts`, `prisma` model `PromptBaseSnapshot`.)

## Lifecycle

```
bakeStaticBase(store):   STATIC_HEAD + <full memory list> + STATIC_CLOSING  →  one active snapshot row
getActiveBaseSnapshot:   read the active row (bake lazily on a cold/empty DB)
rebakeBase:              re-merge current memory into a fresh active row (periodic + manual `npm run rebake`)
rebakeIfStaticChanged:   on boot, rebake if the static prose changed (a code edit)
```

The stored `baseText` is the byte-stable artifact. The continuous loop reads it fresh each turn (so a
separate rebake process is picked up without a restart) but never re-renders it.

## The diff (how memory edits stay cheap)

The snapshot also stores the memory rows it was baked from (`items`). Each turn, the tail diffs the LIVE
memory against those rows by a content hash and renders only `added` / `removed`
(`computeIdentityDiff` → `renderIdentityDiff`). So a `remember`/`forget` mid-day:
- the base stays **byte-identical** → KV prefix stays warm,
- the tail grows by one small line.
The next rebake folds the edits back into the base and the diff resets to empty.

## The rebake cadence is a tradeoff (not behavior)

`AGENT_REBAKE_MS` (default 1h). Each rebake changes the base bytes → the next turn pays ONE cold re-prefill
of the base; a shorter period keeps the per-turn diff smaller. Pick per your memory churn. This is
plumbing — `[AGENCY: code-fixed]`.

## What is NEVER baked
- Conversation history (a live rolling window).
- Volatile self-state — self-image, opinions, focus, felt state, current moment (re-rendered in the tail).
- Game run-state.
Baking any of these would churn the base bytes every turn and defeat the whole mechanism.
