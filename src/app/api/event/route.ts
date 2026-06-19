import { submitGameEvent } from "@/loop/scheduler";
import { checkBearer } from "@/server/auth";
import type { GameEventInput } from "@/game/adapter";

export const runtime = "nodejs";

// The game backend POSTs an event here when it wants the agent to act (docs/GAME_ADAPTER.md). The body is a
// GameEventInput: { type, text, gameTools: { catalog, execUrl, sessionId, headers }, forceFirstTool? }. We
// run the pass on the game lane (so it never blocks chat) and return the final text + tool trajectory.
// Game-mechanical tools execute remotely, back in the game, via gameTools.execUrl.
export async function POST(req: Request): Promise<Response> {
  const unauth = checkBearer(req, "game");
  if (unauth) return unauth;

  let input: GameEventInput;
  try {
    input = (await req.json()) as GameEventInput;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (!input?.type || typeof input.text !== "string") {
    return Response.json({ error: "event needs { type, text }" }, { status: 400 });
  }

  const result = await submitGameEvent(input);
  return Response.json({
    finalText: result.finalText,
    stopReason: result.stopReason,
    steps: result.steps,
    toolCalls: result.toolCalls.map((c) => ({ name: c.name, args: c.args })),
  });
}
