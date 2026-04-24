# StorageAdapter Interface Specification

> Canonical reference for the StorageAdapter TypeScript interface.
> Produced as WI-543 during Phase 0 (PH-018) of the Platform Strategy project.

---

## 1. Design Principles

The StorageAdapter is the boundary between MCP tool handlers (business logic, validation, response formatting) and storage (persistence, indexing, graph traversal). The interface speaks exclusively in graph-native vocabulary:

- **Nodes** — not "YAML files" or "SQLite rows"
- **Edges** — not "foreign keys" or "JOIN"
- **Traversals** — not "recursive CTE" or "file walk"
- **Mutations** — not "upsert" or "writeFileSync"

No YAML, SQLite, Drizzle, file-path, or filesystem idiom crosses this boundary.

---

## 2. Core Types

```typescript
// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** The set of artifact types in the graph. */
type NodeType =
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
  | "metrics_event"
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

/** Metadata common to every node. */
interface NodeMeta {
  id: string;
  type: NodeType;
  status: string | null;
  cycle_created: number | null;
  cycle_modified: number | null;
  content_hash: string;
  token_count: number | null;
}

/** A full node: metadata + type-specific properties as a flat record. */
interface Node extends NodeMeta {
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

type EdgeType =
  | "depends_on"
  | "blocks"
  | "belongs_to_module"
  | "derived_from"
  | "relates_to"
  | "addressed_by"
  | "references"
  | "amended_by"
  | "supersedes"
  | "triggered_by"
  | "governed_by"
  | "informed_by"
  | "belongs_to_project"
  | "belongs_to_phase";

interface Edge {
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Traversal types
// ---------------------------------------------------------------------------

interface TraversalOptions {
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
  /** Maximum token budget for context assembly. */
  token_budget?: number;
  /** Node types to always include regardless of PPR score. */
  always_include_types?: NodeType[];
}

interface TraversalResult {
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
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

interface NodeFilter {
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

interface GraphQuery {
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

interface QueryResult {
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

interface MutateNodeInput {
  id: string;
  type: NodeType;
  properties: Record<string, unknown>;
  /** For cycle-scoped types, which cycle this belongs to. */
  cycle?: number;
}

interface MutateNodeResult {
  id: string;
  status: "created" | "updated";
}

interface UpdateNodeInput {
  id: string;
  /** Only the fields to change. Immutable fields (id, type, cycle_created) are rejected. */
  properties: Record<string, unknown>;
}

interface UpdateNodeResult {
  id: string;
  status: "updated" | "not_found";
}

interface DeleteNodeResult {
  id: string;
  status: "deleted" | "not_found";
}

// ---------------------------------------------------------------------------
// Batch types
// ---------------------------------------------------------------------------

interface BatchMutateInput {
  nodes: MutateNodeInput[];
  /** Edges to create alongside the nodes. */
  edges?: Edge[];
}

interface BatchMutateResult {
  results: MutateNodeResult[];
  /** Any validation errors (e.g., DAG cycles, scope collisions). */
  errors: Array<{ id: string; error: string }>;
}
```

---

## 3. StorageAdapter Interface

```typescript
interface StorageAdapter {
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
   * When `group_by` is `'severity'` and `filter.type === 'finding'`, findings
   * whose `addressed_by` field is non-null, non-empty are excluded from all
   * counts. Only unresolved findings (addressed_by IS NULL) are counted
   * (per P-88).
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
   * Findings with a non-null, non-empty addressed_by are excluded from all counts;
   * only unresolved findings count toward convergence blockers (per P-88).
   */
  getConvergenceData(cycle: number): Promise<{
    findings_by_severity: Record<string, number>;
    cycle_summary_content: string | null;
  }>;

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
   * LocalAdapter: transitions artifacts to archived state, updates node
   * location entries in the index to reflect new locations, and removes
   * stale index entries for moved artifacts.
   *
   * RemoteAdapter: calls the archiveCycle GraphQL mutation which transitions
   * artifact statuses from 'active' to 'archived' for the given cycle.
   *
   * @returns A human-readable summary string (e.g. "Archived cycle 3: 2 work
   *   items, 4 incremental reviews moved."). Callers surface this string to
   *   the user rather than constructing their own message.
   *
   *   **LocalAdapter**: archival-logic errors are returned as a string
   *   beginning with "Error during cycle archival" — the method never throws
   *   for archival failures. Callers must inspect the return value.
   *
   *   **RemoteAdapter**: archival-logic errors from the server are returned
   *   in the successful GraphQL response and surfaced as the return string.
   *   However, transport-layer failures (network, HTTP error, auth failure,
   *   malformed response) propagate as thrown `ConnectionError` or
   *   `StorageAdapterError` because `client.mutate` has no try/catch.
   *
   *   A cycle that has already been archived returns a
   *   "0 work items, 0 incremental reviews moved" message (no error).
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
```

