#!/usr/bin/env node
/**
 * migrate-status-vocab.ts — WI-220
 *
 * One-time, idempotent migration that normalizes legacy `work_item` status
 * values in a `.ideate/` workspace to the canonical vocabulary defined in
 * `src/node-type-registry.ts`:
 *
 *     pending | in_progress | done | obsolete | blocked
 *
 * Problem this fixes: work_item statuses in the wild are a mix of
 * unknown/complete/completed/done (plus obsolete/pending/blocked/in_progress),
 * which makes get_execution_status and get_workspace_status counts disagree
 * and causes finished legacy items to be miscategorised as "ready".
 *
 * Legacy synonym mapping (see WORK_ITEM_STATUS_SYNONYMS in node-type-registry.ts):
 *   complete, completed   -> done
 *   unknown / null / ""   -> pending
 *   pending/in_progress/done/obsolete/blocked -> preserved as-is
 *   anything else (unanticipated) -> pending (never silently passed through;
 *     printed as a warning so it can be investigated)
 *
 * Safety:
 *   - BACKS UP the target workspace to a timestamped sibling directory
 *     (`<workspace>.backup-<ISO8601-compact>`) before any writes are made.
 *   - Writes go through LocalAdapter.patchNode() — the SAME writer code path
 *     the MCP server uses for all work_item updates — so the YAML files and
 *     the SQLite index (index.db) are updated together and stay consistent
 *     (two-phase P-44 write: YAML first, SQLite second).
 *   - Idempotent: a node whose status is already canonical is left untouched
 *     (no YAML rewrite, no SQLite write). Re-running the script after a
 *     successful run performs zero writes.
 *   - Before/after status counts are printed so the effect of the migration
 *     (and the idempotency of a second run) can be verified directly.
 *
 * Usage:
 *   node --loader ts-node/esm scripts/migrate-status-vocab.ts <path-to-.ideate-dir> [--dry-run]
 *
 * `<path-to-.ideate-dir>` must point at the `.ideate/` directory itself (the
 * same path the MCP server calls `ideateDir`), not the project root.
 *
 * IMPORTANT: do not run this against a workspace that is currently being
 * served by a live MCP server process — run it offline against a copy, or
 * stop the server first. This script opens its own exclusive SQLite handle
 * and does not coordinate with any other process.
 */

import * as fs from "fs";
import * as path from "path";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { openDatabase } from "../src/server.js";
import * as dbSchema from "../src/db.js";
import { LocalAdapter } from "../src/adapters/local/index.js";
import { hasV4ScopingColumns } from "../src/schema.js";
import { rebuildIndex } from "../src/indexer.js";
import {
  normalizeWorkItemStatus,
  WORK_ITEM_STATUSES,
  WORK_ITEM_STATUS_SYNONYMS,
  type WorkItemStatus,
} from "../src/node-type-registry.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  workspaceDir: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const dryRun = argv.includes("--dry-run");

  if (positional.length !== 1) {
    throw new Error(
      "Usage: migrate-status-vocab.ts <path-to-.ideate-dir> [--dry-run]"
    );
  }

  return {
    workspaceDir: path.resolve(positional[0]),
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Backup — copy the workspace to a timestamped sibling directory
// ---------------------------------------------------------------------------

/** Compact ISO-8601 timestamp safe for use in a directory name, e.g. 20260701T121314Z. */
function compactTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "").replace(/-/g, "");
}

/**
 * Back up `workspaceDir` to a timestamped sibling directory before any
 * writes are made. Returns the backup path.
 */
function backupWorkspace(workspaceDir: string, dryRun: boolean): string {
  const parent = path.dirname(workspaceDir);
  const base = path.basename(workspaceDir);
  const backupDir = path.join(parent, `${base}.backup-${compactTimestamp()}`);

  if (dryRun) {
    console.log(`[dry-run] Would back up ${workspaceDir} -> ${backupDir}`);
    return backupDir;
  }

  fs.cpSync(workspaceDir, backupDir, { recursive: true, errorOnExist: true });
  console.log(`Backed up ${workspaceDir} -> ${backupDir}`);
  return backupDir;
}

// ---------------------------------------------------------------------------
// Status count reporting
// ---------------------------------------------------------------------------

interface StatusCounts {
  [status: string]: number;
}

/** Display key used for a null/undefined/empty raw status value. */
const NULL_STATUS_KEY = "(null)";

function rawStatusKey(status: string | null): string {
  if (status === null || status.trim() === "") return NULL_STATUS_KEY;
  return status;
}

