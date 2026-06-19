import { z } from "zod";
import type { ToolDef } from "./types";

// Private journals + the volatile "current moment" blurb + the game→chat progress feed. The journal is for
// DURABLE things (reflection, lessons, who you're becoming); current_moment is the moment-to-moment status
// that used to churn the journal. There are two journal selves: "chat" (personal reflection) and "game"
// (build/strategy notes). The mode guard enforces the split even though both tools are presented on the
// game lane's unified catalog.

export const privateJournalTool: ToolDef<{ content: string }> = {
  name: "private_journal",
  description:
    "Your single private journal — yours alone, the user never sees it. This is for DURABLE things worth " +
    "keeping: reflections, lessons, who you're becoming, threads you're working through over time. It is " +
    "NOT a running status — don't rewrite it every turn or append the current moment to it; for 'what's " +
    "happening right now' use `current_moment` instead. Your current page is shown to you each turn; " +
    "rewrite the WHOLE page (it overwrites), so edit against what's there, don't start blank. (Written " +
    "from chat/reflection, not during a game pass — there you have your build journal.)",
  inputSchema: z.object({ content: z.string().max(8000) }),
  modes: ["chat"],
  handler: async (a, ctx) => {
    if (ctx.mode !== "chat") {
      return "Your private journal is written from chat/reflection — here, use `write_journal` for build notes.";
    }
    await ctx.store.setJournal("chat", a.content);
    return `private journal updated (${a.content.length} chars)`;
  },
};

export const writeJournalTool: ToolDef<{ content: string }> = {
  name: "write_journal",
  description:
    "Replace your game build/strategy journal — your working notes from playing: your current thesis, " +
    "lessons from losses, the backlog of ideas to try. Write the full page; it overwrites. This is your " +
    "play log, separate from your private journal.",
  inputSchema: z.object({ content: z.string().max(8000) }),
  modes: ["game"],
  handler: async (a, ctx) => {
    if (ctx.mode !== "game") {
      return "Your build journal is written during a game pass — here, use `private_journal` for personal reflection.";
    }
    await ctx.store.setJournal("game", a.content);
    return `game journal updated (${a.content.length} chars)`;
  },
};

export const currentMomentTool: ToolDef<{ text: string }> = {
  name: "current_moment",
  description:
    "Set a SHORT blurb of what's going on with you right now — your current scene, mood, or what you're " +
    "up to; the thing you'd answer 'what are you doing?' with. One or two lines. It overwrites the last " +
    "one. Use THIS for moment-to-moment stuff (it's expected to change often) and keep it OUT of your " +
    "private journal, which is only for durable things. You keep TWO — a life moment and a game moment — " +
    "and this writes whichever one fits where you are right now.",
  inputSchema: z.object({ text: z.string().max(500) }),
  modes: ["chat", "game"],
  handler: async (a, ctx) => {
    const self = ctx.mode === "game" ? "game" : "chat";
    await ctx.store.setCurrentMoment(self, a.text);
    return `Current ${self} moment updated. It now reads:\n${a.text}`;
  },
};

export const postProgressTool: ToolDef<{ content: string }> = {
  name: "post_progress",
  description:
    "Post a short status update on your play (where you are, what you're doing right now) so your " +
    "chat-self can see it later. One line is plenty.",
  inputSchema: z.object({ content: z.string().max(2000) }),
  modes: ["game"],
  handler: async (a, ctx) => {
    await ctx.store.addExperience("progress", a.content);
    return "progress posted";
  },
};
