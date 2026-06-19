---
name: brain-dev
description: Operational playbook for developing the homunculus brain — the agentic loop, modes, tools, prompt layering, heartbeat, and identity store. Use when editing src/loop, src/modes, src/tools, src/prompt, src/store, or the API routes; when adding a self-management tool; or when any change touches what the agent attends to, believes, remembers, or decides (the agency invariant). Covers the edit→typecheck→build loop, where each subsystem lives, and the agency checklist.
---

# Brain development playbook

This repo is a local-native autonomous agent that plays turn-based, idle, and text-based games and forms
its own memory, opinions, and self-image. Read `CLAUDE.md` first — especially the **agency invariant**
(Principle 0). Architecture is in `docs/ARCHITECTURE.md`.

## The agency check (run this against every behavior change)
Whenever a change decides whether some agent behavior is fixed-in-code vs. the agent's own mutable state:
1. It MUST be the agent's state unless it's a safety rail / responsiveness guarantee / plumbing.
2. Call it out in your reply: the decision, `[AGENCY: her-state]` or `[AGENCY: code-fixed]`, one-line why.
3. For `code-fixed`, justify it (rail/guarantee/plumbing). If you can't, it's likely a violation — flag it.
4. Record anything that diverges from these conventions in `docs/DECISIONS.md`.
Smell test: writing a constant, map, or rule where the agent's judgment belongs (a mood→action map, an
auto-formed opinion, a fixed priority order) is the violation. Surface it; don't ship it silently.

## Where things live
- `src/loop/engine.ts` — the one loop (call → tools → repeat → final). Guards + text-tool recovery in `done()`.
- `src/loop/scheduler.ts` — heartbeat cadence, queue entry points, rebake. `heartbeat.ts` — tier-1/tier-2.
- `src/loop/chatTick.ts` / `gameLoop.ts` — the chat and game passes.
- `src/modes/` — a mode = `{ systemPrompt, tools }`. `chat.ts` builds the chat toolset; `game.ts` the game one.
- `src/tools/` — self-management tools + `index.ts` registry. Add a tool here (see below).
- `src/prompt/` — `staticBase.ts` (blank base prose), `baseSnapshot.ts`/`identityDiff.ts` (warm cache),
  `selfTail.ts` (volatile self-state), `gameTail.ts`. See the `prompt-warm-base` notes in `docs/`.
- `src/store/types.ts` (interface) + `prisma.ts` (impl). `prisma/schema.prisma` is the source of truth.

## Adding a self-management tool
1. Write a `ToolDef` in `src/tools/<area>.ts` (zod `inputSchema`, `modes`, `handler` returning a short
   string, NEVER throwing — return error strings). Mark agency in the comment.
2. If it writes new state, add the store method to `src/store/types.ts` + `prisma.ts` (+ a schema model).
3. Register it in `src/tools/index.ts` (`ALL_TOOLS`).
4. If it surfaces state into the prompt, render it in `src/prompt/selfTail.ts` (tail, not the base).
5. If the model might leak it as text and the intent should still land, add it to the recovery whitelist in
   `engine.ts` `done()` + `buildTypedCall` in `sanitizeReply.ts` (scoped, validated — don't over-broaden).

## Edit → validate loop
```
npm run typecheck      # tsc --noEmit — fast, run constantly
npm run build          # next build — full validation incl. routes
npm run db:push        # after a schema change (rehearse on a clone if data exists)
npm run heartbeat      # fire one idle tick by hand (needs a running model + DB)
```
After a schema change, `npx prisma generate` (build does this). The model + DB must be up for runtime tests.

## Gotchas
- Don't bake volatile state into the warm base (kills the KV cache — see `docs/WARM_BASE_CACHING.md`).
- Tools render at the front of the prompt → changing a mode's tool list cold-prefills it.
- Persist the agent's chat turn BEFORE delivering it (`addChatTurn` then `addOutbound`) — ordering race.
- The agent's role is `"agent"` in the store and `"assistant"` on the wire. The human is `"user"`.
- Never add a hosted model API — local llama-server only.
