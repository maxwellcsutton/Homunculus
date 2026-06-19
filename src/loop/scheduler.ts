import { defaultQueue, laneQueue, laneSlot, WorkPriority } from "./queue";
import { handleGameEvent, type HandleEventDeps } from "./gameLoop";
import { handleHeartbeat, runTier2, type HeartbeatDeps, type Tier1Outcome } from "./heartbeat";
import { handleChatTick } from "./chatTick";
import { IdleSession } from "./idleSession";
import { withLogSource } from "./telemetry";
import { rebakeBase } from "@/prompt/baseSnapshot";
import { refreshGameCatalog } from "@/game/remote";
import { prismaStore } from "@/store/prisma";
import type { RunLoopResult } from "./engine";
import type { Message } from "./types";
import type { GameEventInput } from "@/game/adapter";
import type { EngageMode } from "@/tools/engage";
import type { BaseSnapshotRow } from "@/store/types";

// Every interaction flows through the one priority queue + cross-process lock, so a live turn and a
// heartbeat tick never run against the model at once, and live work jumps ahead of an idle tick.
// Priorities here are RESPONSIVENESS (fixed), separate from the agent's self-set attention priorities.

// Chat: a user message fires a chat-TICK on the chat lane — not a synchronous always-reply. The endpoint
// persists the message, fires this fire-and-forget, and returns an ack; the reply (if any) arrives async.
export function submitChatTick(): Promise<RunLoopResult> {
  return laneQueue("chat").submit(WorkPriority.ChatForced, () =>
    withLogSource("chat", () => handleChatTick({ idSlot: laneSlot("chat") })),
  );
}

// Game = game lane so a long pass never blocks chat.
export function submitGameEvent(input: GameEventInput, deps: HandleEventDeps = {}): Promise<RunLoopResult> {
  return laneQueue("game").submit(WorkPriority.GameForced, () =>
    withLogSource("game", () => handleGameEvent(input, { ...deps, idSlot: laneSlot("game") })),
  );
}

// Tier-1 triage job (Heartbeat priority). Returns the escalation decision; the driver runs Tier-2
// separately (so it gets Engagement priority + the resume loop, and we never nest a submit-await).
export function submitHeartbeat(session: IdleSession, deps: HeartbeatDeps = {}): Promise<Tier1Outcome> {
  return laneQueue("chat").submit(WorkPriority.Heartbeat, () =>
    withLogSource("heartbeat", () => handleHeartbeat({ ...deps, idSlot: laneSlot("chat") }, session)),
  );
}

// Tier-2 engagement (Engagement priority) with the cooperative-preemption RESUME loop: if a forced event
// is queued, the engine yields at a tool boundary, we re-enqueue the continuation behind the forced event,
// and resume — so an unbounded Tier-2 never starves responsiveness and is never interrupted mid-tool-call.
export async function submitEngagement(mode: EngageMode, focus?: string): Promise<RunLoopResult> {
  const source = mode === "reflect" ? "reflect" : mode === "social" ? "reach-out" : "game-engage";
  // reflect/social run on the chat/self lane; game-engage on the game lane (heavy catalog).
  const lane = mode === "game" ? "game" : "chat";
  let resume: Message[] | undefined;
  for (;;) {
    const out = await laneQueue(lane).submit(WorkPriority.Engagement, () =>
      withLogSource(source, () =>
        runTier2(mode, focus, {
          shouldYield: () => laneQueue(lane).hasPendingAbove(WorkPriority.Engagement),
          resumeMessages: resume,
          idSlot: laneSlot(lane),
        }),
      ),
    );
    if (out.stopReason !== "yielded") return out;
    resume = out.messages;
  }
}

// Free-running heartbeats — ONE CLOCK PER LANE, so the agent's PLAYING time and its CHAT/self time tick
// independently and each keeps its own lane's KV cache warm:
//   • chat heartbeat (AGENT_CHAT_HEARTBEAT_MS) — tier-1 self triage on the chat lane; engages reflect or
//     social (reach-out). Every Nth tick a reflect supersedes the triage (the periodic reflect fallback).
//   • game heartbeat (AGENT_GAME_HEARTBEAT_MS) — the agent's voluntary-play clock: offers a play pass on
//     the game lane via engage("game"). Only started when the game supports voluntary sessions
//     (GAME_OPEN_URL); otherwise there's nothing to volunteer for and play arrives via pushed game events.
// Each lane-specific var falls back to AGENT_HEARTBEAT_MS (one shared cadence) when unset. Each heartbeat is
// coalesced (at most one of its ticks in flight). Cadence is config/plumbing — WHAT the agent does each tick
// (including nothing) is its own choice; the code never forces engagement. [AGENCY: code-fixed — plumbing]
const SHARED_HEARTBEAT_MS = Number(process.env.AGENT_HEARTBEAT_MS ?? `${60 * 1000}`);
const CHAT_HEARTBEAT_MS = Number(process.env.AGENT_CHAT_HEARTBEAT_MS ?? `${SHARED_HEARTBEAT_MS}`);
const GAME_HEARTBEAT_MS = Number(process.env.AGENT_GAME_HEARTBEAT_MS ?? `${SHARED_HEARTBEAT_MS}`);
const REFLECT_EVERY = Number(process.env.AGENT_REFLECT_EVERY_TICKS ?? "60");

