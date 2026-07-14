// adapter.ts — StorageAdapter interface and supporting types
//
// This module defines the graph-native boundary between MCP tool handlers and
// storage. No YAML, SQLite, Drizzle, file-path, or filesystem types cross this
// boundary. The interface speaks exclusively in nodes, edges, traversals, and
// mutations.

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** The set of artifact types in the graph. */
export type NodeType =
  | "work_item"
  | "finding"
  | "domain_policy"
  | "domain_decision"
  | "domain_question"
  | "guiding_principle"
  | "constraint"
  | "module_spec"
  | "research_finding"
  | "journal_entry"
  | "interview_question"
  | "proxy_human_decision"
  | "project"
  | "phase"
  // Document artifact subtypes
  | "decision_log"
  | "cycle_summary"
  | "review_manifest"
  | "review_output"
  | "architecture"
  | "overview"
  | "execution_strategy"
  | "guiding_principles"
  | "constraints"
  | "research"
  | "interview"
  | "domain_index"
  // Session/state artifacts
  | "autopilot_state";

/** All valid NodeType values for runtime validation. */
export const ALL_NODE_TYPES = [
  "work_item",
  "finding",
  "domain_policy",
  "domain_decision",
  "domain_question",
  "guiding_principle",
  "constraint",
  "module_spec",
  "research_finding",
  "journal_entry",
  "interview_question",
  "proxy_human_decision",
  "project",
  "phase",
  "decision_log",
  "cycle_summary",
  "review_manifest",
  "review_output",
  "architecture",
  "overview",
  "execution_strategy",
  "guiding_principles",
  "constraints",
  "research",
  "interview",
  "domain_index",
  "autopilot_state",
] as const;

// Compile-time exhaustiveness: every NodeType must appear in ALL_NODE_TYPES.
// If a new NodeType member is added without updating ALL_NODE_TYPES, tsc emits:
// "Type 'true' is not assignable to type 'false'"
type _ExhaustiveNodeTypeCheck = Exclude<
  NodeType,
  typeof ALL_NODE_TYPES[number]
> extends never
  ? true
  : false;
const _nodeTypesExhaustive: _ExhaustiveNodeTypeCheck = true;
void _nodeTypesExhaustive;

/** Metadata common to every node. */
export interface NodeMeta {
  id: string;
  type: NodeType;
  status: string | null;
  cycle_created: number | null;
  cycle_modified: number | null;
  content_hash: string;
  token_count: number | null;
}

