import { createHash } from "node:crypto";
import type { ResolvedTool } from "@/tools/resolved";
import type { ToolCall } from "@/loop/types";
import { telemetryEnabled, tlog, ms, rate } from "@/loop/telemetry";

// PREFIX DEBUG (AGENT_DEBUG_PREFIX=1): the warm KV cache only reuses a prompt's PREFIX, and on this
// build the tools block renders at the FRONT, so the prefix = tools + system. If a chat turn cold-
// prefills the whole base, its prefix must have changed vs the prior turn. This logs a hash of the tools
// block and the system message per call: if `tools=`/`sys=` flaps between consecutive same-source turns,
// the prefix is non-deterministic; if it's stable but still cold, the slot was evicted.
const h8 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);
function logPrefix(messages: WireMessage[], tools: unknown[]): void {
  if (process.env.AGENT_DEBUG_PREFIX !== "1" || !telemetryEnabled()) return;
  const sys = messages.find((m) => m.role === "system");
  const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
  tlog(`[prefix] tools=${h8(JSON.stringify(tools))}(${tools.length}) sys=${h8(sysText)} msgs=${messages.length}`);
}

// llama-server's JSON parser (nlohmann/json) REJECTS lone UTF-16 surrogates with a 500, which kills the
// whole turn. They arise when a CODE-UNIT string slice cuts an emoji's surrogate pair in half. Scrub any
// unpaired surrogate to U+FFFD at THIS boundary so no upstream slice can ever 500 a turn. This must run
// DURING serialization via a replacer (the replacer sees raw code units before escaping), NOT on the
// output of JSON.stringify (which escapes a lone surrogate to literal `\udXXX` text).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function serializeBody(body: unknown): string {
  return JSON.stringify(body, (_key, value) =>
    typeof value === "string" ? value.replace(LONE_SURROGATE, "�") : value,
  );
}

// llama.cpp returns a non-standard `timings` block (and OpenAI `usage`) on its chat-completions response
// — the source for prefill/decode token counts + rates. `usage.prompt_tokens` is the FULL prompt size;
// `timings.prompt_n` is only the tokens actually evaluated, so the difference is the warm-cache hit (KV
// reused) — exactly the prefill-savings signal we want to see per turn.
interface LlamaTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
}
interface LlamaUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

// One concise line per model call: TTFT (stream only), prefill (tokens/time/rate + cached hit), decode
// (tokens/time/rate), and wall. Missing fields degrade gracefully (a server that omits timings, or a mock).
function logModelCall(
  kind: string,
  ttftMs: number | null,
  wallMs: number,
  t?: LlamaTimings,
  u?: LlamaUsage,
): void {
  if (!telemetryEnabled()) return;
  const parts: string[] = [`[model] ${kind}`];
  if (ttftMs !== null) parts.push(`ttft=${ms(ttftMs)}`);
  if (t?.prompt_n !== undefined) {
    let pf = `prefill ${t.prompt_n}tok/${ms(t.prompt_ms)} (${rate(t.prompt_n, t.prompt_ms, t.prompt_per_second)})`;
    const cached = u?.prompt_tokens !== undefined ? u.prompt_tokens - t.prompt_n : undefined;
    if (cached !== undefined && cached > 0) pf += `, cached ${cached}/${u!.prompt_tokens}`;
    parts.push(pf);
  }
  if (t?.predicted_n !== undefined) {
    parts.push(
      `decode ${t.predicted_n}tok/${ms(t.predicted_ms)} (${rate(t.predicted_n, t.predicted_ms, t.predicted_per_second)})`,
    );
  }
  parts.push(`wall=${ms(wallMs)}`);
  tlog(parts.join(" · "));
}

// Local-native model client: an OpenAI-compatible chat-completions endpoint served by llama-server. No
// hosted-cache or Anthropic-marshaling layer. Reasoning depth is bounded server-side via
// `--reasoning-budget` — the app does not manage thinking.

interface OpenAIToolCall {
  id?: string;
  type?: "function";
  function: { name: string; arguments?: string };
}
interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

// Messages in OpenAI wire shape. The engine owns conversion from our Message union.
export type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatRequest {
  messages: WireMessage[];
  tools: ResolvedTool[];
  toolChoice?: "auto" | "required" | "none";
  // Desired llama.cpp slot/lane. Only forwarded when the server runs with >1 parallel slot; single-slot
  // servers ignore it. (See the id_slot note in createLocalModelClient — KV isolation is done by separate
  // PROCESSES, not id_slot, because id_slot pinning breaks prefix caching on this llama.cpp build.)
  idSlot?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  // finish_reason === "length": the generation hit max_tokens — a runaway / truncated reply. A legit chat
  // reply never hits the cap; the async chat-tick drops such a reply so a degenerate blob never reaches
  // the user.
  truncated?: boolean;
}

