#!/usr/bin/env bash
# start.sh – start the Voyager learning loop in the background.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"

# ── Load .env ──────────────────────────────────────────────────────────────
if [[ -f "$REPO_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source <(grep -v '^\s*#' "$REPO_DIR/.env" | grep '=')
    set +a
fi

MC_PORT="${MC_PORT:-25566}"

# ── Helpers ────────────────────────────────────────────────────────────────
port_in_use() { ss -tlnH "sport = :$1" 2>/dev/null | grep -q .; }
proc_running() { pgrep -f "$1" &>/dev/null; }

if proc_running "run_local.py"; then
    echo "[start] voyager → already running, skipping"
    exit 0
fi

if port_in_use "$MC_PORT"; then
    echo "[start] WARNING: port $MC_PORT already in use; forge-proxy will fail to bind"
fi

VENV_PYTHON="$REPO_DIR/.venv/bin/python"
[[ -x "$VENV_PYTHON" ]] || VENV_PYTHON="python3"

LOG_FILE="$LOG_DIR/voyager.log"
echo "[start] voyager → starting (log: $LOG_FILE)"
nohup "$VENV_PYTHON" -u "$REPO_DIR/run_local.py" >> "$LOG_FILE" 2>&1 &
PID=$!
echo "[start] voyager PID=$PID"
echo "$PID" > "$LOG_DIR/voyager.pid"

echo ""
echo "Stop: $REPO_DIR/stop.sh"
echo "Tailing $LOG_FILE  (Ctrl-C stops tailing but leaves Voyager running)"
echo ""
tail -f "$LOG_FILE"