/** A full node: metadata + type-specific properties as a flat record. */
export interface Node extends NodeMeta {
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

// EdgeType and EDGE_TYPES are canonically defined in schema.ts.
// Re-exported here for backwards compatibility with existing callers.
import type { EdgeType } from "./schema.js"; // Local import for use below; re-exported for callers below
import { EDGE_TYPES } from "./schema.js";
export type { EdgeType } from "./schema.js";
export { EDGE_TYPES } from "./schema.js";

/** All valid EdgeType values for runtime validation. Canonical source: EDGE_TYPES in schema.ts. */
export const ALL_EDGE_TYPES = EDGE_TYPES;

export interface Edge {
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Traversal types
// ---------------------------------------------------------------------------

export interface TraversalOptions {
  /** Seed node IDs for PPR or BFS traversal. */
  seed_ids: string[];
  /** PPR restart probability (0-1). */
  alpha?: number;
  /** Maximum PPR iterations. */
  max_iterations?: number;
  /** PPR convergence threshold. */
  convergence_threshold?: number;
  /** Per-edge-type weight overrides for PPR score propagation. */
  edge_type_weights?: Record<string, number>;
  /**
   * Maximum token budget for context assembly. Defaults to 50000 when omitted.
   *
   * Contract invariant (WI-787, Option 1 — Budget-capped always-include):
   *   - Seeds (seed_ids) are force-included even if they would exceed the budget.
   *   - Every other artifact — including always_include_types — is
   *     budget-gated: once inclusion would bust the budget, the artifact is
   *     skipped and TraversalResult.budget_exhausted is set to true.
   *   - Always-include types are pulled in preference order but not
   *     unconditionally. This replaces the pre-WI-787 behavior where
   *     always_include_types bypassed the budget and caused overflow.
   */
  token_budget?: number;
  /**
   * Node types to include preferentially (fetched regardless of PPR
   * reachability) but still subject to token_budget. If dropping an artifact
   * of one of these types due to budget, its NodeType is recorded in
   * TraversalResult.truncated_types.
   */
  always_include_types?: NodeType[];
  /**
   * Maximum number of ranked nodes returned. Applied as a slice after PPR
   * scoring. If omitted or 0, all ranked nodes are returned. No effect on
   * PPR computation itself.
   */
  max_nodes?: number;
}

export interface TraversalResult {
  /** Nodes ranked by relevance score, highest first. */
  ranked_nodes: Array<{
    node: Node;
    score: number;
    content: string;
  }>;
  /** Total tokens consumed by included nodes. */
  total_tokens: number;
  /** Top-N PPR scores for metadata/debugging. */
  ppr_scores: Array<{ id: string; score: number }>;
  /**
   * True when one or more artifacts were skipped because including them would
   * have exceeded token_budget. Applies to both always_include_types and
   * ranked artifacts. Callers use this to detect incomplete context.
   */
  budget_exhausted?: boolean;
  /**
   * NodeTypes for which at least one always-include artifact was skipped due
   * to budget. Empty/absent when budget_exhausted is false or when only ranked
   * (non-always-include) artifacts were truncated.
   */
  truncated_types?: NodeType[];
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface NodeFilter {
  type?: NodeType;
  status?: string;
  domain?: string;
  cycle?: number;
  severity?: string;
  phase?: string;
  work_item?: string;
  work_item_type?: string;
  /** Agent type filter — matched inside payload JSON. */
  agent_type?: string;
}

export interface GraphQuery {
  /** Start node for graph traversal. */
  origin_id: string;
  /** Maximum traversal depth. */
  depth?: number;
  /** Traverse outgoing, incoming, or both edge directions. */
  direction?: "outgoing" | "incoming" | "both";
  /** Restrict to specific edge types. */
  edge_types?: EdgeType[];
  /** Filter result nodes by type. */
  type_filter?: NodeType;
  /** Additional filters on result nodes. */
  filters?: NodeFilter;
}

export interface QueryResult {
  nodes: Array<{
    node: NodeMeta;
    summary: string;
    /** Present in graph queries. */
    edge_type?: EdgeType;
    direction?: "outgoing" | "incoming";
    depth?: number;
  }>;
  total_count: number;
}

// ---------------------------------------------------------------------------
// Mutation types
// ---------------------------------------------------------------------------

export interface MutateNodeInput {
  id: string;
  type: NodeType;
  properties: Record<string, unknown>;
  /** For cycle-scoped types, which cycle this belongs to. */
  cycle?: number;
}

export interface MutateNodeResult {
  id: string;
  status: "created" | "updated";
}

export interface UpdateNodeInput {
  id: string;
  /** Only the fields to change. Immutable fields (id, type, cycle_created) are rejected. */
  properties: Record<string, unknown>;
}

export interface UpdateNodeResult {
  id: string;
  status: "updated" | "not_found";
}

export interface DeleteNodeResult {
  id: string;
  status: "deleted" | "not_found";
}

// ---------------------------------------------------------------------------
// Batch types
// ---------------------------------------------------------------------------

export interface BatchMutateInput {
  nodes: MutateNodeInput[];
  /** Edges to create alongside the nodes. */
  edges?: Edge[];
}

export interface BatchMutateResult {
  results: MutateNodeResult[];
  /** Any validation errors (e.g., DAG cycles, scope collisions). */
  errors: Array<{ id: string; error: string }>;
}

// ---------------------------------------------------------------------------
// StorageAdapter interface
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  // -----------------------------------------------------------------------
  // Node CRUD
  // -----------------------------------------------------------------------

  /**
   * Retrieve a single node by ID.
   *
   * @returns The full node including properties, or null if not found.
   */
  getNode(id: string): Promise<Node | null>;

  /**
   * Retrieve multiple nodes by IDs in a single call.
   * Missing IDs are omitted from the result (no error).
   *
   * @returns Map of id -> Node for all found nodes.
   */
  getNodes(ids: string[]): Promise<Map<string, Node>>;

  /**
   * Read the full content of a node (the complete serialized artifact).
   * Returns the content as a serialized content string. The format is an
   * adapter implementation detail — callers treat it as opaque text.
   * Returns empty string if content is unavailable.
   */
  readNodeContent(id: string): Promise<string>;

