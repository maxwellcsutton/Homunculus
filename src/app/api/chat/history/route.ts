import { prismaStore } from "@/store/prisma";
import { checkBearer } from "@/server/auth";

export const runtime = "nodejs";

// Recent chat turns for the UI to render on load (oldest→newest), plus any display-only image bytes.
export async function GET(req: Request): Promise<Response> {
  const unauth = checkBearer(req, "chat");
  if (unauth) return unauth;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "50");
  const turns = await prismaStore.recentChatTurns(limit);
  return Response.json({ turns: turns.map((t) => ({ role: t.role, content: t.content, createdAt: t.createdAt })) });
}
