#!/usr/bin/env bash
# Run the t3-wall read-only dashboard server.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# launchd starts agents with a minimal PATH; restore the usual tool locations.
export PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}:/opt/homebrew/bin:/usr/local/bin"
export T3_WALL_PORT="${T3_WALL_PORT:-4123}"

if [[ -z "${T3_WALL_OPENUSAGE:-}" ]]; then
  for candidate in /usr/local/bin/openusage /opt/homebrew/bin/openusage; do
    [[ -x "$candidate" ]] && export T3_WALL_OPENUSAGE="$candidate" && break
  done
fi

BUN="${BUN:-$(command -v bun || true)}"
[[ -z "$BUN" ]] && BUN="$HOME/.bun/bin/bun"
if [[ ! -x "$BUN" ]]; then
  echo "bun not found; install it from https://bun.sh" >&2
  exit 1
fi

exec "$BUN" run "$DIR/server.ts"
