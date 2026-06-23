import type { LoopEvent, Message, StopReason, ToolCall } from "./types";
import type { Mode } from "@/modes/types";
import type { ModelClient, WireMessage } from "@/model/client";
import type { ToolContext } from "@/tools/types";
import type { IdentityStore } from "@/store/types";
import { sanitizeReply, hasToolTagLeak, recoverTypedToolCalls } from "./sanitizeReply";
import { tlog, ms, clip } from "./telemetry";

// Tool args are PRIVATE content by default (journal/memory text) → logs show arg NAMES only. A few
// CONTROL tools carry non-sensitive args genuinely useful to see; for ONLY these names, show key=value.
const LOGGABLE_ARG_VALUES: Record<string, readonly string[]> = {
  engage: ["mode", "focus"],
  form_opinion: ["subject", "confidence"],
  revise_opinion: ["id", "confidence"],
};

function formatToolArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const keys = Object.keys(args as Record<string, unknown>);
  if (!keys.length) return "";
  const allow = LOGGABLE_ARG_VALUES[name];
  const parts = keys.map((k) => {
    if (!allow?.includes(k)) return k;
    const v = (args as Record<string, unknown>)[k];
    return typeof v === "string" ? `${k}=${JSON.stringify(clip(v, 80))}` : `${k}=${JSON.stringify(v)}`;
  });
  return ` args=[${parts.join(",")}]`;
}

export interface RunLoopOptions {
  mode: Mode;
  event: LoopEvent;
  model: ModelClient;
  store: IdentityStore;
  // Prior conversation turns (oldest→newest), inserted between the system prompt and the current user
  // message so the model has within-session context. "agent" → assistant.
  history?: { role: "user" | "agent"; content: string }[];
  maxSteps?: number; // runaway rail, not a normal length
  wallClockMs?: number; // optional per-turn budget
  // Cooperative preemption: polled at each tool-call boundary; if it returns true the loop stops cleanly
  // with stopReason "yielded" and returns the transcript so far as the resume point.
  shouldYield?: () => boolean;
  // Resume a previously-yielded loop from its returned messages.
  resumeMessages?: Message[];
  idSlot?: number;
}

export interface RunLoopResult {
  finalText: string | null;
  stopReason: StopReason;
  steps: number;
  // The FINAL model response hit max_tokens (finish_reason "length") — a runaway/truncated reply. The
  // async chat-tick refuses to deliver such a reply (a legit reply never hits the cap).
  truncated: boolean;
  toolCalls: ToolCall[];
  messages: Message[];
  // Image captions the agent pulled in via recall_images surface:<id> this turn. The chat orchestrator
  // appends these to its persisted reply so they ride conversation history.
  surfacedImages: string[];
}

const DEFAULT_MAX_STEPS = 60;

// Per-turn cap on "last write wins" / looping-state tools — re-calling them in one turn changes nothing,
// so a run is a pure loop signal. Past the cap we refuse with a nudge (no-op anyway), and if it keeps
// hammering, end the turn instead of burning steps to the max-step rail.
const OVERWRITE_TOOL_CAPS = new Map<string, number>([
  ["current_moment", 1],
  ["private_journal", 2],
  ["write_journal", 2],
  ["reweigh_focus", 2],
  ["tend_self", 2],
  ["revise_self_image", 2],
]);
const OVERWRITE_TOOL_BAIL = 5;

// recall_images SEARCH cap — chat-only, a responsiveness rail (a person is waiting). Surfacing a pick
// never counts. UNCAPPED on autonomous turns (heartbeat/reflect): nobody's waiting.
const RECALL_IMAGES_SEARCH_CAP = 2;

