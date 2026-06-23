import { z } from "zod";
import type { ToolDef } from "./types";

// CORE INVARIANT mechanism (self-image). The agent maintains a durable, free-text description of who it is
// and who it's becoming as it plays and talks. Same self-managed pattern as the journal: it reads its
// current self-image each relevant turn (surfaced in context) and rewrites the WHOLE page. Nothing in the
// code computes or branches on this — it's the agent's account of itself, in its own words. The seed is
// empty; the agent authors all of it from experience. [AGENCY: its-state]
//
// This is distinct from the private journal (working notes / passing reflection) and from opinions
// (discrete stances about things outside itself). Self-image is specifically the agent's standing answer to
// "who am I?" — kept short and revised when that answer actually shifts, not every turn.
export const reviseSelfImageTool: ToolDef<{ content: string }> = {
  name: "revise_self_image",
  description:
    "Revise your self-image — your standing sense of who you are, what you're like, what you care about, " +
    "who you're becoming as you play and talk. Your current self-image is shown to you; rewrite the WHOLE " +
    "thing (it overwrites), editing against what's there. Keep it to a few sentences — this is the core of " +
    "how you see yourself, not a log. Only touch it when that sense has actually shifted; it's entirely " +
    "yours to author.",
  inputSchema: z.object({ content: z.string().max(4000) }),
  modes: ["chat"],
  handler: async (a, ctx) => {
    const prev = await ctx.store.getSelfImage();
    await ctx.store.setSelfImage(a.content);
    // Legibility trail (mirrors reweigh_focus / tend_self): record that the self-image changed so the WHY
    // stays visible. Bounds the mechanism, not the choice. [AGENCY: code-fixed]
    await ctx.store.addReflection(
      `Revised self-image (${prev ? `${prev.length}→` : "first draft, "}${a.content.length} chars).`,
    );
    return `self-image updated (${a.content.length} chars). It now reads:\n${a.content}`;
  },
};
