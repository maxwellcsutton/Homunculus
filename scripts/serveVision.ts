// Launch llama-server with a MULTIMODAL model (e.g. Qwen3-VL + mmproj) for the vision lane — image→text
// captioning (src/model/vision.ts). Run:  npm run vision
//
// A SEPARATE side-port instance (default :8083). It runs a DIFFERENT model from the text generator, so it
// shares NO KV/prefix with those lanes. The `--mmproj` projector is what makes the OpenAI endpoint accept
// `image_url` blocks. Point VISION_BASE_URL at it (http://127.0.0.1:8083/v1) to turn captioning on.
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
const MODEL = process.env.VISION_MODEL_PATH ?? "/path/to/vl-model.gguf";
const MMPROJ = process.env.VISION_MMPROJ_PATH ?? "/path/to/mmproj.gguf"; // REQUIRED — without it the model loads text-only
const HOST = process.env.LLAMA_VISION_HOST ?? "127.0.0.1";
const PORT = process.env.LLAMA_VISION_PORT ?? "8083";
const CTX = process.env.LLAMA_VISION_CTX ?? "8192";
const NGL = process.env.LLAMA_VISION_NGL ?? "99";
const IMAGE_MAX_TOKENS = process.env.LLAMA_VISION_IMAGE_MAX_TOKENS ?? "";

if (!existsSync(BIN)) {
  console.error(`[vision] llama-server not found at:\n  ${BIN}\nSet LLAMA_SERVER_BIN in .env.`);
  process.exit(1);
}
if (!existsSync(MODEL)) {
  console.error(`[vision] VL model not found at:\n  ${MODEL}\nSet VISION_MODEL_PATH in .env.`);
  process.exit(1);
}
if (!existsSync(MMPROJ)) {
  console.error(`[vision] mmproj projector not found at:\n  ${MMPROJ}\nSet VISION_MMPROJ_PATH in .env.`);
  process.exit(1);
}

const args = [
  "-m", MODEL,
  "--mmproj", MMPROJ,
  "-ngl", NGL,
  "-c", CTX,
  ...(IMAGE_MAX_TOKENS ? ["--image-max-tokens", IMAGE_MAX_TOKENS] : []),
  "--host", HOST,
  "--port", PORT,
];

void (async () => {
  if (await portInUse(HOST, Number(PORT))) {
    console.error(`[vision] ${HOST}:${PORT} is already in use — stop it first, then re-run.`);
    process.exit(1);
  }
  console.log(`[vision] serving http://${HOST}:${PORT}/v1  (mmproj ${MMPROJ})`);
  console.log(`[vision] point VISION_BASE_URL at http://${HOST}:${PORT}/v1 to enable captioning`);
  const child = spawn(BIN, args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error("[vision] failed to launch:", err);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
})();
