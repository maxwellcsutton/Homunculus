import { toolsForMode } from "@/tools";
import { resolveLocalAll, type ResolvedTool } from "@/tools/resolved";
import { frozenGameCatalog, resolveRemote } from "./remote";

// The work-lane (game-mode) toolset: the agent's LOCAL game-mode self tools (remember, recall, journal,
// current_moment, post_progress, opinions) PLUS the frozen REMOTE game-mechanical catalog. Assembled from
// the frozen catalog (NOT a per-event one) so the tool prefix is byte-stable across passes and the work
// lane stays cache-warm. On a name collision the LOCAL tool wins — the agent's self-state belongs in the
// shared store, not the game DB; a game should expose mechanical ops only.
export function gameLaneTools(): ResolvedTool[] {
  const local = resolveLocalAll(toolsForMode("game"));
  const localNames = new Set(local.map((t) => t.name));
  const remote = frozenGameCatalog()
    .filter((s) => !localNames.has(s.name))
    .map(resolveRemote);
  return [...local, ...remote];
}
