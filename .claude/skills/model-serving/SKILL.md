---
name: model-serving
description: Playbook for serving the local model and tuning llama.cpp for homunculus — lanes (chat/game/embed/vision), the validated serving flags, KV-cache warmth, reasoning budget, and anti-loop samplers. Use when starting/configuring the model servers, adding a second lane, debugging cold prefills / empty answers / repeat loops, or tuning latency.
---

# Model serving + llama.cpp tuning

One LOCAL model via `llama.cpp` `llama-server`, OpenAI-compatible. No hosted API. Full reference:
`docs/MODEL_SERVING.md`. Config is baked into `scripts/serveModel.ts` (env-overridable); the client is
`src/model/client.ts`; lane→URL selection is `src/model/index.ts`.

## Start it
```
npm run model     # chat lane (LLAMA_PORT, default 8080) → MODEL_BASE_URL
npm run embed     # optional embedding lane → AGENT_EMBED_URL (semantic de-dup)
npm run vision    # optional VL lane → VISION_BASE_URL (image captions)
```
Set `LLAMA_MODEL_PATH` + `LLAMA_SERVER_BIN` in `.env` first. A second "game" lane = run `serveModel` again
on another port and set `MODEL_BASE_URL_GAME` (the primary work lane — see `docs/LANES.md`).

## The flags that matter (and why)
- **`-np 1`** — single slot. >1 on one instance scatters chat across cold slots → full base re-prefill
  every message. Lane isolation = separate PROCESSES, not slots (id_slot pinning breaks prefix caching).
- **`--reasoning-budget` (2048) < `MODEL_MAX_TOKENS` (5120)** — or a runaway `<think>` eats the budget and
  emits an EMPTY answer. The work instance honors `LLAMA_REASONING_BUDGET_GAME` (matched by port).
- **DRY sampler** (`LLAMA_DRY_*`, chat lane) — the real fix for verbatim repeat loops.
- **Sampler order** (`LLAMA_SAMPLERS`) — for Qwen reasoning models, `top_k;top_p;min_p;temperature;dry;penalties`
  (temperature first) stops "endless generation". Empty = stock order.
- **`-ctk/-ctv f16`** on Apple Metal; **`--cpu-moe`** only on low-VRAM GPUs (cripples a big unified-memory Mac).

## Diagnosing
| symptom | likely cause | lever |
|---|---|---|
| every chat turn slow (full re-prefill) | base bytes changed, or `-np`>1, or a different lane poisoned the slot | keep base byte-stable (`docs/WARM_BASE_CACHING.md`); `-np 1`; run a separate work instance |
| empty final reply | reasoning ate the budget | raise `MODEL_MAX_TOKENS` / lower `--reasoning-budget` |
| repeats the same sentence | repeat loop | DRY on; check sampler order; the engine's re-say guard is the phrasing-independent backstop |
| tool intent shows up as text | format adherence under loose sampling | the engine's text-tool recovery handles a scoped set; tighten temp if widespread |

Turn on `AGENT_DEBUG_PREFIX=1` to log a hash of the tools+system prefix per call — if it flaps between
same-source turns, the prefix is non-deterministic (the cold-prefill cause). Telemetry (`[model] …`) reports
prefill/decode tokens + cached-hit per call.
