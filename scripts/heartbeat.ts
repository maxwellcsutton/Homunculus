// Fire ONE heartbeat tick by hand (tier-1 triage; runs the tier-2 engagement if the agent escalates).
// Useful for testing the idle loop without waiting for the cadence. Run: npm run heartbeat
import { handleHeartbeat, runTier2 } from "@/loop/heartbeat";
import { IdleSession } from "@/loop/idleSession";

void (async () => {
  const session = new IdleSession();
  const { result, engage } = await handleHeartbeat({}, session);
  console.log(`[heartbeat] tier-1 done — steps=${result.steps}, engage=${engage ? engage.mode : "(pass)"}`);
  if (engage) {
    const r2 = await runTier2(engage.mode, engage.focus, {});
    console.log(`[heartbeat] tier-2 (${engage.mode}) done — steps=${r2.steps}${r2.finalText ? `, said: ${r2.finalText.slice(0, 120)}` : ""}`);
  }
  process.exit(0);
})();
