import { tlog } from "@/loop/telemetry";

// Semantic dedup for the say path. Lexical word-overlap can't catch SYNONYM rewordings ("so good today"
// → "amazing today" share too few words), which is the residual "say a thought, then re-say it reworded"
// loop. Embedding cosine catches paraphrases the word-overlap check can't.
//
// OFF unless AGENT_EMBED_URL is set: with no endpoint configured, semanticDedupEnabled() is false and the
// deduper is a no-op (lexical-only). Point AGENT_EMBED_URL at any OpenAI-compatible /embeddings server — a
// llama-server launched with `--embeddings` on a SIDE port (don't reuse the chat instance — embeddings
// mode changes pooling), or a small dedicated embed model. Fails OPEN everywhere: an endpoint error never
// blocks delivery, it just falls back to lexical-only for that message.

// Read at call-time (not module load) so it's a config flip without a restart, and testable.
const embedUrl = () => (process.env.AGENT_EMBED_URL ?? "").trim();
const embedModel = () => process.env.AGENT_EMBED_MODEL ?? "embed";
// Cosine ≥ this = "the same thing reworded". The cutoff is MODEL-DEPENDENT — tune per model.
const defaultThreshold = () => Number(process.env.AGENT_SEMANTIC_DEDUP_THRESHOLD ?? "0.80");

export function semanticDedupEnabled(): boolean {
  return embedUrl().length > 0;
}

// Embed a batch via the OpenAI-compatible /embeddings endpoint. Returns null on any failure (caller
// treats null as "couldn't check" → fail open). One round-trip per call.
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!texts.length) return [];
  if (!semanticDedupEnabled()) return null;
  try {
    const res = await fetch(`${embedUrl().replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: embedModel(), input: texts }),
    });
    if (!res.ok) {
      tlog(`[embed] http ${res.status} — falling back to lexical-only`);
      return null;
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    const vecs = json.data?.map((d) => d.embedding);
    if (!vecs || vecs.length !== texts.length || vecs.some((v) => !Array.isArray(v) || !v.length)) {
      tlog(`[embed] malformed response (got ${vecs?.length ?? 0}/${texts.length}) — lexical-only`);
      return null;
    }
    return vecs;
  } catch (e) {
    tlog(`[embed] error: ${String(e)} — lexical-only`);
    return null;
  }
}

export function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Per-turn semantic deduper: remembers the embeddings of ACCEPTED (delivered) messages and answers
// whether a new one is a paraphrase of one already sent. One instance per loop turn. Disabled / fail-open
// paths return false so it never blocks delivery.
export class SemanticDeduper {
  private vecs: number[][] = [];
  private threshold: number;
  constructor(threshold?: number) {
    this.threshold = threshold ?? defaultThreshold();
  }

  async isDuplicate(text: string): Promise<boolean> {
    if (!semanticDedupEnabled() || !text.trim()) return false;
    const got = await embed([text]);
    if (!got || !got[0]) return false; // fail open — couldn't embed, don't block
    const v = got[0];
    for (const prev of this.vecs) {
      if (cosine(prev, v) >= this.threshold) return true;
    }
    this.vecs.push(v);
    return false;
  }
}
