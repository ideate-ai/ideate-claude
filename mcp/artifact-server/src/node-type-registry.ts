// node-type-registry.ts — Single source of truth for node type metadata
//
// Before this file existed, extension-table metadata was duplicated across:
//   - db.ts (TYPE_TO_EXTENSION_TABLE)
//   - reader.ts (TYPE_EXTENSION_INFO map)
//   - reader.ts / query.ts (TYPE_PREFIX_MAP)
//   - query.ts (VALID_TYPES derived from TYPE_TO_EXTENSION_TABLE)
//   - writer.ts (if/else dispatch over types)
//
// Adding a new node type required touching 5-7 places with no compile-time
// check that all were updated consistently.  NODE_TYPE_REGISTRY consolidates
// all per-type metadata in one place.  The `satisfies Record<NodeType,
// NodeTypeSpec>` annotation causes tsc to error if any NodeType is missing a
// registry entry, providing exhaustiveness at compile time.
//
// WI-904 added buildRow to NodeTypeSpec: each entry now carries a function that
// converts raw YAML properties into the extension-table row shape, eliminating
// the 390-line if/else dispatch chain in writer.ts.

import type { NodeType } from "./adapter.js";
import type { AnyTable } from "./db.js";
import * as tables from "./db.js";

// ---------------------------------------------------------------------------
// NodeTypeSpec — per-type metadata record
// ---------------------------------------------------------------------------

/** Drizzle table reference for an extension table, or null when the type has
 *  no extension table (document-only or singleton types stored in the base
 *  nodes table with optional document_artifacts row). */
export type ExtensionTableRef = AnyTable | null;

export interface NodeTypeSpec {
  /**
   * The Drizzle ORM extension table for this node type, or null if the type
   * has no extension table (stored only in the base `nodes` row, or stored in
   * `document_artifacts` for document-subtype nodes that share a table).
   *
   * When non-null, this is the authoritative table reference for JOIN
   * generation in reader.ts and writer.ts dispatch.
   */
  extensionTable: ExtensionTableRef;

  /**
   * The extension table name as a SQL string, or null when extensionTable is
   * null.  Provided as a convenience for raw-SQL consumers (reader.ts) so they
   * do not need to extract the table name from the Drizzle object.
   */
  extensionTableName: string | null;

  /**
   * The ID prefix for this node type, e.g. "WI-", "F-", "GP-".
   * null means the type does not use prefix-based IDs (e.g. autopilot_state).
   */
  idPrefix: string | null;

  /**
   * The padding width used when formatting the numeric suffix of generated IDs.
   * e.g. padWidth: 3 produces "WI-001"; padWidth: 2 produces "GP-01".
   * null when idPrefix is null.
   */
  idPadWidth: number | null;

  /**
   * SQL expression fragment (aliasing extension table as `e`, base table as
   * `n`) used to build the one-line summary string for query results.
   * null when the type has no extension table or meaningful summary.
   *
   * Example: "e.title" → uses the title column directly.
   * Example: "e.severity || ' — ' || e.verdict" → concatenation expression.
   */
  summarySelector: string | null;

  /**
   * Whether this node type is listable via ideate_artifact_query(type: X).
   * Types backed by an extension table are generally queryable.
   * Types without an extension table (autopilot_state) are not.
   */
  isQueryable: boolean;

