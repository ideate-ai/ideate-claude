// adapters/local/index.ts — LocalAdapter module exports
//
// Exports all LocalAdapter implementations for the local (SQLite + YAML)
// storage backend.
//
// LocalAdapter: full StorageAdapter implementation combining write (WI-552),
// read/query (WI-553), and traversal (WI-554) operations.
// Write methods are fully implemented. Read/query/traversal stubs will be
// filled in by subsequent work items.

import type {
  StorageAdapter,
  Node,
  NodeType,
  Edge,
  TraversalOptions,
  TraversalResult,
  GraphQuery,
  QueryResult,
  NodeFilter,
  ToolUsageFilter,
  ToolUsageRow,
  WorkspaceCheckReport,
} from "../../adapter.js";
import { indexFiles as indexerIndexFiles, removeFiles as indexerRemoveFiles } from "../../indexer.js";
import { ValidationError } from "../../adapter.js";
import { CROSS_CODEBASE_SENTINEL } from "../../adapter.js";
import { LocalWriterAdapter, type LocalWriterConfig } from "./writer.js";
import { LocalReaderAdapter } from "./reader.js";
import { LocalContextAdapter } from "./context.js";
import { artifactWatcher } from "../../watcher.js";
import { hasV4ScopingColumns } from "../../schema.js";

// ---------------------------------------------------------------------------
// LocalAdapter — full StorageAdapter implementation for local .ideate/ storage
// ---------------------------------------------------------------------------

export class LocalAdapter extends LocalWriterAdapter implements StorageAdapter {
  private reader: LocalReaderAdapter;
  private contextAdapter: LocalContextAdapter;
  /** Cached result of hasV4Columns() — null means not yet computed. */
  private _hasV4ColumnsCache: boolean | null = null;

  constructor(config: LocalWriterConfig) {
    super(config);
    this.reader = new LocalReaderAdapter(this.db, this.drizzleDb, this.ideateDir);
    this.contextAdapter = new LocalContextAdapter(this.drizzleDb, this.db);
  }

  // -------------------------------------------------------------------------
  // Scope helpers — filter nodes by (org_id, codebase_id) when v4 columns exist
  // -------------------------------------------------------------------------

  /**
   * Returns true when v4 scoping columns exist in the database.
   * Result is cached per-instance after first call (lazy-init, M1).
   */
  private hasV4Columns(): boolean {
    if (this._hasV4ColumnsCache !== null) return this._hasV4ColumnsCache;
    this._hasV4ColumnsCache = hasV4ScopingColumns(this.db);
    return this._hasV4ColumnsCache;
  }

  /**
   * Filter a node by the current default scope. Returns null if the node
   * does not match the scope (and scope enforcement is active).
   *
   * When called with a cross-codebase sentinel ('*'), all nodes pass.
   * When defaultScope is null or v4 columns don't exist, all nodes pass.
   */
  private nodeMatchesScope(id: string, scopeOverride?: { codebase_id?: string }): boolean {
    if (!this.defaultScope || !this.hasV4Columns()) return true;
    const codebaseId = scopeOverride?.codebase_id ?? this.defaultScope.codebase_id;
    if (codebaseId === CROSS_CODEBASE_SENTINEL) return true;

    try {
      const row = this.db
        .prepare(`SELECT org_id, codebase_id FROM nodes WHERE id = ?`)
        .get(id) as { org_id: string; codebase_id: string } | undefined;
      if (!row) return false;
      return row.org_id === this.defaultScope.org_id && row.codebase_id === codebaseId;
    } catch {
      return true; // fallback: allow on error
    }
  }

  /**
   * Returns the scope to push into SQL queries when v4 columns are active
   * and the sentinel is not in use. Returns null when scope should not be
   * applied (pre-v4 schema, no defaultScope, or cross-codebase sentinel).
   */
  private effectiveScopeForRead(): { org_id: string; codebase_id: string } | null {
    if (!this.defaultScope || !this.hasV4Columns()) return null;
    if (this.defaultScope.codebase_id === CROSS_CODEBASE_SENTINEL) return null;
    return { org_id: this.defaultScope.org_id, codebase_id: this.defaultScope.codebase_id };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // LocalAdapter is initialized externally (schema creation, index rebuild,
    // watcher setup happen in server.ts). This is a no-op for now.
  }

  async shutdown(): Promise<void> {
    // Idempotent: calling shutdown() twice must not throw.
    if (this._isShutDown) return;
    this._isShutDown = true;
    // Stop the artifact watcher — prevents lingering file-watch handles.
    // index.ts owns state.db and closes it separately; we do NOT close it here.
    await artifactWatcher.close();
    // Flip the writer's shutdown guard so mutating methods throw ADAPTER_SHUT_DOWN.
    this._markShutDown();
  }

  // -------------------------------------------------------------------------
  // Node CRUD — read operations (WI-553 scope)
  // -------------------------------------------------------------------------

  async getNode(id: string): Promise<Node | null> {
    const node = await this.reader.getNode(id);
    if (node === null) return null;
    if (!this.nodeMatchesScope(id)) return null;
    return node;
  }

  async getNodes(ids: string[]): Promise<Map<string, Node>> {
    const all = await this.reader.getNodes(ids);
    if (!this.defaultScope || !this.hasV4Columns()) return all;
    const result = new Map<string, Node>();
    for (const [nodeId, node] of all) {
      if (this.nodeMatchesScope(nodeId)) {
        result.set(nodeId, node);
      }
    }
    return result;
  }

  async readNodeContent(id: string): Promise<string> {
    // Scope guard: return empty string for nodes outside the current scope.
    if (!this.nodeMatchesScope(id)) return "";
    return this.reader.readNodeContent(id);
  }

