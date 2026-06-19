import { withCrossProcessLock, crossProcessLockFor, type ExclusiveRunner } from "./lock";

// Single work queue with priority. Higher-precedence (lower number) work jumps the queue ahead of lower.
// Atomic jobs (a tick isn't interrupted mid-tool-call); forced events additionally PREEMPT a running
// tier-2 cooperatively, via hasPendingAbove() checked at tool-call boundaries (see engine `shouldYield`).
// This priority is RESPONSIVENESS and is fixed — SEPARATE from the agent's self-set attention priorities,
// which only order its idle time. [AGENCY: code-fixed — responsiveness guarantee]
export enum WorkPriority {
  ChatForced = 0, // the user messaged — a person is waiting
  GameForced = 1, // a game turn that demands an action — unblock the game ASAP
  Engagement = 2, // the agent's tier-2 escalations (game/social/reflect) + the periodic reflect
  Heartbeat = 3, // tier-1 triage + maintenance (rebake)
}

interface Queued<T> {
  priority: WorkPriority;
  seq: number;
  job: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export class WorkQueue {
  private pending: Queued<unknown>[] = [];
  private draining = false;
  private seq = 0;

  // runExclusive defaults to the cross-process lock; tests inject a pass-through.
  constructor(private runExclusive: ExclusiveRunner = withCrossProcessLock) {}

  submit<T>(priority: WorkPriority, job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ priority, seq: this.seq++, job, resolve, reject } as Queued<unknown>);
      void this.drain();
    });
  }

  get size(): number {
    return this.pending.length;
  }

  // Is any QUEUED job higher-precedence than `priority` (lower number)? A running tier-2 job polls this
  // at tool-call boundaries to cooperatively yield to a pending forced event. Only counts pending work —
  // the in-flight job isn't in `pending`.
  hasPendingAbove(priority: WorkPriority): boolean {
    return this.pending.some((q) => q.priority < priority);
  }

  private take(): Queued<unknown> | undefined {
    if (this.pending.length === 0) return undefined;
    // lowest priority number first; ties broken by submission order (stable, FIFO).
    let best = 0;
    for (let i = 1; i < this.pending.length; i++) {
      const a = this.pending[i];
      const b = this.pending[best];
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    return this.pending.splice(best, 1)[0];
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.take(); next; next = this.take()) {
        try {
          const result = await this.runExclusive(next.job);
          next.resolve(result);
        } catch (e) {
          next.reject(e);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

// ── Lanes (multi-instance model serving) ────────────────────────────────────────────────────────────
// The agent's primary work is PLAYING, so the GAME lane is the conceptual primary lane. When a second
// llama-server instance is configured (MODEL_BASE_URL_GAME), work splits across two lanes pointed at
// SEPARATE instances — independent KV caches that never evict each other — and SEPARATE in-process queues +
// advisory locks, so a chat turn runs CONCURRENTLY with a long game pass instead of queueing behind it:
//   • game lane → the game instance: game passes + ALL idle cognition (game heartbeat, reflect,
//     game-engage, rebake). Within the lane the priority order + cooperative yield still apply.
//   • chat lane → the main instance: a person is waiting (real user chat turns).
// The chat lane is the REQUIRED base lane (MODEL_BASE_URL); the game lane is OPTIONAL and falls back to it
// (see docs/LANES.md for when to run them together vs. separate). With a single instance (default) BOTH
// lanes collapse to one queue + one lock — fully serialized. [AGENCY: code-fixed — responsiveness/serving]
export type Lane = "chat" | "game";

const MODEL_SLOTS = Math.max(1, Number(process.env.AGENT_MODEL_SLOTS ?? "1"));
// Lanes split when either a distinct game instance is configured OR a multi-slot single server is used.
export const LANES_SPLIT =
  MODEL_SLOTS > 1 || (!!process.env.MODEL_BASE_URL_GAME && process.env.MODEL_BASE_URL_GAME !== process.env.MODEL_BASE_URL);

/** Physical llama.cpp slot id for a lane (pure; takes the slot count). Single-slot → 0 for both. */
export function laneSlotFor(lane: Lane, slots: number): number {
  if (slots <= 1) return 0;
  return lane === "chat" ? 0 : Math.min(1, slots - 1);
}
/** Slot id for a lane under the configured AGENT_MODEL_SLOTS. */
export function laneSlot(lane: Lane): number {
  return laneSlotFor(lane, MODEL_SLOTS);
}

// One queue per lane. Single-instance: both lanes resolve to ONE shared queue (key "game") + the default
// lock, so every job serializes. Multi-instance: a queue per lane, each with its own per-lane advisory
// lock, so the lanes run concurrently in- and cross-process.
const laneQueues = new Map<Lane, WorkQueue>();
export function laneQueue(lane: Lane): WorkQueue {
  const key: Lane = LANES_SPLIT ? lane : "game";
  let q = laneQueues.get(key);
  if (!q) {
    q = new WorkQueue(LANES_SPLIT ? crossProcessLockFor(key) : withCrossProcessLock);
    laneQueues.set(key, q);
  }
  return q;
}

// The "default" queue is the game lane (game passes + idle cognition + maintenance). Callers that don't
// care about lanes (e.g. rebake) use this; chat goes through laneQueue("chat").
export function defaultQueue(): WorkQueue {
  return laneQueue("game");
}
