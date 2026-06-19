import type { GameAdapter, GameToolExecution, GameToolResult, OpenedSession, RemoteToolSpec } from "./adapter";

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// STUB / REFERENCE adapter — NOT wired into anything. It exists only to show the shape of a real game
// adapter and to document the contract in code. This repo ships NO working game (by design); to wire a
// real one, implement these methods on YOUR game backend's HTTP endpoints (see docs/GAME_ADAPTER.md) and
// point GAME_EXEC_URL / GAME_CATALOG_URL / GAME_OPEN_URL / GAME_CLOSE_URL at them.
//
// The methods below are deliberately minimal placeholders. A real game would build the snapshot text from
// its state, expose its mechanical tools, and execute them against game state keyed by sessionId.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// A tiny example catalog so the shape is concrete. A real game's tools depend entirely on the game.
const EXAMPLE_CATALOG: RemoteToolSpec[] = [
  {
    name: "move",
    description: "Move in a direction.",
    parameters: {
      type: "object",
      properties: { direction: { type: "string", enum: ["north", "south", "east", "west"] } },
      required: ["direction"],
    },
  },
  {
    name: "take",
    description: "Take an item that's present in the current location.",
    parameters: {
      type: "object",
      properties: { item: { type: "string" } },
      required: ["item"],
    },
  },
];

export class StubGameAdapter implements GameAdapter {
  async buildSnapshotText(): Promise<string> {
    // A real adapter renders the live game state here. This is what the agent "sees" this turn.
    return [
      "Location: a quiet clearing in a forest.",
      "Exits: north, east.",
      "You see: a brass lantern, a weathered note.",
      "Your inventory: empty.",
    ].join("\n");
  }

  async buildCatalog(): Promise<RemoteToolSpec[]> {
    return EXAMPLE_CATALOG;
  }

  async executeTool(exec: GameToolExecution): Promise<GameToolResult> {
    // A real adapter loads game state by exec.sessionId, applies the move, and returns a short result.
    // Failures return { error } — never throw to the brain.
    switch (exec.name) {
      case "move":
        return { result: `You move ${String((exec.args as { direction?: string }).direction ?? "?")}.` };
      case "take":
        return { result: `You take the ${String((exec.args as { item?: string }).item ?? "thing")}.` };
      default:
        return { error: `unknown tool: ${exec.name}` };
    }
  }

  async openSession(): Promise<OpenedSession | null> {
    // A real adapter would pause its world, snapshot it, and return a session token. The stub declines.
    return null;
  }

  async closeSession(_sessionId: string, _finalText: string, _wasPaused?: boolean): Promise<void> {
    // A real adapter applies results + unpauses here.
  }
}
