#!/usr/bin/env bash
# scripts/report-tool-usage.sh — Summarize MCP tool_usage telemetry
#
# WI-858 (phase PH-048 "Quality metrics rebuild").
# Replaces four deleted metrics-report scripts (WI-850) with one focused report
# that queries the tool_usage table via the ideate_get_tool_usage handler.
#
# Usage: report-tool-usage.sh [OPTIONS]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVER_DIR="${REPO_ROOT}/mcp/artifact-server"

usage() {
  cat <<'EOF'
Usage: report-tool-usage.sh [OPTIONS]

Summarize MCP tool_usage telemetry for the current ideate workspace.

Options:
  --cycle N            Filter to a cycle number.
  --phase PH-NNN       Filter to a phase ID.
  --session SID        Filter to a session ID.
  --tool NAME          Filter to a tool name (e.g. ideate_get_context_package).
  --from ISO           ISO 8601 timestamp lower bound (inclusive).
  --to ISO             ISO 8601 timestamp upper bound (inclusive).
  --limit N            Max detail rows included in the raw data (default 1000,
                       max 10000). Must be a positive integer (N >= 1); 0 is
                       an error. Does not affect aggregate totals.
  --top N              Show top-N most-called tools in the summary (default 5).
                       Must be a positive integer (N >= 1); 0 is an error.
  -h, --help           Show this help and exit.

Examples:
  report-tool-usage.sh --cycle 48
  report-tool-usage.sh --tool ideate_artifact_query --from 2026-04-01T00:00:00Z
  report-tool-usage.sh --session "$SESSION_ID" --top 10

Exits 0 on success (including when there is no data). Exits non-zero on
invalid arguments or missing/unbuilt artifact server.
EOF
}

