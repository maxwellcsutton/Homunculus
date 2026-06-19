import type { RemoteToolSpec } from "./remote";

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// THE GAME ADAPTER CONTRACT (docs/GAME_ADAPTER.md)
//
// This is the boundary between the BRAIN (this repo) and ANY game it can keep pace with — turn-based, idle,
// text-based, or other paced/pausable games (docs/GAME_TYPES.md). The brain knows nothing
// about a specific game — it speaks this contract over HTTP. To wire a game, implement the HTTP endpoints
// below on the game's side; the `GameAdapter` interface documents the shape of that implementation. There
// is deliberately NO concrete game in this repo — only the contract + a documented stub (stubAdapter.ts).
//
// Two directions:
//   game → brain :  the game POSTs an EVENT to the brain's /api/event when it wants the agent to act.
//   brain → game :  the brain POSTs each tool the agent calls back to the game's exec endpoint, and (for
//                   the agent's OWN voluntary play passes) asks the game to OPEN / CLOSE a session.
//
// Observation in, action out. The snapshot is free-form JSON the brain never interprets — it's rendered
// into the agent's user turn as text. The game owns all game logic; the brain owns the agent's mind.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type { RemoteToolSpec } from "./remote";

// ── game → brain : the event POSTed to /api/event ───────────────────────────────────────────────────
export interface GameEventInput {
  // Event type, e.g. "your_turn", "combat", "level_up". Free-form; the brain just labels the pass with it.
  type: string;
  // The human-readable rendering of the current game state — the agent's view of the world this turn. The
  // game builds this from its state (the brain renders it verbatim into the user turn after "# Now").
  text: string;
  // The game's tool catalog + how to call back + the session token binding calls to game state.
  gameTools?: {
    catalog: RemoteToolSpec[];
    execUrl: string; // brain POSTs {name, args, sessionId} here per tool call
    sessionId: string;
    headers?: Record<string, string>;
  };
  // Force a tool call on the first step (action-required events). Responsiveness, not autonomy.
  forceFirstTool?: boolean;
  // Iteration soft cap + wall-clock budget for this pass (optional).
  maxSteps?: number;
  wallClockMs?: number;
}

// ── brain → game : one tool execution (POSTed to gameTools.execUrl) ─────────────────────────────────
export interface GameToolExecution {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
}
export interface GameToolResult {
  result?: string; // success — a short, structured string the model reads
  error?: string; // failure — a string the model adapts to (the game NEVER throws to the brain)
}

// ── brain → game : a voluntary play session (for the agent's own engage("game") passes) ─────────────
// When the agent CHOOSES to play on its own time, the brain asks the game to open a session: pause the
// world if needed, hand back the current snapshot + tool catalog + a session token. After the pass the
// brain asks the game to close it (apply results, unpause). The brain-side clients are in session.ts;
// these are the shapes they exchange. A game that doesn't support voluntary play simply doesn't expose
// the open endpoint (GAME_OPEN_URL unset) → engage("game") is a clean no-op.
export interface OpenedSession {
  sessionId: string;
  execUrl: string;
  catalog: RemoteToolSpec[];
  snapshotText: string; // the rendered state to act on (same role as GameEventInput.text)
  maxSteps?: number;
  wasPaused?: boolean; // so close can restore the prior run state
  headers?: Record<string, string>;
}

// ── The contract, as an interface (implemented on the GAME side) ────────────────────────────────────
// Documentation of what a game backend provides. The brain doesn't import this — it talks HTTP — but a
// game (or the stub) can implement it to keep the shapes honest.
export interface GameAdapter {
  // Build the agent's text view of the current state (→ GameEventInput.text / OpenedSession.snapshotText).
  buildSnapshotText(): Promise<string>;
  // The tool catalog the agent may call this turn (may vary by phase).
  buildCatalog(): Promise<RemoteToolSpec[]>;
  // Execute one mechanical tool call against the bound session; return a short string (never throw).
  executeTool(exec: GameToolExecution): Promise<GameToolResult>;
  // Open / close a voluntary play session (optional — omit to disable engage("game")).
  openSession?(): Promise<OpenedSession | null>;
  closeSession?(sessionId: string, finalText: string, wasPaused?: boolean): Promise<void>;
}
