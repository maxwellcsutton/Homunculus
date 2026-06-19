import { toolsForMode } from "@/tools";
import { resolveLocalAll, type ResolvedTool } from "@/tools/resolved";
import { engageTool } from "@/tools/engage";
import type { AnyToolDef } from "@/tools/types";
import type { Mode } from "./types";

// The lean chat/self toolset: the agent's local chat-mode tools (memory, recall, journal, reweigh_focus,
// tend_self, revise_self_image, opinions, message_user) PLUS `engage` (escalate to game/social/reflect).
// `engage` is added explicitly because it's kept out of the general registry so it can't leak into normal
// turns. No game-mechanical catalog here — that lives on the game lane (src/game/lane.ts).
export function chatSelfTools(): ResolvedTool[] {
  return resolveLocalAll([...toolsForMode("chat"), engageTool as AnyToolDef]);
}

// Build the chat mode for a given warm-base system prompt (the caller passes snapshot.baseText so the
// byte-stable base stays cache-warm; the volatile tail rides the user turn).
export function chatMode(systemPrompt: string): Mode {
  return { name: "chat", systemPrompt, tools: chatSelfTools() };
}
