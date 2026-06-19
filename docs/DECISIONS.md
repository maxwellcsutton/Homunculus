# Architectural decisions — homunculus

This file records the design decisions behind the boilerplate and the rationale for each, so a forker can
understand *why* it's shaped this way before changing it. Decisions that are self-evident from the code or
covered in `docs/` are not repeated here.

The core invariant — the **agency invariant** (`CLAUDE.md` Principle 0) — is the non-negotiable that most of
these decisions serve: wherever the agent's behavior could be fixed in code or be its own mutable state, it
is its own state.

Format: decision · rationale · agency tag where relevant.

---

## Scope decisions

- **Game integration = an abstract `GameAdapter` interface only** (no demo game). The brain loop is
  generic; any game it can keep pace with implements the HTTP contract (`src/game/adapter.ts`,
  `docs/GAME_ADAPTER.md`). The capability envelope is *tempo*, not genre — `docs/GAME_TYPES.md`.
- **Model serving = local, config-driven, single main lane by default** + an embedding lane + a vision
  lane, with support for *optional additional main lanes*. No hosted model API, ever — local inference is
  the premise.
- **UI = a minimal, stripped chat UI** (no styling beyond the bare minimum) + the API.
- **Identity = blank, self-authored.** Empty memory / self-image / opinion stores the agent fills entirely
  from experience. No seed personality. [AGENCY: her-state]
- **Subsystems included:** memory + recall, self-image / opinions / priorities, reflection + journal (all
  default-enabled); **proactive outreach default-OFF behind `AGENT_PROACTIVE_ENABLED`**.
- **Deploy/ops:** generic launchd/serve scripts + docs.
- **Heartbeat:** configurable, default 60s.

### Intentionally out of scope
Deliberately *not* included, to keep the boilerplate a clean brain rather than a specific embodiment: any
concrete game, a graphical/3D avatar or other embodiment, screen-feed/TV-watch input lanes, and web-push
notifications. The generic text-tool recovery (`recoverTypedToolCalls`) IS kept — it's a portable lesson,
not embodiment. The image-caption / vision lane IS kept as an optional sidecar.

---

## Design rationale

### Env-var prefix `AGENT_*`
App-level env vars are namespaced `AGENT_*` (e.g. `AGENT_HEARTBEAT_MS`, `AGENT_EMBED_URL`) to mark
agent/identity behavior, while `MODEL_*`, `LLAMA_*`, and `VISION_*` are about the model / serving. Keeping
the two namespaces distinct makes it obvious which knobs touch the agent vs. the inference stack.

### Attention domains `{inner_life, game, social}`
The agency invariant's canonical instance — the agent's self-owned attention weighting — has three domains:
`inner_life`, `game`, and `social` (interacting with the user). The *weighting* is entirely the agent's
mutable state; the labels are just a seed taxonomy. [AGENCY: her-state — the seed is a starting state, not a
rule.]

### First-class **self-image** and **opinion** surfaces
The whole point is *forming opinions and self-image from gameplay*, so both are promoted to first-class,
self-managed state rather than folded into a single journal:
- `SelfImage` — a durable free-text self-description the agent maintains (`revise_self_image`).
- `Opinion` — discrete opinion rows (subject / stance / confidence / basis), formed and revised from
  experience (`form_opinion`, `revise_opinion`, `drop_opinion`).
Both are **the agent's mutable, self-authored state**, read into context and rewritten only by the agent's
own tools — nothing in the code computes or branches on them. The "reflect on what happened → update your
stance" pattern is made explicit here. [AGENCY: her-state]

### The game→brain perception channel: `Experience`
`Experience` is a neutral log of game-world events the agent perceives (outcomes, wins, losses, salient
moments), surfaced in the heartbeat delta. It is pure perception plumbing. [AGENCY: code-fixed — perception
plumbing; whether/how the agent responds stays hers.]

### Lanes: game lane primary + chat base (renamed from "work")
The lane is `Lane = "chat" | "game"`. The agent's primary work is PLAYING, so the **game lane** (formerly the
"work" lane; env `MODEL_BASE_URL_GAME` / `MODEL_TEMPERATURE_GAME`) is framed as the primary work lane,
carrying game passes + all idle cognition. The **chat lane** (`MODEL_BASE_URL`) remains the REQUIRED base:
the game lane is optional and falls back to it, so a minimal setup is one instance with zero extra config.
This is a *framing + rename* change — which lane is required/default was deliberately left unchanged so the
default stays robust (cold-prefill behavior unchanged). The queue/lock/slot machinery degrades to a single
serialized lane when `MODEL_BASE_URL_GAME` is unset (the default). The cost/benefit of running them together
vs. separate + base recommendations live in `docs/LANES.md`. [AGENCY: code-fixed — serving plumbing.]

### Heartbeats: one clock PER LANE
Each lane has its own free-running heartbeat with its own cadence env var: the **chat heartbeat**
(`AGENT_CHAT_HEARTBEAT_MS`) runs the self triage (reflect/reach-out) on the chat lane; the **game heartbeat**
(`AGENT_GAME_HEARTBEAT_MS`) offers a voluntary play pass on the game lane (only when `GAME_OPEN_URL` is set).
Both fall back to `AGENT_HEARTBEAT_MS`. Previously a single chat-lane heartbeat did triage and escalated into
game on engage; splitting gives each lane an independent clock and keeps each lane's KV cache warm with its
own tick type. The agent still chooses within each tick (engage or pass); the code only sets the cadence and
offers the opportunity. [AGENCY: code-fixed — cadence/plumbing; the choice each tick stays the agent's.]

### Owner identity generalized to `AGENT_OWNER_NAME`
The human is referred to generically and the display name is `AGENT_OWNER_NAME` (default "the user"). No
facts about any specific person are baked into the prompt or tooling.
