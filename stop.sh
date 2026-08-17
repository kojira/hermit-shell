#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$SCRIPT_DIR/.hermit.pid"

if [ ! -f "$PIDFILE" ]; then
    echo "No pidfile found. Checking for running process..."
    PID=$(pgrep -f "node dist/index.js" 2>/dev/null | head -1 || true)
    if [ -n "$PID" ]; then
        echo "Found hermit-shell (PID $PID). Stopping..."
        kill "$PID"
        echo "Stopped."
    else
        echo "hermit-shell is not running."
    fi
    exit 0
fi

PID=$(cat "$PIDFILE")
if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping hermit-shell (PID $PID)..."
    kill "$PID"
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
        echo "Force killing..."
        kill -9 "$PID"
    fi
    echo "Stopped."
else
    echo "Process $PID is not running (stale pidfile)."
fi

rm -f "$PIDFILE"
