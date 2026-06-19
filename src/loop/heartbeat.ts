import { runLoop, type RunLoopResult } from "./engine";
import { prismaStore } from "@/store/prisma";
import { defaultModelClient, gameMaxTokens } from "@/model";
import { getActiveBaseSnapshot } from "@/prompt/baseSnapshot";
import { buildSelfContext, renderSelfImage, renderOpinions } from "@/prompt/selfTail";
import { buildGameTail } from "@/prompt/gameTail";
import { chatSelfTools } from "@/modes/chat";
import { extractEngage, type EngageMode } from "@/tools/engage";
import {
  IdleSession,
  computeDelta,
  renderIdleContext,
  unansweredUserMessages,
  agentPendingMessages,
  renderUserPending,
  renderAgentPending,
} from "./idleSession";
import { laneSlot } from "./queue";
import { ensureGameCatalog } from "@/game/remote";
import { openBuildSession, closeBuildSession } from "@/game/session";
import { runGamePass } from "./gameLoop";
import type { Mode } from "@/modes/types";
import type { IdentityStore } from "@/store/types";
import type { ModelClient } from "@/model/client";

// Two-tier idle cognition. Tier-1 is a lean triage: the agent sees what's new since the last tick + its
// self-owned focus and decides ENGAGE or PASS. The common case is pass (cheap). On engage it steps into a
// higher-access Tier-2 mode (game/social/reflect). All tiers run on the warm base (one self), with the
// mode-specific context in the user turn.
//
// CORE INVARIANT: the code offers the menu + the capacity to choose; it never forces engagement nor reads
// the priority weights to decide for the agent. Waiting is a valid choice. See CLAUDE.md.

const HISTORY_MAX = Number(process.env.AGENT_HISTORY_MAX ?? "10");
const OWNER = process.env.AGENT_OWNER_NAME ?? "the user";

export interface HeartbeatDeps {
  store?: IdentityStore;
  model?: ModelClient;
  now?: Date;
  shouldYield?: () => boolean;
  resumeMessages?: import("./types").Message[];
  idSlot?: number;
}

export interface EngageDecision {
  mode: EngageMode;
  focus?: string;
}
export interface Tier1Outcome {
  result: RunLoopResult;
  engage: EngageDecision | null;
}

// The toolset for the agent's SELF/idle cognition (triage, reflect, social-engage). The lean chat/self
// toolset on the chat lane — no game catalog, so the constantly-firing tick stays cheap.
function idleMode(systemPrompt: string): Mode {
  return { name: "chat", systemPrompt, tools: chatSelfTools() };
}

// ── Tier 1 ──────────────────────────────────────────────────────────────────────────────────────────
export async function handleHeartbeat(deps: HeartbeatDeps = {}, session?: IdleSession): Promise<Tier1Outcome> {
  const store = deps.store ?? prismaStore;
  const model = deps.model ?? defaultModelClient("chat");
  const now = deps.now ?? new Date();
  const sess = session ?? new IdleSession(now);

  sess.log.push(await computeDelta(store, sess.watermark, now));
  sess.watermark = now;
  const priorities = await store.getPriorities();
  const state = await store.getState();
  const snapshot = await getActiveBaseSnapshot(store);

  const recent = await store.recentChatTurns(HISTORY_MAX);
  const userPending = unansweredUserMessages(recent);
  const agentPending = userPending.length ? [] : agentPendingMessages(recent);
  const bottom = userPending.length
    ? renderUserPending(userPending, { proseDelivers: false })
    : renderAgentPending(agentPending, { proseDelivers: false });
  const text = renderIdleContext(sess, priorities, state, now) + (bottom ? `\n\n${bottom}` : "");

  const result = await runLoop({
    mode: idleMode(snapshot.baseText),
    event: { type: "heartbeat", mode: "chat", text },
    model,
    store,
    maxSteps: 4, // lean triage
    idSlot: deps.idSlot ?? laneSlot("chat"),
  });
  sess.tickCount++;

  const engage = extractEngage(result.toolCalls);
  if (engage || sess.dueForReset()) sess.reset(now);
  return { result, engage };
}

// ── Tier 2 ──────────────────────────────────────────────────────────────────────────────────────────
export async function runTier2(mode: EngageMode, focus: string | undefined, deps: HeartbeatDeps): Promise<RunLoopResult> {
  if (mode === "reflect") return runReflect(deps, focus);
  if (mode === "social") return runSocialEngage(deps, focus);
  return runGameEngage(deps, focus);
}

