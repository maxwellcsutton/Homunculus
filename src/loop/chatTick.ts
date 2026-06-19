import { runLoop, type RunLoopResult } from "./engine";
import { prismaStore } from "@/store/prisma";
import { defaultModelClient } from "@/model";
import { getActiveBaseSnapshot } from "@/prompt/baseSnapshot";
import { buildSelfContext } from "@/prompt/selfTail";
import { chatMode } from "@/modes/chat";
import { extractEngage } from "@/tools/engage";
import { isResay, recentAgentMessages } from "./resay";
import { unansweredUserMessages, agentPendingMessages, renderUserPending, renderAgentPending } from "./idleSession";
import { fmtStamp, historyAtTail } from "./timeFmt";
import { laneSlot } from "./queue";
import type { IdentityStore } from "@/store/types";
import type { ModelClient } from "@/model/client";

// The chat/self TICK — THE chat path. A user message no longer forces an instant reply; the endpoint
// persists it and fires this tick, where the agent sees the latest over the warm history window + its own
// self-state, and MAY reply (its sanitized prose, or message_user → async delivery) or stay busy. Runs on
// the chat/self lane.
//
// CORE INVARIANT: the framing offers a reply + the agent's own options; it never forces a response (it can
// be genuinely busy). [AGENCY: her-state — whether/when/how it replies.]

const HISTORY_MAX = Number(process.env.AGENT_HISTORY_MAX ?? "10");

export interface ChatTickDeps {
  store?: IdentityStore;
  model?: ModelClient;
  idSlot?: number;
}

// Nudge when the agent's prose reply just restates its last message — say something fresh, or let it be.
const RESAY_NUDGE =
  "One thing before that sends: it's almost exactly what you just said. If you've got something genuinely " +
  "new to add, say that instead; if not, it's fine to leave it — you don't have to restate yourself.";

export async function handleChatTick(deps: ChatTickDeps = {}): Promise<RunLoopResult> {
  const store = deps.store ?? prismaStore;
  const model = deps.model ?? defaultModelClient();

  const snapshot = await getActiveBaseSnapshot(store);
  const recent = await store.recentChatTurns(HISTORY_MAX);
  const priors = recentAgentMessages(recent);
  const atTail = historyAtTail();
  // The agent's own-life framing for the pass: its volatile self-state (self-image, opinions, focus, felt
  // state, memory diff). Owner-agnostic; the user's pending message rides the separate block below.
  const framing = await buildSelfContext(store, snapshot);

  const userPending = unansweredUserMessages(recent);
  const agentPending = userPending.length ? [] : agentPendingMessages(recent);
  const tailRun = userPending.length ? userPending : agentPending;
  const histTurns = recent.slice(0, recent.length - tailRun.length);

  let history: { role: "user" | "agent"; content: string }[];
  let trailingText: string;
  const bottom = userPending.length
    ? renderUserPending(userPending, { stamped: atTail, proseDelivers: true })
    : renderAgentPending(agentPending, { stamped: atTail, proseDelivers: true });
  if (atTail) {
    const framingMsg = { role: "user" as const, content: framing };
    const stamped = histTurns.map((t) => ({
      role: (t.role === "agent" ? "agent" : "user") as "user" | "agent",
      content: `[${fmtStamp(t.createdAt)}] ${t.content}`,
    }));
    history = [framingMsg, ...stamped];
    trailingText = bottom || `# Now\nPick things up from here if you feel like it.`;
  } else {
    history = histTurns.map((t) => ({
      role: (t.role === "agent" ? "agent" : "user") as "user" | "agent",
      content: t.content,
    }));
    trailingText = bottom ? `${framing}\n\n${bottom}` : framing;
  }

  const run = (nudge?: string): Promise<RunLoopResult> =>
    runLoop({
      mode: chatMode(snapshot.baseText),
      event: {
        type: "user_msg",
        mode: "chat",
        text: nudge ? `${trailingText}\n\n# Heads up\n${nudge}` : trailingText,
      },
      model,
      store,
      history,
      maxSteps: 8,
      idSlot: deps.idSlot ?? laneSlot("chat"),
    });

  // The agent's prose reply to deliver — null when it messaged via message_user (the tool delivers +
  // dedups itself), escalated (engage), ran away (truncated), or wrote nothing (busy).
  const proseReply = (r: RunLoopResult): string | null =>
    r.truncated || r.toolCalls.some((c) => c.name === "message_user") || extractEngage(r.toolCalls)
      ? null
      : r.finalText?.trim() || null;

  let result = await run();
  let reply = proseReply(result);

  // Consecutive re-say guard: nudge once; if still a re-say, swallow it (don't send a near-duplicate).
  if (reply && (await isResay(reply, priors))) {
    result = await run(RESAY_NUDGE);
    reply = proseReply(result);
    if (reply && (await isResay(reply, priors))) {
      console.warn("[chat-tick] swallowed a consecutive re-say (still a near-duplicate after the nudge)");
      reply = null;
    }
  }

  // Image gists the agent pulled in this tick (recall_images surface:<id>): they ride its PERSISTED history
  // turn (context for future turns) but are NOT sent to the user.
  const surfaced = result.surfacedImages.map((c) => `\n\n[${c}]`).join("");

  if (reply) {
    // Persist the agent's turn BEFORE delivering (ordering fix): a fast user reply could otherwise get a
    // lower id and scramble order + the last-sender attribution. Record first → the user's reply lands after.
    await store.addChatTurn("agent", reply + surfaced);
    await store.addOutbound(reply);
  } else if (result.truncated) {
    console.warn("[chat-tick] dropped a runaway reply (hit max_tokens) — not delivered");
  } else if (surfaced.trim()) {
    await store.addChatTurn("agent", surfaced.trim());
  }
  return result;
}
