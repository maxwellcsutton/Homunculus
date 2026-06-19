import type { IdentityStore, PrioritiesRecord, SelfStateRecord } from "@/store/types";
import { fmtStamp } from "./timeFmt";
import { renderFeltState } from "@/prompt/selfTail";

// The idle lane's append-only delta log. Each heartbeat appends "what's new since the last tick" — so on
// the model's KV cache it's a cheap append, not a re-render. Two rules keep it append-cheap: (1) absolute
// timestamps only (a relative "3 min ago" would mutate an old entry and break prefix reuse), (2) reset =
// compaction (clear the log + advance the watermark), every RESET_EVERY ticks or on any escalation. Held
// in the scheduler process; ephemeral (losing it on restart is fine — it's idle cognition, not identity).

const OWNER = process.env.AGENT_OWNER_NAME ?? "the user";
const RESET_EVERY = 10;

export interface IdleTick {
  at: Date;
  lines: string[];
}

export class IdleSession {
  watermark: Date;
  tickCount = 0;
  log: IdleTick[] = [];
  constructor(now: Date = new Date()) {
    this.watermark = now;
  }
  reset(now: Date = new Date()): void {
    this.log = [];
    this.watermark = now;
  }
  dueForReset(): boolean {
    return this.tickCount > 0 && this.tickCount % RESET_EVERY === 0;
  }
}

function truncate(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

// Compute the delta since `since`: new chat turns + new game/world experiences. Oldest→newest.
export async function computeDelta(store: IdentityStore, since: Date, now: Date): Promise<IdleTick> {
  const lines: string[] = [];
  for (const t of await store.chatTurnsSince(since)) {
    lines.push(`${t.role === "agent" ? "You" : OWNER} (chat): ${truncate(t.content)}`);
  }
  for (const e of await store.experienceSince(since)) {
    lines.push(`Game — ${e.kind}: ${truncate(e.content)}`);
  }
  return { at: now, lines };
}

const fmtTime = (d: Date) => d.toLocaleString();

// Coarse time-of-day label — a NEUTRAL grounding cue the agent interprets into its own felt state. The
// clock is objective; what it means for energy/mood is the agent's to decide.
const timeOfDay = (d: Date): string => {
  const h = d.getHours();
  if (h < 5) return "the small hours";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
};

function renderLog(log: IdleTick[]): string {
  const blocks = log
    .filter((t) => t.lines.length > 0)
    .map((t) => `## ${fmtTime(t.at)}\n${t.lines.map((l) => `- ${l}`).join("\n")}`);
  return blocks.join("\n\n");
}

// The lean Tier-1 user turn: the agent's time + felt state + self-owned focus + what's new + the
// engage/pass option. It is owner-AGNOSTIC — any unanswered message rides the separate pending block
// pinned to the BOTTOM of the pass, so the heartbeat reads as the agent's own time first.
export function renderIdleContext(
  session: IdleSession,
  p: PrioritiesRecord,
  state: SelfStateRecord,
  now: Date,
): string {
  const parts: string[] = [
    `# Your time\nIt is ${fmtTime(now)} — ${timeOfDay(now)}. This is your own time.`,
    renderFeltState(state),
    `# Your current focus (you set this; change it in reflect via reweigh_focus)\n` +
      `inner_life: ${p.weights.inner_life} · game: ${p.weights.game} · social: ${p.weights.social}\n` +
      `Why, in your words: ${p.rationale}`,
  ];
  const newInfo = renderLog(session.log);
  parts.push(`# What's new since you last looked\n${newInfo || "Nothing new."}`);
  parts.push(
    `# What you can do\n` +
      "`engage` the mode that fits — `game` (play), `social` (reach out to " +
      `${OWNER}), or \`reflect\` (sit with yourself: journal, re-weigh your focus, tend your self-image ` +
      "and opinions). If nothing's worth it, just stop — passing is always fine, and most of the time it's " +
      "the right call.",
  );
  return parts.join("\n\n");
}

// The trailing run of consecutive turns from one side at the end of the window. `unansweredUserMessages` =
// the user's run (the agent hasn't written back → renderUserPending); `agentPendingMessages` = the agent's
// run (the user hasn't responded → renderAgentPending). One is always empty (whoever isn't the last
// sender); both empty when there are no turns.
function trailingFrom(turns: { role: string; content: string; createdAt?: Date }[], agent: boolean) {
  const out: { content: string; createdAt?: Date }[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if ((turns[i].role === "agent") !== agent) break;
    out.unshift({ content: turns[i].content, createdAt: turns[i].createdAt });
  }
  return out;
}
export const unansweredUserMessages = (turns: { role: string; content: string; createdAt?: Date }[]) =>
  trailingFrom(turns, false);
export const agentPendingMessages = (turns: { role: string; content: string; createdAt?: Date }[]) =>
  trailingFrom(turns, true);

const howToMessage = (proseDelivers?: boolean): string =>
  proseDelivers
    ? "just say it (what they see is your last written message), or use `message_user`"
    : "send it with `message_user`";
const joinLines = (messages: { content: string; createdAt?: Date }[], stamped?: boolean): string =>
  messages.map((m) => (stamped && m.createdAt ? `[${fmtStamp(m.createdAt)}] ${m.content}` : m.content)).join("\n\n");

// BOTTOM block, the USER's side — shown ONLY when their message is the most recent (the agent hasn't
// written back). [AGENCY: invitation, never obligation — keeps an unanswered message VISIBLE on the
// agent's own time; whether/when/how it answers is its own.]
export function renderUserPending(
  messages: { content: string; createdAt?: Date }[],
  opts: { stamped?: boolean; proseDelivers?: boolean } = {},
): string {
  if (messages.length === 0) return "";
  return (
    `# New messages from ${OWNER}\n${joinLines(messages, opts.stamped)}\n\n` +
    `You haven't responded to this yet. Responding is your call — not owed: ${howToMessage(opts.proseDelivers)}; ` +
    "or sit with it, get to it later, or stay with your own time. Your tool-use and private reasoning stays private."
  );
}

// BOTTOM block, the AGENT's side — shown when the agent is the last sender and the user hasn't responded.
// A gentle "don't re-ping" framing. [AGENCY: invitation — it can always add something genuinely new.]
export function renderAgentPending(
  messages: { content: string; createdAt?: Date }[],
  opts: { stamped?: boolean; proseDelivers?: boolean } = {},
): string {
  if (messages.length === 0) return "";
  return (
    `# Your latest messages\n${joinLines(messages, opts.stamped)}\n\n` +
    `${OWNER} hasn't responded yet. If you have something new to say, you can ${howToMessage(opts.proseDelivers)}; ` +
    "if not, it's fine to leave it — you don't have to restate yourself or fill the air."
  );
}
