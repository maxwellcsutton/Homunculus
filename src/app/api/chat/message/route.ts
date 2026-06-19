import { prismaStore } from "@/store/prisma";
import { submitChatTick } from "@/loop/scheduler";
import { captionAttachments } from "@/model/vision";
import { checkBearer } from "@/server/auth";

export const runtime = "nodejs";

// The user sends a message. We PERSIST it (with any image captions folded into the text), fire a chat-tick
// fire-and-forget (the agent sees it over the warm history + its self-state and MAY reply async), and
// return an ack immediately. The reply, if any, arrives via the outbound channel — the UI polls
// /api/outbound/pending. (docs/ARCHITECTURE.md "the chat path")
export async function POST(req: Request): Promise<Response> {
  const unauth = checkBearer(req, "chat");
  if (unauth) return unauth;

  let body: { content?: string; images?: string[] };
  try {
    body = (await req.json()) as { content?: string; images?: string[] };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const content = (body.content ?? "").trim();
  const images = Array.isArray(body.images) ? body.images.filter((s) => typeof s === "string") : [];
  if (!content && images.length === 0) return Response.json({ error: "empty message" }, { status: 400 });

  // Caption attachments at the doorway (vision lane). Only the caption text flows into the loop; the raw
  // bytes are stored display-only, keyed to this turn.
  const { note, captions } = await captionAttachments(images);
  const turnId = await prismaStore.addChatTurn("user", content + note);
  if (images.length) await prismaStore.addChatImages(turnId, images);
  for (const c of captions) await prismaStore.writeImageCaption(c);

  // Fire-and-forget: the tick runs through the queue/lock; we don't block the user on the model.
  void submitChatTick().catch((e) => console.error("[chat] tick failed:", e));
  return Response.json({ ok: true, turnId });
}