---

## 4. Behavior Specification

### 4.1 `putNode`

| Aspect | Behavior |
|---|---|
| Hash computation | The adapter computes `content_hash` from the node's properties (excluding hash, token_count). Callers never provide these. |
| Token counting | The adapter estimates token count from the serialized content. |
| ID validation | If `input.id` matches an existing node of a different type, the adapter throws `TypeMismatchError`. |
| Cycle scoping | For cycle-scoped types (finding, cycle_summary, review_output, review_manifest, decision_log, proxy_human_decision), the `cycle` field is required. |
| Atomicity | The entire operation (content persistence + index update) succeeds or fails as a unit. No partial state. |

### 4.2 `patchNode`

| Aspect | Behavior |
|---|---|
| Immutable fields | If `properties` contains `id`, `type`, or `cycle_created`, the adapter throws `ImmutableFieldError`. |
| Merge semantics | Provided fields overwrite existing values. Omitted fields are unchanged. Setting a field to `null` clears it. |
| Hash recomputation | After merging, the adapter recomputes `content_hash` and `token_count`. |
| Not found | If the node does not exist, returns `{ status: "not_found" }` without throwing. |

### 4.3 `batchMutate`

| Aspect | Behavior |
|---|---|
| Validation first | All validation runs before any persistence. DAG cycle detection includes both existing edges and new edges from the batch. Scope collision detection checks declared scopes across concurrent (non-dependent) work items. |
| Atomicity | If validation passes, all nodes and edges are persisted in a single transaction. If any persistence step fails, all changes are rolled back. |
| ID generation | Nodes without an `id` in their input receive the next available ID (adapter calls `nextId` internally). |
| Edge creation | Edges specified in `input.edges` are created. Additionally, the adapter extracts implicit edges from node properties (e.g., `depends`, `blocks`, `domain`, `phase` fields on work items) and creates them automatically. |

### 4.4 `traverse`

| Aspect | Behavior |
|---|---|
| PPR execution | Runs Personalized PageRank from `seed_ids`. The algorithm and its implementation are adapter-internal. |
| Token budgeting | The adapter greedily assembles nodes by descending PPR score until `token_budget` is exhausted. Nodes in `always_include_types` are included first regardless of score. Seed nodes are always included. |
| Content loading | The adapter reads full artifact content for each included node. Content is returned as a serialized content string. The format is an adapter implementation detail — callers treat it as opaque text. |
| Empty graph | If the graph has no edges, returns seed nodes with their content. |

### 4.5 `queryGraph`

| Aspect | Behavior |
|---|---|
| Depth | BFS traversal up to `depth` hops from `origin_id`. Maximum depth: 10. |
| Direction | `"outgoing"` follows source->target; `"incoming"` follows target->source; `"both"` follows both. |
| Filtering | `type_filter` restricts result node types. `filters` restricts by status, domain, etc. |
| Pagination | Results are ordered by (depth, node_id) and paginated with limit/offset. |
| Summaries | Each result node includes a human-readable summary derived from type-specific fields. |

### 4.6 `queryNodes`

| Aspect | Behavior |
|---|---|
| Default exclusion | When querying work items without an explicit status filter, nodes with status `done` or `obsolete` are excluded by default. |
| Pagination | Results are ordered by node ID and paginated with limit/offset. |
| Total count | `total_count` reflects the total matching nodes before pagination. |

### 4.7 `archiveCycle`

