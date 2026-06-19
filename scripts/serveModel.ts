// Launch llama-server with a VALIDATED serving config, baked in so you
// don't retype it.  Run:  npm run model
//
// The one that bites: `-np 1` (single slot). The default multi-slot server load-balances chat turns across
// DIFFERENT slots, so consecutive turns land on cold slots → a full base re-prefill every message. One slot
// = one warm KV prefix = reliably cached chat. (docs/MODEL_SERVING.md, docs/WARM_BASE_CACHING.md)
//
// Machine-specific bits (binary, model path, port) are env-overridable; the validated reasoning/anti-loop
// flags are constants. To run a SECOND instance for the game lane, set LLAMA_PORT + MODEL_BASE_URL_GAME and
// run this script again (the game instance honors LLAMA_REASONING_BUDGET_GAME / drops DRY automatically).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// Best-effort .env load so LLAMA_*/MODEL_* overrides are picked up without exporting them.
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env — fine */
}

const BIN = process.env.LLAMA_SERVER_BIN ?? "/opt/homebrew/bin/llama-server";
const MODEL = process.env.LLAMA_MODEL_PATH ?? "/path/to/your/model.gguf";
const HOST = process.env.LLAMA_HOST ?? "127.0.0.1";
const PORT = process.env.LLAMA_PORT ?? "8080";
const CTX = process.env.LLAMA_CTX ?? "131072";
const NP = process.env.LLAMA_NP ?? "1"; // single slot — see the warning above
const NGL = process.env.LLAMA_NGL ?? "99";
// --cpu-moe offloads MoE expert tensors to CPU. Necessary on a limited-VRAM GPU, but CRIPPLES generation on
// a big unified-memory machine (e.g. Mac Studio) where every layer fits on the GPU. LLAMA_CPU_MOE=0 to drop it.
const CPU_MOE = !["0", "off", "false", "no", ""].includes((process.env.LLAMA_CPU_MOE ?? "1").toLowerCase());

// Reasoning config. This class of model emits clean tool_calls when it produces a <think> block and LEAKS
// tool intent as text when it skips reasoning. So force reasoning ON and BOUND the budget (so a rambling
// <think> can't eat the whole max_tokens and emit no answer — keep BUDGET comfortably below MODEL_MAX_TOKENS).
const REASONING = process.env.LLAMA_REASONING ?? "on";
// GAME-lane reasoning-budget override: a per-request reasoning_budget isn't honored by this build, only the
// server-level flag. The game instance (port == MODEL_BASE_URL_GAME) honors LLAMA_REASONING_BUDGET_GAME;
// the chat instance ignores it. So both servers can read the same .env safely.
function gameLanePort(): string | null {
  const w = process.env.MODEL_BASE_URL_GAME;
  if (!w || w === process.env.MODEL_BASE_URL) return null;
  try {
    return new URL(w).port || null;
  } catch {
    return null;
  }
}
const IS_GAME_LANE = gameLanePort() === String(PORT);
const REASONING_BUDGET_GAME =
  IS_GAME_LANE && process.env.LLAMA_REASONING_BUDGET_GAME ? process.env.LLAMA_REASONING_BUDGET_GAME : undefined;
const REASONING_BUDGET = REASONING_BUDGET_GAME ?? process.env.LLAMA_REASONING_BUDGET ?? "2048";

// Repetition control at GENERATION (counters the runaway "spam the same message" loop). Keep gentle for
// coherence — token-level penalties can't stop a REWORDED loop anyway (the engine's re-say guard does that).
const FREQUENCY_PENALTY = process.env.LLAMA_FREQUENCY_PENALTY ?? "0.25";
const PRESENCE_PENALTY = process.env.LLAMA_PRESENCE_PENALTY ?? "0";
const REPEAT_PENALTY = process.env.LLAMA_REPEAT_PENALTY ?? "1.0";
const REPEAT_LAST_N = process.env.LLAMA_REPEAT_LAST_N ?? "256";

