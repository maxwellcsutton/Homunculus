# homunculus

A boilerplate for a **local-native autonomous agent that plays games it can keep pace with — turn-based,
idle, text-based, and the like — and forms its own memories, opinions, and self-image** as a result of
playing. One continuous agentic-loop engine + a local model + a shared identity store. The game is an
abstract adapter; chat is a mode. The real envelope is *tempo*, not genre — see `docs/GAME_TYPES.md`.

A reusable agent "brain" — the loop, prompt layering, warm-base caching, model serving, self-management
tools, concurrency — that is fully generic, with nothing game- or persona-specific baked in.
Identity starts **blank**: the agent authors who it is from experience.

> **The core idea (the agency invariant):** wherever the agent's behavior *could* be fixed in code or be
> its own mutable state, it is its own state. Its attention, feelings, opinions, self-image, and memory are
> records *it* reads and rewrites — never constants the code picks. See `CLAUDE.md`.

## What's here
- **The loop** (`src/loop/`) — one agentic engine, a heartbeat that gives the agent its own clock, a
  priority queue + cross-process lock for concurrency.
- **Prompt layering + warm-base KV caching** (`src/prompt/`) — a byte-stable baked base + a volatile tail,
  so the local model stays cache-warm. The performance model that makes a slow local model usable.
- **Self-management tools** (`src/tools/`) — memory, recall, journals, priorities, felt state, **self-image**,
  **opinions**, proactive outreach (flagged off). Everything self-authored.
- **Local model serving** (`src/model/`, `scripts/serve*.ts`) — llama.cpp `llama-server`, OpenAI-compatible,
  with a single main lane + optional work / embedding / vision lanes. No hosted API.
- **The GameAdapter contract** (`src/game/`) — an abstract HTTP contract any game implements (see
  `docs/GAME_TYPES.md` for which game types fit and how). No working game ships here, by design.
- **A minimal chat UI + API** (`src/app/`) and **deploy/ops** scaffolding (`deploy/`, `scripts/backup.ts`).

## Quickstart
```bash
cp .env.example .env          # set DATABASE_URL, LLAMA_MODEL_PATH, LLAMA_SERVER_BIN
npm install
npm run db:push               # create the schema (everything starts empty)
npm run model                 # start the local model (separate terminal)
npm run dev                   # start the brain; open http://localhost:3000/chat
```
The continuous loop (heartbeat + rebake) starts with the server. Talk to the agent in the chat UI; wire a
game via the GameAdapter contract when you're ready.

## Docs
- `CLAUDE.md` — the agency invariant + repo map + the engineering lessons. **Start here.**
- `docs/ARCHITECTURE.md` — the loop, modes, heartbeat, concurrency, the chat/game paths.
- `docs/PROMPT_LAYERING.md` + `docs/WARM_BASE_CACHING.md` — how the prompt is assembled to stay cache-warm.
- `docs/MODEL_SERVING.md` — lanes + the validated llama.cpp flags.
- `docs/LANES.md` — the game lane + chat lane: together vs. separate, cost/benefit + recommendations.
- `docs/GAME_ADAPTER.md` — wiring a game (the HTTP contract).
- `docs/GAME_TYPES.md` — which game types this can drive (turn-based, idle, text, …) + the levers that make each work.
- `docs/MODES_TOOLS_AND_LEVERS.md` — what each mode sees and can do + every tuning lever (a living reference).
- `docs/SELF_FORMATION.md` — how memories / opinions / self-image accumulate from play.
- `docs/ENGINEERING_LESSONS.md` — the reusable engineering lessons (pitfalls to avoid).
- `docs/DEPLOYMENT.md` + `deploy/README.md` — local-native (launchd) deploy.
- `docs/DECISIONS.md` — the architectural decisions behind this boilerplate and why.
- `.claude/skills/` — operational playbooks (`brain-dev`, `wire-a-game`, `model-serving`) and
  **`new-project`** (run `/new-project` to interactively scaffold a customized copy of this boilerplate
  into a fresh repo).

## Status
Compiles and builds clean (`npm run typecheck`, `npm run build`). It's a **boilerplate**: the loop, prompt
caching, tools, serving, and game contract are wired and validated; you bring the model file, a Postgres DB,
and (optionally) a game.