function countByRawStatus(
  db: import("better-sqlite3").Database
): StatusCounts {
  const rows = db
    .prepare(`SELECT status FROM nodes WHERE type = 'work_item'`)
    .all() as Array<{ status: string | null }>;
  const counts: StatusCounts = {};
  for (const row of rows) {
    const key = rawStatusKey(row.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function printCounts(label: string, counts: StatusCounts): void {
  console.log(`\n${label}:`);
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) {
    console.log("  (no work_item nodes found)");
    return;
  }
  for (const key of keys) {
    console.log(`  ${key}: ${counts[key]}`);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`  TOTAL: ${total}`);
}

// ---------------------------------------------------------------------------
// Scope resolution — determine (org_id, codebase_id) to pass to LocalAdapter
//
// Rather than relying on cwd heuristics (resolveDefaultScope) or requiring a
// sibling .ideate.json to be present next to the workspace copy, we derive
// the scope directly from the existing node data: the most common
// (org_id, codebase_id) pair already stamped on work_item nodes. This makes
// the script deterministic regardless of the invoking cwd and avoids any
// risk of LocalAdapter.patchNode's scope-stamping silently re-tagging nodes
// with the wrong codebase_id (see server.ts initServer's AC7 scope-fix for
// why this matters — that same stamping happens on every patchNode call).
// ---------------------------------------------------------------------------

function resolveScopeFromExistingData(
  db: import("better-sqlite3").Database
): { org_id: string; codebase_id: string } {
  if (!hasV4ScopingColumns(db)) {
    // Pre-v4 schema — scope is not tracked; any value is fine since
    // LocalWriterAdapter.stampScope() is a no-op without v4 columns.
    return { org_id: "ideate", codebase_id: "UNSCOPED" };
  }

  const row = db
    .prepare(
      `SELECT org_id, codebase_id, COUNT(*) as c
       FROM nodes
       WHERE type = 'work_item'
       GROUP BY org_id, codebase_id
       ORDER BY c DESC
       LIMIT 1`
    )
    .get() as { org_id: string; codebase_id: string; c: number } | undefined;

  if (row) {
    return { org_id: row.org_id, codebase_id: row.codebase_id };
  }

  // No work_item nodes yet — fall back to the documented default.
  return { org_id: "ideate", codebase_id: "UNSCOPED" };
}

// ---------------------------------------------------------------------------
// Main migration routine
// ---------------------------------------------------------------------------

export interface MigrationSummary {
  scanned: number;
  patched: number;
  unchanged: number;
  unanticipated: Array<{ id: string; raw: string | null }>;
  before: StatusCounts;
  after: StatusCounts;
  backupDir: string;
}

export async function migrateStatusVocab(
  workspaceDir: string,
  dryRun: boolean
): Promise<MigrationSummary> {
  if (!fs.existsSync(workspaceDir)) {
    throw new Error(`Workspace directory does not exist: ${workspaceDir}`);
  }

  const backupDir = backupWorkspace(workspaceDir, dryRun);

  const db = openDatabase(workspaceDir);
  let summary: MigrationSummary;
  try {
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const scope = resolveScopeFromExistingData(db);

    // Refresh the SQLite index from the YAML files (the actual source of
    // truth) before reading counts, so "before" reflects on-disk reality
    // rather than a possibly-stale index.
    rebuildIndex(db, drizzleDb, workspaceDir, scope);

    const before = countByRawStatus(db);
    printCounts("BEFORE (raw status values)", before);

    const adapter = new LocalAdapter({
      db,
      drizzleDb,
      ideateDir: workspaceDir,
      default_scope: scope,
    });

    const rows = db
      .prepare(`SELECT id, status FROM nodes WHERE type = 'work_item' ORDER BY id`)
      .all() as Array<{ id: string; status: string | null }>;

    let patched = 0;
    let unchanged = 0;
    const unanticipated: Array<{ id: string; raw: string | null }> = [];
    const canonicalSet: ReadonlySet<string> = new Set(WORK_ITEM_STATUSES);
    const synonymSet: ReadonlySet<string> = new Set(
      Object.keys(WORK_ITEM_STATUS_SYNONYMS)
    );

    for (const row of rows) {
      const normalized: WorkItemStatus = normalizeWorkItemStatus(row.status);

      // Flag raw values that are neither canonical nor a known synonym so
      // they can be investigated (they are still normalized to 'pending',
      // never silently passed through).
      const rawTrimmedLower = (row.status ?? "").trim().toLowerCase();
      if (
        rawTrimmedLower !== "" &&
        !canonicalSet.has(rawTrimmedLower) &&
        !synonymSet.has(rawTrimmedLower)
      ) {
        unanticipated.push({ id: row.id, raw: row.status });
      }

      // Idempotency: only write when the raw value actually differs from
      // the canonical value that would be written.
      if (row.status === normalized) {
        unchanged++;
        continue;
      }

      if (dryRun) {
        console.log(
          `[dry-run] Would update ${row.id}: ${JSON.stringify(row.status)} -> "${normalized}"`
        );
        patched++;
        continue;
      }

      await adapter.patchNode({ id: row.id, properties: { status: normalized } });
      patched++;
    }

    const after = dryRun ? before : countByRawStatus(db);
    printCounts(dryRun ? "AFTER (dry-run — no changes applied)" : "AFTER (raw status values)", after);

    console.log(`\nScanned: ${rows.length}`);
    console.log(`Patched: ${patched}`);
    console.log(`Unchanged (already canonical): ${unchanged}`);
    if (unanticipated.length > 0) {
      console.log(
        `\nWARNING: ${unanticipated.length} node(s) had an unanticipated status value ` +
          `(normalized to 'pending', not silently passed through):`
      );
      for (const u of unanticipated) {
        console.log(`  ${u.id}: ${JSON.stringify(u.raw)}`);
      }
    }
    console.log(`\nBackup: ${backupDir}`);

    summary = {
      scanned: rows.length,
      patched,
      unchanged,
      unanticipated,
      before,
      after,
      backupDir,
    };
  } finally {
    db.close();
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point (only runs when invoked directly, not when imported by tests)
// ---------------------------------------------------------------------------

function main(): void {
  const { workspaceDir, dryRun } = parseArgs(process.argv.slice(2));
  migrateStatusVocab(workspaceDir, dryRun)
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`ERROR: ${(err as Error).message}`);
      process.exit(1);
    });
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("migrate-status-vocab.ts") ||
    process.argv[1].endsWith("migrate-status-vocab.js"))
) {
  main();
}
