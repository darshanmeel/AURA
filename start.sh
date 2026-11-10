#!/usr/bin/env bash
# Native (no Docker) run on Linux/macOS: watcher + dbt cycle + frontend.
#   ./start.sh            start, Ctrl+C stops both
#   ./start.sh --rebuild  force `npm run build` and `pip install -e watcher`
#   ./start.sh stop       stop a running instance (reads data/state/native.pids)
# Untested on Linux/macOS (written on Windows, checked with `bash -n` only).
set -euo pipefail
cd "$(dirname "$0")"

REPO="$PWD"
DATA="$REPO/data"
PID_FILE="$DATA/state/native.pids"
REBUILD=0

stop() {
  trap - INT TERM EXIT
  [ -f "$PID_FILE" ] || return 0
  while read -r pid; do
    [ -n "$pid" ] || continue
    # Children first (the watcher's dbt), so no orphan dbt holds the work-DB lock;
    # then SIGTERM the parent, which makes the watcher do its final flush.
    pkill -TERM -P "$pid" || true
    kill -TERM "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  wait || true
  rm -f "$PID_FILE"
  echo "Aura stopped."
}

case "${1:-}" in
  stop) stop; exit 0 ;;
  --rebuild) REBUILD=1 ;;
  "") ;;
  *) echo "usage: $0 [--rebuild|stop]" >&2; exit 64 ;;
esac

# 1. The watcher's own mode guard is the real enforcement; this is an early, clearer error.
if command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q --filter name=aura-watcher 2>/dev/null || true)" ]; then
  echo "The compose watcher is running. Run 'docker compose down' first (never run both modes at once)." >&2
  exit 1
fi

# 2. Python 3.12 venv (watcher + dbt) and Node >= 20.
PY="$REPO/.venv/bin/python"
FRESH=0
if [ ! -x "$PY" ]; then
  command -v python3.12 >/dev/null 2>&1 || { echo "Python 3.12 (python3.12) is required." >&2; exit 1; }
  python3.12 -m venv "$REPO/.venv"
  FRESH=1
fi
PYVER="$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
[ "$PYVER" = "3.12" ] || { echo ".venv uses Python $PYVER; delete .venv and rerun with python3.12 installed." >&2; exit 1; }
if [ "$FRESH" = 1 ] || [ "$REBUILD" = 1 ]; then
  "$REPO/.venv/bin/pip" install -e "$REPO/watcher"
fi

command -v node >/dev/null 2>&1 || { echo "Node >= 20 is required." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node >= 20 is required (found $NODE_MAJOR)." >&2; exit 1; }

# 3. Frontend standalone build and its static copies; verify script deps.
FE="$REPO/frontend"
SA="$FE/.next/standalone"
[ -d "$FE/node_modules" ] || (cd "$FE" && npm ci --legacy-peer-deps)
if [ "$REBUILD" = 1 ] || [ ! -f "$FE/.next/BUILD_ID" ]; then
  (cd "$FE" && npm run build)
fi
rm -rf "$SA/.next/static" "$SA/public"
mkdir -p "$SA/.next"
cp -R "$FE/.next/static" "$SA/.next/static"
cp -R "$FE/public" "$SA/public"
[ -d "$REPO/scripts/verify/node_modules" ] || (cd "$REPO/scripts/verify" && npm install --omit=dev)

# 4. Env (inherited by both processes). .env is not read.
export AURA_RUN_MODE=native
export AURA_DATA_DIR="$DATA"
export AURA_DB_PATH="$DATA/work/aura.duckdb"
export AURA_LOGS_DIR="$HOME/.claude/projects"
export AURA_OBSERVER=native
# The native observer can drop events on bursts; sweep every minute.
export AURA_SWEEP_INTERVAL_SECONDS=60
export AURA_DBT_DIR="$REPO/dbt"
export AURA_VERIFY_SCRIPT="$REPO/scripts/verify/run_all.mjs"
export TZ=UTC
export PYTHONUTF8=1
export HOSTNAME=127.0.0.1
export PORT=3000

# 5. Start both, logging under data/logs/.
LOGS="$DATA/logs"
mkdir -p "$LOGS" "$DATA/state"
"$PY" -m aura_watcher.main >> "$LOGS/watcher.log" 2>&1 &
WATCHER_PID=$!
node "$SA/server.js" >> "$LOGS/frontend.log" 2>&1 &
FRONTEND_PID=$!
printf '%s\n%s\n' "$WATCHER_PID" "$FRONTEND_PID" > "$PID_FILE"

# 6. Ctrl+C / TERM / exit stops both.
trap stop INT TERM EXIT

# 7. Where to look.
echo "Aura running at http://127.0.0.1:3000 (Ctrl+C to stop)"
echo "Logs: $LOGS/watcher.log, $LOGS/frontend.log"

# Poll instead of `wait -n` (macOS ships bash 3.2): stop both when either exits.
while kill -0 "$WATCHER_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do sleep 2; done
echo "A process exited; see the logs. Stopping the other."
