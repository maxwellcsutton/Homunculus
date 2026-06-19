# Model serving

One LOCAL model, served by `llama.cpp`'s `llama-server` on an OpenAI-compatible endpoint. No hosted API.
The app never manages thinking — reasoning depth is bounded **server-side** via `--reasoning-budget`. The
client is `src/model/client.ts`; the validated serving config is baked into `scripts/serveModel.ts`.

## Lanes (chat base + optional game lane)

The agent's primary work is playing, so the **game lane** is the primary work lane; the **chat lane** is the
required base. The default is a **single instance** (the game lane falls back to chat). Optionally add more
instances so a long pass never evicts chat's warm cache — the full **cost/benefit + recommendations** are in
`docs/LANES.md`:

| lane  | env                    | serves                                          |
|-------|------------------------|-------------------------------------------------|
| chat  | `MODEL_BASE_URL`       | user chat turns + chat/self heartbeat (required, kept warm) |
| game  | `MODEL_BASE_URL_GAME`  | game passes + idle cognition (optional 2nd instance — the primary work) |
| embed | `AGENT_EMBED_URL`      | semantic de-dup (optional)                      |
| vision| `VISION_BASE_URL`      | image → text captions (optional)                |

If `MODEL_BASE_URL_GAME` is unset, the game lane falls back to the chat lane and everything serializes
(`src/loop/queue.ts`, `lock.ts`). Lane→URL resolution is a tiny registry in `src/model/index.ts` — to add a
THIRD main lane, add a case there and extend the `Lane` type in `queue.ts`.

**Why separate instances, not slots:** id_slot pinning DISABLES prefix-cache reuse on this llama.cpp build
(every pinned request cold-prefills). So KV isolation between lanes is done by separate llama-server
PROCESSES, each pointed at by its own `MODEL_BASE_URL_*`. Run two `serveModel` instances on different ports.

## The flags that matter (`scripts/serveModel.ts`, all env-gated)

- **`-np 1` (single slot).** A multi-slot single server scatters chat across cold slots → a full base
  re-prefill every message. One slot = one warm prefix.
- **Reasoning bounded.** `-rea on` + `--reasoning-budget` (default 2048) kept well below `MODEL_MAX_TOKENS`
  (default 5120), or a runaway `<think>` eats the budget and emits an EMPTY answer. The game lane can use a
  separate budget (`LLAMA_REASONING_BUDGET_GAME`) — it's applied only on the instance whose port matches
  `MODEL_BASE_URL_GAME`.
- **DRY sampler** (chat lane only) — the real fix for verbatim/near-verbatim repeat loops. `LLAMA_DRY_*`.
- **Sampler order** — for Qwen reasoning models, penalties-before-temperature can cause endless generation.
  `LLAMA_SAMPLERS="top_k;top_p;min_p;temperature;dry;penalties"` moves temperature ahead. Empty = stock.
- **KV dtype f16** on Apple Metal (quantizing KV adds per-token dequant work there); q8_0 can help on CUDA.
- **`--cpu-moe`** offloads MoE experts to CPU — needed on low-VRAM GPUs, cripples a big unified-memory Mac.

## Client tuning (per-request, `src/model/index.ts`)
`MODEL_TEMPERATURE` (chat) / `MODEL_TEMPERATURE_GAME`, `MODEL_TOP_P`, `MODEL_TOP_K`, `MODEL_MAX_TOKENS`,
`MODEL_MAX_TOKENS_GAME`. Model id: `MODEL_NAME`.
