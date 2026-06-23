import { z } from "zod";
import type { ToolDef } from "./types";

// CORE INVARIANT mechanism (opinions). The agent forms discrete opinions from experience — about
// strategies, the game, the user, itself — and revises or drops them as it learns more. This is the
// generic form of a pattern many game agents use implicitly (reflect on what happened last time → change
// your approach), made explicit and self-managed. Nothing in the code forms an opinion or reads one to decide
// for the agent; opinions are surfaced into its context and it does what it wants with them. The store is
// empty at the start; every opinion is the agent's, formed from something that actually happened.
// [AGENCY: its-state]

export const formOpinionTool: ToolDef<{ subject: string; stance: string; confidence?: number; basis?: string }> = {
  name: "form_opinion",
  description:
    "Record an opinion you've formed — about a strategy, the game, the user, or yourself. `subject` is " +
    "what it's about (short, like \"aggressive early game\" or \"the merchant NPC\"); `stance` is the " +
    "opinion itself, in your own words; `confidence` (0–1) is how settled you feel about it; `basis` is " +
    "what led you to it (the experience that produced it). Form one when something you did or saw actually " +
    "shifts how you think — that's how your views accumulate instead of resetting every session.",
  inputSchema: z.object({
    subject: z.string().min(1).max(120),
    stance: z.string().min(1).max(1000),
    confidence: z.number().min(0).max(1).optional(),
    basis: z.string().max(1000).optional(),
  }),
  modes: ["chat", "game"],
  handler: async (a, ctx) => {
    const row = await ctx.store.formOpinion({
      subject: a.subject,
      stance: a.stance,
      confidence: a.confidence,
      basis: a.basis,
    });
    return `Opinion #${row.id} formed on "${a.subject}" (confidence ${row.confidence}).`;
  },
};

export const reviseOpinionTool: ToolDef<{ id: number; stance?: string; confidence?: number; basis?: string }> = {
  name: "revise_opinion",
  description:
    "Revise an opinion you already hold — by its `[#id]` in your opinions list — when new experience " +
    "changes it. Update the `stance`, your `confidence` (0–1), and/or the `basis`. Use this instead of " +
    "forming a duplicate when your view of the same subject deepens, softens, or flips.",
  inputSchema: z.object({
    id: z.number().int(),
    stance: z.string().min(1).max(1000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    basis: z.string().max(1000).optional(),
  }),
  modes: ["chat", "game"],
  handler: async (a, ctx) => {
    if (a.stance == null && a.confidence == null && a.basis == null)
      return "nothing to revise — change the stance, confidence, and/or basis.";
    const ok = await ctx.store.reviseOpinion(a.id, { stance: a.stance, confidence: a.confidence, basis: a.basis });
    if (!ok) return `#${a.id} isn't a live opinion anymore — nothing to revise.`;
    return `Opinion #${a.id} revised.`;
  },
};

export const dropOpinionTool: ToolDef<{ id: number }> = {
  name: "drop_opinion",
  description:
    "Drop an opinion you no longer hold — by its `[#id]`. It retires from your active opinions (kept in " +
    "history). Use this when you've changed your mind and the old stance no longer reflects you.",
  inputSchema: z.object({ id: z.number().int() }),
  modes: ["chat", "game"],
  handler: async (a, ctx) => {
    const ok = await ctx.store.dropOpinion(a.id);
    if (!ok) return `#${a.id} is already gone from your active opinions — nothing to do.`;
    return `Dropped opinion #${a.id}.`;
  },
};