  /**
   * Create or replace a node. The adapter handles all persistence
   * details internally.
   *
   * Content hash and token count are computed by the adapter, not the caller.
   *
   * @returns The ID and whether the node was created or updated.
   */
  putNode(input: MutateNodeInput): Promise<MutateNodeResult>;

  /**
   * Partially update an existing node's properties.
   * Only provided fields are changed. Immutable fields (id, type,
   * cycle_created) are rejected with an error.
   *
   * @returns Updated status or not_found.
   */
  patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult>;

  /**
   * Delete a node and its associated edges.
   *
   * @returns Deleted status or not_found.
   */
  deleteNode(id: string): Promise<DeleteNodeResult>;

  // -----------------------------------------------------------------------
  // Edge CRUD
  // -----------------------------------------------------------------------

  /**
   * Create an edge between two nodes. Idempotent: if the exact
   * (source, target, type) triple exists, this is a no-op.
   */
  putEdge(edge: Edge): Promise<void>;

  /**
   * Remove all edges from a given source node with the specified types.
   * Used during node updates to replace dependency sets atomically.
   */
  removeEdges(source_id: string, edge_types: EdgeType[]): Promise<void>;

  /**
   * Get all edges originating from or targeting a node.
   *
   * @param direction - "outgoing" returns edges where source_id = id,
   *                    "incoming" where target_id = id,
   *                    "both" returns all.
   */
  getEdges(
    id: string,
    direction: "outgoing" | "incoming" | "both"
  ): Promise<Edge[]>;

  // -----------------------------------------------------------------------
  // Graph traversal
  // -----------------------------------------------------------------------

  /**
   * Execute a PPR-based graph traversal for context assembly.
   *
   * The implementation is invisible to callers:
   * - LocalAdapter runs PPR in-process via ppr.ts
   * - RemoteAdapter delegates to a server-side PPR endpoint
   *
   * Returns ranked nodes with content, respecting the token budget.
   */
  traverse(options: TraversalOptions): Promise<TraversalResult>;

  /**
   * Execute a graph query: BFS/DFS from an origin node, with filters.
   * Used by ideate_query for the related_to mode.
   */
  queryGraph(query: GraphQuery, limit: number, offset: number): Promise<QueryResult>;

  // -----------------------------------------------------------------------
  // Filtered queries
  // -----------------------------------------------------------------------

  /**
   * Query nodes by type and filters with pagination.
   * Used by ideate_query for the filter mode.
   */
  queryNodes(
    filter: NodeFilter,
    limit: number,
    offset: number
  ): Promise<QueryResult>;

  /**
   * Incrementally index specific file paths into the SQLite index.
   * Called by the artifact watcher on add/change events.
   *
   * LocalAdapter: delegates to the indexer's indexFiles() function.
   * RemoteAdapter: no-op stub (remote index is maintained server-side).
   *
   * @param paths - Absolute file paths to index. Non-YAML paths are ignored.
   */
  indexFiles(paths: string[]): Promise<void>;

  /**
   * Remove file paths from the SQLite index.
   * Called by the artifact watcher on unlink events.
   *
   * LocalAdapter: delegates to the indexer's removeFiles() function.
   * RemoteAdapter: no-op stub (remote index is maintained server-side).
   *
   * @param paths - Absolute file paths to remove from the index.
   */
  removeFiles(paths: string[]): Promise<void>;

  /**
   * Generate the next available ID for a given node type.
   * Handles ID format conventions (WI-001, GP-01, etc.) internally.
   */
  nextId(type: NodeType, cycle?: number): Promise<string>;

  // -----------------------------------------------------------------------
  // Batch operations
  // -----------------------------------------------------------------------

  /**
   * Atomically create/update multiple nodes and edges.
   *
   * The adapter performs validation before persisting:
   * - DAG cycle detection on depends_on/blocks edges
   * - Scope collision detection across concurrent work items
   *
   * On validation failure, no nodes or edges are persisted.
   * On partial persistence failure, the adapter rolls back all changes.
   */
  batchMutate(input: BatchMutateInput): Promise<BatchMutateResult>;

  // -----------------------------------------------------------------------
  // Aggregation queries
  // -----------------------------------------------------------------------

