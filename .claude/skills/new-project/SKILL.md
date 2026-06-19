---
name: new-project
description: Interactive scaffolder that creates a NEW project from this homunculus boilerplate. Use when the user wants to start a new agent/game-bot off this boilerplate, "clone the boilerplate", "set up a new project", or "/new-project". It interviews the user for everything needed (name, target dir, character, game wiring, model/lanes, owner, proactive, cadence, DB), copies the boilerplate to a fresh directory, customizes it from the answers (.env, package name, launchd labels, optional seed character, optional game adapter), validates, and makes an initial commit.
---

# new-project — scaffold a customized copy of the boilerplate

You are an interactive setup tool. Interview the user, then create and customize a new project from this
boilerplate. Work in phases; don't skip the interview. Honor the **agency invariant** (`CLAUDE.md`) — any
"character" you seed is a STARTING STATE the agent can rewrite, never fixed behavior.

## Phase 0 — locate the boilerplate (source)
The boilerplate root is the repo that contains this skill (look for `CLAUDE.md`, `prisma/schema.prisma`,
and `src/loop/engine.ts` at the root). Call it `$SRC`. If you can't find those markers, stop and tell the
user to run this from inside the homunculus boilerplate.

## Phase 1 — gather free-form basics (ask directly)
Ask the user (plain questions, or AskUserQuestion with an "Other" free-text option):
- **Project name** → derive a kebab `$SLUG` (lowercase, hyphens, e.g. "Dungeon Diver" → `dungeon-diver`).
- **Target directory** → default the new project's parent to the boilerplate's parent dir; final path
  `$DEST = <parent>/$SLUG`. **Refuse to proceed if `$DEST` exists and is non-empty** (confirm a different
  path or removal first).

## Phase 2 — gather decisions (use AskUserQuestion; batch ≤4 per call)
1. **Starting character** (header "Character"):
   - *Blank, self-authored (Recommended)* — ships neutral; the agent authors itself from play.
   - *Seed a starting character / domain* — you'll draft `STATIC_HEAD` in `staticBase.ts` from a short
     description the user gives (Phase 3). Still a starting state, not fixed behavior.
2. **Game** (header "Game"):
   - *No game yet — brain only (Recommended)* — leave the GameAdapter dormant.
   - *Wire an existing game* — collect its endpoint URLs in Phase 3 and set `GAME_*` in `.env`.
   - *Scaffold a custom adapter* — copy `stubAdapter.ts` to a named adapter for their game + add TODO notes
     from `docs/GAME_ADAPTER.md` (no working game still — a scaffold to fill in).
3. **Extra model lanes** (header "Lanes", multiSelect): *game lane*, *embedding lane*, *vision lane* (the
   chat lane is always included). Each adds its env block + a note to run the matching `serve*` script.
4. **Proactive outreach** (header "Proactive"): *Off (Recommended)* / *On* → sets `AGENT_PROACTIVE_ENABLED`.

## Phase 3 — gather config values (ask directly; offer sensible defaults)
- Model: `LLAMA_MODEL_PATH`, `LLAMA_SERVER_BIN` (default `/opt/homebrew/bin/llama-server`), `MODEL_NAME`
  (default `qwen3.6`), main port (default 8080). For each extra lane chosen: its port (defaults
  work=8081, embed=8082, vision=8083) + its model path (embed/vision need their own GGUFs).
- `AGENT_OWNER_NAME` (default "the user").
- `AGENT_HEARTBEAT_MS` (default 60000).
- Database: DB name (default `$SLUG` with hyphens→underscores) → build `DATABASE_URL`
  (`postgresql://localhost:5432/<db>?schema=public`), or accept a full URL.
- If **seed character**: a 2–5 sentence description (who the agent is, tone, any domain knowledge).
- If **wire an existing game**: `GAME_EXEC_URL`, `GAME_CATALOG_URL`, optional `GAME_OPEN_URL`/`GAME_CLOSE_URL`,
  optional `GAME_AI_EXEC_TOKEN`.
- Whether to run install/migrate now (needs network + a reachable Postgres) — default yes if they have the DB ready.

Before implementing, briefly echo the collected plan back and proceed (don't wait for a second confirmation
unless something is risky like overwriting a dir).

