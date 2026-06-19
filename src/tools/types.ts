import type { z } from "zod";
import type { ModeName } from "@/loop/types";
import type { IdentityStore } from "@/store/types";

// A tool is deterministic code (or a local sim) — never a nested model call. Inputs are a tight zod
// schema (also the JSON-schema contract sent to the model). Handlers return a short string result and
// MUST NOT throw: failures come back as structured error strings so the model can adapt mid-loop. The
// engine enforces this discipline.
export interface ToolDef<T = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<T>;
  modes: ModeName[];
  handler: (args: T, ctx: ToolContext) => string | Promise<string>;
}

// Per-invocation context threaded to handlers: the shared identity store, plus an optional hook the chat
// orchestrator uses to collect image captions the agent surfaced this turn (so they ride its persisted
// reply as history context).
export interface ToolContext {
  mode: ModeName;
  eventType: string;
  store: IdentityStore;
  onSurfaceImage?: (caption: string) => void;
}

// Convenience for registries holding tools of mixed arg types.
export type AnyToolDef = ToolDef<unknown>;
