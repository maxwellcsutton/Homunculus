// Manually re-bake the warm base snapshot (re-merge memory edits into a fresh byte-stable base). The
// continuous loop does this on a cadence (AGENT_REBAKE_MS); this is the on-demand override. Run: npm run rebake
import { rebakeBase } from "@/prompt/baseSnapshot";
import { prismaStore } from "@/store/prisma";

void (async () => {
  const row = await rebakeBase(prismaStore);
  console.log(`[rebake] baked base snapshot #${row.id} (${row.baseText.length} chars).`);
  process.exit(0);
})();
