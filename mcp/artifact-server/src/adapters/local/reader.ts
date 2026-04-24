// adapters/local/reader.ts — LocalAdapter read and query operations
//
// Implements the read/query half of StorageAdapter for local (SQLite + YAML)
// storage.  All SQL is executed synchronously via better-sqlite3; the async
// signatures match the StorageAdapter interface.
//
// Internal helpers mirror the logic in tools/query.ts and tools/analysis.ts so
// that query.ts and analysis.ts tool handlers can delegate to this module
// instead of running raw SQL directly.

import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import type { DrizzleDb } from "../../db-helpers.js";
import { log } from "../../logger.js";

import { and, asc, eq, gte, lte } from "drizzle-orm";
import * as dbSchema from "../../db.js";
import { CONTAINMENT_EDGE_TYPES } from "../../schema.js";
import { NODE_TYPE_REGISTRY, NODE_TYPE_ID_PREFIXES } from "../../node-type-registry.js";

import type {
  Node,
  NodeMeta,
  NodeType,
  NodeFilter,
  GraphQuery,
  QueryResult,
  Edge,
  EdgeType,
  ToolUsageFilter,
  ToolUsageRow,
  WorkspaceCheckReport,
} from "../../adapter.js";
import { ValidationError } from "../../adapter.js";

// ---------------------------------------------------------------------------
// Internal row shapes returned from SQLite
// ---------------------------------------------------------------------------

interface NodeRow {
  id: string;
  type: string;
  status: string | null;
  cycle_created: number | null;
  cycle_modified: number | null;
  content_hash: string;
  token_count: number | null;
  file_path: string;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  edge_type: string;
  props: string | null;
}

// ---------------------------------------------------------------------------
// Extension table metadata — sourced from NODE_TYPE_REGISTRY (node-type-registry.ts).
// Use NODE_TYPE_REGISTRY[type].extensionTableName and .summarySelector instead
// of the former inline TYPE_EXTENSION_INFO map.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Column presence helpers (mirrors tools/query.ts hasColumn)
// ---------------------------------------------------------------------------