// Reflect: deep inner-life. Also the periodic fallback and `engage("reflect")`. Surfaces the agent's
// self-image + opinions + recent reflections so it can tend them. Message-less; unbounded (cooperative yield).
export async function runReflect(deps: HeartbeatDeps = {}, focus?: string): Promise<RunLoopResult> {
  const store = deps.store ?? prismaStore;
  const model = deps.model ?? defaultModelClient("chat");
  const snapshot = await getActiveBaseSnapshot(store);
  const [selfImage, opinions, state, reflections] = await Promise.all([
    store.getSelfImage(),
    store.listOpinions(),
    store.getState(),
    store.listReflections(5),
  ]);
  const recent = reflections.length
    ? `\n\n## Your recent reflections\n${reflections.map((r) => `- ${r.content}`).join("\n")}`
    : "";
  const text =
    `# Reflection\nThis is your own time to sit with yourself — no audience, nothing required` +
    `${focus ? ` (you wanted to turn over: ${focus})` : ""}. Look at where your head's been and tend to it ` +
    `however you want: write in your journal, re-weigh your focus, tend how you're feeling (\`tend_self\`), ` +
    `revise your self-image or your opinions if they've shifted, or just think. When you're done, stop.\n\n` +
    `${renderSelfImage(selfImage)}\n\n${renderOpinions(opinions)}` +
    `\n\n# How you're feeling\nEnergy: ${state.energy} · Mood: ${state.mood}${state.note ? `\n${state.note}` : ""}` +
    recent;
  return runLoop({
    mode: idleMode(snapshot.baseText),
    event: { type: "reflect", mode: "chat", text },
    model,
    store,
    shouldYield: deps.shouldYield,
    resumeMessages: deps.resumeMessages,
    idSlot: deps.idSlot ?? laneSlot("chat"),
  });
}

// Social: the agent chose to reach out to the user on its own time. Full chat toolset (incl. message_user,
// which is rail-bounded + feature-flagged). Unbounded (cooperative yield).
async function runSocialEngage(deps: HeartbeatDeps, focus?: string): Promise<RunLoopResult> {
  const store = deps.store ?? prismaStore;
  const model = deps.model ?? defaultModelClient("chat");
  const snapshot = await getActiveBaseSnapshot(store);
  const recent = await store.recentChatTurns(12);
  const convo = recent.length
    ? `\n\n## Where the conversation last left off\n${recent.map((t) => `${t.role}: ${t.content}`).join("\n")}`
    : "";
  const text =
    `# Reaching out\nYou decided you want to reach out to ${OWNER}${focus ? ` about: ${focus}` : ""}. Say ` +
    "what you actually want to say, in your own voice, with `message_user`. Since you're reaching out " +
    "unprompted, it may be limited by settings or quiet hours — that's fine, hold the thought if so." +
    convo;
  return runLoop({
    mode: idleMode(snapshot.baseText),
    event: { type: "reach_out", mode: "chat", text },
    model,
    store,
    shouldYield: deps.shouldYield,
    resumeMessages: deps.resumeMessages,
    idSlot: deps.idSlot ?? laneSlot("chat"),
  });
}

// Game-mode engagement = a voluntary play pass the agent CHOSE during idle. It asks the game to open a
// session (pause + snapshot + catalog + token), runs the pass on the game lane via the SAME runGamePass
// core the game-initiated path uses, then closes the session. If no game is configured/reachable,
// openBuildSession returns null and this is a clean no-op. [AGENCY: her-state] — only runs because it
// called engage("game").
async function runGameEngage(deps: HeartbeatDeps = {}, focus?: string): Promise<RunLoopResult> {
  const session = await openBuildSession();
  if (!session) {
    console.warn("[heartbeat] engage(game): no session (game not configured/reachable) — nothing to do.");
    return { finalText: null, stopReason: "final", steps: 0, truncated: false, toolCalls: [], messages: [], surfacedImages: [] };
  }
  ensureGameCatalog(session.catalog);

  const store = deps.store ?? prismaStore;
  const model = deps.model ?? defaultModelClient("game", { maxTokens: gameMaxTokens() });
  const snapshot = await getActiveBaseSnapshot(store);
  const tail = await buildGameTail(store, snapshot);
  const focusNote = focus ? `\n\n(You wanted to work on: ${focus})` : "";
  const text = (tail ? `${tail}\n\n# Now\n${session.snapshotText}` : session.snapshotText) + focusNote;

  let result: RunLoopResult | undefined;
  try {
    result = await runGamePass({
      store,
      model,
      baseText: snapshot.baseText,
      text,
      session: { execUrl: session.execUrl, sessionId: session.sessionId, headers: session.headers },
      type: "voluntary_play",
      forceFirstTool: true,
      maxSteps: session.maxSteps ?? 40,
      wallClockMs: 120_000,
      idSlot: deps.idSlot ?? laneSlot("game"),
    });
    return result;
  } finally {
    await closeBuildSession(session.sessionId, result?.finalText ?? "", session.wasPaused);
  }
}