// DRY sampler — the real fix for verbatim/near-verbatim repeat loops (penalizes repeated n-gram SEQUENCES,
// growing exponentially with match length). Chat lane only; the game lane opts out (its own backstop covers
// loops and the per-token scan is decode overhead we don't want there).
const DRY_MULTIPLIER = process.env.LLAMA_DRY_MULTIPLIER ?? "0.8";
const DRY_BASE = process.env.LLAMA_DRY_BASE ?? "1.75";
const DRY_ALLOWED_LENGTH = process.env.LLAMA_DRY_ALLOWED_LENGTH ?? "2";
const DRY_PENALTY_LAST_N = process.env.LLAMA_DRY_PENALTY_LAST_N ?? "1024";
const DRY_ON = DRY_MULTIPLIER !== "0" && !IS_GAME_LANE;

// Sampler chain ORDER. For Qwen reasoning models, penalties-before-temperature can cause endless generation;
// moving temperature ahead of dry/penalties fixes it. Default EMPTY = stock order (today's baseline). To A/B:
// LLAMA_SAMPLERS="top_k;top_p;min_p;temperature;dry;penalties". Chat lane only.
const SAMPLERS = (process.env.LLAMA_SAMPLERS ?? "").trim();
const SAMPLERS_ON = SAMPLERS !== "" && !IS_GAME_LANE;

// KV-cache dtype. f16 on Apple Metal (the flash-attention kernel is most optimized for f16 KV; quantizing
// adds per-token dequant work there). On a CUDA box, q8_0 can help at depth.
const CACHE_TYPE_K = process.env.LLAMA_CACHE_TYPE_K ?? "f16";
const CACHE_TYPE_V = process.env.LLAMA_CACHE_TYPE_V ?? "f16";

if (!existsSync(BIN)) {
  console.error(`[model] llama-server not found at:\n  ${BIN}\nSet LLAMA_SERVER_BIN in .env to its path.`);
  process.exit(1);
}
if (!existsSync(MODEL)) {
  console.error(`[model] model file not found at:\n  ${MODEL}\nSet LLAMA_MODEL_PATH in .env to its path.`);
  process.exit(1);
}

const args = [
  "-m", MODEL,
  "--jinja",
  "-ngl", NGL,
  ...(CPU_MOE ? ["--cpu-moe"] : []),
  "-fa", "on",
  "-ctk", CACHE_TYPE_K,
  "-ctv", CACHE_TYPE_V,
  "-c", CTX,
  "-np", NP,
  "-rea", REASONING,
  "--reasoning-budget", REASONING_BUDGET,
  "--frequency-penalty", FREQUENCY_PENALTY,
  "--presence-penalty", PRESENCE_PENALTY,
  "--repeat-penalty", REPEAT_PENALTY,
  "--repeat-last-n", REPEAT_LAST_N,
  ...(DRY_ON
    ? ["--dry-multiplier", DRY_MULTIPLIER, "--dry-base", DRY_BASE, "--dry-allowed-length", DRY_ALLOWED_LENGTH, "--dry-penalty-last-n", DRY_PENALTY_LAST_N]
    : []),
  ...(SAMPLERS_ON ? ["--samplers", SAMPLERS] : []),
  "--host", HOST,
  "--port", PORT,
];

void (async () => {
  if (await portInUse(HOST, Number(PORT))) {
    console.error(
      `[model] ${HOST}:${PORT} is already in use — stop it first, then re-run. A new server can't take a ` +
        `bound port; the OLD config would keep serving silently.`,
    );
    process.exit(1);
  }
  console.log(`[model] ${BIN}`);
  console.log(`[model] ${MODEL}`);
  console.log(`[model] serving http://${HOST}:${PORT}  (ctx=${CTX}, -np=${NP}, ngl=${NGL}, cpu-moe=${CPU_MOE ? "on" : "off"}, lane=${IS_GAME_LANE ? "game" : "chat"})`);
  console.log(`[model] reasoning=${REASONING}, budget=${REASONING_BUDGET}${REASONING_BUDGET_GAME ? " (work-lane override)" : ""}`);
  console.log(`[model] DRY: ${DRY_ON ? `on (mult=${DRY_MULTIPLIER})` : "off (game lane or disabled)"} · samplers: ${SAMPLERS_ON ? `"${SAMPLERS}"` : "stock"}`);
  if (NP !== "1") console.warn(`[model] ⚠️  -np=${NP} (>1): a single instance scatters chat across cold slots → cold prefills. Use 1 unless you run an instance per lane.`);

  const child = spawn(BIN, args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error("[model] failed to launch:", err);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
})();
