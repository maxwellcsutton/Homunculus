# Lanes — game lane + chat lane: together vs. separate

The agent runs on **two model lanes**. The lane is just which `llama-server` instance a pass is routed to;
the split exists because tools render at the *front* of the prompt, so a game prompt and a chat prompt share
no cached prefix — interleaving them on one instance throws away the warm KV cache (`docs/WARM_BASE_CACHING.md`).

- **Game lane** — the **primary work lane**. Carries game passes **and** all idle cognition (the game
  heartbeat, reflect, game-engage, rebake). Env: `MODEL_BASE_URL_GAME` / `MODEL_TEMPERATURE_GAME`. It is the
  conceptual center of gravity because the agent's whole purpose is to *play*.
- **Chat lane** — the **required base lane**. Carries real user chat turns (a person is waiting) and the
  chat/self heartbeat (triage → reflect/reach-out). Env: `MODEL_BASE_URL` (always set).

Architecturally the **chat lane is the required base** and the **game lane is optional and falls back to
it**: if `MODEL_BASE_URL_GAME` is unset, both lanes resolve to the one `MODEL_BASE_URL` instance. (The
naming says "game-primary"; the fallback stays on chat so a minimal setup is one instance with zero extra
config — see `docs/DECISIONS.md`.)

---

## Together (one instance) vs. separate (two instances)

"Together" = leave `MODEL_BASE_URL_GAME` unset; both lanes share the single `MODEL_BASE_URL` server, and
all work is **fully serialized** through one queue + lock. "Separate" = point `MODEL_BASE_URL_GAME` at a
second `llama-server` instance; the lanes get **independent KV caches + queues + locks** and run concurrently.

| | **Together (1 instance)** | **Separate (2 instances)** |
|---|---|---|
| **Memory / VRAM** | ✅ one model in memory | ❌ two instances (~2× — unless the game lane runs a smaller model) |
| **Setup** | ✅ simplest — one server, no extra env | ❌ two servers to launch + monitor |
| **Cache warmth** | ❌ chat and game evict each other's prefix on every interleave → cold re-prefills | ✅ each lane stays warm independently |
| **Concurrency** | ❌ a long game pass *blocks* a chat turn (serialized) — the user waits | ✅ chat runs concurrently with a game pass; neither waits |
| **Per-lane tuning** | ⚠️ one model / temp / reasoning budget for both | ✅ independent model, temperature, reasoning budget per lane |
| **Best when** | you mostly do one thing (mostly play, or mostly chat) | you interleave playing and chatting and care about latency |

Two ways to run "separate": **same GGUF twice** (identical behavior, ~2× memory, simplest) or **a smaller/
faster model on one lane** (cut memory or latency where quality matters less — usually a lean game lane, or
a lean chat lane if chat is incidental). Serving flags + the `-np 1` rule: `docs/MODEL_SERVING.md`.

Per-lane heartbeats apply **either way**: `AGENT_GAME_HEARTBEAT_MS` and `AGENT_CHAT_HEARTBEAT_MS` set each
lane's own clock (both default to `AGENT_HEARTBEAT_MS`). On a single instance the two heartbeats still
serialize on the one server; on two instances they tick truly independently.

---

## Base recommendations — pick by what you care about most

### 1. You primarily care about the **game** → game lane primary, chat lane optional
Run a **single instance** and treat it as the game lane. The agent mostly plays, so the game prefix stays
warm; occasional chat costs a re-prefill you don't care about. Don't pay for a second model. Tune the game
heartbeat to the game's pace (`docs/GAME_TYPES.md`).
```bash
# one instance; game lane falls back to it. Tune the play clock; let chat be occasional.
MODEL_BASE_URL="http://127.0.0.1:8080/v1"
MODEL_BASE_URL_GAME=            # unset → single instance
AGENT_GAME_HEARTBEAT_MS=30000   # e.g. brisk play cadence for an idle game
AGENT_CHAT_HEARTBEAT_MS=120000  # self/reach-out can tick slowly
```

### 2. You primarily care about **response times** → two lanes (separate instances)
Run **two instances** so a chat turn never queues behind a long game pass and never eats a cold prefill from
game interleaving — and a game pass never stalls waiting on chat. This is the latency-optimal setup. Put a
**smaller/faster model on the game lane** if memory is tight; keep the strong model on chat.
```bash
MODEL_BASE_URL="http://127.0.0.1:8080/v1"        # chat lane (strong model, warm)
MODEL_BASE_URL_GAME="http://127.0.0.1:8081/v1"   # game lane (2nd instance)
MODEL_TEMPERATURE_GAME=0.45                       # pin game tool-determinism independently
# both heartbeats tick concurrently on their own instances
```

### 3. You primarily care about **chatting about the game** → two lanes, biased toward chat
Run **two instances** as well, but bias resources toward the **chat lane**: the strong/large model and the
warm cache go to chat (the conversation is the point), and the game lane gets the **smaller/faster** model
since play is in service of the chat. Keep the chat heartbeat lively and let the game tick steadily in the
background.
```bash
MODEL_BASE_URL="http://127.0.0.1:8080/v1"        # chat lane → the BIG model, kept warm
MODEL_BASE_URL_GAME="http://127.0.0.1:8081/v1"   # game lane → a smaller/faster model
AGENT_CHAT_HEARTBEAT_MS=30000                     # responsive self/reach-out
AGENT_GAME_HEARTBEAT_MS=90000                     # play ticks along in the background
```

---

## Rules of thumb
- **One instance is the floor**, not a downgrade — it's the right call whenever you mostly do one thing.
- **Two instances buy concurrency + warmth, at the cost of memory.** Only worth it if you actually interleave
  play and chat and feel the latency.
- **`-np 1` per instance, always** — lane isolation is separate *processes*, never slots on one server
  (`docs/MODEL_SERVING.md`).
- **The lane split is plumbing.** It changes *when/where* a pass runs, never *what* the agent does — that
  stays the agent's own state (`CLAUDE.md`, the agency invariant).
