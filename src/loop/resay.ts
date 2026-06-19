import { isNearDuplicate } from "./textSimilarity";
import { embed, cosine, semanticDedupEnabled } from "@/model/embeddings";

// Consecutive-message re-say guard. The agent sends ONE message per turn, so the repeat to catch isn't dup
// lines within a reply — it's sending a message that just restates its LAST one ("say it, then re-say it
// reworded"). Lexical word-overlap can't see a REWORDING; embedding cosine can. So: lexical first (cheap —
// verbatim / high overlap), then semantic. [AGENCY: code-fixed — a thin anti-repeat rail; it never chooses
// WHAT the agent says, only nudges it off restating itself, and it can always say something new or nothing.]

const LOOKBACK = Number(process.env.AGENT_RESAY_LOOKBACK ?? "3");
const threshold = () => Number(process.env.AGENT_SEMANTIC_DEDUP_THRESHOLD ?? "0.80");

// The agent's recent delivered messages from a turn window, newest last, capped at LOOKBACK.
export function recentAgentMessages(turns: { role: string; content: string }[]): string[] {
  return turns
    .filter((t) => t.role === "agent")
    .map((t) => t.content)
    .slice(-LOOKBACK);
}

// Is `text` a near-duplicate of any of the agent's recent delivered messages `priors`? Lexical first, then
// embed-cosine (catches rewordings). Fails OPEN: embed off/error → lexical-only.
export async function isResay(text: string, priors: string[]): Promise<boolean> {
  const t = text.trim();
  if (!t || priors.length === 0) return false;
  if (isNearDuplicate(t, priors)) return true;
  if (!semanticDedupEnabled()) return false;
  const vecs = await embed([t, ...priors]);
  if (!vecs || !vecs[0]) return false;
  const [tv, ...pvs] = vecs;
  const th = threshold();
  return pvs.some((pv) => pv && pv.length > 0 && cosine(tv, pv) >= th);
}
