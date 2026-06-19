import { buildSelfContext } from "./selfTail";
import type { IdentityStore, BaseSnapshotRow, ExperienceRow } from "@/store/types";

// The game-pass tail (docs/PROMPT_LAYERING.md). Game-situational framing + the agent's volatile self-state
// + its game journal + recent experiences, folded into the user turn ahead of the live game snapshot. The
// game-loop appends "# Now\n<snapshot>" after this. None of it is baked — the warm base is byte-identical
// across chat and game, so the two modes share the cached prefix.

const GAME_FRAMING = `# You're playing right now

This is a live game turn. Read the state below and act — make your moves through the game's tools. Think
about what you're doing and why; when you learn something worth keeping, form an opinion (\`form_opinion\`)
or write it in your game journal (\`write_journal\`). Post a short status with \`post_progress\` so your
chat-self can see how it's going.`;

// Optional detailed playing guidance, appended ONLY when a distinct game lane is configured (so the
// game-heavy prose never bloats a single shared instance's prompt). This is a GENERIC placeholder — extend
// it with how to play YOUR game well (what to optimize, how to read outcomes, common mistakes). Kept out
// of the warm base so it can change without a cold re-prefill of chat.
export const GAME_GUIDANCE = `# Playing well

- Read the full state before acting; don't assume.
- After a loss or a setback, look at WHY — then change your approach instead of repeating it. That's how
  your opinions get sharper over time.
- A tool result that comes back as an error isn't a wall — adapt (try a smaller move, a different action).
- You don't have to do everything in one turn. Make a real move, see what happens, and continue.`;

function renderExperiences(rows: ExperienceRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => `- [${r.kind}] ${r.content}`).join("\n");
  return `# Recently, in the game\n${lines}`;
}

function renderGameJournal(journal: string | null): string {
  if (!journal || !journal.trim()) return "";
  return `# Your game journal (your build/strategy notes — rewrite the whole page with \`write_journal\`)\n${journal.trim()}`;
}

function renderGameMoment(moment: string | null): string {
  if (!moment || !moment.trim()) return "";
  return `# Your current game moment\n${moment.trim()}`;
}

export async function buildGameTail(store: IdentityStore, snapshot: BaseSnapshotRow): Promise<string> {
  const [selfContext, journal, moment, experiences] = await Promise.all([
    buildSelfContext(store, snapshot),
    store.getJournal("game"),
    store.getCurrentMoment("game"),
    store.listExperience(8),
  ]);
  return [
    GAME_FRAMING,
    selfContext,
    renderGameJournal(journal),
    renderGameMoment(moment),
    renderExperiences(experiences),
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}
