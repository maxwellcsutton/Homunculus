import { STATIC_HEAD, STATIC_CLOSING, buildFactsSection, type FactLike } from "./staticBase";
import { extractIdentityRows } from "./identityDiff";
import type { IdentityStore, BaseSnapshotItems, BaseSnapshotRow } from "@/store/types";

// Warm-base snapshot lifecycle (docs/WARM_BASE_CACHING.md). The base = static prose (STATIC_HEAD) + the
// agent's FULL memory list + STATIC_CLOSING, baked once and served byte-identical until the next rebake.
// We DON'T memoize across turns: the stored baseText is the byte-stable artifact (what keeps llama.cpp's KV
// prefix warm), and reading it fresh each turn means a separate rebake process is picked up without a
// server restart.
//
// Only MEMORY is baked. The agent's volatile self-state (self-image, opinions, focus, felt state, current
// moment) rides the per-turn tail, never the base — it changes too often to bake without churning the cache.

const BAKE_MEMORY_LIMIT = Number(process.env.AGENT_BAKE_MEMORY_LIMIT ?? "500");

function renderBaseIdentity(items: BaseSnapshotItems): string {
  const facts: FactLike[] = items.memory.map((m) => ({ id: m.id, category: m.category, fact: m.content }));
  return buildFactsSection(facts).trim();
}

// composeBaseText builds the base from static prose + memory only — never conversation history (the chat
// path serves a live rolling window) and never volatile self-state. Byte-identical for game mode too.
function composeBaseText(items: BaseSnapshotItems): string {
  return [STATIC_HEAD, renderBaseIdentity(items), STATIC_CLOSING]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

// Bake a fresh base from current memory and persist it as the active snapshot.
export async function bakeStaticBase(store: IdentityStore): Promise<BaseSnapshotRow> {
  const memory = await store.listMemory(BAKE_MEMORY_LIMIT);
  const items = extractIdentityRows(memory);
  const baseText = composeBaseText(items);
  return store.saveBaseSnapshot({ baseText, items });
}

// The per-turn read: the active frozen base, baking one lazily on cold start (fresh DB).
export async function getActiveBaseSnapshot(store: IdentityStore): Promise<BaseSnapshotRow> {
  const active = await store.getActiveBaseSnapshot();
  if (active) return active;
  return bakeStaticBase(store);
}

// The periodic / manual entry point: re-merge the day's memory edits and write a fresh active snapshot.
export async function rebakeBase(store: IdentityStore): Promise<BaseSnapshotRow> {
  return bakeStaticBase(store);
}

// Boot hook: if the static prose changed since the active snapshot was baked (a code edit), rebake so it
// takes effect now rather than waiting for the next scheduled rebake.
export async function rebakeIfStaticChanged(store: IdentityStore): Promise<BaseSnapshotRow> {
  const active = await store.getActiveBaseSnapshot();
  if (active && active.baseText.startsWith(STATIC_HEAD) && active.baseText.endsWith(STATIC_CLOSING)) {
    return active;
  }
  return bakeStaticBase(store);
}
