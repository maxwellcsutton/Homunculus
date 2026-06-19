import { describe, it, expect } from "vitest";
import { computeIdentityDiff, extractIdentityRows, isEmptyDiff } from "@/prompt/identityDiff";
import type { MemoryRow } from "@/store/types";

// Warm-base caching depends on the memory diff: the base bakes the full list, the tail shows only what
// changed since. An in-place edit must read as removed(old)+added(new) so the cache stays byte-stable.

const mem = (id: number, content: string, category = "misc"): MemoryRow => ({ id, key: null, category, content });

describe("computeIdentityDiff", () => {
  it("is empty when live matches the snapshot", () => {
    const snap = extractIdentityRows([mem(1, "a"), mem(2, "b")]);
    const live = extractIdentityRows([mem(1, "a"), mem(2, "b")]);
    expect(isEmptyDiff(computeIdentityDiff(snap, live))).toBe(true);
  });

  it("reports an added memory", () => {
    const snap = extractIdentityRows([mem(1, "a")]);
    const live = extractIdentityRows([mem(1, "a"), mem(2, "b")]);
    const d = computeIdentityDiff(snap, live);
    expect(d.memory.added.map((r) => r.content)).toEqual(["b"]);
    expect(d.memory.removed).toHaveLength(0);
  });

  it("reports a removed memory", () => {
    const snap = extractIdentityRows([mem(1, "a"), mem(2, "b")]);
    const live = extractIdentityRows([mem(1, "a")]);
    const d = computeIdentityDiff(snap, live);
    expect(d.memory.removed.map((r) => r.content)).toEqual(["b"]);
  });

  it("treats an in-place edit as removed(old)+added(new)", () => {
    const snap = extractIdentityRows([mem(1, "the troll fears fire")]);
    const live = extractIdentityRows([mem(1, "the troll fears fire AND silver")]);
    const d = computeIdentityDiff(snap, live);
    expect(d.memory.added.map((r) => r.content)).toEqual(["the troll fears fire AND silver"]);
    expect(d.memory.removed.map((r) => r.content)).toEqual(["the troll fears fire"]);
  });
});
