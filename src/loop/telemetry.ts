// Lightweight runtime telemetry for the agentic loop + model client — logs TTFT, prefill/decode
// timings (incl. warm-cache hit rate), per-tool latency, and a per-turn summary. ON by default for
// dev/prod so the live logs are legible; silenced under vitest and when AGENT_TELEMETRY=0 so test
// output and intentionally-quiet runs stay clean.
import { AsyncLocalStorage } from "node:async_hooks";

const ON =
  process.env.AGENT_TELEMETRY !== "0" &&
  process.env.VITEST === undefined &&
  process.env.NODE_ENV !== "test";

export function telemetryEnabled(): boolean {
  return ON;
}

// Per-turn SOURCE tag (chat / game / heartbeat / reflect / …) carried via AsyncLocalStorage so EVERY
// tlog line emitted during a turn — including async continuations (model calls, tool logs) — is prefixed
// with where it came from. Concurrency-safe: chat and the game lane can run interleaved in one process,
// and each keeps its own tag. Set at the lane entry points (scheduler) with withLogSource.
const sourceCtx = new AsyncLocalStorage<string>();
export function withLogSource<T>(source: string, fn: () => T): T {
  return sourceCtx.run(source, fn);
}

export function tlog(line: string): void {
  if (!ON) return;
  const src = sourceCtx.getStore();
  console.log(src ? `[${src}] ${line}` : line);
}

/** ms → human ("812ms" / "4.9s"). */
export function ms(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/** tokens/ms → "428 tok/s". Prefers a server-reported rate when one is given. */
export function rate(tokens?: number, msVal?: number, reported?: number): string {
  if (reported && Number.isFinite(reported)) return `${Math.round(reported)} tok/s`;
  if (tokens && msVal && msVal > 0) return `${Math.round(tokens / (msVal / 1000))} tok/s`;
  return "—";
}

/** Collapse whitespace + clip, for one-line arg/result previews. */
export function clip(s: string, n = 80): string {
  const o = (s ?? "").replace(/\s+/g, " ").trim();
  return o.length > n ? `${o.slice(0, n)}…` : o;
}
