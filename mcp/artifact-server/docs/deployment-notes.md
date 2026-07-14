# Deployment Notes — ideate-artifact-server

## Overview

The ideate MCP artifact server runs as a long-lived Node.js process. MCP hosts
(Claude Desktop, VS Code Cline, etc.) typically spawn it once and keep it alive
across many tool calls. This document covers the operational implications of
that lifecycle — specifically what happens when you rebuild `dist/`.

---

## Node.js `require.cache` and why process restart is mandatory after a build

Node.js caches every module the first time it is loaded. Subsequent `require()`
or `import` calls within the same process return the cached module without
re-reading the file from disk.

**Consequence for MCP servers**: if you run `npm run build` after an MCP server
process is already running, the new `.js` files land in `dist/` but the running
process keeps executing the old code — indefinitely, until it exits.

- The SQLite database reflects the latest state.
- The filesystem reflects the new build.
- The running process does not.

This mismatch is silent: tool calls succeed but may produce wrong results based
on old logic. The `[ideate-mcp] build timestamp=...` line emitted to stderr at
startup is the primary diagnostic signal (see "Startup build stamp" below).

---

## Incident: 2026-04-16 — stale process shadowed WI-860 fix

### What happened

| Time  | Event |
|-------|-------|
| 09:25 | MCP server process PID 68171 spawned; loads `reader.js` into `require.cache`. |
| 13:30 | `npm run build` runs; new `dist/` written with WI-860 fix (`WHERE addressed_by IS NULL`). |
| 15:45 | WI-860 change committed. DB is correct; new `dist/` is correct. |
| ~16:xx | Symptoms: filter not applied. DB shows correct rows. Code looks correct. |
| ~17:xx | Diagnosis: PID 68171 still alive, running pre-WI-860 `reader.js`. ~1 hour lost. |

### Root cause

PID 68171 was never killed after the 13:30 build. The MCP host reused the same
connection rather than spawning a fresh process, so the old module stayed in
memory.

### Fix

Kill the old process and let the MCP host respawn it on the next tool call.

---

## Startup build stamp

Every time `server.ts` is first loaded, it logs a line to stderr:

```
[timestamp] [INFO] [ideate-mcp] build timestamp=<ISO-8601-mtime> source=<path-to-dist/server.js>
```

**How to use it during diagnosis**:

1. Note the `build timestamp` value.
2. Compare it to the mtime of `dist/server.js` on disk:
   ```sh
   stat mcp/artifact-server/dist/server.js
   ```
3. If the timestamps match, the running process loaded the current build.
4. If they differ (disk mtime is newer), the running process is stale — restart it.

The log goes to stderr and is also written to
`~/.claude/logs/ideate-mcp.log` (or the path in `IDEATE_MCP_LOG`).

---

## Reload mechanism chosen: restart script (option b)

**Chosen**: `scripts/restart.sh` — a local shell script that finds and SIGTERMs
the running server process, then exits so the MCP host can respawn it.

**Tradeoff rationale**: A `postbuild` npm hook (option a) would fire automatically
but is too dangerous — it would kill the server even during CI builds or Docker
layer builds where there is no host to respawn. A manual kill (option c) works
but requires the operator to remember the incantation every time. The restart
script (option b) is explicit (operator must invoke it), safe (only matches
processes using this repo's exact `dist/index.js` path), and reliable (works
without any global state or daemon manager).

**Safety properties**:
- Matches only processes whose argv contains the absolute path to THIS
  repository's `dist/index.js`. Other projects' MCP servers are unaffected.
- Sends SIGTERM (graceful); escalates to SIGKILL after grace period if the process does not exit.
- Skips gracefully if no matching process exists.
- Does not auto-run; must be explicitly invoked by the operator.
- Remote-backend deployments (Docker, Fly.io) run with different absolute paths
  and are never matched.

---

## Operator guidance: standard deploy workflow

After every `npm run build`, restart the server explicitly:

```sh
cd mcp/artifact-server
npm run build
sh scripts/restart.sh
```

The MCP host (Claude Desktop, VS Code) will spawn a fresh server process on the
next tool call. You do not need to restart the MCP host itself.

The `start.sh` wrapper rebuilds `dist/` automatically before starting whenever
it is stale, so you normally do **not** need a manual `npm run build`. It
rebuilds when any of: `dist/index.js` or the build marker is missing, the built
`package.json` version differs from the marker, **or any `src/`/`tsconfig.json`/
`package.json` file is newer than the last build** (an mtime check — a `git pull`
or a source edit triggers a rebuild on the next server start). Committed source
changes therefore go live on the next launch without a version bump. (Concurrent
builds across multiple MCP hosts are serialized by a `node_modules/.ideate-build.lock`
mutex.)

```sh
# Equivalent alternative if using start.sh:
cd mcp/artifact-server
npm run build
# Then: in your MCP host config, trigger a server restart
#        (Claude Desktop: restart Claude; VS Code Cline: reload window)
```

---

## Manual verification steps

These steps let a reviewer confirm that the restart mechanism works end-to-end,
without manually killing processes.

### Prerequisites

- The MCP server is running (spawned by Claude Desktop or `node dist/index.js`).
- You have access to the server log (`~/.claude/logs/ideate-mcp.log` or stderr).

### Steps

1. **Record the current build stamp.**
   ```sh
   grep "ideate-mcp.*build timestamp" ~/.claude/logs/ideate-mcp.log | tail -1
   ```
   Note the `build timestamp=` value (call it `T1`).

2. **Make a visible edit to a source file.**
   ```sh
   # Touch server.ts to bump its mtime without changing behaviour:
   touch mcp/artifact-server/src/server.ts
   ```

3. **Rebuild.**
   ```sh
   cd mcp/artifact-server && npm run build
   ```

4. **Confirm `dist/server.js` mtime changed.**
   ```sh
   stat mcp/artifact-server/dist/server.js
   ```
   The mtime should be later than `T1`.

5. **Restart the server.**
   ```sh
   sh mcp/artifact-server/scripts/restart.sh
   ```
   Expected output (stderr):
   ```
   [restart] Sending SIGTERM to PID <N> (ideate-artifact-server)
   [restart] Done. The MCP host (Claude Desktop / VS Code) will restart the server on next tool call.
   ```

6. **Trigger a tool call** in Claude Desktop (e.g., ask Claude to list work items).
   The MCP host spawns a fresh server process.

7. **Confirm new build stamp in the log.**
   ```sh
   grep "ideate-mcp.*build timestamp" ~/.claude/logs/ideate-mcp.log | tail -1
   ```
   The `build timestamp=` value (call it `T2`) should be equal to or later than
   the `dist/server.js` mtime from step 4.

8. **Pass condition**: `T2 > T1`, confirming the running process loaded the new build.

### What "no running process found" means

If `restart.sh` reports no process found, the server is already stopped (e.g.,
the MCP host shut it down). That is fine — the next tool call will spawn a fresh
process with the new build automatically.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IDEATE_MCP_LOG` | `~/.claude/logs/ideate-mcp.log` | Path for persistent log file |
| `IDEATE_MCP_DEBUG` | unset | Set to any value to enable debug-level logging |