function hasColumn(type: string, column: string): boolean {
  const domainTypes = [
    "domain_policy", "domain_decision", "domain_question", "work_item", "interview_question",
  ];
  const cycleTypes = ["finding", "domain_decision", "proxy_human_decision"];
  const workItemRefTypes = ["finding"];
  const phaseTypes = ["journal_entry", "work_item"];
  const workItemTypeTypes = ["work_item"];

  switch (column) {
    case "domain": return domainTypes.includes(type);
    case "cycle": return cycleTypes.includes(type);
    case "work_item": return workItemRefTypes.includes(type);
    case "phase": return phaseTypes.includes(type);
    case "work_item_type": return workItemTypeTypes.includes(type);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Build Node from raw row + optional extension properties
// ---------------------------------------------------------------------------

function buildNodeMeta(row: NodeRow): NodeMeta {
  return {
    id: row.id,
    type: row.type as NodeType,
    status: row.status,
    cycle_created: row.cycle_created,
    cycle_modified: row.cycle_modified,
    content_hash: row.content_hash,
    token_count: row.token_count,
  };
}

function fetchExtensionProperties(
  db: Database.Database,
  id: string,
  type: string
): Record<string, unknown> {
  const spec = NODE_TYPE_REGISTRY[type as NodeType];
  if (!spec || !spec.extensionTableName) return {};

  const row = db
    .prepare(`SELECT * FROM ${spec.extensionTableName} WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return {};

  // Remove the id field from properties (it's already in NodeMeta)
  const { id: _id, ...props } = row;
  return props;
}

// ---------------------------------------------------------------------------
// LocalReaderAdapter class
//
// Only implements the read/query subset of StorageAdapter.  The remaining
// methods (put, patch, delete, putEdge, removeEdges, traverse, batchMutate,
// nextId, initialize, shutdown, archiveCycle) are provided by other modules.
// ---------------------------------------------------------------------------

export class LocalReaderAdapter {
  private currentCycle: number | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly drizzleDb: DrizzleDb,
    private readonly ideateDir: string
  ) {}

  /**
   * Fetch the current cycle from domains/index.yaml.
   * Caches the result for subsequent calls.
   */
  private fetchCurrentCycle(): number | null {
    if (this.currentCycle !== null) {
      return this.currentCycle;
    }

    try {
      const indexYamlPath = path.join(this.ideateDir, "domains", "index.yaml");
      const indexMdPath = path.join(this.ideateDir, "domains", "index.md");
      let indexPath: string | null = null;
      if (fs.existsSync(indexYamlPath)) {
        indexPath = indexYamlPath;
      } else if (fs.existsSync(indexMdPath)) {
        indexPath = indexMdPath;
      }
      if (indexPath) {
        const indexContent = fs.readFileSync(indexPath, "utf8");
        const match = indexContent.match(/^current_cycle:\s*(\d+)/m);
        const cycle = match ? parseInt(match[1], 10) : null;
        this.currentCycle = cycle;
        return cycle;
      }
    } catch {
      // Failed to read domains/index — return null
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // getNode
  // -----------------------------------------------------------------------

  async getNode(id: string): Promise<Node | null> {
    if (!id || typeof id !== "string") {
      throw new ValidationError("Node ID must be a non-empty string", "INVALID_NODE_ID", { id });
    }
    const row = this.db
      .prepare(
        `SELECT id, type, status, cycle_created, cycle_modified, content_hash, token_count, file_path
         FROM nodes WHERE id = ?`
      )
      .get(id) as NodeRow | undefined;

    if (!row) return null;

    // Apply current cycle as cycle_modified default (matches RemoteAdapter behavior)
    const currentCycle = this.fetchCurrentCycle();
    if (row.cycle_modified === null && currentCycle !== null) {
      row.cycle_modified = currentCycle;
    }

    const properties = fetchExtensionProperties(this.db, id, row.type);
    return { ...buildNodeMeta(row), properties };
  }

  // -----------------------------------------------------------------------
  // getNodes
  // -----------------------------------------------------------------------

  async getNodes(ids: string[]): Promise<Map<string, Node>> {
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, type, status, cycle_created, cycle_modified, content_hash, token_count, file_path
         FROM nodes WHERE id IN (${placeholders})`
      )
      .all(...ids) as NodeRow[];

    const result = new Map<string, Node>();
    const currentCycle = this.fetchCurrentCycle();
    for (const row of rows) {
      // Apply current cycle as cycle_modified default (matches RemoteAdapter behavior)
      if (row.cycle_modified === null && currentCycle !== null) {
        row.cycle_modified = currentCycle;
      }
      const properties = fetchExtensionProperties(this.db, row.id, row.type);
      result.set(row.id, { ...buildNodeMeta(row), properties });
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // readNodeContent — read YAML from file_path
  // -----------------------------------------------------------------------

  async readNodeContent(id: string): Promise<string> {
    const row = this.db
      .prepare(`SELECT file_path FROM nodes WHERE id = ?`)
      .get(id) as { file_path: string } | undefined;

    if (!row) return "";

    try {
      return fs.readFileSync(row.file_path, "utf8");
    } catch {
      return "";
    }
  }

  // -----------------------------------------------------------------------
  // getEdges
  // -----------------------------------------------------------------------

  async getEdges(
    id: string,
    direction: "outgoing" | "incoming" | "both"
  ): Promise<Edge[]> {
    let rows: EdgeRow[];

    if (direction === "outgoing") {
      rows = this.db
        .prepare(
          `SELECT source_id, target_id, edge_type, props FROM edges WHERE source_id = ?`
        )
        .all(id) as EdgeRow[];
    } else if (direction === "incoming") {
      rows = this.db
        .prepare(
          `SELECT source_id, target_id, edge_type, props FROM edges WHERE target_id = ?`
        )
        .all(id) as EdgeRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT source_id, target_id, edge_type, props FROM edges WHERE source_id = ? OR target_id = ?`
        )
        .all(id, id) as EdgeRow[];
    }

    // Filter out containment edges (organizational hierarchy) - matches server-side behavior
    return rows
      .filter((r) => !CONTAINMENT_EDGE_TYPES.has(r.edge_type as EdgeType))
      .map((r) => ({
        source_id: r.source_id,
        target_id: r.target_id,
        edge_type: r.edge_type as EdgeType,
        properties: r.props ? (JSON.parse(r.props) as Record<string, unknown>) : {},
      }));
  }

  // -----------------------------------------------------------------------
  // queryNodes — returns nodes matching a NodeFilter with pagination
  // -----------------------------------------------------------------------

  async queryNodes(
    filter: NodeFilter,
    limit: number,
    offset: number,
    scope?: { org_id: string; codebase_id: string }
  ): Promise<QueryResult> {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new ValidationError("Limit must be a non-negative integer", "INVALID_LIMIT", { limit });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError("Offset must be a non-negative integer", "INVALID_OFFSET", { offset });
    }
    const type = filter.type as string | undefined;
    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    // Scope predicate: filter by org_id + codebase_id when v4 columns are active
    if (scope) {
      whereClauses.push("n.org_id = ?");
      params.push(scope.org_id);
      whereClauses.push("n.codebase_id = ?");
      params.push(scope.codebase_id);
    }

    if (type) {
      whereClauses.push("n.type = ?");
      params.push(type);
    }

    if (filter.status) {
      whereClauses.push("n.status = ?");
      params.push(filter.status);
    } else if (type === "work_item") {
      // D-131: When querying work_item without explicit status filter, exclude terminal statuses
      // This matches RemoteAdapter/Neo4j behavior: NOT n.status IN ['done', 'obsolete']
      whereClauses.push("n.status NOT IN ('done', 'obsolete')");
    }

    let summaryExpr = "NULL";
    let extensionJoin = "";

    const typeSpec = type ? NODE_TYPE_REGISTRY[type as NodeType] : undefined;
    if (type && typeSpec?.extensionTableName) {
      summaryExpr = typeSpec.summarySelector ?? "NULL";
      extensionJoin = `LEFT JOIN ${typeSpec.extensionTableName} e ON e.id = n.id`;

      if (filter.domain && hasColumn(type, "domain")) {
        whereClauses.push("e.domain = ?");
        params.push(filter.domain);
      }
      if (filter.cycle !== undefined && filter.cycle !== null && hasColumn(type, "cycle")) {
        whereClauses.push("e.cycle = ?");
        params.push(filter.cycle);
      }
      if (filter.severity && type === "finding") {
        whereClauses.push("e.severity = ?");
        params.push(filter.severity);
      }
      if (filter.phase && hasColumn(type, "phase")) {
        whereClauses.push("e.phase = ?");
        params.push(filter.phase);
      }
      if (filter.work_item && hasColumn(type, "work_item")) {
        whereClauses.push("e.work_item = ?");
        params.push(filter.work_item);
      }
      if (filter.work_item_type && hasColumn(type, "work_item_type")) {
        whereClauses.push("e.work_item_type = ?");
        params.push(filter.work_item_type);
      }
    } else if (!type) {
      // No type specified — apply cross-type filters via subqueries
      // against all extension tables that have the column.

      // D-131: When doing cross-type queries without explicit status filter,
      // exclude done/obsolete work_items from results
      if (!filter.status) {
        whereClauses.push(
          "(n.type != 'work_item' OR n.status NOT IN ('done', 'obsolete'))"
        );
      }

      if (filter.domain) {
        // Filter by domain: node must appear in any extension table with a matching domain column
        // Tables with domain: work_items, domain_policies, domain_decisions, domain_questions, interview_questions
        whereClauses.push(
          `n.id IN (SELECT id FROM work_items WHERE domain = ? UNION SELECT id FROM domain_policies WHERE domain = ? UNION SELECT id FROM domain_decisions WHERE domain = ? UNION SELECT id FROM domain_questions WHERE domain = ? UNION SELECT id FROM interview_questions WHERE domain = ?)`
        );
        params.push(filter.domain, filter.domain, filter.domain, filter.domain, filter.domain);
      }
      if (filter.phase) {
        // Filter by phase: node must appear in any extension table with a matching phase column
        // Tables with phase: work_items, journal_entries
        whereClauses.push(
          `n.id IN (SELECT id FROM work_items WHERE phase = ? UNION SELECT id FROM journal_entries WHERE phase = ?)`
        );
        params.push(filter.phase, filter.phase);
      }
    }

    const whereClause =
      whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

    const countSql = `
      SELECT COUNT(*) as total_count
      FROM nodes n
      ${extensionJoin}
      ${whereClause}
    `;
    const countRow = this.db
      .prepare(countSql)
      .get(...params) as { total_count: number };
    const total_count = countRow.total_count;

    const selectSql = `
      SELECT
        n.id,
        n.type,
        n.status,
        n.cycle_created,
        n.cycle_modified,
        n.content_hash,
        n.token_count,
        SUBSTR(COALESCE(${summaryExpr}, ''), 1, 81) AS summary
      FROM nodes n
      ${extensionJoin}
      ${whereClause}
      ORDER BY n.id ASC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db
      .prepare(selectSql)
      .all(...params, limit, offset) as Array<
      NodeRow & { summary: string | null }
    >;

    const nodes = rows.map((r) => ({
      node: buildNodeMeta(r),
      summary: r.summary ?? "",
    }));

    return { nodes, total_count };
  }

  // -----------------------------------------------------------------------
  // queryGraph — traverses the edge graph from an origin node up to a depth
  // -----------------------------------------------------------------------

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
    const {
      origin_id,
      depth = 1,
      direction = "both",
      edge_types,
      type_filter,
      filters = {},
    } = query;

    // Verify seed node exists
    const seedNode = this.db
      .prepare("SELECT id FROM nodes WHERE id = ?")
      .get(origin_id) as { id: string } | undefined;

    if (!seedNode) {
      const { NotFoundError } = await import("../../adapter.js");
      throw new NotFoundError(origin_id);
    }

    const edgeTypeParams = edge_types ?? [];

    // Containment edge types to exclude (matches server-side behavior)
    const containmentEdgeParams = Array.from(CONTAINMENT_EDGE_TYPES);

    function buildEdgeFilter(alias: string): string {
      const filters: string[] = [];
      if (edge_types && edge_types.length > 0) {
        const placeholders = edge_types.map(() => "?").join(", ");
        filters.push(`AND ${alias}.edge_type IN (${placeholders})`);
      }
      // Always exclude containment edges
      const containmentPlaceholders = containmentEdgeParams.map(() => "?").join(", ");
      filters.push(`AND ${alias}.edge_type NOT IN (${containmentPlaceholders})`);
      return filters.join(" ");
    }

    let baseSql: string;
    let baseParams: (string | number)[];

    if (depth === 1) {
      const edgeTypeFilter = buildEdgeFilter("e");
      if (direction === "outgoing") {
        baseSql = `
          SELECT n.id AS node_id, n.type, e.edge_type, 'outgoing' AS direction, 1 AS depth, n.status, n.cycle_created, n.cycle_modified, n.content_hash, n.token_count
          FROM edges e
          JOIN nodes n ON n.id = e.target_id
          WHERE e.source_id = ? ${edgeTypeFilter}
        `;
        baseParams = [origin_id, ...edgeTypeParams, ...containmentEdgeParams];
      } else if (direction === "incoming") {
        baseSql = `
          SELECT n.id AS node_id, n.type, e.edge_type, 'incoming' AS direction, 1 AS depth, n.status, n.cycle_created, n.cycle_modified, n.content_hash, n.token_count
          FROM edges e
          JOIN nodes n ON n.id = e.source_id
          WHERE e.target_id = ? ${edgeTypeFilter}
        `;
        baseParams = [origin_id, ...edgeTypeParams, ...containmentEdgeParams];
      } else {
        baseSql = `
          SELECT n.id AS node_id, n.type, e.edge_type, 'outgoing' AS direction, 1 AS depth, n.status, n.cycle_created, n.cycle_modified, n.content_hash, n.token_count
          FROM edges e
          JOIN nodes n ON n.id = e.target_id
          WHERE e.source_id = ? ${edgeTypeFilter}
          UNION
          SELECT n.id AS node_id, n.type, e.edge_type, 'incoming' AS direction, 1 AS depth, n.status, n.cycle_created, n.cycle_modified, n.content_hash, n.token_count
          FROM edges e
          JOIN nodes n ON n.id = e.source_id
          WHERE e.target_id = ? ${edgeTypeFilter}
        `;
        baseParams = [origin_id, ...edgeTypeParams, ...containmentEdgeParams, origin_id, ...edgeTypeParams, ...containmentEdgeParams];
      }
    } else {
      // Recursive CTE for depth > 1 with visited-node tracking to prevent duplicates
      const edgeTypeFilter = buildEdgeFilter("e");
      const outgoingStep = `
        SELECT e.target_id AS next_id, e.edge_type, 'outgoing' AS direction, t.depth + 1 AS depth, t.visited || ',' || e.target_id AS visited
        FROM traversal t
        JOIN edges e ON e.source_id = t.node_id
        ${edgeTypeFilter}
        WHERE t.depth < ? AND instr(t.visited, ',' || e.target_id || ',') = 0
      `;
      const incomingStep = `
        SELECT e.source_id AS next_id, e.edge_type, 'incoming' AS direction, t.depth + 1 AS depth, t.visited || ',' || e.source_id AS visited
        FROM traversal t
        JOIN edges e ON e.target_id = t.node_id
        ${edgeTypeFilter}
        WHERE t.depth < ? AND instr(t.visited, ',' || e.source_id || ',') = 0
      `;

      let recursiveBody: string;
      const visitedInit = `',' || ? || ','`;
      if (direction === "outgoing") {
        recursiveBody = `
          SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth, ${visitedInit} AS visited
          UNION
          ${outgoingStep}
        `;
        baseParams = [origin_id, origin_id, ...edgeTypeParams, ...containmentEdgeParams, depth];
      } else if (direction === "incoming") {
        recursiveBody = `
          SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth, ${visitedInit} AS visited
          UNION
          ${incomingStep}
        `;
        baseParams = [origin_id, origin_id, ...edgeTypeParams, ...containmentEdgeParams, depth];
      } else {
        recursiveBody = `
          SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth, ${visitedInit} AS visited
          UNION
          ${outgoingStep}
          UNION
          ${incomingStep}
        `;
        baseParams = [origin_id, origin_id, ...edgeTypeParams, ...containmentEdgeParams, depth, ...edgeTypeParams, ...containmentEdgeParams, depth];
      }

      baseSql = `
        WITH RECURSIVE traversal(node_id, edge_type, direction, depth, visited) AS (
          ${recursiveBody}
        )
        SELECT n.id AS node_id, n.type, t.edge_type, t.direction, t.depth, n.status, n.cycle_created, n.cycle_modified, n.content_hash, n.token_count
        FROM traversal t
        JOIN nodes n ON n.id = t.node_id
        WHERE t.depth > 0
      `;
    }

    // Apply additional filters
    let filteredSql = baseSql;
    const filteredParams = [...baseParams];

    if (type_filter) {
      filteredSql = `SELECT * FROM (${filteredSql}) WHERE type = ?`;
      filteredParams.push(type_filter);
    }
    if (filters.status) {
      filteredSql = `SELECT * FROM (${filteredSql}) WHERE status = ?`;
      filteredParams.push(filters.status);
    }

    // Count total before pagination
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total_count FROM (${filteredSql})`)
      .get(...filteredParams) as { total_count: number };
    const total_count = countRow.total_count;

    // Paginate
    filteredSql = `${filteredSql} ORDER BY depth, node_id LIMIT ? OFFSET ?`;
    filteredParams.push(limit, offset);

    type RawRow = {
      node_id: string;
      type: string;
      edge_type: string;
      direction: string;
      depth: number;
      status: string | null;
      cycle_created: number | null;
      cycle_modified: number | null;
      content_hash: string | null;
      token_count: number | null;
    };

    const rawRows = this.db.prepare(filteredSql).all(...filteredParams) as RawRow[];

    // Fetch summaries for the result rows
    const summaryMap = this._buildSummaryMap(
      rawRows.map((r) => ({ id: r.node_id, type: r.type }))
    );

    const nodes = rawRows.map((r) => {
      // Build a minimal NodeMeta without a full node lookup
      const nodeMeta: NodeMeta = {
        id: r.node_id,
        type: r.type as NodeType,
        status: r.status,
        cycle_created: r.cycle_created ?? null,
        cycle_modified: r.cycle_modified ?? null,
        content_hash: r.content_hash ?? "",
        token_count: r.token_count ?? null,
      };
      return {
        node: nodeMeta,
        summary: summaryMap[r.node_id] ?? "",
        edge_type: r.edge_type as EdgeType,
        direction: r.direction as "outgoing" | "incoming",
        depth: r.depth,
      };
    });

    return { nodes, total_count };
  }

  // -----------------------------------------------------------------------
  // countNodes — aggregation (mirrors analysis.ts aggregation queries)
  // -----------------------------------------------------------------------

  async countNodes(
    filter: NodeFilter,
    group_by: "status" | "type" | "domain" | "severity",
    scope?: { org_id: string; codebase_id: string }
  ): Promise<Array<{ key: string; count: number }>> {
    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    // Scope predicate: filter by org_id + codebase_id when v4 columns are active
    if (scope) {
      whereClauses.push("n.org_id = ?");
      params.push(scope.org_id);
      whereClauses.push("n.codebase_id = ?");
      params.push(scope.codebase_id);
    }

    if (filter.type) {
      whereClauses.push("n.type = ?");
      params.push(filter.type);
    }
    if (filter.status) {
      whereClauses.push("n.status = ?");
      params.push(filter.status);
    }
    if (filter.cycle !== undefined && filter.cycle !== null) {
      // Cycle lives on extension tables; handled via JOIN when type is known
    }

    let groupExpr: string;
    let joinClause = "";

    switch (group_by) {
      case "status":
        groupExpr = "n.status";
        break;
      case "type":
        groupExpr = "n.type";
        break;
      case "domain": {
        // domain lives on extension tables
        if (filter.type && (filter.type.startsWith("domain_") || filter.type === "work_item" || filter.type === "interview_question")) {
          const domainSpec = NODE_TYPE_REGISTRY[filter.type as NodeType];
          joinClause = `LEFT JOIN ${domainSpec.extensionTableName} e ON e.id = n.id`;
          groupExpr = "e.domain";
        } else if (!filter.type) {
          // No type filter: query across all domain-bearing extension tables
          const domainUnion = `(
            SELECT id, domain FROM work_items WHERE domain IS NOT NULL
            UNION ALL SELECT id, domain FROM domain_policies WHERE domain IS NOT NULL
            UNION ALL SELECT id, domain FROM domain_decisions WHERE domain IS NOT NULL
            UNION ALL SELECT id, domain FROM domain_questions WHERE domain IS NOT NULL
            UNION ALL SELECT id, domain FROM interview_questions WHERE domain IS NOT NULL
          )`;
          joinClause = `INNER JOIN ${domainUnion} e ON e.id = n.id`;
          groupExpr = "e.domain";
        } else {
          groupExpr = "'unknown'";
        }
        break;
      }
      case "severity": {
        if (filter.type === "finding") {
          joinClause = "LEFT JOIN findings e ON e.id = n.id";
          groupExpr = "e.severity";
          whereClauses.push("e.addressed_by IS NULL");
          if (filter.cycle !== undefined && filter.cycle !== null) {
            whereClauses.push("e.cycle = ?");
            params.push(filter.cycle);
          }
        } else {
          groupExpr = "'unknown'";
        }
        break;
      }
    }

    const finalWhere =
      whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

    const sql = `
      SELECT ${groupExpr} AS key, COUNT(*) AS count
      FROM nodes n
      ${joinClause}
      ${finalWhere}
      GROUP BY ${groupExpr}
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      key: string | null;
      count: number;
    }>;

    return rows.map((r) => ({ key: r.key ?? "unknown", count: r.count }));
  }

  // -----------------------------------------------------------------------
  // getDomainState — mirrors handleGetDomainState in tools/analysis.ts
  // -----------------------------------------------------------------------

  async getDomainState(
    domains?: string[],
    scope?: { org_id: string; codebase_id: string }
  ): Promise<
    Map<
      string,
      {
        policies: Array<{ id: string; description: string | null; status: string | null }>;
        decisions: Array<{ id: string; description: string | null; status: string | null }>;
        questions: Array<{ id: string; description: string | null; status: string | null }>;
      }
    >
  > {
    // Build optional scope clause for joining against nodes
    const scopeClause = scope
      ? `AND n.org_id = '${scope.org_id.replace(/'/g, "''")}' AND n.codebase_id = '${scope.codebase_id.replace(/'/g, "''")}'`
      : "";

    const allPolicies = this.db
      .prepare(
        `SELECT dp.id, dp.domain, dp.description, n.status
         FROM domain_policies dp
         JOIN nodes n ON n.id = dp.id
         WHERE (n.status IS NULL OR (n.status != 'deprecated' AND n.status != 'superseded'))
         ${scopeClause}
         ORDER BY dp.domain, dp.id`
      )
      .all() as Array<{ id: string; domain: string; description: string | null; status: string | null }>;

    const allDecisions = this.db
      .prepare(
        `SELECT dd.id, dd.domain, dd.description, n.status
         FROM domain_decisions dd
         JOIN nodes n ON n.id = dd.id
         WHERE 1=1
         ${scopeClause}
         ORDER BY dd.domain, dd.id`
      )
      .all() as Array<{ id: string; domain: string; description: string | null; status: string | null }>;

    const allQuestions = this.db
      .prepare(
        `SELECT dq.id, dq.domain, dq.description, n.status
         FROM domain_questions dq
         JOIN nodes n ON n.id = dq.id
         WHERE n.status = 'open'
         ${scopeClause}
         ORDER BY dq.domain, dq.id`
      )
      .all() as Array<{ id: string; domain: string; description: string | null; status: string | null }>;

    const domainSet = new Set<string>([
      ...allPolicies.map((p) => p.domain),
      ...allDecisions.map((d) => d.domain),
      ...allQuestions.map((q) => q.domain),
    ]);

    let domainList = Array.from(domainSet).sort();
    if (domains && domains.length > 0) {
      domainList = domainList.filter((d) => domains.includes(d));
    }

    const result = new Map<
      string,
      {
        policies: Array<{ id: string; description: string | null; status: string | null }>;
        decisions: Array<{ id: string; description: string | null; status: string | null }>;
        questions: Array<{ id: string; description: string | null; status: string | null }>;
      }
    >();

    for (const domain of domainList) {
      result.set(domain, {
        policies: allPolicies
          .filter((p) => p.domain === domain)
          .map(({ id, description, status }) => ({ id, description, status })),
        decisions: allDecisions
          .filter((d) => d.domain === domain)
          .map(({ id, description, status }) => ({ id, description, status })),
        questions: allQuestions
          .filter((q) => q.domain === domain)
          .map(({ id, description, status }) => ({ id, description, status })),
      });
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // getConvergenceData — mirrors handleGetConvergenceStatus in tools/analysis.ts
  // -----------------------------------------------------------------------

  async getConvergenceData(cycle: number, scope?: { org_id: string; codebase_id: string }): Promise<{
    findings_by_severity: Record<string, number>;
    cycle_summary_content: string | null;
  }> {
    // Q-164 defensive fix (WI-887): instead of counting via SQL GROUP BY, fetch
    // per-finding rows so we can verify each one against YAML ground truth.
    // SQLite's addressed_by column can be stale when:
    //   (A) a finding is written twice (first without addressed_by, then with it)
    //       and convergence is checked between the two writes, OR
    //   (B) the file-watcher re-index has not yet propagated a YAML change to
    //       the extension table.
    // For each row the SQL considers unresolved (addressed_by IS NULL), we read
    // the YAML file and verify.  If YAML has addressed_by populated, we skip
    // the finding (treat it as resolved) and warn about the stale SQLite row.
    // If the YAML file cannot be read or parsed, we fall back to the SQLite value
    // (count the finding as open) and warn — convergence must remain callable.
    const scopeClause = scope
      ? `AND n.org_id = '${scope.org_id.replace(/'/g, "''")}' AND n.codebase_id = '${scope.codebase_id.replace(/'/g, "''")}'`
      : "";

    const candidateRows = this.db
      .prepare(
        `SELECT f.id, f.severity, n.file_path
         FROM findings f
         JOIN nodes n ON f.id = n.id
         WHERE f.cycle = ? AND f.addressed_by IS NULL
         ${scopeClause}`
      )
      .all(cycle) as Array<{ id: string; severity: string; file_path: string }>;

    const findings_by_severity: Record<string, number> = {};

    for (const row of candidateRows) {
      // Verify against YAML ground truth
      let countAsOpen = true;

      try {
        const yamlContent = fs.readFileSync(row.file_path, "utf8");
        const parsed = parseYaml(yamlContent) as Record<string, unknown> | null;
        if (parsed && typeof parsed === "object") {
          const addressedBy = parsed["addressed_by"];
          if (addressedBy !== null && addressedBy !== undefined && addressedBy !== "") {
            // YAML says resolved but SQLite still has addressed_by = NULL — stale DB row.
            log.warn(
              "q164",
              `Stale SQLite row detected: finding ${row.id} has addressed_by='${String(addressedBy)}' ` +
                `in YAML but addressed_by IS NULL in SQLite findings table. ` +
                `Treating as resolved. Run a full re-index to close this staleness window.`
            );
            countAsOpen = false;
          }
        }
      } catch (readErr) {
        // YAML read/parse failure: fall back to SQLite value (count as open)
        const errMsg = readErr instanceof Error ? readErr.message : String(readErr);
        log.warn(
          "q164",
          `Could not read/parse YAML for finding ${row.id} at '${row.file_path}': ` +
            `${errMsg}. Falling back to SQLite value (counting as open).`
        );
        countAsOpen = true;
      }

      if (countAsOpen) {
        findings_by_severity[row.severity] = (findings_by_severity[row.severity] ?? 0) + 1;
      }
    }

    // Retrieve cycle_summary content
    const paddedCycle = String(cycle).padStart(3, "0");
    const likePattern = `%/cycles/${paddedCycle}/%`;

    type RawRow = { id: string; file_path: string; da_content: string | null };
    const summaryRows = this.db
      .prepare(
        `SELECT n.id, n.file_path, da.content AS da_content
         FROM nodes n
         LEFT JOIN document_artifacts da ON n.id = da.id
         WHERE n.type = 'cycle_summary'
           AND (
             da.cycle = ?
             OR (da.id IS NULL AND n.file_path LIKE ?)
             OR (da.id IS NOT NULL AND da.cycle IS NULL AND n.file_path LIKE ?)
           )
         ${scopeClause}`
      )
      .all(cycle, likePattern, likePattern) as RawRow[];

    // Fix option (c) — strict canonical-only selection (WI-824).
    // Only rows whose file_path ends with a canonical filename are considered.
    // Legacy ID-named files (SA-NNN, CQ-NNN, GA-NNN) are invisible to this
    // selector regardless of whether their document_artifacts row has content
    // (rebuildIndex populates da.cycle from the YAML's embedded cycle: field,
    // so a da_content-present test is not a safe provenance guard). Canonical
    // writes always generate spec-adherence.yaml / summary.yaml on disk via
    // resolveArtifactPath, so those filenames are the reliable signal.
    // If no canonical row is found, cycle_summary_content returns null and
    // the caller treats the cycle as having no convergence data.
    const adherenceRow = summaryRows.find((r) =>
      r.file_path.endsWith("/spec-adherence.yaml")
    );
    const summaryRow = summaryRows.find((r) =>
      r.file_path.endsWith("/summary.yaml")
    );

    const targetRow = adherenceRow ?? summaryRow;
    let cycle_summary_content: string | null = null;

    if (targetRow) {
      if (targetRow.da_content !== null && targetRow.da_content !== undefined) {
        try {
          const parsed = JSON.parse(targetRow.da_content) as Record<string, unknown>;
          if (parsed && typeof parsed.content === "string") {
            cycle_summary_content = parsed.content;
          } else {
            cycle_summary_content = targetRow.da_content;
          }
        } catch {
          cycle_summary_content = targetRow.da_content;
        }
      } else {
        try {
          cycle_summary_content = fs.readFileSync(targetRow.file_path, "utf8");
        } catch {
          cycle_summary_content = null;
        }
      }
    }

    return { findings_by_severity, cycle_summary_content };
  }

  // -----------------------------------------------------------------------
  // nextId — generate next ID for a given node type
  // -----------------------------------------------------------------------

  async nextId(type: NodeType, cycle?: number): Promise<string> {
    // Validate cycle parameter: must be non-negative integer if provided
    if (cycle !== undefined) {
      if (!Number.isInteger(cycle)) {
        throw new ValidationError(
          `Cycle must be an integer, received ${typeof cycle}`,
          "INVALID_CYCLE",
          { value: cycle }
        );
      }
      if (cycle < 0) {
        throw new ValidationError(
          `Cycle must be a non-negative integer, received ${cycle}`,
          "INVALID_CYCLE",
          { value: cycle }
        );
      }
    }

    const CYCLE_SCOPED_ID_TYPES = ["proxy_human_decision"];

    const mapping = NODE_TYPE_ID_PREFIXES.get(type);
    if (!mapping) {
      throw new Error(`Unknown type '${type}' for ID generation`);
    }

    const { prefix, padWidth } = mapping;

    if (CYCLE_SCOPED_ID_TYPES.includes(type)) {
      if (cycle === undefined) {
        throw new Error(`Parameter 'cycle' is required for type '${type}'`);
      }
      const paddedCycle = String(cycle).padStart(3, "0");
      const pattern = `${prefix}${paddedCycle}-%`;
      const row = this.db
        .prepare(
          `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num
           FROM nodes WHERE id LIKE ?`
        )
        .get(prefix.length + 4 + 1, pattern) as { max_num: number | null } | undefined;
      const maxNum = row?.max_num ?? 0;
      const nextNum = maxNum + 1;
      return `${prefix}${paddedCycle}-${String(nextNum).padStart(padWidth, "0")}`;
    }

    const row = this.db
      .prepare(
        `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as max_num
         FROM nodes WHERE id LIKE ? || '%'`
      )
      .get(prefix, prefix) as { max_num: number | null } | undefined;

    const maxNum = row?.max_num ?? 0;
    const nextNum = maxNum + 1;
    return prefix + String(nextNum).padStart(padWidth, "0");
  }

  // -----------------------------------------------------------------------
  // Internal: build a summary string map for a list of (id, type) pairs
  // -----------------------------------------------------------------------

  private _buildSummaryMap(items: { id: string; type: string }[]): Record<string, string> {
    if (items.length === 0) return {};

    const byTable: Record<string, { ids: string[]; summaryExpr: string }> = {};

    for (const item of items) {
      const spec = NODE_TYPE_REGISTRY[item.type as NodeType];
      if (!spec || !spec.extensionTableName || !spec.summarySelector) continue;
      const key = spec.extensionTableName;
      if (!byTable[key]) {
        byTable[key] = { ids: [], summaryExpr: spec.summarySelector };
      }
      byTable[key].ids.push(item.id);
    }

    const result: Record<string, string> = {};

    for (const [table, { ids, summaryExpr }] of Object.entries(byTable)) {
      const placeholders = ids.map(() => "?").join(", ");
      const sql = `
        SELECT n.id, SUBSTR(COALESCE(${summaryExpr}, ''), 1, 81) AS summary
        FROM nodes n
        LEFT JOIN ${table} e ON e.id = n.id
        WHERE n.id IN (${placeholders})
      `;
      const rows = this.db.prepare(sql).all(...ids) as { id: string; summary: string }[];
      for (const row of rows) {
        result[row.id] = row.summary ?? "";
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // getToolUsage — query tool_usage telemetry rows with optional filters
  // -----------------------------------------------------------------------

  async getToolUsage(filter?: ToolUsageFilter): Promise<ToolUsageRow[]> {
    const conditions = [];

    if (filter?.tool_name !== undefined) {
      conditions.push(eq(dbSchema.toolUsage.tool_name, filter.tool_name));
    }
    if (filter?.session_id !== undefined) {
      conditions.push(eq(dbSchema.toolUsage.session_id, filter.session_id));
    }
    if (filter?.cycle !== undefined) {
      conditions.push(eq(dbSchema.toolUsage.cycle, filter.cycle));
    }
    if (filter?.phase !== undefined) {
      conditions.push(eq(dbSchema.toolUsage.phase, filter.phase));
    }
    if (filter?.from !== undefined) {
      conditions.push(gte(dbSchema.toolUsage.timestamp, filter.from));
    }
    if (filter?.to !== undefined) {
      conditions.push(lte(dbSchema.toolUsage.timestamp, filter.to));
    }

    const query = this.drizzleDb
      .select()
      .from(dbSchema.toolUsage)
      .orderBy(asc(dbSchema.toolUsage.timestamp), asc(dbSchema.toolUsage.id));

    const rows = conditions.length > 0
      ? await query.where(and(...conditions))
      : await query;

    return rows as ToolUsageRow[];
  }

  // -----------------------------------------------------------------------
  // checkWorkspace — run four integrity checks against the local index + disk
  // -----------------------------------------------------------------------

  async checkWorkspace(): Promise<WorkspaceCheckReport> {
    const db = this.db;
    const ideateDir = this.ideateDir;

    // -----------------------------------------------------------------------
    // Internal file walker (mirrors indexer.ts walkDir)
    // -----------------------------------------------------------------------
    function walkDir(dir: string): string[] {
      const results: string[] = [];
      if (!fs.existsSync(dir)) return results;
      function walk(current: string): void {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else {
            results.push(full);
          }
        }
      }
      walk(dir);
      return results;
    }

    // -----------------------------------------------------------------------
    // Check 1: Orphan nodes — rows in nodes with a file_path that does not
    //          exist on disk.
    // -----------------------------------------------------------------------
    const allNodeRows = db
      .prepare(`SELECT id, file_path FROM nodes WHERE file_path IS NOT NULL AND file_path != ''`)
      .all() as Array<{ id: string; file_path: string }>;

    const orphanIds: string[] = [];
    for (const row of allNodeRows) {
      if (!fs.existsSync(row.file_path)) {
        orphanIds.push(row.id);
      }
    }

    // -----------------------------------------------------------------------
    // Check 2: Unindexed YAML — YAML files on disk with no corresponding
    //          node row (matched by file_path).
    //          Paths are stored as relative paths (P-33: no absolute paths in
    //          report output).
    // -----------------------------------------------------------------------
    const yamlFiles = walkDir(ideateDir).filter(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml")
    );

    const unindexedPaths: string[] = [];
    for (const filePath of yamlFiles) {
      const row = db
        .prepare(`SELECT id FROM nodes WHERE file_path = ?`)
        .get(filePath) as { id: string } | undefined;
      if (!row) {
        // Convert to relative path (P-33: no path leakage)
        unindexedPaths.push(path.relative(ideateDir, filePath));
      }
    }

    // -----------------------------------------------------------------------
    // Check 3: Dangling edges — edges where source_id or target_id is not
    //          present in the nodes table.
    // -----------------------------------------------------------------------
    interface DanglingEdgeRow {
      source_id: string;
      target_id: string;
      edge_type: string;
    }

    const danglingRows = db
      .prepare(
        `SELECT e.source_id, e.target_id, e.edge_type
         FROM edges e
         LEFT JOIN nodes ns ON ns.id = e.source_id
         LEFT JOIN nodes nt ON nt.id = e.target_id
         WHERE ns.id IS NULL OR nt.id IS NULL`
      )
      .all() as DanglingEdgeRow[];

    const danglingExamples = danglingRows.map((r) => ({
      source: r.source_id,
      target: r.target_id,
      type: r.edge_type,
    }));

    // -----------------------------------------------------------------------
    // Check 4: Stale addressed_by — findings.addressed_by references a
    //          work_item id that does not exist in nodes.
    // -----------------------------------------------------------------------
    interface FindingRow {
      id: string;
      addressed_by: string;
    }

    const findingsWithRef = db
      .prepare(
        `SELECT f.id, f.addressed_by
         FROM findings f
         WHERE f.addressed_by IS NOT NULL AND f.addressed_by != ''`
      )
      .all() as FindingRow[];

    const staleExamples: Array<{ finding: string; work_item: string }> = [];
    for (const row of findingsWithRef) {
      const wiRow = db
        .prepare(`SELECT id FROM nodes WHERE id = ?`)
        .get(row.addressed_by) as { id: string } | undefined;
      if (!wiRow) {
        staleExamples.push({ finding: row.id, work_item: row.addressed_by });
      }
    }

    // -----------------------------------------------------------------------
    // Assemble report
    // -----------------------------------------------------------------------
    const EXAMPLE_LIMIT = 10;

    const orphanCount = orphanIds.length;
    const unindexedCount = unindexedPaths.length;
    const danglingCount = danglingExamples.length;
    const staleCount = staleExamples.length;

    const failedChecks = [orphanCount, unindexedCount, danglingCount, staleCount].filter(
      (c) => c > 0
    ).length;

    const report: WorkspaceCheckReport = {
      timestamp: new Date().toISOString(),
      summary: {
        total_checks: 4,
        passed: 4 - failedChecks,
        failed: failedChecks,
      },
      checks: {
        orphan_nodes: {
          count: orphanCount,
          examples: orphanIds.slice(0, EXAMPLE_LIMIT),
        },
        unindexed_yaml: {
          count: unindexedCount,
          examples: unindexedPaths.slice(0, EXAMPLE_LIMIT),
        },
        dangling_edges: {
          count: danglingCount,
          examples: danglingExamples.slice(0, EXAMPLE_LIMIT),
        },
        stale_addressed_by: {
          count: staleCount,
          examples: staleExamples.slice(0, EXAMPLE_LIMIT),
        },
      },
    };

    return report;
  }

  // -----------------------------------------------------------------------
  // readDomainIndexCycle — read current_cycle from domains/index.yaml or index.md
  // Used by analysis handlers for workspace status cycle display
  // -----------------------------------------------------------------------

  readDomainIndexCycle(): number | null {
    const indexYamlPath = path.join(this.ideateDir, "domains", "index.yaml");
    const indexMdPath = path.join(this.ideateDir, "domains", "index.md");

    let content: string | null = null;
    try {
      content = fs.readFileSync(indexYamlPath, "utf8");
    } catch {
      try {
        content = fs.readFileSync(indexMdPath, "utf8");
      } catch {
        // neither file exists
      }
    }

    if (content === null) return null;
    const match = content.match(/^current_cycle:\s*(\d+)/m);
    return match ? parseInt(match[1], 10) : null;
  }
}
