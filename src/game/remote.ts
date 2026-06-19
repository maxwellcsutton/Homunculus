import type { ResolvedTool } from "@/tools/resolved";
import type { ToolContext } from "@/tools/types";
import { tlog, ms } from "@/loop/telemetry";

// Remote (game-mechanical) tools. The agent's identity/self tools run in-process; the GAME's mechanical
// tools (move, attack, take_item, …) run in the external game backend, where the game state lives. Both
// look identical to the loop (a ResolvedTool). This module holds (a) the frozen, byte-stable tool catalog
// for the work-lane prompt prefix, (b) the current live session binding for the pass, and (c) the executor
// that POSTs a tool call to the game's exec callback. See docs/GAME_ADAPTER.md.

// One game-mechanical tool the backend exposes. `parameters` is a JSON Schema (the same shape a local
// ResolvedTool carries), so the model sees game tools and self tools uniformly.
export interface RemoteToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// What the game sends with a game event so the agent can execute its tools: the catalog + where to call
// back + the opaque session token that binds a call to the game's state.
export interface RemoteToolsetConfig {
  catalog: RemoteToolSpec[];
  execUrl: string; // POST {name, args, sessionId} here; expect {result?|error?}
  sessionId: string;
  headers?: Record<string, string>;
}

// The live binding for the DURATION of one pass (execUrl + session + auth). Set before the loop, cleared
// after. The remote tools route their mutations through whatever binding is current.
export interface RemoteBinding {
  execUrl: string;
  sessionId: string;
  headers?: Record<string, string>;
}

let currentSession: RemoteBinding | null = null;
export function setCurrentGameSession(b: RemoteBinding | null): void {
  currentSession = b;
}

// The frozen catalog. Game tools render at the FRONT of the work-lane prompt, so the catalog must be
// byte-stable across passes to keep that lane's KV prefix warm (a changed tool list = a cold re-prefill).
// We freeze it once (from the boot fetch or the first event) and only refresh on the rebake cadence.
let frozenCatalog: RemoteToolSpec[] = [];
export function ensureGameCatalog(catalog: RemoteToolSpec[]): void {
  if (frozenCatalog.length === 0 && catalog.length > 0) {
    frozenCatalog = catalog;
    tlog(`[game] froze tool catalog (${catalog.length} tools)`);
  }
}
export function frozenGameCatalog(): RemoteToolSpec[] {
  return frozenCatalog;
}

// Fetch the catalog from GAME_CATALOG_URL (GET → { catalog: RemoteToolSpec[] }) and re-freeze. Called at
// boot and on the rebake cadence so a tool-list change is picked up at a cache-cold moment, not mid-window.
// No-op (clean) when no game is configured.
export async function refreshGameCatalog(): Promise<void> {
  const url = process.env.GAME_CATALOG_URL;
  if (!url) return;
  try {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      tlog(`[game] catalog fetch http ${res.status} — keeping current catalog`);
      return;
    }
    const json = (await res.json()) as { catalog?: RemoteToolSpec[] };
    if (json.catalog && json.catalog.length) {
      frozenCatalog = json.catalog;
      tlog(`[game] refreshed tool catalog (${json.catalog.length} tools)`);
    }
  } catch (e) {
    tlog(`[game] catalog fetch error: ${String(e)} — keeping current catalog`);
  }
}

function authHeaders(): Record<string, string> {
  const tok = process.env.GAME_AI_EXEC_TOKEN;
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

// Execute one remote tool call against the bound session. Returns a short string result; failures come
// back as strings (never thrown), so the model can adapt mid-loop — the same discipline as local tools.
async function execRemote(name: string, args: unknown): Promise<string> {
  if (!currentSession) return `Error: ${name} unavailable — no game session is bound right now.`;
  const t0 = performance.now();
  try {
    const res = await fetch(currentSession.execUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(currentSession.headers ?? {}) },
      body: JSON.stringify({ name, args, sessionId: currentSession.sessionId }),
    });
    if (!res.ok) return `Error: ${name} failed (game http ${res.status}).`;
    const json = (await res.json()) as { result?: string; error?: string };
    tlog(`[game-tool] ${name} ${ms(performance.now() - t0)}`);
    return json.error ? `Error: ${json.error}` : json.result ?? "(no result)";
  } catch (e) {
    return `Error: ${name} failed (${e instanceof Error ? e.message : String(e)}).`;
  }
}

// Wrap a remote spec as a ResolvedTool the engine runs identically to a local one. No local zod schema —
// the JSON Schema the game supplied IS the contract; the game validates and returns a string either way.
export function resolveRemote(spec: RemoteToolSpec): ResolvedTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (args: unknown, _ctx: ToolContext) => execRemote(spec.name, args),
  };
}
