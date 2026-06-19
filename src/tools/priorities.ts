import { z } from "zod";
import type { ToolDef } from "./types";

// THE mechanism behind the CORE INVARIANT: the agent rewrites its own attention ordering. This tool writes
// its self-owned Priorities record — same self-managed pattern as journal/memory. The code offers the
// capacity; the agent supplies the weighting and the choice. Nothing in the engine reads these weights to
// decide for it. [AGENCY: her-state]
export const reweighFocusTool: ToolDef<{
  weights: { inner_life: number; game: number; social: number };
  rationale: string;
}> = {
  name: "reweigh_focus",
  description:
    "Re-weigh how much of your own unprompted time you give each of your three domains: inner_life (your " +
    "private thought/reflection), game (playing), and social (reaching out to the user). Higher number = " +
    "more of your attention. This governs only your autonomous time — you always respond when actually " +
    "called. It's your call; change it whenever your sense of what matters shifts, and say why.",
  inputSchema: z.object({
    weights: z.object({
      inner_life: z.number().min(0),
      game: z.number().min(0),
      social: z.number().min(0),
    }),
    rationale: z.string().max(2000),
  }),
  modes: ["chat"],
  handler: async (a, ctx) => {
    await ctx.store.setPriorities({ weights: a.weights, rationale: a.rationale });
    // The one guardrail (legibility): record the change + rationale so the WHY stays visible. This bounds
    // the mechanism, not the choice. [AGENCY: code-fixed]
    await ctx.store.addReflection(
      `Re-weighed focus → inner_life:${a.weights.inner_life} game:${a.weights.game} social:${a.weights.social} — ${a.rationale}`,
    );
    return `focus re-weighed (inner_life:${a.weights.inner_life} game:${a.weights.game} social:${a.weights.social})`;
  },
};
