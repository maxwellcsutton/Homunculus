#!/usr/bin/env bash
# Stop homunculus launchd jobs. `bootout` is the only reliable stop because the jobs are KeepAlive=true
# (a kill/pkill is respawned). The backup timer is left alone unless explicitly named.
#
#   ./deploy/teardown.sh app      # stop the brain
#   ./deploy/teardown.sh model    # stop the main model lane
#   ./deploy/teardown.sh all      # stop app (model lanes are explicit — pass `model`)
set -euo pipefail
UID_NUM="$(id -u)"
TARGET="${1:-all}"

stop() {
  local name="$1"
  launchctl bootout "gui/$UID_NUM/$name" 2>/dev/null && echo "[teardown] stopped $name" || echo "[teardown] $name not loaded"
}

case "$TARGET" in
  app)    stop com.homunculus.app ;;
  model)  stop com.homunculus.model ;;
  backup) stop com.homunculus.backup-hourly ;;
  all)    stop com.homunculus.app ;;
  *) echo "usage: teardown.sh {app|model|backup|all}"; exit 1 ;;
esac
