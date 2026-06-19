import type { ModeName } from "@/loop/types";
import type { ResolvedTool } from "@/tools/resolved";

// A mode is just a system prompt + a tool subset. One model serves both, switched per invocation by the
// caller. Identity is constant across modes; only the surface and the tool subset differ. Tools are
// ResolvedTools so a mode can mix local self tools with remote game-mechanical tools transparently.
export interface Mode {
  name: ModeName;
  systemPrompt: string;
  tools: ResolvedTool[];
}
