import { zodToJsonSchema } from "zod-to-json-schema";
import type { AnyToolDef, ToolContext } from "./types";

// The engine's runtime tool shape. Decouples the loop from HOW a tool executes: local identity/self tools
// run an in-process handler; game-mechanical tools run remotely in the external game backend (where the
// game state lives). Both look identical to the loop — {name, description, parameters (JSON Schema),
// execute()} — so the transport is swappable (HTTP callback now; MCP later) without touching the engine.
export interface ResolvedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: unknown, ctx: ToolContext) => Promise<string>;
}

// Wrap a locally-authored ToolDef (zod-validated, in-process). Validation lives here so the engine stays
// transport-agnostic; failures are returned as strings, never thrown.
export function resolveLocal(t: AnyToolDef): ResolvedTool {
  return {
    name: t.name,
    description: t.description,
    parameters: zodToJsonSchema(t.inputSchema, { target: "openAi" }) as Record<string, unknown>,
    execute: async (args, ctx) => {
      const parsed = t.inputSchema.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return `Error: ${t.name} invalid args (${issues}).`;
      }
      return t.handler(parsed.data, ctx);
    },
  };
}

export function resolveLocalAll(tools: AnyToolDef[]): ResolvedTool[] {
  return tools.map(resolveLocal);
}