export interface StreamCallbacks {
  // Called for each user-facing content delta (NOT reasoning_content, which stays private).
  onContent?: (delta: string) => void;
}

export interface ModelClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
  // Optional streaming variant: streams content deltas via cb.onContent while accumulating, and resolves
  // with the same ChatResponse shape once the turn completes. Engines fall back to chat() when absent.
  chatStream?(req: ChatRequest, cb: StreamCallbacks): Promise<ChatResponse>;
}

export interface LocalModelConfig {
  baseUrl: string; // e.g. http://127.0.0.1:8080/v1
  model: string; // served model id, e.g. "qwen3.6"
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  parallelSlots?: number;
}

function toOpenAITool(t: ResolvedTool) {
  return {
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

export function createLocalModelClient(cfg: LocalModelConfig): ModelClient {
  const {
    baseUrl,
    model,
    temperature = 0.3,
    topP = 0.8,
    topK = 20,
    maxTokens = 4096,
    parallelSlots = 1,
  } = cfg;

  // We DO NOT send `id_slot`. Empirically, on this llama.cpp build, specifying id_slot DISABLES
  // prefix-cache reuse: every pinned request cold-prefills the whole prompt. llama-server's automatic
  // prefix-similarity routing is what keeps a slot warm. KV ISOLATION between lanes is therefore done by
  // separate llama-server PROCESSES (per-lane MODEL_BASE_URL_*), not id_slot. `idSlot`/`parallelSlots`
  // are kept in the type for future builds but intentionally unused here.
  void parallelSlots;
  const laneOf = (_idSlot?: number): Record<string, never> => ({});

  return {
    async chat({ messages, tools, toolChoice, idSlot }) {
      const body = {
        model,
        messages,
        tools: tools.map(toOpenAITool),
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
        top_k: topK,
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...laneOf(idSlot),
      };
      logPrefix(messages, body.tools);
      const t0 = performance.now();
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(body),
      });
      if (!res.ok) {
        throw new Error(`model http ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as {
        choices: { message: OpenAIMessage; finish_reason?: string }[];
        timings?: LlamaTimings;
        usage?: LlamaUsage;
      };
      logModelCall("sync", null, performance.now() - t0, json.timings, json.usage);
      const choice = json.choices[0];
      const msg = choice?.message;
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c, i) => ({
        id: c.id ?? `call_${i}`,
        name: c.function.name,
        args: parseArgs(c.function.arguments),
      }));
      return { content: msg?.content ?? null, toolCalls, truncated: choice?.finish_reason === "length" };
    },

    async chatStream({ messages, tools, toolChoice, idSlot }, cb) {
      const body = {
        model,
        messages,
        tools: tools.map(toOpenAITool),
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
        top_k: topK,
        stream: true,
        stream_options: { include_usage: true },
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...laneOf(idSlot),
      };
      logPrefix(messages, body.tools);
      const t0 = performance.now();
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(body),
      });
      if (!res.ok || !res.body) {
        throw new Error(`model http ${res.status}: ${await res.text().catch(() => "")}`);
      }

      let content = "";
      let ttftMs: number | null = null;
      let streamTimings: LlamaTimings | undefined;
      let streamUsage: LlamaUsage | undefined;
      let finishReason: string | null = null;
      const tcParts = new Map<number, { id?: string; name: string; args: string }>();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: {
            choices?: { delta?: OpenAIDelta; finish_reason?: string }[];
            timings?: LlamaTimings;
            usage?: LlamaUsage;
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.timings) streamTimings = chunk.timings;
          if (chunk.usage) streamUsage = chunk.usage;
          if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content) {
            if (ttftMs === null) ttftMs = performance.now() - t0;
            content += delta.content;
            cb.onContent?.(delta.content);
          }
          for (const tc of delta.tool_calls ?? []) {
            if (ttftMs === null) ttftMs = performance.now() - t0;
            const cur = tcParts.get(tc.index) ?? { name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            tcParts.set(tc.index, cur);
          }
        }
      }
      logModelCall("stream", ttftMs, performance.now() - t0, streamTimings, streamUsage);

      const toolCalls: ToolCall[] = [...tcParts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, p]) => ({ id: p.id ?? `call_${i}`, name: p.name, args: parseArgs(p.args) }));
      return { content: content || null, toolCalls, truncated: finishReason === "length" };
    },
  };
}

// Tool args arrive as a JSON string; a weak local model may emit malformed JSON. Return a sentinel the
// engine surfaces as a structured tool error rather than throwing.
function parseArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __parseError: raw };
  }
}