  /**
   * Build the extension-table row from raw YAML properties.
   *
   * Called by writer.ts to convert the content of a node's YAML file into the
   * column values for the type's extension table.  The returned object MUST NOT
   * include `id` — that is injected by the upsert helper in db-helpers.ts.
   *
   * `cycleForNode` is the resolved cycle number for the node (from the base
   * nodes row); it is needed by a few types (finding, document_artifacts) that
   * store a cycle column in the extension table.
   *
   * Returns null when the type has no extension table (extensionTable === null).
   * In that case writer.ts skips the extension-table upsert entirely.
   */
  buildRow: (props: Record<string, unknown>, cycleForNode: number | null) => Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// NODE_TYPE_REGISTRY
//
// The `satisfies Record<NodeType, NodeTypeSpec>` annotation is the key
// compile-time safety guarantee: if a new NodeType is added to adapter.ts
// without a corresponding entry here, tsc emits a type error.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildRow helpers — shared coercion utilities (mirrors indexer.ts conventions)
// ---------------------------------------------------------------------------

function toStr(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v);
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toJson(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// buildRow implementations — one per type that has an extension table
// ---------------------------------------------------------------------------

function buildRowWorkItem(props: Record<string, unknown>): Record<string, unknown> {
  return {
    title: toStr(props.title) ?? "",
    complexity: toStr(props.complexity),
    scope: toJson(props.scope),
    depends: toJson(props.depends),
    blocks: toJson(props.blocks),
    criteria: toJson(props.criteria),
    module: null,
    domain: toStr(props.domain),
    phase: toStr(props.phase),
    notes: toStr(props.notes),
    work_item_type: toStr(props.work_item_type) ?? "feature",
    resolution: toStr(props.resolution),
  };
}

function buildRowFinding(props: Record<string, unknown>, cycleForNode: number | null): Record<string, unknown> {
  return {
    severity: toStr(props.severity) ?? "",
    work_item: toStr(props.work_item) ?? "",
    file_refs: toStr(props.file_refs),
    verdict: toStr(props.verdict) ?? "",
    cycle: toNum(props.cycle) ?? cycleForNode ?? 0,
    reviewer: toStr(props.reviewer) ?? "",
    description: toStr(props.description),
    suggestion: toStr(props.suggestion),
    addressed_by: toStr(props.addressed_by),
    title: toStr(props.title),
  };
}

function buildRowDomainPolicy(props: Record<string, unknown>): Record<string, unknown> {
  return {
    domain: toStr(props.domain) ?? "",
    derived_from: toJson(props.derived_from),
    established: toStr(props.established),
    amended: toStr(props.amended),
    amended_by: toStr(props.amended_by),
    description: toStr(props.description),
  };
}

function buildRowDomainDecision(props: Record<string, unknown>): Record<string, unknown> {
  return {
    domain: toStr(props.domain) ?? "",
    cycle: toNum(props.cycle),
    supersedes: toStr(props.supersedes),
    description: toStr(props.description),
    rationale: toStr(props.rationale),
    title: toStr(props.title),
    source: toStr(props.source),
  };
}

function buildRowDomainQuestion(props: Record<string, unknown>): Record<string, unknown> {
  return {
    domain: toStr(props.domain) ?? "",
    impact: toStr(props.impact),
    source: toStr(props.source),
    resolution: toStr(props.resolution),
    resolved_in: toNum(props.resolved_in),
    description: toStr(props.description),
    addressed_by: toStr(props.addressed_by),
  };
}

function buildRowGuidingPrinciple(props: Record<string, unknown>): Record<string, unknown> {
  return {
    name: toStr(props.name) ?? "",
    description: toStr(props.description),
    amendment_history: toJson(props.amendment_history),
  };
}

function buildRowConstraint(props: Record<string, unknown>): Record<string, unknown> {
  return {
    category: toStr(props.category) ?? "",
    description: toStr(props.description),
  };
}

function buildRowModuleSpec(props: Record<string, unknown>): Record<string, unknown> {
  return {
    name: toStr(props.name) ?? "",
    scope: toStr(props.scope),
    provides: toJson(props.provides),
    requires: toJson(props.requires),
    boundary_rules: toJson(props.boundary_rules),
  };
}

function buildRowResearchFinding(props: Record<string, unknown>): Record<string, unknown> {
  return {
    topic: toStr(props.topic) ?? "",
    date: toStr(props.date),
    content: toStr(props.content),
    sources: toJson(props.sources),
  };
}

function buildRowJournalEntry(props: Record<string, unknown>): Record<string, unknown> {
  return {
    phase: toStr(props.phase),
    date: toStr(props.date),
    title: toStr(props.title),
    work_item: toStr(props.work_item),
    content: toStr(props.content),
  };
}

function buildRowInterviewQuestion(props: Record<string, unknown>): Record<string, unknown> {
  return {
    interview_id: toStr(props.interview_id) ?? "",
    question: toStr(props.question) ?? "",
    answer: toStr(props.answer) ?? "",
    domain: toStr(props.domain),
    seq: toNum(props.seq) ?? 0,
  };
}

function buildRowProxyHumanDecision(props: Record<string, unknown>): Record<string, unknown> {
  return {
    cycle: toNum(props.cycle) ?? 0,
    trigger: toStr(props.trigger) ?? "",
    triggered_by: toJson(props.triggered_by),
    decision: toStr(props.decision) ?? "",
    rationale: toStr(props.rationale),
    timestamp: toStr(props.timestamp) ?? new Date().toISOString(),
    status: toStr(props.status) ?? "resolved",
  };
}

function buildRowProject(props: Record<string, unknown>): Record<string, unknown> {
  return {
    name: toStr(props.name),
    description: toStr(props.description),
    intent: toStr(props.intent) ?? "",
    scope_boundary: toJson(props.scope_boundary),
    success_criteria: toJson(props.success_criteria),
    appetite: toNum(props.appetite),
    steering: toStr(props.steering),
    horizon: toJson(props.horizon),
    status: toStr(props.status) ?? "active",
    current_phase_id: toStr(props.current_phase_id),
  };
}

function buildRowPhase(props: Record<string, unknown>): Record<string, unknown> {
  return {
    name: toStr(props.name),
    description: toStr(props.description),
    project: toStr(props.project) ?? "",
    phase_type: toStr(props.phase_type) ?? "implementation",
    intent: toStr(props.intent) ?? "",
    steering: toStr(props.steering),
    status: toStr(props.status) ?? "pending",
    work_items: toJson(props.work_items),
    completed_date: toStr(props.completed_date),
  };
}

function buildRowDocumentArtifact(props: Record<string, unknown>, cycleForNode: number | null): Record<string, unknown> {
  return {
    title: toStr(props.title),
    cycle: toNum(props.cycle) ?? cycleForNode,
    content: typeof props.content === "string" ? props.content : JSON.stringify(props),
  };
}

export const NODE_TYPE_REGISTRY = {
  // -------------------------------------------------------------------------
  // Structured artifact types — each has its own extension table
  // -------------------------------------------------------------------------

  work_item: {
    extensionTable: tables.workItems,
    extensionTableName: "work_items",
    idPrefix: "WI-",
    idPadWidth: 3,
    summarySelector: "e.title",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowWorkItem(props),
  },

  finding: {
    extensionTable: tables.findings,
    extensionTableName: "findings",
    idPrefix: "F-",
    idPadWidth: 3,
    summarySelector: "e.severity || ' — ' || e.verdict || ' by ' || e.reviewer",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowFinding(props, cycleForNode),
  },

  domain_policy: {
    extensionTable: tables.domainPolicies,
    extensionTableName: "domain_policies",
    idPrefix: "P-",
    idPadWidth: 2,
    summarySelector: "e.description",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowDomainPolicy(props),
  },

  domain_decision: {
    extensionTable: tables.domainDecisions,
    extensionTableName: "domain_decisions",
    idPrefix: "D-",
    idPadWidth: 2,
    summarySelector: "e.description",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowDomainDecision(props),
  },

  domain_question: {
    extensionTable: tables.domainQuestions,
    extensionTableName: "domain_questions",
    idPrefix: "Q-",
    idPadWidth: 2,
    summarySelector: "e.description",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowDomainQuestion(props),
  },

  guiding_principle: {
    extensionTable: tables.guidingPrinciples,
    extensionTableName: "guiding_principles",
    idPrefix: "GP-",
    idPadWidth: 2,
    summarySelector: "e.name",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowGuidingPrinciple(props),
  },

  constraint: {
    extensionTable: tables.constraints,
    extensionTableName: "constraints",
    idPrefix: "C-",
    idPadWidth: 2,
    summarySelector: "e.category || ': ' || e.description",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowConstraint(props),
  },

  module_spec: {
    extensionTable: tables.moduleSpecs,
    extensionTableName: "module_specs",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "e.name",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowModuleSpec(props),
  },

  research_finding: {
    extensionTable: tables.researchFindings,
    extensionTableName: "research_findings",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "e.topic",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowResearchFinding(props),
  },

  journal_entry: {
    extensionTable: tables.journalEntries,
    extensionTableName: "journal_entries",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "'[' || e.phase || '] ' || e.title",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowJournalEntry(props),
  },

  interview_question: {
    extensionTable: tables.interviewQuestions,
    extensionTableName: "interview_questions",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "e.interview_id || ': ' || e.question",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowInterviewQuestion(props),
  },

  proxy_human_decision: {
    extensionTable: tables.proxyHumanDecisions,
    extensionTableName: "proxy_human_decisions",
    idPrefix: "PHD-",
    idPadWidth: 2,
    summarySelector: "e.trigger || ' → ' || e.decision || ' [' || e.status || ']'",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowProxyHumanDecision(props),
  },

  project: {
    extensionTable: tables.projects,
    extensionTableName: "projects",
    idPrefix: "PR-",
    idPadWidth: 3,
    summarySelector: "COALESCE(e.name, SUBSTR(e.intent, 1, 40))",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowProject(props),
  },

  phase: {
    extensionTable: tables.phases,
    extensionTableName: "phases",
    idPrefix: "PH-",
    idPadWidth: 3,
    summarySelector: "COALESCE(e.name, e.phase_type || ': ' || SUBSTR(e.intent, 1, 40))",
    isQueryable: true,
    buildRow: (props, _cycleForNode) => buildRowPhase(props),
  },

  // -------------------------------------------------------------------------
  // Document artifact subtypes — all stored in the document_artifacts table.
  // These share an extension table; each subtype is differentiated by the
  // `type` column on the base `nodes` row.
  // -------------------------------------------------------------------------

  decision_log: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  cycle_summary: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  review_manifest: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  review_output: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  architecture: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  overview: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  execution_strategy: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  guiding_principles: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  constraints: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  research: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  interview: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  domain_index: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
    buildRow: (props, cycleForNode) => buildRowDocumentArtifact(props, cycleForNode),
  },

  // -------------------------------------------------------------------------
  // autopilot_state — singleton managed via ideate_manage_autopilot_state.
  //
  // This type is intentionally excluded from the queryable set because it is
  // a singleton state artifact, not a collection of queryable records.
  // It lives as a plain YAML file and is stored only in the base `nodes` row
  // (no extension table).  ideate_artifact_query(type: "autopilot_state")
  // silently returns zero results in the current implementation; registering
  // extensionTable: null and isQueryable: false makes this exclusion EXPLICIT
  // and documented, resolving the S2 asymmetry identified in cycle 28.
  //
  // If autopilot_state ever grows structured fields that need querying or
  // indexing, add an extension table here and update isQueryable to true.
  // -------------------------------------------------------------------------

  autopilot_state: {
    extensionTable: null,
    extensionTableName: null,
    idPrefix: null,
    idPadWidth: null,
    summarySelector: null,
    isQueryable: false,
    buildRow: (_props, _cycleForNode) => null,
  },
} as const satisfies Record<NodeType, NodeTypeSpec>;

// ---------------------------------------------------------------------------
// Derived utilities — computed once from the registry
// ---------------------------------------------------------------------------

/**
 * Set of NodeType values for which ideate_artifact_query is supported.
 * Derived from NODE_TYPE_REGISTRY.isQueryable — single source of truth.
 */
export const QUERYABLE_NODE_TYPES: ReadonlySet<NodeType> = new Set(
  (Object.entries(NODE_TYPE_REGISTRY) as Array<[NodeType, NodeTypeSpec]>)
    .filter(([, spec]) => spec.isQueryable)
    .map(([type]) => type)
);

/**
 * Map from NodeType to idPrefix for types that have one.
 * Derived from NODE_TYPE_REGISTRY — single source of truth for ID generation.
 */
export const NODE_TYPE_ID_PREFIXES: ReadonlyMap<NodeType, { prefix: string; padWidth: number }> = new Map(
  (Object.entries(NODE_TYPE_REGISTRY) as Array<[NodeType, NodeTypeSpec]>)
    .filter(([, spec]) => spec.idPrefix !== null && spec.idPadWidth !== null)
    .map(([type, spec]) => [
      type,
      { prefix: spec.idPrefix as string, padWidth: spec.idPadWidth as number },
    ])
);

/**
 * Maps YAML type string → Drizzle extension table reference.
 * Derived from NODE_TYPE_REGISTRY — replaces the duplicate literal in db.ts.
 *
 * Consumers: indexer.ts, adapters/local/writer.ts, tools/write.ts.
 * Note: types with extensionTable === null (autopilot_state) are excluded
 * because they have no extension table to map to.
 */
export const TYPE_TO_EXTENSION_TABLE: Record<string, AnyTable | undefined> = Object.fromEntries(
  (Object.entries(NODE_TYPE_REGISTRY) as Array<[NodeType, NodeTypeSpec]>)
    .filter(([, spec]) => spec.extensionTable !== null)
    .map(([type, spec]) => [type, spec.extensionTable as AnyTable])
);

// ---------------------------------------------------------------------------
// WI-220 — canonical work_item status vocabulary
//
// Problem: work_item status values in the wild are a mix of
// unknown/complete/completed/done (plus obsolete/pending/blocked/in_progress),
// causing get_execution_status and get_workspace_status counts to disagree
// and finished legacy items to be miscategorised as "ready".
//
// This section is the single source of truth for the canonical status enum
// and the legacy-synonym → canonical mapping. It is consumed by:
//   - tools/execution.ts        (get_execution_status classification)
//   - scripts/migrate-status-vocab.ts (one-time data migration)
//
// NOTE ON ENFORCEMENT SCOPE: work_item status is stored on the base `nodes`
// row (nodes.status), not in the work_items extension table (work_items has
// no status column — see schema.ts). NodeTypeSpec.buildRow only builds
// extension-table rows, so buildRowWorkItem does not (and should not) touch
// status. Actual persistence of nodes.status happens in
// adapters/local/writer.ts (putNode/patchNode/batchMutate) and indexer.ts,
// which are outside this work item's declared file scope. normalizeWorkItemStatus
// is exported here as the canonical validator/normalizer so those write paths
// have a single, correct function to call; wiring it into writer.ts/indexer.ts
// is left to a follow-up change (see WI-220 completion notes).
// ---------------------------------------------------------------------------

/** Canonical work_item status vocabulary (WI-220). */
export const WORK_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "obsolete",
  "blocked",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

const WORK_ITEM_STATUS_SET: ReadonlySet<string> = new Set(WORK_ITEM_STATUSES);

/**
 * Statuses considered terminal/finished for execution-readiness purposes.
 * Per WI-220 design: only 'done' and 'obsolete' are terminal — legacy
 * synonyms (complete/completed) must be normalized to 'done' before this
 * check is meaningful (see normalizeWorkItemStatus).
 */
export const TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  "done",
  "obsolete",
]);

