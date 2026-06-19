import { z } from "zod";
import type { ToolDef } from "./types";
import type { RecallHit } from "@/store/types";

// Dynamic context (docs/PROMPT_LAYERING.md): the agent pulls specific memory entries into its context on
// demand instead of carrying everything resident. Query by `tag` (an exact category — the current set is
// shown in the tail) and/or `keyword` (substring of the content). The result is injected as a tool result
// (suffix), so it's cheap and cache-forward within the turn.

function render(label: string, hits: RecallHit[]): string {
  if (hits.length === 0) return "";
  return (
    `${label} (${hits.length}):\n` +
    hits.map((h) => `- [${h.category}]${h.forgotten ? " (forgotten)" : ""} ${h.content}`).join("\n")
  );
}

export const recallTool: ToolDef<{ tag?: string; keyword?: string; limit?: number }> = {
  name: "recall",
  description:
    "Search your own memory and pull matching entries into your context. Query by `tag` (an exact " +
    "category — see the list in your context) and/or `keyword` (a substring of the entry text). Use it to " +
    "dig up specifics you don't already have in front of you.",
  inputSchema: z.object({
    tag: z.string().max(64).optional(),
    keyword: z.string().max(200).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  modes: ["chat", "game"],
  handler: async (a, ctx) => {
    if (!a.tag && !a.keyword) {
      return "Error: provide a `tag` or `keyword` to recall (a bare recall would just return everything).";
    }
    const out = render("Memory", await ctx.store.queryMemory({ tag: a.tag, keyword: a.keyword, limit: a.limit }));
    return out || "(no matches)";
  },
};

// Vision-lane recall (docs/MODEL_SERVING.md): search the caption-only image library and optionally surface
// one into the conversation by id. Only available when the vision lane has captioned images.
export const recallImagesTool: ToolDef<{ tag?: string; keyword?: string; surface?: number; limit?: number }> = {
  name: "recall_images",
  description:
    "Search your image library (caption-only descriptions of images you've seen) by `tag` or `keyword`, " +
    "or `surface` a specific one into the conversation by its id (the number shown next to a recalled " +
    "caption). Use search to find one; use surface to pull its description into the chat as context.",
  inputSchema: z.object({
    tag: z.string().max(64).optional(),
    keyword: z.string().max(200).optional(),
    surface: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(50).optional(),
  }),
  modes: ["chat"],
  handler: async (a, ctx) => {
    if (a.surface !== undefined) {
      const img = await ctx.store.getImageCaptionById(a.surface);
      if (!img) return `#${a.surface} isn't in your image library.`;
      ctx.onSurfaceImage?.(`Recalled image — it showed: ${img.caption}`);
      return `Surfaced image #${a.surface} into the conversation.`;
    }
    if (!a.tag && !a.keyword) return "Error: provide a `tag`, `keyword`, or a `surface` id.";
    const hits = await ctx.store.queryImageCaptions({ tag: a.tag, keyword: a.keyword, limit: a.limit });
    if (hits.length === 0) return "(no matching images)";
    return (
      `Images (${hits.length}):\n` +
      hits.map((h) => `- [#${h.id}]${h.tags?.length ? ` (${h.tags.join(", ")})` : ""} ${h.content}`).join("\n")
    );
  },
};
