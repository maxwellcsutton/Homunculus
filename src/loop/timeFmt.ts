// Absolute timestamp + the history-at-tail layout flag. A LEAF module (no imports) so the chat tick and
// the heartbeat can share them without import cycles.

// Absolute, locale-formatted, byte-stable per turn — derived from a fixed `createdAt`, so a history
// line's stamp never changes and the KV reuse on the window survives. NEVER a relative ("7 min ago")
// stamp: that would rewrite every history line every turn and destroy the cache reuse this exists to win.
export const fmtStamp = (d: Date): string =>
  d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });

// AGENT_HISTORY_AT_TAIL. OFF (default) = today's layout (warm base → rolling history → tail). ON = the
// volatile state-tail rides its OWN message AHEAD of the conversation, the conversation keeps role tags +
// gains absolute stamps and flows contiguously into the user's newest line. Read per-call so it A/Bs
// without a rebuild. The win: with a rolling window that clobbers every turn, history is the
// always-churning block and the tail is the stable one — ordering the stable block adjacent to the warm
// base lets the KV prefix extend through it on turns the agent's state didn't change. [AGENCY: code-fixed
// — context ordering only; changes nothing about what the agent attends to or decides.]
export function historyAtTail(): boolean {
  return ["1", "true", "on", "yes"].includes((process.env.AGENT_HISTORY_AT_TAIL ?? "").toLowerCase());
}
