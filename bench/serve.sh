#!/bin/sh
# Build, restart Brewse headless with a throwaway profile, and wait for its tool server.
# Usage: bench/serve.sh [profile-dir]
set -e
cd "$(dirname "$0")/.."
PROFILE="${1:-${TMPDIR:-/tmp}/brewse-bench-profile}"
LOG="$PROFILE/brewse.log"
mkdir -p "$PROFILE"
pkill -f "$(pwd)/node_modules/electron/dist/Electron.app" 2>/dev/null || true
sleep 0.5
npx electron-vite build >/dev/null
(node_modules/.bin/electron . --headless --user-data="$PROFILE" >"$LOG" 2>&1 &)
for _ in $(seq 1 60); do
  if curl -s -m 1 http://127.0.0.1:47821/health >/dev/null 2>&1; then
    grep "brewse-core" "$LOG" || true
    exit 0
  fi
  sleep 0.5
done
echo "Brewse did not start; see $LOG" >&2
tail -20 "$LOG" >&2
exit 1
