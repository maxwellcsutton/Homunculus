import { computeIdentityDiff, extractIdentityRows, renderIdentityDiff } from "./identityDiff";
import type {
  IdentityStore,
  PrioritiesRecord,
  SelfStateRecord,
  OpinionRow,
  BaseSnapshotRow,
} from "@/store/types";

// The VOLATILE self-state tail (docs/PROMPT_LAYERING.md). These blocks are the agent's own mutable state —
// self-image, opinions, focus, felt state — re-rendered every turn (cheap) and folded into the user turn,
// never baked into the warm base. Surfacing them is how the agent READS its own state; nothing in the code
// branches on them. [AGENCY: her-state — the code only shows them back to her.]

export function renderSelfImage(content: string): string {
  const body = content.trim() || "(You haven't written your self-image yet — it's blank. You author it with `revise_self_image`.)";
  return `# Your self-image (yours — revise with \`revise_self_image\` when it shifts)\n${body}`;
}

export function renderOpinions(rows: OpinionRow[]): string {
  if (rows.length === 0) {
    return "# Your opinions\n(None yet. Form one with `form_opinion` when experience gives you a view worth keeping.)";
  }
  const lines = rows
    .map((o) => `- [#${o.id}] ${o.subject}: ${o.stance} (confidence ${o.confidence}${o.basis ? `; from: ${o.basis}` : ""})`)
    .join("\n");
  return (
    "# Your opinions (yours — `form_opinion` / `revise_opinion` / `drop_opinion`)\n" + lines
  );
}

export function renderFocus(p: PrioritiesRecord): string {
  return (
    "# Your current focus (you set this; change it with `reweigh_focus`)\n" +
    `inner_life: ${p.weights.inner_life} · game: ${p.weights.game} · social: ${p.weights.social}\n` +
    `Why, in your words: ${p.rationale}`
  );
}

export function renderFeltState(s: SelfStateRecord): string {
  return (
    "# How you're feeling (yours — update with `tend_self` when it shifts)\n" +
    `Energy: ${s.energy} · Mood: ${s.mood}` +
    (s.note ? `\nIn your words: ${s.note}` : "")
  );
}

export function renderMemoryCategories(cats: string[]): string {
  if (cats.length === 0) return "";
  return `# Your memory categories (use these as \`tag\` in \`recall\`)\n${cats.join(", ")}`;
}

// The full self-state block shared by the chat tick and the game tail: self-image, opinions, focus, felt
// state, memory categories, and the memory diff against the warm base. One read of the agent's own state.
export async function buildSelfContext(store: IdentityStore, snapshot: BaseSnapshotRow): Promise<string> {
  const [selfImage, opinions, priorities, state, memory, cats] = await Promise.all([
    store.getSelfImage(),
    store.listOpinions(),
    store.getPriorities(),
    store.getState(),
    store.listMemory(500),
    store.memoryCategories(),
  ]);
  const diff = computeIdentityDiff(snapshot.items, extractIdentityRows(memory));
  const parts = [
    renderSelfImage(selfImage),
    renderFeltState(state),
    renderFocus(priorities),
    renderOpinions(opinions),
    renderMemoryCategories(cats),
    renderIdentityDiff(diff),
  ];
  return parts.map((s) => s.trim()).filter((s) => s.length > 0).join("\n\n");
}
