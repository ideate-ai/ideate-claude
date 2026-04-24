/**
 * adapters/local/schema.ts — Local adapter SQLite schema versioning.
 *
 * This module tracks the local adapter's internal schema version separately
 * from the config schema version (CONFIG_SCHEMA_VERSION in config.ts). The
 * local adapter schema version governs the shape of the SQLite index tables,
 * whereas the config schema version governs .ideate.json structure.
 *
 * Version history:
 *   1 — Initial nodes, edges, extension tables
 *   2 — Added tool_usage table
 *   3 — Added domain_decisions.derived_from column
 *   4 — Added codebase_id and org_id columns to all artifact-storing tables
 *       (work_items, findings, domain_policies, domain_decisions,
 *       domain_questions, guiding_principles, constraints, module_specs,
 *       research_findings, journal_entries, document_artifacts,
 *       interview_questions, proxy_human_decisions, projects, phases, nodes)
 */

// ---------------------------------------------------------------------------
// Local adapter schema version
// ---------------------------------------------------------------------------

/**
 * Current schema version for the local SQLite adapter's index tables.
 * This must be incremented whenever a structural change (new column, new
 * table, changed constraint) is made to the tables managed by the local
 * adapter.
 */
export const LOCAL_ADAPTER_SCHEMA_VERSION = 4;

// ---------------------------------------------------------------------------
// Artifact-storing tables that receive codebase_id + org_id columns
//
// Excludes operational tables (tool_usage, edges, node_file_refs) which are
// not artifact-level tables and do not need per-artifact scoping.
// ---------------------------------------------------------------------------

/**
 * All SQLite tables that store artifact data and should have codebase_id and
 * org_id columns added in the v4 migration.
 */
export const ARTIFACT_TABLES = [
  "nodes",
  "work_items",
  "findings",
  "domain_policies",
  "domain_decisions",
  "domain_questions",
  "guiding_principles",
  "constraints",
  "module_specs",
  "research_findings",
  "journal_entries",
  "document_artifacts",
  "interview_questions",
  "proxy_human_decisions",
  "projects",
  "phases",
] as const;

export type ArtifactTable = (typeof ARTIFACT_TABLES)[number];

// ---------------------------------------------------------------------------
// Default backfill values for pre-v4 rows
// ---------------------------------------------------------------------------

/**
 * Default org_id applied to all rows when migrating from v3 to v4.
 * Represents the single-tenant "ideate" organization.
 */
export const MIGRATION_DEFAULT_ORG_ID = "ideate";

/**
 * Default codebase_id applied to all rows when migrating from v3 to v4.
 * Represents the Claude plugin codebase.
 */
export const MIGRATION_DEFAULT_CODEBASE_ID = "plugin-claude";