## Phase 4 — implement
1. **Copy** the boilerplate to `$DEST`, excluding build/secret artifacts:
   ```bash
   mkdir -p "$DEST"
   rsync -a --exclude .git --exclude node_modules --exclude .next --exclude .env \
         --exclude backups --exclude tsconfig.tsbuildinfo --exclude '.claude/settings.local.json' \
         "$SRC"/ "$DEST"/
   ```
   (If `rsync` is unavailable, use `cp -R` then delete the excluded dirs.)
2. **git init** the new repo (`git -C "$DEST" init -q`).
3. **package.json** — set `"name": "$SLUG"` and tailor `"description"` to the project.
4. **launchd labels + logs** — in `$DEST/deploy/`: rename `com.homunculus.*` → `com.$SLUG.*` (plist
   filenames + `<Label>` values + the references in `deploy.sh` / `teardown.sh`), and the log dir
   `homunculus` → `$SLUG` (in the plists, deploy.sh, deploy/README.md).
5. **.env** — copy `$DEST/.env.example` → `$DEST/.env` and fill in every value gathered: `DATABASE_URL`,
   `AGENT_OWNER_NAME`, `AGENT_HEARTBEAT_MS`, `AGENT_PROACTIVE_ENABLED`, `MODEL_BASE_URL`, `MODEL_NAME`,
   `LLAMA_*` paths/ports, the chosen extra-lane URLs (`MODEL_BASE_URL_GAME`, `AGENT_EMBED_URL`,
   `VISION_BASE_URL`) + their `LLAMA_*` blocks, and any `GAME_*`. Leave unused optional vars blank.
6. **Seed character (if chosen)** — edit `$DEST/src/prompt/staticBase.ts`: replace the neutral `NATURE`
   block (and add domain notes) with prose drafted from the user's description. KEEP the `AGENCY`,
   `TOOLS_NOTE`, `MODES_NOTE`, and `CLOSING` blocks intact and KEEP the framing that this is who the agent
   *starts as* and can revise (don't turn it into fixed rules). Keep it concise (it's baked into the warm
   base). Note in `docs/DECISIONS.md` that a seed character was added.
7. **Game (if chosen)** — *wire existing*: the `GAME_*` env from step 5 is enough. *scaffold adapter*: copy
   `src/game/stubAdapter.ts` → `src/game/<Game>Adapter.ts`, rename the class, and leave clearly-marked
   `// TODO` stubs for `buildSnapshotText` / `buildCatalog` / `executeTool` (+ a pointer to
   `docs/GAME_ADAPTER.md`). Do NOT wire it into the loop (the brain talks HTTP) — it's a reference to fill in.
8. **SETUP.md** — write a short `$DEST/SETUP.md` recording every answer (name, character mode, game mode,
   lanes, proactive, owner, cadence, model + DB) and the remaining manual steps. Add a top-line to the new
   repo's `README.md` noting it was generated from the homunculus boilerplate on the chosen settings.
9. **Validate** (only if the user opted to run install): in `$DEST` run `npm install`, `npx prisma generate`,
   then `npm run typecheck`. If the DB is reachable, `npm run db:push`. Report any failures; don't loop on them.
10. **Commit** — `git -C "$DEST" add -A` then commit:
    `chore: scaffold <name> from homunculus boilerplate` with the same Co-Authored-By trailer the repo uses.

## Phase 5 — report
Tell the user: the new path, what was customized, and the exact next steps —
`cd $DEST` → ensure Postgres + the GGUF are in place → `npm run model` → `npm run dev` → open `/chat`. If a
game was chosen, point at `docs/GAME_ADAPTER.md` and the adapter scaffold. Note that `.env` holds secrets
and is gitignored. Remind them the agent starts with an empty self and authors it from play.

## Guardrails
- Never overwrite a non-empty target without explicit confirmation.
- Never copy the source `.env`, `.git`, `node_modules`, `.next`, or `backups` into the new project.
- Keep every customization inside the agency invariant — a seed character/persona is a starting state the
  agent rewrites, never hard-coded behavior. If the user asks for fixed behavior, flag it (`CLAUDE.md` P0).
- Don't reinvent the architecture; only fill in the boilerplate's intended customization points.
