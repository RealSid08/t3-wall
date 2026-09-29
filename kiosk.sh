#!/usr/bin/env bash
# Launch the t3-wall dashboard fullscreen on an external display.
#
# The wall server runs separately (start-server.sh). This script only wakes the
# panel, waits for the wall to answer, and opens an isolated Chrome kiosk window
# on the target display. It does not touch T3 Code.
set -euo pipefail

WALL_URL="${T3_WALL_URL:-http://127.0.0.1:4123/}"
HEALTH_URL="${WALL_URL%/}/health"
PROFILE="${T3_WALL_PROFILE:-$HOME/.t3-wall/chrome-profile}"
DISPLAY_INDEX="${T3_WALL_DISPLAY_INDEX:-1}"

CHROME="${T3_WALL_CHROME:-}"
if [[ -z "$CHROME" ]]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome 2>/dev/null || true)" \
    "$(command -v chromium 2>/dev/null || true)"; do
    [[ -n "$candidate" && -x "$candidate" ]] && CHROME="$candidate" && break
  done
fi
if [[ -z "$CHROME" ]]; then
  echo "No Chrome/Chromium found. Set T3_WALL_CHROME to a browser binary." >&2
  exit 1
fi

# Wake the panel: a sleeping display renders nothing even though the compositor
# still holds a framebuffer.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -u -t 2 2>/dev/null || true
fi

# Wait for the wall server so the kiosk never lands on a connection error.
for _ in $(seq 1 30); do
  if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then break; fi
  sleep 1
done

# Resolve the target display's top-left origin in global (top-left) screen
# coordinates. NSScreen reports bottom-left origins, so convert with the main
# display's height. Falls back to the main display when AppleScript is absent.
ORIGIN="$(osascript -l JavaScript -e '
function run(argv) {
  ObjC.import("AppKit");
  const i = Number(argv[0]);
  const s = $.NSScreen.screens;
  if (s.count <= i) return "{\"x\":0,\"y\":0,\"w\":1080,\"h\":1920}";
  const main = s.objectAtIndex(0).frame;
  const f = s.objectAtIndex(i).frame;
  return JSON.stringify({
    x: Math.round(f.origin.x),
    y: Math.round(main.size.height - (f.origin.y + f.size.height)),
    w: Math.round(f.size.width),
    h: Math.round(f.size.height),
  });
}
' "$DISPLAY_INDEX" 2>/dev/null || echo '{"x":0,"y":0,"w":1080,"h":1920}')"

read -r X Y W H <<<"$(printf '%s' "$ORIGIN" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["x"], d["y"], d["w"], d["h"])')"

echo "t3-wall kiosk -> display $DISPLAY_INDEX at ${X},${Y} (${W}x${H})"

exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --window-position="${X},${Y}" --window-size="${W},${H}" \
  --kiosk "$WALL_URL"
