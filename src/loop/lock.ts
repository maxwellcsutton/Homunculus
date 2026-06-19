import { Client } from "pg";

// Cross-process lock: one model instance can't run a heartbeat tick and a live turn at the same time —
// and schedulers/live turns may be separate processes. A Postgres session-level advisory lock on a
// dedicated connection gives true cross-process mutual exclusion (the dedicated connection guarantees
// lock+unlock on the same session, which a pooled client can't). At a continuous cadence this is a
// hazard if missing, so it's built in. [AGENCY: code-fixed — concurrency plumbing]

const LOCK_KEY = Number(process.env.AGENT_LOCK_KEY ?? "918273645");

export type ExclusiveRunner = <T>(fn: () => Promise<T>) => Promise<T>;

// Build a cross-process exclusive runner keyed on a specific advisory-lock id. One per "thing that must
// be mutually exclusive across processes."
function makeLock(key: number): ExclusiveRunner {
  return async (fn) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [key]); // blocks until acquired
      return await fn();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [key]);
      } catch {
        // best-effort; connection close releases the session lock regardless
      }
      await client.end();
    }
  };
}

// The default single lock — every unit of work serializes against every other (single-slot model).
export const withCrossProcessLock: ExclusiveRunner = makeLock(LOCK_KEY);

// Per-lane lock (multi-lane model serving): when chat and game/idle run on SEPARATE llama.cpp instances
// they must NOT serialize against each other, so each lane gets its own advisory-lock id (still
// cross-process within the lane). Offsets are small fixed deltas off the base key. [AGENCY: code-fixed]
const LANE_LOCK_OFFSET: Record<string, number> = { chat: 1, work: 2 };
export function crossProcessLockFor(lane: string): ExclusiveRunner {
  return makeLock(LOCK_KEY + (LANE_LOCK_OFFSET[lane] ?? 0));
}