| Aspect | Behavior |
|---|---|
| Precondition | The cycle number must exist and have at least one artifact associated with it. **LocalAdapter**: if either condition is not met, returns an error string beginning with `"Error during cycle archival"` — it does not throw. **RemoteAdapter**: the server enforces preconditions and returns the outcome as the GraphQL response string; transport failures (network, HTTP, auth) cause `client.mutate` to throw `ConnectionError` or `StorageAdapterError`. A cycle that has already been archived is treated as a no-op in both adapters; it returns a "0 work items, 0 incremental reviews moved" message. |
| LocalAdapter | Transitions artifacts to archived state under the cycle's directory. Updates each node's location entry in the index to reflect its new location. Deletes stale index entries for any artifacts that no longer exist at their original location after the transition. |
| RemoteAdapter | Calls the `archiveCycle` GraphQL mutation, transitioning artifact statuses from `active` to `archived` for the given cycle. |
| Atomicity | **LocalAdapter**: performs all transitions and index updates atomically — on failure, any transitions already completed are rolled back and the method returns an error string beginning with `"Error during cycle archival"` rather than throwing. **RemoteAdapter**: relies on server-side transaction semantics; the server's archival result (success or error string) is returned in the GraphQL response. Transport-layer failures cause `client.mutate` to throw rather than return a string. |
| Idempotency | Calling `archiveCycle` on a cycle that has already been archived is a no-op (no error). |
| Return value | Returns a human-readable summary string (e.g. `"Archived cycle 3: 2 work items, 4 incremental reviews moved."`). On an already-archived cycle, returns a `"0 work items, 0 incremental reviews moved"` message. |

---

## 5. Error Handling Contract

All adapter methods follow a consistent error contract:

### 5.1 Error Types

```typescript
/** Base error for all adapter failures. */
class StorageAdapterError extends Error {
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
class NotFoundError extends StorageAdapterError {
  constructor(id: string) {
    super(`Node not found: "${id}"`, "NOT_FOUND", { id });
  }
}

/** Attempted to change an immutable field. */
class ImmutableFieldError extends StorageAdapterError {
  constructor(field: string) {
    super(
      `Cannot modify immutable field: "${field}"`,
      "IMMUTABLE_FIELD",
      { field }
    );
  }
}

/** Node type does not match expected type for operation. */
class TypeMismatchError extends StorageAdapterError {
  constructor(id: string, expected: string, actual: string) {
    super(
      `Type mismatch for "${id}": expected "${expected}", got "${actual}"`,
      "TYPE_MISMATCH",
      { id, expected, actual }
    );
  }
}

/** DAG cycle detected in dependency graph. */
class CycleDetectedError extends StorageAdapterError {
  constructor(cycles: string[][]) {
    super(
      `DAG cycle detected: ${cycles.map((c) => c.join(" -> ")).join("; ")}`,
      "CYCLE_DETECTED",
      { cycles }
    );
  }
}

/** Scope collision between concurrent work items. */
class ScopeCollisionError extends StorageAdapterError {
  constructor(collisions: Array<{ item_a: string; item_b: string; paths: string[] }>) {
    super(
      `Scope collision detected between work items`,
      "SCOPE_COLLISION",
      { collisions }
    );
  }
}

/** Remote adapter connection or authentication failure. */
class ConnectionError extends StorageAdapterError {
  constructor(message: string, cause?: Error) {
    super(message, "CONNECTION_ERROR", { cause: cause?.message });
  }
}

/** Required field missing for a cycle-scoped type. */
class MissingCycleError extends StorageAdapterError {
  constructor(type: string) {
    super(
      `Cycle parameter required for type "${type}"`,
      "MISSING_CYCLE",
      { type }
    );
  }
}
```

### 5.2 Error Behavior by Method

