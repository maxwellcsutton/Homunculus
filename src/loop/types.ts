// Core types for the one agentic loop engine. Model-format-agnostic at the app layer: the engine
// consumes tool calls + final text and nothing about how the model internally structures reasoning vs
// output. The agent's reply role is "agent" (→ "assistant" on the wire).

export type ModeName = "chat" | "game";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface SystemMessage {
  role: "system";
  content: string;
}
export interface UserMessage {
  role: "user";
  content: string;
}
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls?: ToolCall[];
}
export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// One unit of work for the loop. `mode` is set by the caller/event source, never inferred by the model.
// `text` is the rendered event/user input.
export interface LoopEvent {
  type: string;
  mode: ModeName;
  text: string;
  // Force a tool call on the first step (action-required events, e.g. a game turn that demands an
  // action), mirroring a forced first call. Responsiveness, not autonomy.
  forceFirstTool?: boolean;
}

// "yielded" = cooperatively stopped at a tool-call boundary to let a higher-priority forced event run;
// the returned `messages` are the resume point.
export type StopReason = "final" | "max_steps" | "wall_clock" | "yielded";
