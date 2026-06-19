// Lexical near-duplicate check — a LEAF module (no imports) so anything can use it without dragging in
// the tool registry. Keeping it dependency-free breaks the cycle the re-say guard would otherwise create
// (resay → sanitizeReply → @/tools → proactive → resay).

// Word-overlap (Jaccard) cutoff: ≥ this = a near-duplicate. The ceiling: heavy SYNONYM rewrites
// ("so good" → "amazing") share too few words for ANY safe lexical threshold — those need the semantic
// (embedding) check. Env-tunable. (Lower = more aggressive, risks clipping distinct lines.)
const DEDUP_THRESHOLD = Number(process.env.AGENT_DEDUP_THRESHOLD ?? "0.7");

// True if `text` near-matches anything in `priors`: exact repeat, one-contains-the-other, or high
// word-overlap rewording. Normalizes away case/punctuation/whitespace first.
export function isNearDuplicate(text: string, priors: string[]): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const n = norm(text);
  if (!n) return false;
  const aWords = new Set(n.split(" "));
  for (const p of priors) {
    const np = norm(p);
    if (!np) continue;
    if (np === n) return true;
    if (n.length > 20 && (np.includes(n) || n.includes(np))) return true;
    const bWords = new Set(np.split(" "));
    const inter = [...aWords].filter((w) => bWords.has(w)).length;
    const union = new Set([...aWords, ...bWords]).size;
    if (union > 0 && inter / union >= DEDUP_THRESHOLD) return true;
  }
  return false;
}
