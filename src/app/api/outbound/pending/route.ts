import { prismaStore } from "@/store/prisma";
import { checkBearer } from "@/server/auth";

export const runtime = "nodejs";

// The UI polls this for the agent's delivered messages (replies + any proactive reach-outs). Returns
// unconsumed outbound rows; the UI renders them and acks via /api/outbound/ack so they aren't re-shown.
export async function GET(req: Request): Promise<Response> {
  const unauth = checkBearer(req, "chat");
  if (unauth) return unauth;
  const pending = await prismaStore.listUnconsumedOutbound(50);
  return Response.json({ messages: pending });
}
