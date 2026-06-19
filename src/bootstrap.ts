// Node-only continuous-loop bootstrap. Dynamically imported by instrumentation.ts ONLY inside the
// `NEXT_RUNTIME === "nodejs"` guard, so the scheduler (and its `pg` dependency via the cross-process lock)
// never enters the edge bundle — otherwise Next tries to webpack `pg` for edge and fails to resolve `fs`,
// 500ing every route. The continuous loop (heartbeat + rebake) always runs once the Node server boots.
//
// What the agent DOES each tick is its own (the agency invariant); this only starts the clock + sets its
// cadence. [AGENCY: code-fixed — plumbing: the on-switch + cadence, not behavior]
let started = false;

export async function bootstrap(): Promise<void> {
  if (started) return;
  started = true;

  // If the static base prose changed since the active snapshot was baked (a code edit), rebake so it takes
  // effect now rather than waiting for the next scheduled rebake.
  const { rebakeIfStaticChanged } = await import("@/prompt/baseSnapshot");
  const { prismaStore } = await import("@/store/prisma");
  await rebakeIfStaticChanged(prismaStore).catch((e) => console.error("[bootstrap] base rebake check failed:", e));

  // Freeze the game-tool catalog up front (no-op when no game is configured) so the first game/idle pass's
  // tool prefix is complete + byte-stable.
  const { refreshGameCatalog } = await import("@/game/remote");
  await refreshGameCatalog().catch((e) => console.error("[bootstrap] game catalog fetch failed:", e));

  const { startHeartbeat, startPeriodicRebake } = await import("@/loop/scheduler");
  startHeartbeat();
  startPeriodicRebake();
  const rebakeMs = Number(process.env.AGENT_REBAKE_MS ?? String(60 * 60 * 1000));
  const shared = process.env.AGENT_HEARTBEAT_MS ?? "60000";
  const chatMs = process.env.AGENT_CHAT_HEARTBEAT_MS ?? shared;
  const gameMs = process.env.AGENT_GAME_HEARTBEAT_MS ?? shared;
  const gameClock = process.env.GAME_OPEN_URL ? `, game heartbeat every ${gameMs}ms` : " (no game heartbeat — no game wired)";
  console.log(
    `[bootstrap] continuous loop ON — chat heartbeat every ${chatMs}ms${gameClock}, ` +
      `rebake every ~${Math.round(rebakeMs / 60000)}m.`,
  );
}
