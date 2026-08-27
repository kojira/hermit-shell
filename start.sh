#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$SCRIPT_DIR/.hermit.pid"
LOGFILE="$SCRIPT_DIR/.hermit.log"

cd "$SCRIPT_DIR"

# ローカルの認証ファイル（.hermit-auth・chmod 600・git 管理外）。
# auth.ts は環境変数を最優先で読むため、これが唯一の認証源になる。
if [ -f "$SCRIPT_DIR/.hermit-auth" ]; then
    ANTHROPIC_AUTH_TOKEN="$(cat "$SCRIPT_DIR/.hermit-auth")"
    export ANTHROPIC_AUTH_TOKEN
fi

# Already running?
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "hermit-shell is already running (PID $OLD_PID). Restarting..."
        kill "$OLD_PID"
        sleep 1
        # Force kill if still alive
        kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null
        sleep 0.5
    fi
    rm -f "$PIDFILE"
fi

# Start in background
nohup env NODE_OPTIONS=--dns-result-order=ipv4first node dist/index.js >> "$LOGFILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"

echo "hermit-shell started (PID $NEW_PID)"
echo "  log: $LOGFILE"
echo "  pid: $PIDFILE"
