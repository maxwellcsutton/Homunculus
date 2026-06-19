import { z } from "zod";
import type { ToolDef } from "./types";

// Self-managed memory: the agent curates its own long-term memory. No background summarizer writes on its
// behalf. The current state of each store is surfaced to it each turn (the warm base + diff), so writes
// edit against current text, not blind.

export const rememberTool: ToolDef<{ content: string; key?: string; category?: string }> = {
  name: "remember",
  description:
    "Save something to your long-term memory so it survives across sessions — anything you want to keep: " +
    "a fact about the game or the user, a lesson, a moment that mattered. Call this when you decide " +
    'something is worth holding onto; saying "I\'ll remember that" in a reply does NOT save it, only this ' +
    'tool does. Pass an optional stable `key` (e.g. "boss-strategy") to update that note in place vs. ' +
    'adding a duplicate, and an optional `category` to group it.',
  inputSchema: z.object({
    content: z.string().max(2000),
    key: z.string().max(64).optional(),
    category: z.string().max(64).optional(),
  }),
  modes: ["chat", "game"],
  handler: async (a, ctx) => {
    const row = await ctx.store.writeMemory({ key: a.key, category: a.category, content: a.content });
    const count = await ctx.store.countMemory();
    return `Saved to memory${row.key ? ` (key=${row.key})` : ""}. You're keeping ${count} memories now.`;
  },
};

export const forgetTool: ToolDef<{ id: number }> = {
  name: "forget",
  description:
    "Let go of a memory by its id — the number shown as `[#id]` next to each entry in your memory list. " +
    "It drops out of your always-on memory but stays findable later with `recall` if you ever want it.",
  inputSchema: z.object({ id: z.number().int() }),
  modes: ["chat", "game"],
  handler: async (a, ctx) => {
    const ok = await ctx.store.forgetMemory(a.id);
    // A miss means it's ALREADY gone. That is NOT an error to fix — don't invite a re-scan/retry. The
    // memory list in context is a SNAPSHOT from the start of this turn; it won't visibly shrink as you
    // forget things — go by these tool results, not the (stale) list.
    if (!ok)
      return (
        `#${a.id} is already gone — nothing to do, don't retry it. (Your memory list in context is from ` +
        `the start of this turn and won't shrink until next turn; go by these results, not the list.)`
      );
    const count = await ctx.store.countMemory();
    return `Let go of #${a.id}. ${count} memories left. (The list in your context refreshes next turn.)`;
  },
};
