import { runLoop, type RunLoopResult } from "./engine";
import { gameMode } from "@/modes/game";
import { getActiveBaseSnapshot } from "@/prompt/baseSnapshot";
import { buildGameTail } from "@/prompt/gameTail";
import { defaultModelClient, gameMaxTokens } from "@/model";
import { setCurrentGameSession, ensureGameCatalog, type RemoteBinding } from "@/game/remote";
import type { GameEventInput } from "@/game/adapter";
import type { Message } from "./types";
import type { IdentityStore } from "@/store/types";
import type { ModelClient } from "@/model/client";

export interface HandleEventDeps {
  store?: IdentityStore;
  model?: ModelClient;
  idSlot?: number;
}

// Shared core of a game pass — used by both the game-initiated path (handleGameEvent) and the agent's own
// voluntary pass (heartbeat.runGameEngage). Binds the live game session for the DURATION of the pass so
// the work-lane tools route mutations to it, runs the loop on game mode + the warm base, and always clears
// the binding afterward.
export async function runGamePass(opts: {
  store: IdentityStore;
  model: ModelClient;
  baseText: string;
  text: string;
  session: RemoteBinding | null;
  type: string;
  forceFirstTool?: boolean;
  maxSteps?: number;
  wallClockMs?: number;
  shouldYield?: () => boolean;
  resumeMessages?: Message[];
  idSlot?: number;
}): Promise<RunLoopResult> {
  const mode = gameMode(opts.baseText);
  setCurrentGameSession(opts.session);
  try {
    return await runLoop({
      mode,
      event: { type: opts.type, mode: "game", text: opts.text, forceFirstTool: opts.forceFirstTool },
      model: opts.model,
      store: opts.store,
      maxSteps: opts.maxSteps,
      wallClockMs: opts.wallClockMs,
      shouldYield: opts.shouldYield,
      resumeMessages: opts.resumeMessages,
      idSlot: opts.idSlot,
    });
  } finally {
    setCurrentGameSession(null);
  }
}

// Game event from the game backend (POST /api/event). Runs on the SAME frozen warm base as chat (so the
// big base prefix stays cache-warm even when game and chat interleave). The game-situational framing +
// the agent's volatile self-state + run-state ride the volatile game tail folded into the user turn.
export async function handleGameEvent(input: GameEventInput, deps: HandleEventDeps = {}): Promise<RunLoopResult> {
  const store = deps.store ?? (await import("@/store/prisma")).prismaStore;
  const model = deps.model ?? defaultModelClient("game", { maxTokens: gameMaxTokens() });

  const snapshot = await getActiveBaseSnapshot(store);

  // Freeze the work-lane catalog from this event the first time (a cold boot may not have fetched
  // GAME_CATALOG_URL yet). Subsequent passes use the frozen catalog (byte-stable tool prefix).
  if (input.gameTools) ensureGameCatalog(input.gameTools.catalog);

  const tail = await buildGameTail(store, snapshot);
  const text = tail ? `${tail}\n\n# Now\n${input.text}` : input.text;

  const session: RemoteBinding | null = input.gameTools
    ? { execUrl: input.gameTools.execUrl, sessionId: input.gameTools.sessionId, headers: input.gameTools.headers }
    : null;

  return runGamePass({
    store,
    model,
    baseText: snapshot.baseText,
    text,
    session,
    type: input.type,
    forceFirstTool: input.forceFirstTool,
    maxSteps: input.maxSteps,
    wallClockMs: input.wallClockMs,
    idSlot: deps.idSlot,
  });
}