die() { echo "Error: $*" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------

CYCLE=""
PHASE=""
SESSION=""
TOOL=""
FROM=""
TO=""
LIMIT=""
TOP="5"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cycle)   [[ $# -ge 2 ]] || die "--cycle requires a value";   CYCLE="$2";   shift 2 ;;
    --phase)   [[ $# -ge 2 ]] || die "--phase requires a value";   PHASE="$2";   shift 2 ;;
    --session) [[ $# -ge 2 ]] || die "--session requires a value"; SESSION="$2"; shift 2 ;;
    --tool)    [[ $# -ge 2 ]] || die "--tool requires a value";    TOOL="$2";    shift 2 ;;
    --from)    [[ $# -ge 2 ]] || die "--from requires a value";    FROM="$2";    shift 2 ;;
    --to)      [[ $# -ge 2 ]] || die "--to requires a value";      TO="$2";      shift 2 ;;
    --limit)   [[ $# -ge 2 ]] || die "--limit requires a value";   LIMIT="$2";   shift 2 ;;
    --top)     [[ $# -ge 2 ]] || die "--top requires a value";     TOP="$2";     shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
done

# Validate --cycle: non-negative integer if set (0 is valid)
if [[ -n "$CYCLE" && ! "$CYCLE" =~ ^[0-9]+$ ]]; then
  die "--cycle must be a non-negative integer (got: '$CYCLE')"
fi

# Validate --limit and --top: positive integer (>= 1) if set
for pair in "limit:$LIMIT" "top:$TOP"; do
  name="${pair%%:*}"
  val="${pair#*:}"
  if [[ -n "$val" ]]; then
    if [[ ! "$val" =~ ^[0-9]+$ ]]; then
      die "--${name} must be a positive integer (got: '$val')"
    fi
    if [[ "$val" -eq 0 ]]; then
      die "--${name} must be a positive integer >= 1 (got: 0)"
    fi
  fi
done

# ---------------------------------------------------------------------------
# Locate project root and verify built server
# ---------------------------------------------------------------------------

find_ideate_dir() {
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    if [[ -d "$dir/.ideate" ]]; then
      echo "$dir/.ideate"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

IDEATE_DIR="$(find_ideate_dir)" || {
  echo "Error: no .ideate/ directory found in $PWD or any ancestor" >&2
  exit 1
}

if [[ ! -f "${SERVER_DIR}/dist/tools/tool-usage.js" ]]; then
  echo "Error: artifact server is not built." >&2
  echo "Run: (cd ${SERVER_DIR} && npm run build)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build JSON args from flags (only include set fields)
# ---------------------------------------------------------------------------

ARGS_JSON="$(CYCLE="$CYCLE" PHASE="$PHASE" SESSION="$SESSION" TOOL="$TOOL" \
             FROM="$FROM" TO="$TO" LIMIT="$LIMIT" \
             node --input-type=module -e '
const args = { view: "aggregate" };
const env = process.env;
if (env.CYCLE)   args.cycle = Number(env.CYCLE);
if (env.PHASE)   args.phase = env.PHASE;
if (env.SESSION) args.session_id = env.SESSION;
if (env.TOOL)    args.tool_name = env.TOOL;
if (env.FROM)    args.from = env.FROM;
if (env.TO)      args.to = env.TO;
if (env.LIMIT)   args.limit = Number(env.LIMIT);
process.stdout.write(JSON.stringify(args));
')"

# ---------------------------------------------------------------------------
# Invoke adapter + handler + format output via inline Node helper
# Run node from within $SERVER_DIR so bare-specifier package resolution
# (better-sqlite3, drizzle-orm) finds the server's node_modules.
# ---------------------------------------------------------------------------

cd "$SERVER_DIR"
IDEATE_DIR="$IDEATE_DIR" SERVER_DIR="$SERVER_DIR" ARGS_JSON="$ARGS_JSON" TOP="$TOP" \
node --input-type=module <<'NODE_SCRIPT'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'fs';
import path from 'path';
import url from 'url';

const ideateDir = process.env.IDEATE_DIR;
const serverDir = process.env.SERVER_DIR;
const argsJson  = process.env.ARGS_JSON;
const top       = Math.max(1, Number(process.env.TOP) || 5);

const distUrl = url.pathToFileURL(path.join(serverDir, 'dist') + '/').toString();
const { openDatabase } = await import(distUrl + 'server.js');
const dbSchema          = await import(distUrl + 'db.js');
const { LocalAdapter }  = await import(distUrl + 'adapters/local/index.js');
const { RemoteAdapter } = await import(distUrl + 'adapters/remote/index.js');
const { ValidatingAdapter } = await import(distUrl + 'validating.js');
const { handleGetToolUsage } = await import(distUrl + 'tools/tool-usage.js');

// ---------------------------------------------------------------------------
// Read backend from .ideate.json — walk up from ideateDir to find project root
// ---------------------------------------------------------------------------
function findIdeateJson(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, '.ideate.json');
    try {
      readFileSync(candidate); // probe existence
      return candidate;
    } catch (_) {}
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root reached
    dir = parent;
  }
}

let configJson = {};
const ideateJsonPath = findIdeateJson(path.dirname(ideateDir));
if (!ideateJsonPath) {
  process.stderr.write(
    'Error: no .ideate.json found in ' + path.dirname(ideateDir) + ' or any ancestor.\n' +
    'Create a .ideate.json at the project root (see ideate docs).\n'
  );
  process.exit(2);
}
try {
  configJson = JSON.parse(readFileSync(ideateJsonPath, 'utf8'));
} catch (err) {
  process.stderr.write('Error: could not read ' + ideateJsonPath + ': ' + err.message + '\n');
  process.exit(2);
}
const backend = configJson.backend ?? 'local';

function fmtInt(n)  { return Number(n ?? 0).toLocaleString('en-US'); }
function fmtBytes(n) {
  n = Number(n ?? 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MiB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
}

let db;
let resultJson;
let backendNote = null;

if (backend === 'local' || backend === undefined) {
  // Local backend: open SQLite, create LocalAdapter
  try {
    db = openDatabase(ideateDir);
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const rawAdapter = new LocalAdapter({ db, drizzleDb, ideateDir });
    const adapter = new ValidatingAdapter(rawAdapter);
    const ctx = { db, drizzleDb, ideateDir, adapter };
    resultJson = await handleGetToolUsage(ctx, JSON.parse(argsJson));
  } finally {
    if (db) db.close();
  }
} else if (backend === 'remote') {
  // Remote backend: validate required config fields, then construct RemoteAdapter
  const remoteConfig = configJson.remote;
  if (!remoteConfig || !remoteConfig.endpoint) {
    process.stderr.write(
      'Error: backend is "remote" but .ideate.json is missing remote.endpoint.\n' +
      'Add a "remote" block with "endpoint", "org_id", and "codebase_id" to .ideate.json at the project root.\n'
    );
    process.exit(2);
  }
  if (!remoteConfig.org_id) {
    process.stderr.write(
      'Error: backend is "remote" but .ideate.json is missing remote.org_id.\n'
    );
    process.exit(2);
  }
  if (!remoteConfig.codebase_id) {
    process.stderr.write(
      'Error: backend is "remote" but .ideate.json is missing remote.codebase_id.\n'
    );
    process.exit(2);
  }

  // Verify the remote endpoint is reachable before proceeding
  const rawAdapter = new RemoteAdapter(remoteConfig);
  try {
    await rawAdapter.initialize();
  } catch (err) {
    process.stderr.write(
      'Error: remote backend is unreachable or misconfigured.\n' +
      '  Endpoint: ' + remoteConfig.endpoint + '\n' +
      '  Cause: ' + err.message + '\n'
    );
    process.exit(2);
  }

  const adapter = new ValidatingAdapter(rawAdapter);
  const ctx = { ideateDir, adapter };
  resultJson = await handleGetToolUsage(ctx, JSON.parse(argsJson));
  backendNote = 'Note: remote backend tool_usage endpoint is not yet available; data may be empty.';
} else {
  process.stderr.write(
    'Error: unknown backend "' + backend + '" in .ideate.json.\n' +
    'Valid values are "local" (default) or "remote".\n'
  );
  process.exit(2);
}

const result = JSON.parse(resultJson);
const aggregate = result.aggregate ?? [];

// Totals across all rows
let totalCalls = 0;
let totalReqTok = 0, totalRespTok = 0;
let totalReqBytes = 0, totalRespBytes = 0;
for (const r of aggregate) {
  totalCalls    += r.count;
  totalReqTok   += r.request_tokens_total;
  totalRespTok  += r.response_tokens_total;
  totalReqBytes += r.request_bytes_total;
  totalRespBytes+= r.response_bytes_total;
}

// Format filter summary
const filters = result.filters ?? {};
const fKeys = Object.keys(filters);
const filterLine = fKeys.length === 0
  ? '(none — summarising all tool_usage rows)'
  : fKeys.map(k => `${k}=${filters[k]}`).join('  ');

// ---------------------------------------------------------------------------
// Render report
// ---------------------------------------------------------------------------

const out = [];
out.push('MCP Tool Usage Report');
out.push('=====================');
out.push('');
out.push(`Workspace: ${ideateDir}`);
out.push(`Backend:   ${backend}`);
out.push(`Filters:   ${filterLine}`);
if (backendNote) out.push(backendNote);
out.push('');

if (totalCalls === 0) {
  out.push('No tool_usage rows match these filters.');
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}

out.push(`Total calls:          ${fmtInt(totalCalls)}`);
out.push(`Request tokens:       ${fmtInt(totalReqTok)}`);
out.push(`Response tokens:      ${fmtInt(totalRespTok)}`);
out.push(`Request bytes:        ${fmtBytes(totalReqBytes)}`);
out.push(`Response bytes:       ${fmtBytes(totalRespBytes)}`);
out.push(`Distinct tools:       ${aggregate.length}`);
out.push('');

// Top-N most-called
const byCount = [...aggregate].sort((a, b) => b.count - a.count);
const topN = byCount.slice(0, top);
out.push(`Top ${topN.length} most-called tools:`);
for (const r of topN) {
  const pct = ((r.count / totalCalls) * 100).toFixed(1);
  out.push(`  ${r.tool_name.padEnd(40)}  ${String(r.count).padStart(6)}  (${pct}%)`);
}
out.push('');

// Per-tool breakdown (alphabetical)
out.push('Per-tool breakdown:');
const header =
  '  ' +
  'tool_name'.padEnd(40) +
  '  ' + 'calls'.padStart(6) +
  '  ' + 'req_tok'.padStart(9) +
  '  ' + 'resp_tok'.padStart(9) +
  '  ' + 'req_bytes'.padStart(10) +
  '  ' + 'resp_bytes'.padStart(10);
out.push(header);
out.push('  ' + '-'.repeat(header.length - 2));
const byName = [...aggregate].sort((a, b) =>
  a.tool_name < b.tool_name ? -1 : a.tool_name > b.tool_name ? 1 : 0
);
for (const r of byName) {
  out.push(
    '  ' +
    r.tool_name.padEnd(40) +
    '  ' + String(r.count).padStart(6) +
    '  ' + fmtInt(r.request_tokens_total).padStart(9) +
    '  ' + fmtInt(r.response_tokens_total).padStart(9) +
    '  ' + fmtBytes(r.request_bytes_total).padStart(10) +
    '  ' + fmtBytes(r.response_bytes_total).padStart(10)
  );
}

process.stdout.write(out.join('\n') + '\n');
NODE_SCRIPT