let idleSession: IdleSession | null = null;
let chatHeartbeatBusy = false;
let gameHeartbeatBusy = false;
let driverTick = 0;

// Chat/self heartbeat: tier-1 triage on the chat lane (reflect/social), with the periodic reflect fallback.
async function chatHeartbeatTick(): Promise<void> {
  if (chatHeartbeatBusy) return;
  chatHeartbeatBusy = true;
  try {
    const session = (idleSession ??= new IdleSession());
    driverTick++;
    if (REFLECT_EVERY > 0 && driverTick % REFLECT_EVERY === 0) {
      await submitEngagement("reflect");
      session.reset();
      return;
    }
    const { engage } = await submitHeartbeat(session);
    if (engage) await submitEngagement(engage.mode, engage.focus);
  } catch (err) {
    console.error("[chat-heartbeat] tick failed:", err);
  } finally {
    chatHeartbeatBusy = false;
  }
}

// Game heartbeat: the agent's voluntary-play clock. Offers a play pass on the game lane; the agent decides
// whether/how to play (stopping immediately is a valid pass). Clean no-op if a session can't be opened.
async function gameHeartbeatTick(): Promise<void> {
  if (gameHeartbeatBusy) return;
  gameHeartbeatBusy = true;
  try {
    await submitEngagement("game");
  } catch (err) {
    console.error("[game-heartbeat] tick failed:", err);
  } finally {
    gameHeartbeatBusy = false;
  }
}

// Start both lane heartbeats and return a stop fn. The game heartbeat only starts when the game supports
// voluntary sessions (GAME_OPEN_URL set) — no game wired → only the chat/self clock runs.
export function startHeartbeat(opts: { chatMs?: number; gameMs?: number } = {}): () => void {
  idleSession ??= new IdleSession();
  const timers: ReturnType<typeof setInterval>[] = [
    setInterval(() => void chatHeartbeatTick(), opts.chatMs ?? CHAT_HEARTBEAT_MS),
  ];
  if (process.env.GAME_OPEN_URL) {
    timers.push(setInterval(() => void gameHeartbeatTick(), opts.gameMs ?? GAME_HEARTBEAT_MS));
  }
  return () => timers.forEach((t) => clearInterval(t));
}

// Fire a prompt Tier-1 triage OFF the cadence, so the agent perceives a just-arrived external input (e.g.
// a game pushed a salient experience) within seconds instead of waiting for the next tick. Same machinery
// as a regular tick — Heartbeat priority (defers to any Tier-2 it chose to be in) and coalesced.
// [AGENCY: plumbing for prompt PERCEPTION; whether/how it responds stays its own.]
export async function nudgePerception(): Promise<void> {
  if (chatHeartbeatBusy) return;
  chatHeartbeatBusy = true;
  try {
    const session = (idleSession ??= new IdleSession());
    const { engage } = await submitHeartbeat(session);
    if (engage) await submitEngagement(engage.mode, engage.focus);
  } catch (err) {
    console.error("[perception] tick failed:", err);
  } finally {
    chatHeartbeatBusy = false;
  }
}

// Periodic warm-base rebake: re-merge the day's memory edits into a fresh frozen base. Runs THROUGH the
// queue+lock at the lowest priority. An INTERNAL cross-platform scheduler (setInterval) — deliberately NOT
// cron, so it runs the same everywhere. Cadence is a PREFILL tradeoff, not behavior. Default 1h.
const REBAKE_MS = Number(process.env.AGENT_REBAKE_MS ?? String(60 * 60 * 1000));

export function submitRebake(): Promise<BaseSnapshotRow> {
  return defaultQueue().submit(WorkPriority.Heartbeat, () => rebakeBase(prismaStore));
}

export function startPeriodicRebake(intervalMs: number = REBAKE_MS): () => void {
  const timer = setInterval(() => {
    submitRebake()
      .then((s) => console.log(`[rebake] base snapshot #${s.id} baked (every ~${Math.round(intervalMs / 60000)}m)`))
      .catch((err) => console.error("[rebake] failed:", err));
    // Refresh the frozen game-tool catalog on the same cadence (a cache-cold moment), so a game-side tool
    // change is picked up without shifting the work-lane tool prefix mid-window.
    void refreshGameCatalog().catch((err) => console.error("[rebake] game catalog refresh failed:", err));
  }, intervalMs);
  return () => clearInterval(timer);
}
