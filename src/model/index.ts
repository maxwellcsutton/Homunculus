import { createLocalModelClient, type ModelClient } from "./client";
import type { Lane } from "@/loop/queue";

export type { ModelClient, ChatRequest, ChatResponse } from "./client";
export { createLocalModelClient } from "./client";

// Per-lane KV ISOLATION via separate llama-server PROCESSES. Because id_slot pinning breaks prefix
// caching on this llama.cpp build (see client.ts), the way to keep the lanes from poisoning each other —
// their prompts share NO common prefix, since tools render at the FRONT of the prompt — is to point each
// lane at its OWN llama-server instance:
//   game  lane → MODEL_BASE_URL_GAME     (e.g. :8081) — game passes + idle cognition (the primary work)
//   chat  lane → MODEL_BASE_URL          (e.g. :8080) — only ever sees chat-tool prompts → stays warm
// The chat lane (MODEL_BASE_URL) is the REQUIRED base; the game lane is OPTIONAL and falls back to it when
// MODEL_BASE_URL_GAME is unset (single instance; fully serialized). See docs/LANES.md for the tradeoffs.
//
// This is a small registry: to add a THIRD main lane, add a case here and extend the Lane type in
// queue.ts. (See docs/MODEL_SERVING.md "lanes".)
function laneBaseUrl(lane: Lane): string {
  const chat = process.env.MODEL_BASE_URL ?? "http://127.0.0.1:8080/v1";
  if (lane === "game") return process.env.MODEL_BASE_URL_GAME ?? chat;
  return chat;
}

// Temperature is the one sampler VALUE the app sends per request (order / penalties / DRY are server flags
// in scripts/serveModel.ts). Lane-split: MODEL_TEMPERATURE is the base (chat); MODEL_TEMPERATURE_GAME
// overrides the GAME lane (game + idle cognition) when set, else the game lane falls back to the base.
function laneTemperature(lane: Lane): number {
  if (lane === "game" && process.env.MODEL_TEMPERATURE_GAME) return Number(process.env.MODEL_TEMPERATURE_GAME);
  return Number(process.env.MODEL_TEMPERATURE ?? "0.3");
}

// Default local client from env, for the given lane's llama-server. Reasoning is bounded server-side
// (--reasoning-budget), so the app sets no thinking controls — but max_tokens is the TOTAL output budget
// (reasoning + answer), so it must comfortably exceed the server's reasoning-budget or a rambling <think>
// eats the whole turn and emits no visible answer. Default 5120 leaves ~3K for the answer past a 2048
// reasoning budget. `overrides.maxTokens` lets a specific caller widen that budget (see gameMaxTokens).
export function defaultModelClient(lane: Lane = "chat", overrides?: { maxTokens?: number }): ModelClient {
  return createLocalModelClient({
    baseUrl: laneBaseUrl(lane),
    model: process.env.MODEL_NAME ?? "qwen3.6",
    temperature: laneTemperature(lane),
    maxTokens: overrides?.maxTokens ?? Number(process.env.MODEL_MAX_TOKENS ?? "5120"),
    topP: Number(process.env.MODEL_TOP_P ?? "0.8"),
    topK: Number(process.env.MODEL_TOP_K ?? "20"),
  });
}

// Game build passes reason a LOT (multi-step decisions), so the shared default budget can leave too little
// room for the visible answer past the reasoning budget — the failure mode that emits an EMPTY final reply.
// MODEL_MAX_TOKENS_GAME widens the TOTAL budget for game passes ONLY; unset → callers fall back to the
// global MODEL_MAX_TOKENS default. Pure capacity rail, not behavior.
export function gameMaxTokens(): number | undefined {
  const v = process.env.MODEL_MAX_TOKENS_GAME;
  return v ? Number(v) : undefined;
}
