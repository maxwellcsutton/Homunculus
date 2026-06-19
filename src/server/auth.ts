import { timingSafeEqual } from "node:crypto";

// Per-caller bearer-token auth. When a caller's token env is set, its route requires
// `Authorization: Bearer <token>`; when unset (local dev), auth is skipped so nothing local breaks.
// [AGENCY: code-fixed — access plumbing, not the agent's behavior]
export type Caller = "game" | "chat";

function tokenFor(caller: Caller): string | undefined {
  return (caller === "game" ? process.env.AGENT_GAME_TOKEN : process.env.AGENT_CHAT_TOKEN) || undefined;
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Returns a 401 Response if auth is REQUIRED and fails; null if the request may proceed.
export function checkBearer(req: Request, caller: Caller): Response | null {
  const expected = tokenFor(caller);
  if (!expected) return null; // no token configured → dev mode, allow
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (got && timingSafeEq(got, expected)) return null;
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
