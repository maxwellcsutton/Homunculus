import { z } from "zod";
import type { ToolDef } from "./types";

export type EngageMode = "game" | "social" | "reflect";

// Tier-1 escalation. At a heartbeat the agent either PASSES (does nothing, the cheap common case) or calls
// `engage` to step into a higher-access mode. This tool is the DECISION marker — it does nothing itself;
// the dispatcher reads the call's `mode` and runs the matching tier-2 pass. Lives only in the lean tier-1
// toolset, never the general registry, so it can't leak into normal chat/game turns. The choice is
// entirely the agent's. [AGENCY: her-state]
export const engageTool: ToolDef<{ mode: EngageMode; focus?: string }> = {
  name: "engage",
  description:
    "Step into a deeper mode to actually do something with your time — only if something is worth it. " +
    "`game` = play (a build/decision pass on the game). `social` = reach out to the user. `reflect` = sit " +
    "with yourself: journal, re-weigh your focus, tend your self-image and opinions. If nothing here is " +
    "worth your deeper attention, DON'T call this — just stop. Passing is always fine. Put what you want " +
    "to focus on in `focus`.",
  inputSchema: z.object({
    mode: z.enum(["game", "social", "reflect"]),
    focus: z.string().max(500).optional(),
  }),
  modes: ["chat"],
  handler: async (a) => `Engaging ${a.mode} mode${a.focus ? ` — ${a.focus}` : ""}.`,
};

// Pull the escalation choice out of a tier-1 trajectory (the last `engage` call wins).
export function extractEngage(toolCalls: { name: string; args: unknown }[]): { mode: EngageMode; focus?: string } | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (toolCalls[i].name === "engage") {
      const a = toolCalls[i].args as { mode?: EngageMode; focus?: string };
      if (a && (a.mode === "game" || a.mode === "social" || a.mode === "reflect")) {
        return { mode: a.mode, focus: a.focus };
      }
    }
  }
  return null;
}