  /**
   * Count nodes grouped by a dimension (status, type, domain, severity).
   * Used by analysis handlers (workspace status, convergence, domain state).
   *
   * @remarks When `group_by` is `'severity'` and `filter.type === 'finding'`,
   * findings whose `addressed_by` field is non-null, non-empty are excluded
   * from all counts. Only unresolved findings
   * (those with `addressed_by` IS NULL) are counted (per P-88). This is
   * consistent with the exclusion rule applied in `getConvergenceData`.
   */
  countNodes(
    filter: NodeFilter,
    group_by: "status" | "type" | "domain" | "severity"
  ): Promise<Array<{ key: string; count: number }>>;

  /**
   * Retrieve domain state: active policies, decisions, and open questions
   * for the specified domains (or all domains if not specified).
   */
  getDomainState(
    domains?: string[]
  ): Promise<
    Map<
      string,
      {
        policies: Array<{ id: string; description: string | null; status: string | null }>;
        decisions: Array<{ id: string; description: string | null; status: string | null }>;
        questions: Array<{ id: string; description: string | null; status: string | null }>;
      }
    >
  >;

  /**
   * Get convergence status for a cycle: finding counts by severity,
   * principle violation verdict.
   * Excludes findings with non-null, non-empty addressed_by (resolved findings
   * are not counted toward convergence blockers).
   */
  getConvergenceData(cycle: number): Promise<{
    findings_by_severity: Record<string, number>;
    cycle_summary_content: string | null;
  }>;

  /**
   * Retrieve tool_usage telemetry rows. Results are ordered by timestamp ASC, id ASC.
   * Filters are AND-combined; missing filters are ignored.
   */
  getToolUsage(filter?: ToolUsageFilter): Promise<ToolUsageRow[]>;

  /**
   * Run workspace integrity checks against the local SQLite index and YAML files.
   *
   * Runs four checks:
   *   1. Orphan nodes — node rows with no corresponding YAML file on disk.
   *   2. Unindexed YAML — YAML files on disk not present in the nodes table.
   *   3. Dangling edges — edges whose source_id or target_id does not exist in nodes.
   *   4. Stale addressed_by — findings.addressed_by references a non-existent work_item.
   *
   * RemoteAdapter: throws StorageAdapterError("NOT_SUPPORTED", …) — not yet implemented.
   */
  checkWorkspace(): Promise<WorkspaceCheckReport>;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialize the adapter. Called once at server startup.
   * LocalAdapter: initializes the local store, rebuilds the index, starts
   * the artifact watcher.
   * RemoteAdapter: establishes the remote connection and validates auth.
   */
  initialize(): Promise<void>;

  /**
   * Gracefully shut down the adapter.
   * LocalAdapter: flushes pending writes and stops the artifact watcher.
   * RemoteAdapter: closes the remote connection.
   */
  shutdown(): Promise<void>;

  /**
   * Archive completed work items and findings for the given cycle.
   * Must be called after a cycle review is finalized.
   *
   * LocalAdapter: transitions artifacts to archived state,
   * updates node location entries in the index to reflect new locations, and
   * removes stale index entries for moved artifacts.
   *
   * RemoteAdapter: calls the archiveCycle GraphQL mutation which transitions
   * artifact statuses from 'active' to 'archived' for the given cycle.
   *
   * Returns a human-readable summary string (e.g. "Archived cycle 3: 2 work
   * items, 4 incremental reviews moved."). On error the string begins with
   * "Error during cycle archival" rather than throwing, so callers can surface
   * the message to the user.
   *
   * Calling archiveCycle on a cycle that exists but has already been archived
   * is a no-op returning a "0 work items, 0 incremental reviews moved" message.
   */
  archiveCycle(cycle: number): Promise<string>;