/**
 * Legacy status synonyms observed in the wild, mapped to their canonical
 * equivalent. Any raw value not present in WORK_ITEM_STATUSES and not present
 * in this map is treated as unrecognized and normalized to 'pending' by
 * normalizeWorkItemStatus (never silently passed through).
 */
export const WORK_ITEM_STATUS_SYNONYMS: Readonly<Record<string, WorkItemStatus>> = {
  complete: "done",
  completed: "done",
  unknown: "pending",
};

/**
 * Normalize a raw (possibly legacy, null, or unanticipated) status value to
 * the canonical work_item status vocabulary. This is the enforcement point
 * referenced by WI-220's acceptance criteria.
 *
 * Mapping:
 *   - null / undefined / "" / "unknown"   -> "pending"
 *   - "complete" / "completed"            -> "done"
 *   - any of WORK_ITEM_STATUSES verbatim  -> preserved as-is (case-insensitive)
 *   - anything else (typos, future values, unanticipated legacy values)
 *                                          -> "pending" (safe default; never
 *                                             silently passed through)
 */
export function normalizeWorkItemStatus(raw: unknown): WorkItemStatus {
  if (raw === null || raw === undefined) return "pending";
  const s = String(raw).trim().toLowerCase();
  if (s === "") return "pending";
  if (WORK_ITEM_STATUS_SET.has(s)) return s as WorkItemStatus;
  if (Object.prototype.hasOwnProperty.call(WORK_ITEM_STATUS_SYNONYMS, s)) {
    return WORK_ITEM_STATUS_SYNONYMS[s];
  }
  // Unrecognized value — normalize to the safe default rather than passing
  // the raw (non-canonical) string through.
  return "pending";
}

/** True when `raw`, once normalized, is a terminal (done/obsolete) status. */
export function isTerminalWorkItemStatus(raw: unknown): boolean {
  return TERMINAL_WORK_ITEM_STATUSES.has(normalizeWorkItemStatus(raw));
}