| Method | Throws | Returns error status |
|---|---|---|
| `getNode` | Never (returns null) | -- |
| `getNodes` | Never (omits missing) | -- |
| `readNodeContent` | Never (returns "") | -- |
| `putNode` | `TypeMismatchError`, `MissingCycleError`, `StorageAdapterError` (I/O) | -- |
| `patchNode` | `ImmutableFieldError`, `StorageAdapterError` (I/O) | `not_found` |
| `deleteNode` | `StorageAdapterError` (I/O) | `not_found` |
| `putEdge` | `StorageAdapterError` (I/O) | -- |
| `removeEdges` | `StorageAdapterError` (I/O) | -- |
| `getEdges` | Never (returns []) | -- |
| `traverse` | `StorageAdapterError` (I/O) | -- |
| `queryGraph` | `NotFoundError` (origin not found) | -- |
| `queryNodes` | Never | -- |
| `nextId` | `StorageAdapterError` (unknown type) | -- |
| `batchMutate` | `CycleDetectedError`, `ScopeCollisionError`, `StorageAdapterError` | Per-item errors in result |
| `countNodes` | Never | -- |
| `getDomainState` | Never | -- |
| `getConvergenceData` | Never | -- |
| `initialize` | `ConnectionError`, `StorageAdapterError` | -- |
| `shutdown` | Never (best-effort) | -- |
| `archiveCycle` | **LocalAdapter**: never — returns error string beginning with `"Error during cycle archival"`. **RemoteAdapter**: `ConnectionError` or `StorageAdapterError` on transport/HTTP/auth failure; archival-logic errors from the server are returned as the response string, not thrown. | -- |
| `appendJournalEntry` | `StorageAdapterError` (I/O) | -- |

### 5.3 AUTH_FAILURE Error Code

Thrown as a base `StorageAdapterError` with code `AUTH_FAILURE` (no dedicated subclass). Remote adapter only. Not retryable.

**Trigger conditions:**
1. `tokenProvider` returns `null` or `undefined` after a 401 response
2. `tokenProvider` itself throws (e.g., EC2 metadata service timeout)
3. No `tokenProvider` is configured and the endpoint returns 401 Unauthorized

Note: if the retry after token rotation also returns 401, `executeOnceWithAuth` throws `StorageAdapterError` with code `HTTP_401`, not `AUTH_FAILURE`.

Introduced in WI-833. Trigger surface expanded in WI-837 (tokenProvider throw path) and WI-840 (no-tokenProvider 401 path).

---

## 6. Transaction Semantics

### 6.1 Local Adapter

The LocalAdapter preserves the existing two-phase write pattern internally:

1. **Phase 1 (primary store write)** -- Serialize and persist node properties to the primary store. The primary store is the source of truth.
2. **Phase 2 (index upsert)** -- Upsert node metadata, extension table rows, and edges in a single exclusive transaction against the index.
3. **Rollback** -- If Phase 2 fails, the Phase 1 primary-store entry is removed (best-effort cleanup). The adapter never leaves primary-store entries without corresponding index entries.

For `batchMutate`, all primary-store writes are performed first, then all index upserts run in a single transaction. On index failure, all primary-store entries written in that batch are removed.

### 6.2 Remote Adapter

The RemoteAdapter sends a single GraphQL mutation per operation. The server handles atomicity internally. There is no two-phase pattern; the server's transaction boundary encompasses the entire operation.

For `batchMutate`, the RemoteAdapter sends a single `batchMutateNodes` GraphQL mutation containing all nodes and edges. The server validates and persists atomically.

---

## 7. Adapter Factory

`AdapterConfig` is the internal schema of the parsed `.ideate.json` file. It is **not** a parameter to `selectAdapter`; the factory reads it from disk via `readRawConfig(dir)`.

```typescript
/** Shape of the parsed .ideate.json consumed internally by selectAdapter. */
interface AdapterConfig {
  backend: "local" | "remote";
  /** Local-mode configuration. */
  local?: {
    /** Root path for artifact storage. */
    artifact_dir: string;
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

/**
 * Select and instantiate the appropriate StorageAdapter based on .ideate.json
 * in the given ideate directory.
 *
 * @param dir - Path to the ideate directory
 * @param db - Open SQLite database instance (required for local backend)
 * @param drizzleDb - Drizzle ORM wrapper (required for local backend)
 * @throws {Error} when remote config is missing required fields, or backend is unknown
 */
function selectAdapter(
  dir: string,
  db?: Database,
  drizzleDb?: BetterSQLite3Database
): StorageAdapter;
```

