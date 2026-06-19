import type { AnyToolDef } from "@/tools/types";
import type { ModeName } from "@/loop/types";
import { rememberTool, forgetTool } from "./memory";
import { recallTool, recallImagesTool } from "./recall";
import { privateJournalTool, writeJournalTool, currentMomentTool, postProgressTool } from "./journal";
import { reweighFocusTool } from "./priorities";
import { tendSelfTool } from "./state";
import { reviseSelfImageTool } from "./selfImage";
import { formOpinionTool, reviseOpinionTool, dropOpinionTool } from "./opinions";
import { messageUserTool } from "./proactive";

// All registered self-management tools. Per-mode subsets are derived from each tool's `modes`: the model
// only ever sees its own mode's tools, never the union. Game-mechanical tools (move/attack/…) are supplied
// by the external game backend at call time (src/game/remote.ts) — not registered here.
//
// On a tool-name collision between a local tool and a game tool, the local tool wins (the agent's
// memory/journal/opinions belong in the shared store, not the game DB) — a game should send mechanical
// ops only. (See gameLaneTools in src/game/lane.ts.)
export const ALL_TOOLS: AnyToolDef[] = [
  rememberTool,
  forgetTool,
  recallTool,
  recallImagesTool,
  privateJournalTool,
  writeJournalTool,
  currentMomentTool,
  postProgressTool,
  reweighFocusTool,
  tendSelfTool,
  reviseSelfImageTool,
  formOpinionTool,
  reviseOpinionTool,
  dropOpinionTool,
  messageUserTool,
] as AnyToolDef[];

export function toolsForMode(mode: ModeName): AnyToolDef[] {
  return ALL_TOOLS.filter((t) => t.modes.includes(mode));
}
