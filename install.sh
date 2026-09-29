#!/usr/bin/env bash
# Install t3-wall as two per-user launchd agents (server + kiosk).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS" "$HOME/.t3-wall"

for name in server kiosk; do
  src="$DIR/launchd/com.t3wall.$name.plist.tmpl"
  dst="$AGENTS/com.t3wall.$name.plist"
  sed -e "s#__DIR__#$DIR#g" -e "s#__HOME__#$HOME#g" "$src" >"$dst"
  launchctl bootout "gui/$(id -u)/com.t3wall.$name" 2>/dev/null || true
  if ! launchctl bootstrap "gui/$(id -u)" "$dst" 2>/dev/null; then
    launchctl load -w "$dst" 2>/dev/null || true
  fi
  echo "installed $dst"
done

echo
echo "t3-wall is running. Check http://127.0.0.1:${T3_WALL_PORT:-4123}/"
echo "Logs: ~/.t3-wall/server.log, ~/.t3-wall/kiosk.log"
echo "Stop: launchctl bootout gui/$(id -u)/com.t3wall.kiosk  (frees the display)"
echo "      launchctl bootout gui/$(id -u)/com.t3wall.server"