// The one control-flow primitive: call model → if it requests tools, execute and feed results back →
// repeat → stop when it returns a final message with no tool call. Backstops are the max-step rail and an
// optional wall-clock budget. Tool failures are returned as strings, never thrown.
export async function runLoop(opts: RunLoopOptions): Promise<RunLoopResult> {
  const { mode, event, model } = opts;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const deadline = opts.wallClockMs ? Date.now() + opts.wallClockMs : null;
  const turnStart = performance.now();

  let bail = false;
  let finalTruncated = false;
  const toolCallCounts = new Map<string, number>();
  const surfacedImages: string[] = [];
  let lastMomentText: string | null = null;

  const ctx: ToolContext = {
    mode: mode.name,
    eventType: event.type,
    store: opts.store,
    onSurfaceImage: (caption) => {
      const c = caption.trim();
      if (c) surfacedImages.push(c);
    },
  };

  // Fresh start builds [system, ...history, user]; resume restores the prior transcript verbatim.
  const resuming = !!(opts.resumeMessages && opts.resumeMessages.length);
  const transcript: Message[] = [];
  if (resuming) {
    transcript.push(...opts.resumeMessages!);
  } else {
    transcript.push({ role: "system", content: mode.systemPrompt });
    for (const h of opts.history ?? []) {
      transcript.push({ role: h.role === "agent" ? "assistant" : "user", content: h.content });
    }
    transcript.push({ role: "user", content: event.text });
  }
  const wire: WireMessage[] = transcript.map(toWire);
  const toolCalls: ToolCall[] = [];

  for (let step = 0; step < maxSteps; step++) {
    if (deadline && Date.now() > deadline) {
      return done(null, "wall_clock", step);
    }
    if (opts.shouldYield?.()) {
      return done(null, "yielded", step);
    }

    const forceTool = step === 0 && !resuming && event.forceFirstTool === true;
    const resp = await model.chat({
      messages: wire,
      tools: mode.tools,
      toolChoice: forceTool ? "required" : "auto",
      idSlot: opts.idSlot,
    });

    if (resp.toolCalls.length === 0) {
      finalTruncated = resp.truncated ?? false;
      transcript.push({ role: "assistant", content: resp.content });
      return done(resp.content, "final", step + 1);
    }

    transcript.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });
    wire.push({
      role: "assistant",
      content: resp.content,
      tool_calls: resp.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    });

    // A USER-FACING chat turn is the only one where someone is actively waiting on the reply; there,
    // overwrite-churn is a latency hang. Every other turn (heartbeat/reflect/game) is autonomous.
    const userFacing = event.type === "user_msg";
    const momentSelf = ctx.mode === "game" ? "game" : "chat";

    for (const call of resp.toolCalls) {
      toolCalls.push(call);

      // current_moment on an AUTONOMOUS turn: suppress only a VERBATIM repeat (a true no-op) and never
      // trip the runaway bail, so a moment loop can't truncate a productive game/heartbeat pass.
      if (call.name === "current_moment" && !userFacing) {
        const text =
          typeof (call.args as { text?: unknown })?.text === "string"
            ? String((call.args as { text: string }).text).trim()
            : "";
        if (text && text === lastMomentText) {
          const current = (await opts.store.getCurrentMoment(momentSelf))?.trim() || text;
          const msg =
            "Your current moment is already set to exactly that — re-setting it changes nothing. It " +
            `currently reads:\n${current}\n\nCarry on with your pass or finish your turn.`;
          transcript.push({ role: "tool", toolCallId: call.id, content: msg });
          wire.push({ role: "tool", tool_call_id: call.id, content: msg });
          continue;
        }
        lastMomentText = text;
        const tStart = performance.now();
        const result = await executeTool(mode, call, ctx);
        tlog(`[tool] ${call.name} ${ms(performance.now() - tStart)} → ${result.length}ch`);
        transcript.push({ role: "tool", toolCallId: call.id, content: result });
        wire.push({ role: "tool", tool_call_id: call.id, content: result });
        continue;
      }

      // recall_images SEARCH cap — chat-only (a person waiting). Surfacing a pick is free; uncapped on
      // autonomous turns.
      if (
        userFacing &&
        call.name === "recall_images" &&
        (call.args as { surface?: unknown } | undefined)?.surface === undefined
      ) {
        const s = (toolCallCounts.get("recall_images:search") ?? 0) + 1;
        toolCallCounts.set("recall_images:search", s);
        if (s > RECALL_IMAGES_SEARCH_CAP) {
          const msg =
            `You've already run ${RECALL_IMAGES_SEARCH_CAP} image searches this turn — enough while the ` +
            "user is waiting. Surface one you found (recall_images with surface: <id>), or finish.";
          transcript.push({ role: "tool", toolCallId: call.id, content: msg });
          wire.push({ role: "tool", tool_call_id: call.id, content: msg });
          if (s >= OVERWRITE_TOOL_BAIL) bail = true;
          continue;
        }
      }

      // Overwrite-tool loop guard: count per-turn calls; past the cap, refuse a pointless re-overwrite.
      const n = (toolCallCounts.get(call.name) ?? 0) + 1;
      toolCallCounts.set(call.name, n);
      const overwriteCap = OVERWRITE_TOOL_CAPS.get(call.name);
      if (overwriteCap !== undefined && n > overwriteCap) {
        const finish = userFacing
          ? "say what you mean to the user, or just finish your turn."
          : "continue your pass or just finish your turn.";
        let msg =
          `You've already used \`${call.name}\` ${n - 1}× this turn — once is enough; calling it again ` +
          `just re-churns the turn. Stop calling it: ${finish}`;
        if (call.name === "current_moment") {
          const current = (await opts.store.getCurrentMoment(momentSelf))?.trim();
          if (current) msg += `\n\nYour current moment is already set to:\n${current}`;
        }
        tlog(`[guard] ${call.name} ${n}× this turn (cap ${overwriteCap}) — refusing (overwrite loop)`);
        transcript.push({ role: "tool", toolCallId: call.id, content: msg });
        wire.push({ role: "tool", tool_call_id: call.id, content: msg });
        if (n >= OVERWRITE_TOOL_BAIL) bail = true;
        continue;
      }
      const tStart = performance.now();
      const result = await executeTool(mode, call, ctx);
      const argc = formatToolArgs(call.name, call.args);
      tlog(`[tool] ${call.name} ${ms(performance.now() - tStart)} → ${result.length}ch${argc}`);
      transcript.push({ role: "tool", toolCallId: call.id, content: result });
      wire.push({ role: "tool", tool_call_id: call.id, content: result });
    }

    if (bail) {
      tlog(`[guard] overwrite-tool loop — ending turn at step ${step + 1}`);
      return done(null, "final", step + 1);
    }
  }

  return done(null, "max_steps", maxSteps);

  async function done(finalText: string | null, stopReason: StopReason, steps: number): Promise<RunLoopResult> {
    tlog(
      `[loop] ${mode.name}/${event.type} stop=${stopReason} steps=${steps} tools=${toolCalls.length} wall=${ms(performance.now() - turnStart)}`,
    );
    let clean = finalText;

    // TEXT-ROUTED tool recovery (a portable hard-won lesson): looser sampling improves voice but
    // degrades tool-FORMAT adherence — the model leaks tool intent as TEXT instead of a real tool_call.
    // Parse the text-form intent and route it through the SAME executeTool path a real call uses, so the
    // intent lands even when only narrated. The text itself is stripped below by sanitizeReply. Scope is
    // deliberately small (current_moment + remember + forget, plus message_user when in this mode's
    // toolset). A pure prose paragraph with no tool reference is NOT recovered. Dedup against any real
    // tool_call of the same tool this turn so a recovered call can't double-fire. [AGENCY: its-state —
    // routes the decision it expressed; never originates behavior.]
    if (finalText && mode.name === "chat") {
      const alreadyCalled = new Set(toolCalls.map((c) => c.name));
      let ri = 0;
      const recoverNames = ["current_moment", "remember", "forget"];
      if (mode.tools.some((t) => t.name === "message_user")) recoverNames.push("message_user");
      for (const rec of recoverTypedToolCalls(finalText, recoverNames)) {
        if (alreadyCalled.has(rec.name)) continue;
        tlog(`[recover] ${rec.name} from text-form tool intent [AGENCY: its-state]`);
        const result = await executeTool(mode, { id: `recover-${rec.name}-${ri++}`, name: rec.name, args: rec.args }, ctx);
        tlog(`[recover] ${rec.name} → ${result.length}ch`);
      }
    }

    if (finalText !== null && hasToolTagLeak(finalText)) {
      clean = sanitizeReply(finalText);
      tlog(
        `[sanitize] ${mode.name} reply — stripped ${finalText.length - clean.length}ch; raw: ${clip(finalText.replace(/\s+/g, " ").trim(), 300)}`,
      );
    }
    // A final stop with empty content means the turn produced nothing for the user (e.g. reasoning ate the
    // whole max_tokens budget). Make it loud — the fix is config (reasoning-budget < max_tokens).
    if (stopReason === "final" && !clean?.trim()) {
      tlog(
        `[warn] ${mode.name} final reply is EMPTY — likely reasoning ate the max_tokens budget (raise MODEL_MAX_TOKENS / lower --reasoning-budget)`,
      );
    }
    return { finalText: clean, stopReason, steps, truncated: finalTruncated, toolCalls, messages: transcript, surfacedImages };
  }
}

// Errors are returned to the model as structured strings so it can adapt rather than aborting the turn.
async function executeTool(mode: Mode, call: ToolCall, ctx: ToolContext): Promise<string> {
  const tool = mode.tools.find((t) => t.name === call.name);
  if (!tool) return `Error: unknown tool "${call.name}" in ${mode.name} mode.`;
  if (isParseError(call.args)) {
    return `Error: ${call.name} received malformed JSON arguments; re-emit valid JSON.`;
  }
  try {
    return await tool.execute(call.args, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: ${call.name} failed (${msg}).`;
  }
}

function isParseError(args: unknown): boolean {
  return typeof args === "object" && args !== null && "__parseError" in args;
}

function toWire(m: Message): WireMessage {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return m.toolCalls && m.toolCalls.length
        ? {
            role: "assistant",
            content: m.content,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            })),
          }
        : { role: "assistant", content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}
