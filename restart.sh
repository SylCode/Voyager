#!/usr/bin/env bash
# restart.sh – stop the Voyager loop, then start it again.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$REPO_DIR/stop.sh"
sleep 0.5
exec "$REPO_DIR/start.sh"
