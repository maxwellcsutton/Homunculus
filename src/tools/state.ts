import { z } from "zod";
import type { ToolDef } from "./types";

// CORE INVARIANT mechanism: the agent rewrites its own felt state — energy + mood, in its own words, plus a
// note. Same self-managed pattern as reweigh_focus / journal / memory: the code offers the capacity; the
// agent supplies the words and the choice. Nothing in the engine computes its energy or branches on it —
// the heartbeat only surfaces it back (with neutral grounding cues it interprets). [AGENCY: its-state]
//
// Partial updates: move just energy, just mood, just leave a note — whatever's shifted. Omitted fields keep
// their current value (read-merge-write).
export const tendSelfTool: ToolDef<{ energy?: string; mood?: string; note?: string }> = {
  name: "tend_self",
  description:
    "Update how you're feeling right now — your `energy` (a word, like settled / restless / drained / " +
    "wired), your `mood` (focused / playful / frustrated / curious / …), and an optional `note` in your " +
    "own words. Use whatever words fit; set only what's shifted. This is yours — no one sets it but you. " +
    "It's surfaced back to you on your own time so you can let it color what you feel like doing; it never " +
    "forces anything.",
  inputSchema: z.object({
    energy: z.string().min(1).max(60).optional(),
    mood: z.string().min(1).max(60).optional(),
    note: z.string().max(2000).optional(),
  }),
  modes: ["chat"],
  handler: async (a, ctx) => {
    if (a.energy == null && a.mood == null && a.note == null)
      return "nothing to update — name your energy, your mood, and/or a note.";
    const cur = await ctx.store.getState();
    const next = {
      energy: a.energy ?? cur.energy,
      mood: a.mood ?? cur.mood,
      note: a.note ?? cur.note,
    };
    await ctx.store.setState(next);
    await ctx.store.addReflection(
      `Tended to myself → energy:${next.energy} mood:${next.mood}${a.note ? ` — ${a.note}` : ""}`,
    );
    return `noted — energy:${next.energy} mood:${next.mood}`;
  },
};
