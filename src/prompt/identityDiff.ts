import { createHash } from "node:crypto";
import { formatFactsDiff, type FactLike } from "./staticBase";
import type { BaseSnapshotItems, BaseSnapshotMemoryRow, MemoryRow } from "@/store/types";

// Pure diff engine for warm-base caching (docs/WARM_BASE_CACHING.md). The base bakes the agent's FULL
// memory list; the tail carries only what changed since. We diff live state against the snapshot rows by a
// CONTENT hash (not a row id), so an in-place edit reads as removed(old) + added(new) — precisely how we
// want to render it.

export interface ListDiff<T> {
  added: T[];
  removed: T[];
}
export interface IdentityDiff {
  memory: ListDiff<BaseSnapshotMemoryRow>;
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const memKey = (r: BaseSnapshotMemoryRow) => sha1([r.category, r.content].join(" "));

function diffList<T>(snapshot: T[], live: T[], key: (t: T) => string): ListDiff<T> {
  const snapKeys = new Set(snapshot.map(key));
  const liveKeys = new Set(live.map(key));
  return {
    added: live.filter((r) => !snapKeys.has(key(r))),
    removed: snapshot.filter((r) => !liveKeys.has(key(r))),
  };
}

// Project live memory rows into the snapshot-row shape used by BOTH bake and diff, so the two sides always
// compare like-for-like.
export function extractIdentityRows(memory: MemoryRow[]): BaseSnapshotItems {
  return {
    memory: memory.map((m) => ({ id: m.id, category: m.category, content: m.content })),
  };
}

export function computeIdentityDiff(snapshot: BaseSnapshotItems, live: BaseSnapshotItems): IdentityDiff {
  return { memory: diffList(snapshot.memory, live.memory, memKey) };
}

export function isEmptyDiff(d: IdentityDiff): boolean {
  return d.memory.added.length === 0 && d.memory.removed.length === 0;
}

const toFact = (r: BaseSnapshotMemoryRow): FactLike => ({ id: r.id, category: r.category, fact: r.content });

export function renderIdentityDiff(diff: IdentityDiff): string {
  return formatFactsDiff(diff.memory.added.map(toFact), diff.memory.removed.map(toFact)).trim();
}
