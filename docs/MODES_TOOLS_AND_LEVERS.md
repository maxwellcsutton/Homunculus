# Modes, tools, and tuning levers

A living reference for **what each cognition mode sees and can do**, **every lever that tunes it**, and a
**change-log template** to track your own adjustments and their effect over time. Update this whenever a
lever moves. Token sizes are intentionally omitted — measure them on your own model (`scripts/heartbeat.ts`
and the prompt builders are the places to instrument).

Cross-refs: `docs/ARCHITECTURE.md` (the loop), `docs/PROMPT_LAYERING.md` + `docs/WARM_BASE_CACHING.md`
(prompt composition), `docs/MODEL_SERVING.md` (lanes + flags), `docs/LANES.md` (game vs chat lane: together
vs separate), `docs/GAME_TYPES.md` (which games fit + the game-pass levers). The agency invariant (`CLAUDE.md`
Principle 0) governs all of this: levers set *when* and
*whether* the agent gets the opportunity to act; they never decide *what* it does.

Last updated: **2026-06-18**.

---

## 1. Modes at a glance

One unified loop (`src/loop/engine.ts`) runs every mode. There are two engine modes (`ModeName = "chat" |
"game"`) and, within the idle/heartbeat path, three cognition *passes* (triage, reflect, reach-out) that all
run as the `chat` mode. Lanes keep KV caches isolated via **separate `llama-server` processes** (id_slot
pinning breaks prefix caching on this build — see `src/model/index.ts`, and `docs/LANES.md` for the
together-vs-separate tradeoffs):

- **game lane** (the primary work lane) — `MODEL_BASE_URL_GAME` (e.g. `:8081`). **Game passes** — their tool
  catalog renders at the front of the prompt and shares no prefix with chat. Optional; unset → falls back to
  the chat lane (single instance, fully serialized).
- **chat lane** (the required base lane) — `MODEL_BASE_URL` (e.g. `:8080`). Real user chat **and** all idle
  self-cognition (triage/reflect/reach-out). They share the same base + chat tool prefix, so they extend one
  warm prefix rather than poisoning it.

| Mode / pass | Lane | When | Context (tail) | Warm history | Tools | Output |
|---|---|---|---|---|---|---|
| **Chat** | chat | the user sends a message | `selfTail` (self-image/opinions/focus/felt-state/current-moment + memory diff + time) | yes (`AGENT_HISTORY_MAX`) | chat self-set (14) | the reply, delivered |
| **Triage** (chat heartbeat tier-1) | chat | every chat heartbeat (`AGENT_CHAT_HEARTBEAT_MS`) | `renderIdleContext` (delta since last tick + priorities + felt state + time) | none | chat self-set | `engage` or pass (internal) |
| **Reflect** | chat | `engage("reflect")` / periodic fallback | `# Reflection` + self-image + opinions + felt state + last 5 reflections | none | chat self-set | journal / reweigh / revise (no message) |
| **Reach-out** | chat | `engage("social")` | `# Reaching out` + last 12 chat turns | none | chat self-set | `message_user` (rail-bounded) |
| **Game pass** | game | game event / game heartbeat (`AGENT_GAME_HEARTBEAT_MS`) / `engage("game")` | `buildGameTail` + game snapshot (`# Now …`) | none | game self-set + remote game catalog | game actions (remote exec) |

Temperature is **lane-split**: chat lane `MODEL_TEMPERATURE`, game lane `MODEL_TEMPERATURE_GAME`.

---

## 2. Per-mode detail

### Bases
- **Warm base** (`STATIC_HEAD` + the full memory list + closing; `src/prompt/staticBase.ts`,
  `baseSnapshot.ts`) is **byte-identical across every mode**, so chat and game share the cached prefix even
  when they interleave on one instance. It's frozen and served verbatim until a rebake; volatile self-state
  rides the per-turn tail, never the base (`docs/WARM_BASE_CACHING.md`).
- **Game guidance** (`GAME_GUIDANCE`, `src/prompt/gameTail.ts`) is appended to the game base **only when a
  distinct game lane is configured** (`MODEL_BASE_URL_GAME` set) — so a single shared instance stays lean.
  The game-situational framing + run-state ride the volatile game tail, not the cached base.

