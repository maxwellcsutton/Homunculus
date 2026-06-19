import type { OpenedSession } from "./adapter";
import { tlog } from "@/loop/telemetry";

// Brain-side clients for a VOLUNTARY play session (the agent's own engage("game") pass). These speak HTTP
// to the game's open/close endpoints. When no game is configured (GAME_OPEN_URL unset), openBuildSession()
// returns null and engage("game") is a clean no-op — exactly the boilerplate default (no game wired yet).

function authHeaders(): Record<string, string> {
  const tok = process.env.GAME_AI_EXEC_TOKEN;
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

// Ask the game to open a session: pause the world if needed and hand back the snapshot + catalog + token.
// Returns null when no game is configured or the call fails (the caller treats null as "nothing to play").
export async function openBuildSession(): Promise<OpenedSession | null> {
  const url = process.env.GAME_OPEN_URL;
  if (!url) return null;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() } });
    if (!res.ok) {
      tlog(`[game] open session http ${res.status} — nothing to play`);
      return null;
    }
    const json = (await res.json()) as OpenedSession;
    if (!json?.sessionId || !json?.execUrl) {
      tlog("[game] open session returned an incomplete payload — nothing to play");
      return null;
    }
    return json;
  } catch (e) {
    tlog(`[game] open session error: ${String(e)} — nothing to play`);
    return null;
  }
}

// Ask the game to close the session: apply results, unpause if it was paused. Best-effort.
export async function closeBuildSession(sessionId: string, finalText: string, wasPaused?: boolean): Promise<void> {
  const url = process.env.GAME_CLOSE_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ sessionId, finalText, wasPaused }),
    });
  } catch (e) {
    tlog(`[game] close session error: ${String(e)}`);
  }
}
