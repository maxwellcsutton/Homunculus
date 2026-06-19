# homunculus

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

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
  on a chat (base) lane + an optional game lane (the primary work lane), plus embedding / vision lanes. No hosted API.
- **The GameAdapter contract** (`src/game/`) — an abstract HTTP contract any game implements (see
  `docs/GAME_TYPES.md` for which game types fit and how). No working game ships here, by design.
- **A minimal chat UI + API** (`src/app/`) and **deploy/ops** scaffolding (`deploy/`, `scripts/backup.ts`).

## Usage

You bring three things: **Node 18+**, a local **Postgres**, and a **GGUF model** served by llama.cpp's
`llama-server`. Inference is entirely local — there's no hosted API and nothing leaves your machine.

### Start your own agent

**Scaffold a customized copy — recommended (Claude Code).**
This repo ships a `/new-project` skill (`.claude/skills/new-project`). In Claude Code, run **`/new-project`**:
it interviews you — name, starting character, game wiring, model lanes, owner name, heartbeat cadence,
database — then copies the boilerplate into a fresh repo wired to your answers (`.env`, package name,
launchd labels, an optional seed character, an optional game-adapter scaffold) and makes the first commit.
Fastest path from clone to a running, named agent.

**Or run the boilerplate directly.**
```bash
cp .env.example .env       # set DATABASE_URL, LLAMA_MODEL_PATH, LLAMA_SERVER_BIN, AGENT_OWNER_NAME
npm install
npm run db:push            # create the identity store (everything starts empty)
npm run model              # serve the local model            (separate terminal)
npm run dev                # start the brain → http://localhost:3000/chat
```
Talk to it at **`/chat`**. The continuous loop runs the moment the server boots: per-lane heartbeats give it
its own clock (it acts on its own time, not just request→response) and a periodic rebake keeps the prompt
cache warm. Optional extra lanes: `npm run embed` (semantic dedup) and `npm run vision` (image captions).

### Wire up a game

No game ships — by design. The brain is game-agnostic and talks to a game over a small HTTP contract (the
**GameAdapter**). To connect one:

1. **Check it fits.** The envelope is *tempo*, not genre — turn-based, idle, and text games work; real-time
   twitch doesn't. See `docs/GAME_TYPES.md`.
2. **Implement the contract** on your game's side: a text snapshot of the current state, a catalog of
   available actions, and an exec callback that runs one action (plus optional pause/resume sessions for
   voluntary play). The shapes are in `src/game/adapter.ts`; a documented stub is `src/game/stubAdapter.ts`;
   the full contract is `docs/GAME_ADAPTER.md`.
3. **Point the brain at it** — set `GAME_EXEC_URL` / `GAME_CATALOG_URL` (and optional `GAME_OPEN_URL` /
   `GAME_CLOSE_URL`) in `.env`. Until then the game lane stays dormant and it's chat-only.

In Claude Code, the **`/wire-a-game`** skill walks through the whole contract end to end.

### Give it a character (optional)

It ships **blank** and authors its own identity, opinions, and self-image from play. To seed a starting
character or domain, extend `STATIC_HEAD` in `src/prompt/staticBase.ts` — still a *starting state* it can
rewrite, never fixed behavior (`CLAUDE.md`). Or just let it become someone on its own.

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

## License

[GNU AGPLv3](LICENSE) — free and open, and built to stay that way. Use it, fork it, modify it, run it, and
build your own agent with it. The one condition: any version you **distribute or run as a network service**
must also be open-sourced under the AGPL — it can't be taken closed or proprietary. Copyright © 2026 Maxwell
Sutton.