### Tools per mode (resolved live from each tool's `modes` field; `src/tools/index.ts`)
- **Chat self-set** (`chatSelfTools()`, used by chat + triage + reflect + reach-out): `remember`, `forget`,
  `recall`, `recall_images`, `private_journal`, `current_moment`, `reweigh_focus`, `tend_self`,
  `revise_self_image`, `form_opinion`, `revise_opinion`, `drop_opinion`, `message_user`, **+ `engage`**
  (added explicitly; kept out of the general registry so it can't leak into a normal turn). **14 tools.**
- **Game self-set** (`gameLaneTools()`, `src/game/lane.ts`): the game-mode local self tools — `remember`,
  `forget`, `recall`, `write_journal`, `current_moment`, `post_progress`, `form_opinion`, `revise_opinion`,
  `drop_opinion` — **plus the frozen remote game-mechanical catalog**. Assembled from the *frozen* catalog
  (not a per-event one) so the tool prefix is byte-stable and the game lane stays warm. On a name collision
  the **local tool wins** (the agent's self-state belongs in the shared store, not the game DB).

### Context / delivery notes
- **Chat** is the only mode with **warm conversation history** and the only one that **delivers a message to
  the user**. The agent's turn is persisted **before** delivery (ordering/race fix; `docs/ENGINEERING_LESSONS.md`).
- **Triage** is a lean decision capped at `maxSteps: 4`; the common outcome is *pass*. The code surfaces the
  menu + the capacity to choose and never reads the priority weights to decide for the agent.
- **Reflect** & **Reach-out** build their own focused user-turn (no warm history). Reach-out is rail-bounded
  (feature flag / quiet hours / cooldown can hold the message).
- **Game** runs the remote mechanical tools against a live session, bounded by the session (`maxSteps`,
  `wallClockMs`, default `forceFirstTool: true` on a voluntary pass). See `docs/GAME_TYPES.md`.

---

## 3. Tuning levers

**apply:** `model` = restart the model server(s) (`npm run model`, or the launchd `*.model` job via
`deploy/deploy.sh model`) — server flags. `app` = restart the app (`npm run dev`, or `deploy/deploy.sh
app`) — runtime env. `rebake` = `npm run rebake` (or the periodic rebake) — anything baked into the base.
`code` = source edit + rebuild/restart.

### Serving — per-lane `llama-server` flags (`scripts/serveModel.ts`) · apply: **model**
| Lever | env | default | affects | notes |
|---|---|---|---|---|
| Reasoning budget (chat lane) | `LLAMA_REASONING_BUDGET` | 2048 | chat + idle cognition | more = deeper thinking, slower replies. Keep well below `MODEL_MAX_TOKENS`. |
| Reasoning budget (game lane) | `LLAMA_REASONING_BUDGET_GAME` | 2048 | game passes | honored only by the instance whose port matches `MODEL_BASE_URL_GAME`. |
| Reasoning on/off | `LLAMA_REASONING` | `on` | all | **don't turn off** — this model class leaks tool intent as text without a `<think>` block. |
| DRY sampler | `LLAMA_DRY_MULTIPLIER` (+ `_BASE`/`_ALLOWED_LENGTH`/`_PENALTY_LAST_N`) | 0.8 | chat lane only | the real fix for verbatim/near-verbatim loops; auto-off on the game lane. |
| Sampler chain order | `LLAMA_SAMPLERS` | unset (stock) | chat lane only | stock applies penalties/dry *before* temperature → documented "endless generation" on Qwen reasoning models. A/B: `top_k;top_p;min_p;temperature;dry;penalties`. |
| Freq / presence / repeat penalty | `LLAMA_FREQUENCY_PENALTY` / `_PRESENCE_PENALTY` / `_REPEAT_PENALTY` / `_REPEAT_LAST_N` | 0.25 / 0 / 1.0 / 256 | all | gentle; can't stop a *reworded* loop (the engine re-say guard does that). |
| KV cache dtype | `LLAMA_CACHE_TYPE_K` / `_V` | f16 | all | keep f16 on Apple Metal; q8_0 can help at depth on CUDA. |
| MoE CPU offload | `LLAMA_CPU_MOE` | on (`1`) | all | set `0` on a big unified-memory machine where every layer fits on GPU (offload *cripples* it there). |
| Context window | `LLAMA_CTX` | 131072 | all | |
| Slots | `LLAMA_NP` | 1 | all | **keep 1.** Multi-slot scatters chat across cold slots → a re-prefill every message. For lanes, run separate instances. |

### Client — per-request sampler values (`src/model/index.ts`) · apply: **app**
| Lever | env | shipped (`.env.example`) | affects | notes |
|---|---|---|---|---|
| Temperature (chat) | `MODEL_TEMPERATURE` | 0.6 | chat + idle cognition | code fallback 0.3 if unset. |
| Temperature (game) | `MODEL_TEMPERATURE_GAME` | 0.45 | game passes | pins game tool-determinism independent of chat-temp experiments; falls back to `MODEL_TEMPERATURE`. |
| max_tokens (chat + idle) | `MODEL_MAX_TOKENS` | 5120 | chat, triage, reflect, reach-out | TOTAL output (reasoning + answer) — must exceed the reasoning budget. |
| max_tokens (game) | `MODEL_MAX_TOKENS_GAME` | unset | game passes | widens the game budget only (multi-step passes reason a lot); unset → uses `MODEL_MAX_TOKENS`. |
| top_p | `MODEL_TOP_P` | 0.92 | all | looser = more variety; code fallback 0.8. |
| top_k | `MODEL_TOP_K` | 40 | all | candidate-count cap; code fallback 20. |
| Model name | `MODEL_NAME` | qwen3.6 | all | the served model id. |

> max_tokens must comfortably exceed the reasoning budget, or a long `<think>` eats the whole turn and emits
> no visible answer (`docs/ENGINEERING_LESSONS.md`).

### History / base composition · apply: **app + rebake** (baked → rebake)
| Lever | env / where | default | affects | notes |
|---|---|---|---|---|
| History window | `AGENT_HISTORY_MAX` | 10 | chat | rolling chat turns fed into a chat/triage tick. |
| Rebake cadence | `AGENT_REBAKE_MS` | 3600000 (1h) | base warmth | periodic re-fold of the day's identity edits into a fresh frozen base. |
| Owner display name | `AGENT_OWNER_NAME` | "the user" | all (baked) | edit + rebake. |
| Static prose / persona seed | code (`src/prompt/staticBase.ts`) | neutral | all (baked) | extend `STATIC_HEAD` to seed a character; edit + rebake. Ships blank by design. |

### Anti-repeat / dedup (chat delivery) · apply: **app**
| Lever | env / where | default | affects | notes |
|---|---|---|---|---|
| Lexical dedup threshold | `AGENT_DEDUP_THRESHOLD` | 0.7 | chat re-say guard | word-overlap floor (`src/loop/textSimilarity.ts`). |
| Semantic dedup threshold | `AGENT_SEMANTIC_DEDUP_THRESHOLD` | 0.80 | chat re-say guard | embedding-cosine ≥ this = a re-say; catches rewordings (needs the embedding lane, `AGENT_EMBED_URL`). |
| Re-say lookback | `AGENT_RESAY_LOOKBACK` | 3 | chat re-say guard | how many recent agent turns to compare against (`src/loop/resay.ts`). |

### Proactive outreach (reach-out rails) · apply: **app**
| Lever | env | default | affects | notes |
|---|---|---|---|---|
| Proactive enabled | `AGENT_PROACTIVE_ENABLED` | 0 (off) | reach-out | master flag; off → the agent never messages unprompted (still answers when messaged). |
| Active hours | `AGENT_ACTIVE_START` / `AGENT_ACTIVE_END` | 8 / 23 | reach-out | quiet-hours window for unprompted messages. |
| Reach-out cooldown | `AGENT_REACHOUT_COOLDOWN_MS` | 5400000 (1.5h) | reach-out | soft cooldown between unprompted reach-outs. |

### Heartbeat / cognition cadence (one clock PER LANE) · apply: **app**
Each lane runs its own heartbeat on its own cadence (see `docs/LANES.md`). Both per-lane vars fall back to
`AGENT_HEARTBEAT_MS` (one shared cadence) when unset. Cadence is plumbing — never the decision.
| Lever | env / where | default | affects | notes |
|---|---|---|---|---|
| Shared heartbeat default | `AGENT_HEARTBEAT_MS` | 60000 (60s) | both lanes' fallback | the default for both per-lane clocks below. |
| Chat heartbeat | `AGENT_CHAT_HEARTBEAT_MS` | = `AGENT_HEARTBEAT_MS` | chat-lane triage (reflect/reach-out) | the agent's self/inner-life clock. |
| Game heartbeat | `AGENT_GAME_HEARTBEAT_MS` | = `AGENT_HEARTBEAT_MS` | game-lane voluntary play | the agent's play clock; only runs when `GAME_OPEN_URL` is set. Tune to the game's pace (`docs/GAME_TYPES.md`). |
| Reflect fallback cadence | `AGENT_REFLECT_EVERY_TICKS` | 60 | chat heartbeat | every Nth chat tick a reflect supersedes the triage. |
| Triage steps | `maxSteps` (heartbeat, `src/loop/heartbeat.ts`) | 4 | tier-1 triage | lean decision cap. |
| Game pass steps / wall-clock | `maxSteps` / `wallClockMs` (game session) | 40 / 120000 | game passes | per-pass soft caps; a game event may also set these. |

### Model lanes (extra) · apply: **app + model**
| Lever | env | default | affects | notes |
|---|---|---|---|---|
| Game lane URL | `MODEL_BASE_URL_GAME` | unset | game passes + idle cognition | a 2nd instance so a long game pass never evicts the chat lane's warm KV. Unset → shared single lane. See `docs/LANES.md`. |
| Embedding lane | `AGENT_EMBED_URL` / `AGENT_EMBED_MODEL` | unset | semantic dedup | a side `llama-server --embeddings`; unset → dedup is lexical-only. |
| Vision lane | `VISION_BASE_URL` / `VISION_MODEL` (+ `VISION_MAX_*`) | unset | image/frame captioning | turns a non-text game into a text snapshot; unset → attachments aren't described. |

---

## 4. Change log — adjustments & performance

Track your own tuning here, newest first. **Status legend:** ✅ live · 🧪 trial (watching) · ↩︎ reverted.
Fill **Result** as evidence comes in. Recording each move (lever, why, how applied, what happened) is what
makes the levers above legible over time.

| Date | Change | Modes | Why | Apply | Status | Result / notes |
|---|---|---|---|---|---|---|
| _YYYY-MM-DD_ | _e.g. heartbeat 60s → 30s for an idle game_ | _triage_ | _reason_ | _app_ | _🧪_ | _what you observed_ |

---

## 5. Operations — maintenance scripts

All run from the repo root; they read `DATABASE_URL` + `AGENT_*` from `.env` and act on the **live**
identity DB. Effects are picked up on the agent's next turn (the app reads the DB live) — no app restart
unless noted.

### Rebake the base now — `npm run rebake` (`scripts/rebake.ts`)
Re-freeze the static prose + memory + recent turns into a fresh active snapshot, so mid-day prose/identity
edits don't wait for the periodic rebake. Run after editing `staticBase.ts` or `AGENT_OWNER_NAME`.

### Run a heartbeat tick manually — `npm run heartbeat` (`scripts/heartbeat.ts`)
Fire a single triage tick by hand (debugging the idle path without waiting for the interval).

### Back up the identity store — `npm run backup` / `npm run backup:verify` (`scripts/backup.ts`)
Dump the Postgres identity DB (the irreplaceable part). Optional age-encryption + rclone push via
`AGE_RECIPIENT` / `RCLONE_REMOTE`. Rehearse a restore on a clone before you need it.
