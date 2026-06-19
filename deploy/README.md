# Deployment (local-native, macOS/launchd)

This is a generic, single-box deploy distilled to placeholders. The
whole system runs locally; there is no public internet surface and no hosted model API.

## Pieces

- **app** (`com.homunculus.app`) — the Next.js brain + the continuous loop (heartbeat + rebake).
- **model** (`com.homunculus.model`) — the main llama-server lane (`scripts/serveModel.ts`).
- **model-game** (optional) — a second llama-server for the game lane (game + idle cognition). Copy the
  model plist, set `LLAMA_PORT` to the game port, and set `MODEL_BASE_URL_GAME` in `.env`. See
  docs/MODEL_SERVING.md + docs/LANES.md.
- **model-embed / model-vision** (optional) — copy the model plist for `npm run embed` / `npm run vision`.
- **backup-hourly** (`com.homunculus.backup-hourly`) — hourly `scripts/backup.ts`.

## First-time setup

1. Install Postgres locally, create the DB, set `DATABASE_URL` in `.env` (copy `.env.example`).
2. `npm install && npm run db:push` (creates the schema).
3. Put your GGUF model path in `.env` (`LLAMA_MODEL_PATH`, `LLAMA_SERVER_BIN`).
4. `./deploy/deploy.sh model` then `./deploy/deploy.sh app`.

`deploy.sh` templates the `__REPO__` / `__HOME__` placeholders in the plists for this machine, installs
them to `~/Library/LaunchAgents`, and (re)starts the job. Logs: `~/Library/Logs/homunculus/`.

## Stop

Jobs are `KeepAlive=true`, so a `kill` is respawned — use `./deploy/teardown.sh <target>` (it `bootout`s).

## Exposing the UIs privately

Recommended: keep internal calls on localhost and expose only the chat UI on a private mesh (e.g.
Tailscale Serve for auto-HTTPS on a `*.ts.net` name). Do NOT use a public ingress. The per-caller bearer
tokens (`AGENT_CHAT_TOKEN` / `AGENT_GAME_TOKEN`, `src/server/auth.ts`) are the second auth layer.
