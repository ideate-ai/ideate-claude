/**
 * v4-add-codebase-id.ts — Local adapter schema migration v3 → v4.
 *
 * Adds codebase_id and org_id columns (TEXT NOT NULL with backfill defaults)
 * to all artifact-storing SQLite tables. Also creates a composite index
 * (org_id, codebase_id) on the nodes table for efficient scoped reads.
 *
 * Migration contract:
 *   - Pre-v4 rows are backfilled with org_id='ideate' and
 *     codebase_id='plugin-claude'.
 *   - Columns are added with a DEFAULT clause so SQLite satisfies the NOT NULL
 *     constraint for the ALTER TABLE ADD COLUMN DDL; the DEFAULT is then
 *     used to populate existing rows. After the backfill, existing rows carry
 *     the correct values.
 *   - The migration is idempotent: if the columns already exist (user_version
 *     >= 4), it returns immediately without running any SQL.
 *
 * Tables modified (all extension tables + nodes):
 *   nodes, work_items, findings, domain_policies, domain_decisions,
 *   domain_questions, guiding_principles, constraints, module_specs,
 *   research_findings, journal_entries, document_artifacts,
 *   interview_questions, proxy_human_decisions, projects, phases
 */

import type Database from "better-sqlite3";
import {
  ARTIFACT_TABLES,
  LOCAL_ADAPTER_SCHEMA_VERSION,
  MIGRATION_DEFAULT_ORG_ID,
  MIGRATION_DEFAULT_CODEBASE_ID,
} from "../schema.js";

// ---------------------------------------------------------------------------
// runV4Migration
// ---------------------------------------------------------------------------

/**
 * Migrate a SQLite database from local adapter schema v3 to v4.
 *
 * Adds `org_id TEXT NOT NULL DEFAULT '...'` and
 * `codebase_id TEXT NOT NULL DEFAULT '...'` columns to every artifact table,
 * backfills existing rows, then bumps the local adapter schema version stored
 * in the `meta` table. The `meta` table is created if it does not exist.
 *
 * @param db - Open better-sqlite3 Database instance (must be writable)
 */
export function runV4Migration(db: Database.Database): void {
  // -------------------------------------------------------------------------
  // Check current local schema version via meta table
  // -------------------------------------------------------------------------
  ensureMetaTable(db);

  const currentVersion = getLocalSchemaVersion(db);
  if (currentVersion >= LOCAL_ADAPTER_SCHEMA_VERSION) {
    // Already at v4 or newer — idempotent no-op
    return;
  }

  // -------------------------------------------------------------------------
  // Add codebase_id and org_id to each artifact table (idempotent per column)
  // -------------------------------------------------------------------------

  db.transaction(() => {
    for (const table of ARTIFACT_TABLES) {
      addColumnIfMissing(
        db,
        table,
        "org_id",
        `TEXT NOT NULL DEFAULT '${MIGRATION_DEFAULT_ORG_ID}'`
      );
      addColumnIfMissing(
        db,
        table,
        "codebase_id",
        `TEXT NOT NULL DEFAULT '${MIGRATION_DEFAULT_CODEBASE_ID}'`
      );
    }

    // -----------------------------------------------------------------------
    // Create composite indexes on nodes for scoped reads
    // The extension tables already join through nodes(id), so indexing nodes
    // is sufficient for scope-filtered reads.
    // -----------------------------------------------------------------------
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_org_codebase
        ON nodes(org_id, codebase_id)
    `);

    // -----------------------------------------------------------------------
    // Update local schema version in meta table
    // -----------------------------------------------------------------------
    setLocalSchemaVersion(db, LOCAL_ADAPTER_SCHEMA_VERSION);
  })();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create the meta table if it does not already exist.
 * The meta table stores key-value pairs for the local adapter's internal
 * state, including the local_schema_version.
 */
function ensureMetaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/**
 * Read the local_schema_version from the meta table.
 * Returns 0 if no value is stored (fresh or pre-v4 DB).
 */
function getLocalSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare(`SELECT value FROM meta WHERE key = 'local_schema_version'`)
    .get() as { value: string } | undefined;
  if (!row) return 0;
  const parsed = parseInt(row.value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Write local_schema_version to the meta table.
 */
function setLocalSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('local_schema_version', ?)`
  ).run(String(version));
}

/**
 * Add a column to a table if it does not already exist.
 * Uses PRAGMA table_info to check column presence before ALTER TABLE.
 * Skips silently if the table does not exist (e.g., in test fixtures that
 * only partially implement the schema).
 */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  columnDef: string
): void {
  // Check if the table exists first
  const tableRow = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined;
  if (!tableRow) return; // Table doesn't exist — skip

  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
  }
}
