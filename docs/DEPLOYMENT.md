# Deployment

The runbook lives next to the scripts: **`deploy/README.md`**. Quick version (local-native, macOS/launchd):

1. Local Postgres; set `DATABASE_URL` in `.env` (from `.env.example`); `npm install && npm run db:push`.
2. Point `.env` at your GGUF (`LLAMA_MODEL_PATH`, `LLAMA_SERVER_BIN`).
3. `./deploy/deploy.sh model` then `./deploy/deploy.sh app`. Logs: `~/Library/Logs/homunculus/`.
4. Stop with `./deploy/teardown.sh <target>` (the jobs are `KeepAlive` — `bootout` is the only reliable stop).

Optional lanes (each its own llama-server instance): copy the model plist for the game lane
(`MODEL_BASE_URL_GAME`), embed (`npm run embed`, `AGENT_EMBED_URL`), and vision (`npm run vision`,
`VISION_BASE_URL`). See `docs/MODEL_SERVING.md` + `docs/LANES.md`.

Keep everything on localhost / a private mesh; expose only the chat UI (e.g. Tailscale Serve), never a
public ingress. Per-caller bearer tokens (`AGENT_CHAT_TOKEN` / `AGENT_GAME_TOKEN`) are the second auth layer.

Back up the identity store: `npm run backup` (hourly via the launchd timer) and `npm run backup:verify`
(restore drill) — an untested backup is a hope, not a backup.
