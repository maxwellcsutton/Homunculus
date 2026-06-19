import { prismaStore } from "@/store/prisma";
import { checkBearer } from "@/server/auth";

export const runtime = "nodejs";

// The UI acks delivered outbound messages so they're not re-shown.
export async function POST(req: Request): Promise<Response> {
  const unauth = checkBearer(req, "chat");
  if (unauth) return unauth;
  let body: { ids?: number[] };
  try {
    body = (await req.json()) as { ids?: number[] };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((n) => Number.isInteger(n)) : [];
  await prismaStore.markOutboundConsumed(ids);
  return Response.json({ ok: true });
}
