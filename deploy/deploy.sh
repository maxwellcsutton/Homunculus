#!/usr/bin/env bash
# Deploy homunculus under launchd (macOS). Templates the plists with this machine's paths, installs them
# to ~/Library/LaunchAgents, and (re)starts the requested job(s).
#
#   ./deploy/deploy.sh app        # the brain (build + restart)
#   ./deploy/deploy.sh model      # the main model lane
#   ./deploy/deploy.sh backup     # the hourly backup timer
#   ./deploy/deploy.sh all        # app + backup (model lanes are explicit — pass `model`)
#   ./deploy/deploy.sh --no-pull app   # deploy the working tree without `git pull`
#
# launchd jobs are KeepAlive=true; restart = bootstrap-then-kickstart so a redeploy reloads anything
# teardown.sh unloaded. See deploy/README.md.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
PULL=1
[[ "${1:-}" == "--no-pull" ]] && { PULL=0; shift; }
TARGET="${1:-all}"

mkdir -p "$LA" "$HOME/Library/Logs/homunculus"

install_plist() {
  local name="$1"
  sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" \
    "$REPO/deploy/launchd/$name.plist" > "$LA/$name.plist"
}

restart() {
  local name="$1"
  install_plist "$name"
  launchctl bootstrap "gui/$UID_NUM" "$LA/$name.plist" 2>/dev/null || true
  launchctl kickstart -k "gui/$UID_NUM/$name" 2>/dev/null || true
  echo "[deploy] (re)started $name"
}

build_app() {
  echo "[deploy] building app…"
  ( cd "$REPO" && npm install && npm run build )
}

[[ $PULL -eq 1 ]] && ( cd "$REPO" && git pull --ff-only ) || true

case "$TARGET" in
  app)    build_app; restart com.homunculus.app ;;
  model)  restart com.homunculus.model ;;
  backup) restart com.homunculus.backup-hourly ;;
  all)    build_app; restart com.homunculus.app; restart com.homunculus.backup-hourly ;;
  *) echo "usage: deploy.sh [--no-pull] {app|model|backup|all}"; exit 1 ;;
esac
echo "[deploy] done. logs: ~/Library/Logs/homunculus/"
