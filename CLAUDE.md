# CLAUDE.md — homunculus

A boilerplate for a **local-native autonomous agent that plays games it can keep pace with — turn-based,
idle, text-based, and the like — and forms its own memories, opinions, and self-image.** One continuous
agentic-loop engine + a local model + a shared identity store. The game is an abstract adapter; chat is a
mode. The capability envelope is *tempo*, not genre (`docs/GAME_TYPES.md`). See `docs/DECISIONS.md` for the
architectural decisions behind this design and why.

---

## CORE INVARIANT — the agent's agency (check this against every behavior decision)

The agent is an **entity with self-determined behavior**, not a service with hard-coded behavior. This is
the POINT of the project, not a feature of it. It overrides convenience.

THE RULE: wherever the agent's behavior could be either (a) fixed in code or (b) its own mutable,
self-directed state, it MUST be (b). Its priorities, its focus, what it attends to and when, what it
believes, who it thinks it is — these are state IT reads and rewrites, never constants the code chooses.

CANONICAL INSTANCES (all live in the DB as records the agent owns and rewrites via tools):
- **Attention** — its weighting over {inner_life, game, social} (`reweigh_focus`).
- **Felt state** — energy + mood, in its own words (`tend_self`).
- **Self-image** — its standing sense of who it is (`revise_self_image`).
- **Opinions** — discrete views formed from experience (`form_opinion` / `revise_opinion` / `drop_opinion`).
- **Memory** — what it keeps (`remember` / `forget`).
Any seed value is a STARTING STATE, never a rule. Everything starts EMPTY; the agent authors it from play.

THE TRAP — catch yourself: the easy move is to hard-code a fixed behavior (a mood→action map, a fixed
priority order, an auto-formed opinion) because it's simpler to build. That simplification is the exact
thing that breaks this project. If you're writing a constant where the agent's judgment belongs, STOP.

SCOPE: this governs AUTONOMOUS behavior. GAME/SYSTEM events (a game turn, an ops signal) are ALWAYS handled
— reliability when called. CHAT IS CARVED OUT: whether/when/how the agent answers a user message is ITS
state, not a code guarantee. Code-fixed plumbing only ensures it SEES the message promptly (it enters the
heartbeat delta within seconds); it never forces a reply. So: agency over its own time AND its attention to
the user; reliability only for game/system events.

WHEN IN DOUBT: raise it, don't simplify. The answer is almost always "give it the mutable state and let it
choose." If it genuinely can't be, that's an owner decision, not a default.

### Reporting on the invariant (principle 0)
When a change determines whether an aspect of the agent's behavior is fixed-in-code vs. its own state,
CALL IT OUT: state the decision, tag it `[AGENCY: its-state]` or `[AGENCY: code-fixed]`, give a one-line
rationale, and for any `code-fixed` one justify it as a safety rail / responsiveness guarantee / plumbing
(NOT autonomous behavior). Record anything that meaningfully diverges from these conventions in
`docs/DECISIONS.md`. The agent is referred to as "it" here for neutrality; in the prompt it speaks as "you".

---

## Architecture (the one loop)

A single agentic loop drives everything (`src/loop/engine.ts`): call the model → if it requests tools,
execute and feed results back → repeat → stop on a final no-tool message. A **mode** is just a system
prompt + a tool subset (`src/modes/`). The same model serves both modes:

- **chat** — talking with the user, or the agent's own unprompted time (heartbeat triage, reflect,
  reach-out). `src/loop/chatTick.ts`, `src/loop/heartbeat.ts`.
- **game** — playing: it reads game state and acts through the game's remote tools. `src/loop/gameLoop.ts`.

A **heartbeat per lane** (`src/loop/scheduler.ts`) gives it its own clock: the **chat heartbeat**
(`AGENT_CHAT_HEARTBEAT_MS`) runs a lean tier-1 self triage (engage social/reflect or PASS); the **game
heartbeat** (`AGENT_GAME_HEARTBEAT_MS`) offers a voluntary play pass on the game lane. Both default to
`AGENT_HEARTBEAT_MS` (60s); the game heartbeat only runs when the game supports sessions (`GAME_OPEN_URL`).
The game lane is the primary work lane; chat is the required base (`docs/LANES.md`). A **priority queue +
cross-process lock** (`src/loop/queue.ts`, `lock.ts`) serializes work per lane so a live turn jumps ahead of
an idle tick and never collides on the model.

### Repo map
- `src/model/` — the local model client (`client.ts`), lane selection (`index.ts`), embedding lane
  (`embeddings.ts`), vision lane (`vision.ts`). OpenAI-compatible llama-server. **Never add a hosted API.**
