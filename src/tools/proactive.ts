import { z } from "zod";
import type { ToolDef } from "./types";
import { isResay, recentAgentMessages } from "@/loop/resay";

// One tool for every message the agent sends the user — answering them OR reaching out on its own. The
// DECISION to message is always the agent's (the social slice of its self-set priorities). Same delivery
// either way (the chat UI's poller picks up the outbound row). The difference is the RAILS, which are
// CONTEXT-DETECTED:
//   • ANSWERING (the user's message is the most recent turn — they're waiting) → no rails; goes straight
//     through.
//   • REACHING OUT (the agent is initiating — its own last turn) → gated behind the PROACTIVE FEATURE
//     FLAG (AGENT_PROACTIVE_ENABLED, default OFF), then quiet hours + a soft cooldown.
// [AGENCY: rails bound only UNPROMPTED initiation, never answering. The flag is a deployment safety switch,
// not the agent's choice; messaging is always its choice within what's enabled. See CLAUDE.md.]

const PROACTIVE_ENABLED = () =>
  ["1", "true", "on", "yes"].includes((process.env.AGENT_PROACTIVE_ENABLED ?? "").toLowerCase());
const ACTIVE_HOURS = {
  start: Number(process.env.AGENT_ACTIVE_START ?? "8"),
  end: Number(process.env.AGENT_ACTIVE_END ?? "23"),
};
const COOLDOWN_MS = Number(process.env.AGENT_REACHOUT_COOLDOWN_MS ?? `${90 * 60 * 1000}`);

const RESAY_LOOKBACK_TURNS = 8;
async function resayRefusal(
  message: string,
  store: { recentChatTurns(limit?: number): Promise<{ role: string; content: string }[]> },
): Promise<string | null> {
  const priors = recentAgentMessages(await store.recentChatTurns(RESAY_LOOKBACK_TURNS));
  if (!(await isResay(message, priors))) return null;
  return "Not sent — that's almost exactly what you just said. Say something new if you've got it, or let it be — you don't have to restate yourself.";
}

export const messageUserTool: ToolDef<{ message: string }> = {
  name: "message_user",
  description:
    "Send the user a message in your own voice — whether you're answering what they said or reaching out " +
    "on your own. It reaches them when you send it. When they're waiting on you it goes straight through; " +
    "reaching out unprompted may be limited by settings (and quiet hours / a soft cooldown). Messaging is " +
    "your choice; you never have to, and you can always sit with something instead.",
  inputSchema: z.object({ message: z.string().max(2000) }),
  modes: ["chat"],
  handler: async (a, ctx) => {
    if (ctx.mode === "game") {
      return "Not sent — messaging the user is your chat surface, and you're heads-down in a game pass right now. Tell them later, on your own time.";
    }
    // ANSWERING vs REACHING OUT: if the user's message is the most recent turn, they're waiting → no rails.
    const recent = await ctx.store.recentChatTurns(1);
    const answering = recent.length > 0 && recent[recent.length - 1].role !== "agent";
    const now = new Date();
    if (!answering) {
      if (!PROACTIVE_ENABLED()) {
        return "Not sent — unprompted outreach is turned off right now. You can hold the thought, or write it in your journal. (You can still answer when the user messages you.)";
      }
      const hour = now.getHours();
      if (hour < ACTIVE_HOURS.start || hour >= ACTIVE_HOURS.end) {
        return `Not sent — quiet hours (you reach out between ${ACTIVE_HOURS.start}:00 and ${ACTIVE_HOURS.end}:00). Hold the thought, or write it in your journal.`;
      }
      const last = await ctx.store.getLastReachOut();
      if (last && now.getTime() - last.getTime() < COOLDOWN_MS) {
        const mins = Math.ceil((COOLDOWN_MS - (now.getTime() - last.getTime())) / 60000);
        return `Not sent — soft cooldown (you reached out recently; try again in ~${mins} min).`;
      }
    }
    const resay = await resayRefusal(a.message, ctx.store);
    if (resay) return resay;
    // Record the agent's turn BEFORE delivering it: a fast user reply could otherwise be inserted between
    // this and the persisted turn and get a lower id, scrambling order + the "who's the last sender"
    // attribution. Persist first → the agent's turn always has the lower id.
    await ctx.store.addChatTurn("agent", a.message);
    if (!answering) await ctx.store.recordReachOut(now);
    await ctx.store.addOutbound(a.message);
    return "message sent.";
  },
};
