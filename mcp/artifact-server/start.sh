#!/bin/sh
# Startup wrapper for ideate-artifact-server.
# Installs dependencies on first run if node_modules is missing,
# builds the TypeScript sources if dist/.build-version is missing or stale,
# then starts the MCP server.

DIR="$(cd "$(dirname "$0")" && pwd)"

# Check for .package-lock.json — created by npm only after a successful install.
# Checking the directory alone is unreliable: a partial install leaves node_modules
# present but incomplete, causing silent failures on startup.
if [ ! -f "$DIR/node_modules/.package-lock.json" ]; then
  echo "ideate-artifact-server: installing dependencies (first run)..." >&2
  if ! npm install --prefix "$DIR" --silent; then
    echo "ideate-artifact-server: npm install failed — check that node and npm are in PATH" >&2
    exit 1
  fi
fi

# Decide whether dist/ needs rebuilding before launch. dist/.build-version holds
# the version string written after the last successful build; its MTIME records
# when that build happened.
#
# WI-337 (root-cause fix): rebuild when ANY of —
#   (a) dist/.build-version is missing (never built / dist wiped), OR
#   (b) the built version string differs from package.json, OR
#   (c) any TypeScript source or build config is NEWER than the last build.
# Condition (c) is the fix. The prior check keyed ONLY on the version STRING, so
# committed source changes sat INERT in the running server whenever the version
# wasn't bumped — which is exactly how the cycle-15/16 board-blindness guards
# (committed to src, version unchanged) never reached the live server. mtime is
# the make-style freshness signal: a git pull or edit stamps changed sources
# newer than the marker, so the next server start rebuilds automatically. dist/
# stays git-ignored (decision 01KXEY48JNMFRV2KD1X8TGE6H5 — build output is not
# committed; it is regenerated here instead).
PKG_VERSION="$(node -e "process.stdout.write(require('$DIR/package.json').version)")"
BUILD_VERSION_FILE="$DIR/dist/.build-version"

# needs_build() is factored into scripts/build-freshness.sh so the shipped code
# and its test (src/__tests__/build-freshness.test.ts) exercise the same function.
. "$DIR/scripts/build-freshness.sh"

if needs_build "$DIR" "$PKG_VERSION" "$BUILD_VERSION_FILE"; then
  # Serialize concurrent builds. Multiple MCP hosts (Claude Desktop, an IDE, ...)
  # can each spawn this script against the same $DIR; without a lock their
  # `prebuild: rm -rf dist` + `tsc` interleave and can leave dist/index.js
  # missing/truncated for whichever host reaches `exec` first. The lock dir lives
  # under node_modules/ — git-ignored, and NOT wiped by `rm -rf dist`.
  LOCK="$DIR/node_modules/.ideate-build.lock"
  if mkdir "$LOCK" 2>/dev/null; then
    # We hold the lock: build, and release it even on failure/interrupt.
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
    echo "ideate-artifact-server: building (version $PKG_VERSION, source changed or first run)..." >&2
    if ! npm run build --prefix "$DIR"; then
      echo "ideate-artifact-server: npm run build failed" >&2
      exit 1
    fi
    printf '%s' "$PKG_VERSION" > "$BUILD_VERSION_FILE"
    rmdir "$LOCK" 2>/dev/null
    trap - EXIT INT TERM
  else
    # Another process is building. Wait (bounded) for it to finish, then proceed;
    # if that build failed, `exec node` below fails loudly and the next launch retries.
    echo "ideate-artifact-server: another process is building; waiting..." >&2
    i=0
    while [ -d "$LOCK" ] && [ "$i" -lt 180 ]; do sleep 1; i=$((i + 1)); done
  fi
fi

exec node "$DIR/dist/index.js"