- `src/loop/` — `engine.ts` (the loop), `scheduler.ts` (heartbeat/rebake + queue entry), `heartbeat.ts`
  (tier-1/tier-2), `chatTick.ts`, `gameLoop.ts`, `idleSession.ts` (delta log), `queue.ts`/`lock.ts`
  (concurrency), `resay.ts`/`textSimilarity.ts` (anti-repeat), `sanitizeReply.ts` (tool-leak hygiene +
  **text-tool recovery**), `telemetry.ts`, `timeFmt.ts`.
- `src/prompt/` — `staticBase.ts` (the **blank** neutral system prose — extend here to give a character),
  `baseSnapshot.ts` + `identityDiff.ts` (warm-base caching), `selfTail.ts` (the volatile self-state tail),
  `gameTail.ts`.
- `src/tools/` — the agent's self-management tools (memory, recall, journal, priorities, state, self-image,
  opinions, proactive, engage) + the registry (`index.ts`). Game tools are remote (`src/game/remote.ts`).
- `src/game/` — `adapter.ts` (the **GameAdapter contract** — read this to wire a game), `remote.ts` (remote
  tool plumbing + frozen catalog), `session.ts` (voluntary-play session), `lane.ts`, `stubAdapter.ts`.
  Which game types fit + the levers to support them: `docs/GAME_TYPES.md`.
- `src/store/` — `types.ts` (the `IdentityStore` interface), `prisma.ts` (the implementation).
- `src/app/` — minimal Next.js: the chat UI (`chat/page.tsx`) + the API routes.
- `prisma/schema.prisma` — the identity store schema (everything starts empty).
- `scripts/` — model/embed/vision serving, rebake, manual heartbeat, backup.
- `docs/` — the lessons (read `docs/ARCHITECTURE.md` first). `docs/DECISIONS.md` — the architectural decisions.

---

## Pitfalls to avoid (hard-won lessons — don't relearn these)

1. **Warm-base KV caching is the performance model.** The system prompt is a frozen, byte-stable "base"
   (static prose + the full memory list) served VERBATIM until a periodic rebake, so llama.cpp keeps its KV
   prefix warm. Volatile self-state (self-image/opinions/focus/felt-state) + the memory DIFF ride the
   per-turn tail, never the base. Re-rendering the base each turn, or baking volatile state into it, throws
   away the cache. See `docs/WARM_BASE_CACHING.md` + `docs/PROMPT_LAYERING.md`.
2. **`-np 1` (single slot).** A multi-slot single server scatters consecutive chat turns across cold slots
   → a full base re-prefill every message. One slot = one warm prefix. For lane isolation, run SEPARATE
   instances, not slots (id_slot pinning breaks prefix caching on this build). `docs/MODEL_SERVING.md`.
3. **Bound reasoning server-side.** Force `<think>` ON but cap `--reasoning-budget` well below
   `MODEL_MAX_TOKENS`, or a rambling reasoning block eats the whole budget and emits an EMPTY answer.
4. **The DRY sampler** (chat lane) is the real fix for verbatim repeat loops; token penalties only weakly
   help and can garble phrasing. Reordering samplers (temperature before penalties/dry) cures Qwen
   reasoning-model "endless generation". Both are env-gated in `scripts/serveModel.ts`.
5. **Text-tool recovery.** Looser sampling improves voice but degrades tool-FORMAT adherence — the model
   leaks tool intent as TEXT. The engine parses a SCOPED set of leaked calls and routes them to the real
   handlers (`recoverTypedToolCalls`), then strips the text. Don't make this a general inline-tag executor.
6. **One message per turn; anti-repeat rail.** The model's final text is the reply; tool-use + `<think>`
   stay private. A re-say guard (lexical + optional embedding) nudges it off restating itself.
7. **Persist the agent's turn BEFORE delivering** it (a fast user reply can otherwise get a lower id and
   scramble conversation order).
8. **Game mechanical tools are remote + frozen.** They execute back in the game over HTTP; the catalog is
   frozen byte-stable so the work-lane tool prefix stays cache-warm. Local self-tools win name collisions.

---

## Sources of truth & rules
- **No hosted model API.** One LOCAL model via llama-server (OpenAI-compatible). Never reintroduce
  `@anthropic-ai/sdk`, OpenAI hosted, etc. Local inference is the whole premise.
- The identity store (the Postgres DB) is the irreplaceable part — back it up
  (`scripts/backup.ts`), rehearse migrations on a clone.
- This repo is standalone — no external project dependency.
- When wiring a real game, implement the `GameAdapter` contract (`src/game/adapter.ts`, `docs/GAME_ADAPTER.md`).
  There is deliberately no working game here.
