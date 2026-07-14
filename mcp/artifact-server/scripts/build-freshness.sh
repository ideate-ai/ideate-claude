#!/bin/sh
# Build-freshness check for the artifact-server, shared by start.sh and its test
# (src/__tests__/build-freshness.test.ts) so the tested code IS the shipped code.
#
# Usage: source this file, then call:
#   needs_build <server_dir> <pkg_version> <marker_file>
# Returns 0 (rebuild needed) or 1 (skip). See start.sh for the WI-337 rationale:
# the rebuild must trigger on SOURCE changes, not only on a package.json version
# bump, or committed engine changes sit inert in the running MCP server.
needs_build() {
  _bf_dir="$1"
  _bf_ver="$2"
  _bf_marker="$3"

  # Compiled entrypoint missing (partial/interrupted build, manual deletion):
  # rebuild even if the marker looks intact.
  [ ! -f "$_bf_dir/dist/index.js" ] && return 0
  # Never built / dist wiped.
  [ ! -f "$_bf_marker" ] && return 0
  # Built version differs from package.json.
  [ "$(cat "$_bf_marker")" != "$_bf_ver" ] && return 0
  # Any source / build-config file newer than the last successful build.
  # NOTE (mtime caveat): `-newer` compares mtime; on coarse-resolution filesystems
  # (some network / overlay mounts) an edit in the SAME second as the marker write
  # can be missed. Fine on APFS/ext4 (sub-second). Suppressed `find` errors bias
  # toward "skip", so keep the src tree readable.
  if [ -n "$(find "$_bf_dir/src" "$_bf_dir/tsconfig.json" "$_bf_dir/package.json" \
              -newer "$_bf_marker" 2>/dev/null | head -n 1)" ]; then
    return 0
  fi
  return 1
}
