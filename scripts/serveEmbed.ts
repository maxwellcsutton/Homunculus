// Launch llama-server in EMBEDDINGS mode for the semantic say-dedup (src/model/embeddings.ts). Run:
//   npm run embed
//
// A SEPARATE side-port instance (default :8082) from the chat/work servers — embeddings mode changes
// batching/pooling, so it must not share the chat instance. Serves OpenAI /v1/embeddings; point
// AGENT_EMBED_URL at it (http://127.0.0.1:8082/v1) to turn semantic dedup on. Unset → dedup stays lexical.
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

try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env — fine */
}

const BIN = process.env.LLAMA_SERVER_BIN ?? "/opt/homebrew/bin/llama-server";
// A SMALL dedicated embedding GGUF (e.g. nomic-embed-text) — not the chat generator.
const MODEL = process.env.LLAMA_EMBED_MODEL_PATH ?? "/path/to/embed-model.gguf";
const HOST = process.env.LLAMA_EMBED_HOST ?? "127.0.0.1";
const PORT = process.env.LLAMA_EMBED_PORT ?? "8082";
const CTX = process.env.LLAMA_EMBED_CTX ?? "8192";
const NGL = process.env.LLAMA_EMBED_NGL ?? "99";
// Pooling: most sentence-embedding models (nomic/bge/gte) want "mean"; some want "cls".
const POOLING = process.env.LLAMA_EMBED_POOLING ?? "mean";

if (!existsSync(BIN)) {
  console.error(`[embed] llama-server not found at:\n  ${BIN}\nSet LLAMA_SERVER_BIN in .env.`);
  process.exit(1);
}
if (!existsSync(MODEL)) {
  console.error(`[embed] embedding model not found at:\n  ${MODEL}\nSet LLAMA_EMBED_MODEL_PATH in .env.`);
  process.exit(1);
}

const args = ["-m", MODEL, "--embeddings", "--pooling", POOLING, "-ngl", NGL, "-c", CTX, "--host", HOST, "--port", PORT];

void (async () => {
  if (await portInUse(HOST, Number(PORT))) {
    console.error(`[embed] ${HOST}:${PORT} is already in use — stop it first, then re-run.`);
    process.exit(1);
  }
  console.log(`[embed] serving http://${HOST}:${PORT}/v1/embeddings  (pooling=${POOLING})`);
  console.log(`[embed] point AGENT_EMBED_URL at http://${HOST}:${PORT}/v1 to enable semantic dedup`);
  const child = spawn(BIN, args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error("[embed] failed to launch:", err);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
})();
