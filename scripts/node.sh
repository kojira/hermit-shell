#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
# Resolve from this checkout, not the caller's cwd or an interactive shell's nvm.
NODE="$(mise -C "$ROOT" which node)"
export PATH="$(dirname -- "$NODE"):$PATH"
exec "$NODE" "$@"
