#!/usr/bin/env bash
# stop.sh – stop the Voyager learning loop and its forge-proxy subprocess.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Load .env ──────────────────────────────────────────────────────────────
if [[ -f "$REPO_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source <(grep -v '^\s*#' "$REPO_DIR/.env" | grep '=')
    set +a
fi

MC_PORT="${MC_PORT:-25566}"
MINEFLAYER_SERVER_PORT="${MINEFLAYER_SERVER_PORT:-3000}"

stop_if_running() {
    local name="$1" pattern="$2"
    local pids
    pids=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        echo "[stop] stopping $name (PIDs: $pids)"
        kill $pids 2>/dev/null || true
        local i
        for i in $(seq 1 10); do
            pgrep -f "$pattern" &>/dev/null || break
            sleep 0.5
        done
        pgrep -f "$pattern" &>/dev/null && kill -9 $pids 2>/dev/null || true
        echo "[stop] $name stopped"
    else
        echo "[stop] $name not running"
    fi
}

# Kill the Python launcher first; its SIGTERM handler tears down the proxy.
stop_if_running "voyager"  "run_local.py"
# Also kill the mineflayer Node subprocess Voyager spawned (env/mineflayer/index.js).
stop_if_running "mineflayer" "voyager/env/mineflayer/index.js"
# Belt-and-braces: kill the forge-proxy in case it outlived the launcher.
stop_if_running "proxy"    "forge-proxy.js"

# Free the proxy port if anything is still squatting on it.
fuser -k "${MC_PORT}/tcp" 2>/dev/null || true
# Free the mineflayer HTTP bridge port as well; stale listeners there cause
# the next reset/start cycle to fail with EADDRINUSE and HTTP 400s.
fuser -k "${MINEFLAYER_SERVER_PORT}/tcp" 2>/dev/null || true

rm -f "$REPO_DIR/logs/voyager.pid"

# Keep the persisted vectordbs across restarts. Deleting them forces a full
# embedding rebuild from cached JSON, which can fail when embedding APIs are
# unavailable and unnecessarily slows every monitoring restart.