  // -------------------------------------------------------------------------
  // Edge CRUD — read operations (WI-553 scope)
  // -------------------------------------------------------------------------

  async getEdges(
    id: string,
    direction: "outgoing" | "incoming" | "both"
  ): Promise<Edge[]> {
    return this.reader.getEdges(id, direction);
  }

  // -------------------------------------------------------------------------
  // Graph traversal (WI-554 scope)
  // -------------------------------------------------------------------------

  async traverse(options: TraversalOptions): Promise<TraversalResult> {
    // Scope-filter seed IDs: exclude seeds that don't match the current scope.
    if (this.defaultScope && this.hasV4Columns() && this.defaultScope.codebase_id !== CROSS_CODEBASE_SENTINEL) {
      const filteredSeeds = options.seed_ids.filter((id) => this.nodeMatchesScope(id));
      if (filteredSeeds.length !== options.seed_ids.length) {
        options = { ...options, seed_ids: filteredSeeds };
      }
    }
    const result = await this.contextAdapter.traverse(options);
    // Scope-filter traversal results post-read.
    if (this.defaultScope && this.hasV4Columns() && this.defaultScope.codebase_id !== CROSS_CODEBASE_SENTINEL) {
      return {
        ...result,
        ranked_nodes: result.ranked_nodes.filter((entry) => this.nodeMatchesScope(entry.node.id)),
      };
    }
    return result;
  }

  async queryGraph(
    query: GraphQuery,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new ValidationError("Limit must be a non-negative integer", "INVALID_LIMIT", { limit });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError("Offset must be a non-negative integer", "INVALID_OFFSET", { offset });
    }
    // Scope-check the origin node before traversal.
    if (!this.nodeMatchesScope(query.origin_id)) {
      const { NotFoundError } = await import("../../adapter.js");
      throw new NotFoundError(query.origin_id);
    }
    const result = await this.reader.queryGraph(query, limit, offset);
    // Scope-filter traversal results post-read.
    if (this.defaultScope && this.hasV4Columns() && this.defaultScope.codebase_id !== CROSS_CODEBASE_SENTINEL) {
      const filtered = result.nodes.filter((entry) => this.nodeMatchesScope(entry.node.id));
      return { nodes: filtered, total_count: filtered.length };
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Filtered queries (WI-553 scope)
  // -------------------------------------------------------------------------

  async queryNodes(
    filter: NodeFilter,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new ValidationError("Limit must be a non-negative integer", "INVALID_LIMIT", { limit });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError("Offset must be a non-negative integer", "INVALID_OFFSET", { offset });
    }
    // Push scope predicate into SQL so total_count reflects in-scope rows (S4).
    const scope = this.effectiveScopeForRead();
    return this.reader.queryNodes(filter, limit, offset, scope ?? undefined);
  }

  async indexFiles(paths: string[]): Promise<void> {
    indexerIndexFiles(this.db, this.drizzleDb, paths);
  }

  async removeFiles(paths: string[]): Promise<void> {
    indexerRemoveFiles(this.db, this.drizzleDb, paths);
  }

  // -------------------------------------------------------------------------
  // ID generation (WI-553 scope)
  //
  // Combines writer-specific ID generation (journal_entry, finding) with
  // reader-based ID generation for other artifact types.
  // -------------------------------------------------------------------------

  async nextId(type: NodeType, cycle?: number): Promise<string> {
    // Types handled by LocalWriterAdapter (cycle-based journal / finding IDs)
    if (type === "journal_entry" || type === "finding") {
      return super.nextId(type, cycle);
    }
    // All other types handled by LocalReaderAdapter
    return this.reader.nextId(type, cycle);
  }

  // -------------------------------------------------------------------------
  // Aggregation queries (WI-553 scope)
  // -------------------------------------------------------------------------

  async countNodes(
    filter: NodeFilter,
    group_by: "status" | "type" | "domain" | "severity"
  ): Promise<Array<{ key: string; count: number }>> {
    const scope = this.effectiveScopeForRead();
    return this.reader.countNodes(filter, group_by, scope ?? undefined);
  }

  async getDomainState(
    domains?: string[]
  ): Promise<Map<string, {
    policies: Array<{ id: string; description: string | null; status: string | null }>;
    decisions: Array<{ id: string; description: string | null; status: string | null }>;
    questions: Array<{ id: string; description: string | null; status: string | null }>;
  }>> {
    const scope = this.effectiveScopeForRead();
    return this.reader.getDomainState(domains, scope ?? undefined);
  }

  async getConvergenceData(cycle: number): Promise<{
    findings_by_severity: Record<string, number>;
    cycle_summary_content: string | null;
  }> {
    const scope = this.effectiveScopeForRead();
    return this.reader.getConvergenceData(cycle, scope ?? undefined);
  }

  async getToolUsage(filter?: ToolUsageFilter): Promise<ToolUsageRow[]> {
    return this.reader.getToolUsage(filter);
  }

  async checkWorkspace(): Promise<WorkspaceCheckReport> {
    return this.reader.checkWorkspace();
  }

}

// ---------------------------------------------------------------------------
// Re-export previously existing adapter sub-components
// ---------------------------------------------------------------------------

export { LocalContextAdapter } from "./context.js";
export type {
  DocumentArtifactRow,
  GuidingPrincipleRow,
  ConstraintRow,
  ProjectRow,
  PhaseRow,
} from "./context.js";

export { LocalReaderAdapter } from "./reader.js";
export { LocalWriterAdapter } from "./writer.js";
export type { LocalWriterConfig };