  /**
   * Append a journal entry for the given skill invocation.
   *
   * Handles all persistence details (persistence and indexing, sequence
   * numbering) atomically in an exclusive transaction.
   *
   * @param args.skill      - Skill name (e.g. "execute", "review").
   * @param args.date       - ISO date string for the entry.
   * @param args.entryType  - Entry subtype label (e.g. "work-item-complete").
   * @param args.body       - Full entry body text.
   * @param args.cycle      - Cycle number; defaults to the current max cycle
   *                          when omitted.
   *
   * @returns The ID of the newly created journal entry node (e.g. "J-003-001").
   */
  appendJournalEntry(args: {
    skill: string;
    date: string;
    entryType: string;
    body: string;
    cycle: number;
  }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Workspace check report types
// ---------------------------------------------------------------------------

export interface WorkspaceCheckDetail<T> {
  count: number;
  examples: T[];
}

export interface WorkspaceCheckReport {
  timestamp: string;
  summary: {
    total_checks: 4;
    passed: number;
    failed: number;
  };
  checks: {
    orphan_nodes: WorkspaceCheckDetail<string>;
    unindexed_yaml: WorkspaceCheckDetail<string>;
    dangling_edges: WorkspaceCheckDetail<{ source: string; target: string; type: string }>;
    stale_addressed_by: WorkspaceCheckDetail<{ finding: string; work_item: string }>;
  };
}

// ---------------------------------------------------------------------------
// Operational telemetry types (not part of the artifact graph)
// ---------------------------------------------------------------------------

/**
 * Row type for the tool_usage table as returned by queries.
 * Represents a single tool invocation telemetry record.
 * This is a standalone operational table — not a node-extension table.
 */
export interface ToolUsageRow {
  id: number;
  tool_name: string;
  request_tokens: number | null;
  response_tokens: number | null;
  request_bytes: number;
  response_bytes: number;
  session_id: string | null;
  cycle: number | null;
  phase: string | null;
  timestamp: string;
}

/**
 * Insert-side shape for tool_usage. `id` is omitted because SQLite assigns
 * it via autoincrement on insert.
 */
export type ToolUsageInsert = Omit<ToolUsageRow, "id">;

/**
 * Filter parameters for getToolUsage queries.
 * All fields are optional; present fields are AND-combined.
 */
export interface ToolUsageFilter {
  tool_name?: string;
  session_id?: string;
  cycle?: number;
  phase?: string;
  /** ISO timestamp lower bound (inclusive). */
  from?: string;
  /** ISO timestamp upper bound (inclusive). */
  to?: string;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Base error for all adapter failures. */
export class StorageAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "StorageAdapterError";
  }
}

/** Node or edge not found. */
export class NotFoundError extends StorageAdapterError {
  constructor(id: string) {
    super(`Node not found: "${id}"`, "NOT_FOUND", { id });
    this.name = "NotFoundError";
  }
}

/** Attempted to change an immutable field. */
export class ImmutableFieldError extends StorageAdapterError {
  constructor(field: string) {
    super(
      `Cannot modify immutable field: "${field}"`,
      "IMMUTABLE_FIELD",
      { field }
    );
    this.name = "ImmutableFieldError";
  }
}

/** Node type does not match expected type for operation. */
export class TypeMismatchError extends StorageAdapterError {
  constructor(id: string, expected: string, actual: string) {
    super(
      `Type mismatch for "${id}": expected "${expected}", got "${actual}"`,
      "TYPE_MISMATCH",
      { id, expected, actual }
    );
    this.name = "TypeMismatchError";
  }
}

/** DAG cycle detected in dependency graph. */
export class CycleDetectedError extends StorageAdapterError {
  constructor(cycles: string[][]) {
    super(
      `DAG cycle detected: ${cycles.map((c) => c.join(" -> ")).join("; ")}`,
      "CYCLE_DETECTED",
      { cycles }
    );
    this.name = "CycleDetectedError";
  }
}

/** Scope collision between concurrent work items. */
export class ScopeCollisionError extends StorageAdapterError {
  constructor(collisions: Array<{ item_a: string; item_b: string; paths: string[] }>) {
    super(
      `Scope collision detected between work items`,
      "SCOPE_COLLISION",
      { collisions }
    );
    this.name = "ScopeCollisionError";
  }
}

/** Remote adapter connection or authentication failure. */
export class ConnectionError extends StorageAdapterError {
  constructor(message: string, cause?: Error) {
    super(message, "CONNECTION_ERROR", { cause: cause?.message });
    this.name = "ConnectionError";
  }
}

/** Required field missing for a cycle-scoped type. */
export class MissingCycleError extends StorageAdapterError {
  constructor(type: string) {
    super(
      `Cycle parameter required for type "${type}"`,
      "MISSING_CYCLE",
      { type }
    );
    this.name = "MissingCycleError";
  }
}

/** Validation error for invalid input parameters or transaction failures. */
export class ValidationError extends StorageAdapterError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>
  ) {
    super(message, code, details);
    this.name = "ValidationError";
  }
}

/**
 * The project has migrated to the v3 work-state board (its board.db exists
 * on disk), so the v2 artifact server refuses this work-item write. This is
 * the sink-guard fix for WI-321: on a board-committed project there is no
 * legitimate v2 work-item write — board items are the single home — so this
 * error is thrown instead of silently splitting new work off the board.
 * Distinguishable from ordinary validation errors via `instanceof
 * BoardActiveError` or `code === "BOARD_ACTIVE"`.
 */
export class BoardActiveError extends StorageAdapterError {
  /**
   * @param boardDbPath  the resolved board.db path that triggered the refusal.
   * @param context      optional per-sink override naming the correct v3 path.
   *                     When omitted, the message is the WI-321 create-sink
   *                     message (byte-identical — the create path and its tests
   *                     are unaffected). The WI-330 update sink passes a context
   *                     naming the board transition tools instead of work_create.
   */
  constructor(boardDbPath: string, context?: { action: string; correctPath: string }) {
    const message = context
      ? `Refused: this project uses the v3 work-state board (found ${boardDbPath}). ` +
        `Work items must be ${context.action} via ${context.correctPath}, not the v2 artifact store. ` +
        `Using the v2 work-item path here would silently split work off the board.`
      : `Refused: this project uses the v3 work-state board (found ${boardDbPath}). ` +
        `Work items must be created via the v3 "work_create" tool, not the v2 artifact store. ` +
        `Creating a v2 work item here would silently split new work off the board.`;
    super(message, "BOARD_ACTIVE", { boardDbPath });
    this.name = "BoardActiveError";
  }
}

/**
 * Thrown by the phase-write backstop (WI-331 / II1) when a board-active phase
 * write would silently drop existing work_items membership — protecting the
 * only v2-side record of board-item phase membership (and the P-47 phase-close
 * gate's census that trusts it). Distinguishable via `instanceof
 * PhaseMembershipTruncationError` or `code === "PHASE_MEMBERSHIP_TRUNCATION"`.
 */
export class PhaseMembershipTruncationError extends StorageAdapterError {
  constructor(phaseId: string, droppedIds: string[]) {
    super(
      `Refused: phase ${phaseId} write would drop work_items members [${droppedIds.join(", ")}] ` +
        `while the v3 work-state board is active. These may be board-resident items whose only ` +
        `v2-side phase-membership record is this list; dropping them silently truncates the phase's ` +
        `board-item membership and corrupts the P-47 phase-close gate's census. Re-include them in ` +
        `work_items, or use an explicit removal path if the removal is intended.`,
      "PHASE_MEMBERSHIP_TRUNCATION",
      { phaseId, droppedIds }
    );
    this.name = "PhaseMembershipTruncationError";
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scope types — (org_id, codebase_id) identity model
// ---------------------------------------------------------------------------

/**
 * Artifact scope: the (org_id, codebase_id) pair that uniquely identifies a
 * tenant/codebase combination. Mirrors the remote adapter's multi-tenant model
 * for local SQLite storage.
 *
 * The reserved sentinel codebase_id='*' opts into cross-codebase reads in the
 * local adapter.
 */
export interface ArtifactScope {
  org_id: string;
  codebase_id: string;
}

/**
 * Reserved sentinel value for codebase_id that opts into cross-codebase reads.
 * When a read method receives a scope with this value, it returns artifacts
 * from all codebases within the org.
 */
export const CROSS_CODEBASE_SENTINEL = "*";

export interface AdapterConfig {
  backend: "local" | "remote";
  /** Local-mode configuration. */
  local?: {
    /** Root path for artifact storage. */
    artifact_dir: string;
    /**
     * Default scope (org_id, codebase_id) resolved at startup.
     * Used by LocalAdapter read methods when no explicit scope is passed.
     * Resolved via resolveDefaultScope() in default-scope-resolver.ts.
     */
    default_scope?: ArtifactScope;
  };
  /** Remote-mode configuration. */
  remote?: {
    /** GraphQL endpoint URL. */
    endpoint: string;
    /** Organization ID for multi-tenant isolation. */
    org_id: string;
    /** Codebase ID within the organization. */
    codebase_id: string;
    /** Auth token or token provider. */
    auth_token?: string | null;
    /** Token provider function for automatic token rotation. Called when a request fails with 401. */
    tokenProvider?: () => Promise<string | null>;
  };
}

