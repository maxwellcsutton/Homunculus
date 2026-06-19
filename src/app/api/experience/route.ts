import { prismaStore } from "@/store/prisma";
import { nudgePerception } from "@/loop/scheduler";
import { checkBearer } from "@/server/auth";

export const runtime = "nodejs";

// The game backend pushes a salient world event here (a win, a loss, a notable moment). It's recorded as an
// Experience and surfaces in the agent's next heartbeat "what's new" delta. We also fire an OFF-cadence
// perception tick so the agent notices it within seconds rather than waiting up to a full heartbeat — but
// whether/how it responds stays its own choice. [AGENCY: perception plumbing only.]
export async function POST(req: Request): Promise<Response> {
  const unauth = checkBearer(req, "game");
  if (unauth) return unauth;
  let body: { kind?: string; content?: string };
  try {
    body = (await req.json()) as { kind?: string; content?: string };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (typeof body.content !== "string" || !body.content.trim()) {
    return Response.json({ error: "needs { content }" }, { status: 400 });
  }
  await prismaStore.addExperience((body.kind ?? "event").trim() || "event", body.content.trim());
  void nudgePerception().catch((e) => console.error("[experience] perception tick failed:", e));
  return Response.json({ ok: true });
}
