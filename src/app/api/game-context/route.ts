import { prismaStore } from "@/store/prisma";
import { checkBearer } from "@/server/auth";

export const runtime = "nodejs";

// The game backend POSTs its latest state snapshot here after a pass, so the chat-self can reference the
// current game situation without a tool round-trip. game→agent over HTTP (no shared DB). Singleton.
export async function POST(req: Request): Promise<Response> {
  const unauth = checkBearer(req, "game");
  if (unauth) return unauth;
  let body: { body?: string; meta?: unknown };
  try {
    body = (await req.json()) as { body?: string; meta?: unknown };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (typeof body.body !== "string") return Response.json({ error: "needs { body }" }, { status: 400 });
  await prismaStore.setGameContext({ body: body.body, meta: body.meta });
  return Response.json({ ok: true });
}
