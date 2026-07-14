import type { ToolContext } from "../types.js";
import { NODE_TYPE_ID_PREFIXES, QUERYABLE_NODE_TYPES } from "../node-type-registry.js";
import { boardActiveNotice } from "../board-presence.js";

// ---------------------------------------------------------------------------
// Adapter resolution
//
// All handlers require ctx.adapter to be set.  The fallback path that
// called ctx.db.prepare directly was removed in WI-804 (enforces invariants
// 1 and 2 from RF-clean-interface-proposal §1).
// ---------------------------------------------------------------------------

function getAdapter(ctx: ToolContext) {
  if (!ctx.adapter) {
    throw new Error(
      "query.ts: ToolContext.adapter is required. " +
        "This is a configuration error — the server and all tests must provide an adapter."
    );
  }
  return ctx.adapter;
}

// ---------------------------------------------------------------------------
// handleGetNextId — return next available ID for an artifact type
// ---------------------------------------------------------------------------

// TYPE_PREFIX_MAP replaced by NODE_TYPE_ID_PREFIXES from node-type-registry.ts

export async function handleGetNextId(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const type = args.type as string | undefined;
  const cycle = args.cycle as number | undefined;

  if (!type) {
    throw new Error("Missing required parameter: type");
  }

  const mapping = NODE_TYPE_ID_PREFIXES.get(type as import("../adapter.js").NodeType);
  if (!mapping) {
    const validTypes = Array.from(NODE_TYPE_ID_PREFIXES.keys()).join(", ");
    throw new Error(`Unknown type '${type}'. Valid types: ${validTypes}`);
  }

  const adapter = getAdapter(ctx);
  return adapter.nextId(type as import("../adapter.js").NodeType, cycle);
}

// ---------------------------------------------------------------------------
// Valid artifact types — derived from QUERYABLE_NODE_TYPES (node-type-registry.ts)
// ---------------------------------------------------------------------------

const VALID_TYPES: ReadonlySet<string> = QUERYABLE_NODE_TYPES;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string | null | undefined, max = 80): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function markdownTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const header = "| " + headers.map((h, i) => h.padEnd(widths[i])).join(" | ") + " |";
  const sep = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const body = rows
    .map((r) => "| " + r.map((cell, i) => (cell ?? "").padEnd(widths[i])).join(" | ") + " |")
    .join("\n");
  return [header, sep, body].join("\n");
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleArtifactQuery(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const type = args.type as string | undefined;
  const filters = (args.filters ?? {}) as {
    domain?: string;
    status?: string;
    cycle?: number;
    severity?: string;
    phase?: string;
    work_item?: string;
    work_item_type?: string;
  };
  const relatedTo = args.related_to as string | undefined;
  const edgeTypes = args.edge_types as string[] | undefined;
  const direction = (args.direction as string | undefined) ?? "both";
  const depthRaw = args.depth as number | undefined;
  const limitRaw = args.limit as number | undefined;
  const offset = (args.offset as number | undefined) ?? 0;

  // Validate: at least one of type, related_to, or filters required
  const hasFilters =
    filters &&
    Object.values(filters).some((v) => v !== undefined && v !== null);

  if (!type && !relatedTo && !hasFilters) {
    throw new Error("At least one of 'type', 'related_to', or 'filters' is required");
  }

  // Validate type
  if (type && !VALID_TYPES.has(type)) {
    const validList = Array.from(VALID_TYPES).join(", ");
    throw new Error(`Unknown type '${type}'. Valid types: ${validList}`);
  }

  // Validate depth
  if (depthRaw !== undefined && !relatedTo) {
    throw new Error("'depth' requires 'related_to' parameter");
  }
  const depth = depthRaw ?? 1;
  if (depth > 10) {
    throw new Error("Maximum depth is 10");
  }

  // Cap limit
  let limit = limitRaw ?? 50;
  if (limit > 200) limit = 200;

  const adapter = getAdapter(ctx);

  // WI-335 (C1/C2 fix / D-42 / P-49): mark the response INCOMPLETE on a
  // board-active project whenever it could omit board-resident work items —
  // gated on RESULT CONTENT, not the request `type` argument. The prior
  // WI-332 form (`type === "work_item"`) left the UNTYPED paths board-blind:
  // a related_to graph traversal (depends_on/blocks connect only work-item
  // nodes) or a filters-only query returns work_item rows unmarked. A static
  // census (WI-333) cannot catch that conditional misapplication (C2), so the
  // marker is now correct-by-construction per call: emit when the board is
  // active AND (the result contains work_item rows, OR the query is untyped
  // [could return work_item], OR type === "work_item"). Presence-only.
  const notice = boardActiveNotice(ctx);
  const withNotice = (body: string, resultHasWorkItems: boolean): string => {
    if (!notice) return body;
    const couldOmitBoardItems =
      resultHasWorkItems || type === undefined || type === "work_item";
    return couldOmitBoardItems ? `${notice}\n\n${body}` : body;
  };

  if (relatedTo) {
    let result;
    try {
      result = await adapter.queryGraph(
        {
          origin_id: relatedTo,
          depth,
          direction: direction as "outgoing" | "incoming" | "both",
          edge_types: edgeTypes as import("../adapter.js").EdgeType[] | undefined,
          type_filter: type as import("../adapter.js").NodeType | undefined,
          filters: {
            status: filters.status,
            domain: filters.domain,
            cycle: filters.cycle,
            severity: filters.severity,
            phase: filters.phase,
            work_item: filters.work_item,
            work_item_type: filters.work_item_type,
          },
        },
        limit,
        offset
      );
    } catch (err) {
      const { NotFoundError } = await import("../adapter.js");
      if (err instanceof NotFoundError) {
        return `Error: Node '${relatedTo}' not found`;
      }
      throw err;
    }

    if (result.nodes.length === 0) {
      if (result.total_count === 0) {
        return withNotice("No results found.", false);
      }
      return withNotice(`No results on this page. **Total**: ${result.total_count} — use lower offset.`, false);
    }

    const tableRows = result.nodes.map((n) => [
      n.node.id,
      n.node.type,
      n.edge_type ?? "",
      n.direction ?? "",
      n.depth !== undefined ? String(n.depth) : "",
      n.node.status ?? "",
      truncate(n.summary),
    ]);

    const table = markdownTable(
      ["ID", "Type", "Edge", "Dir", "Depth", "Status", "Summary"],
      tableRows
    );

    return withNotice(`${table}\n\n**Total**: ${result.total_count}`, result.nodes.some((n) => n.node.type === "work_item"));
  } else {
    const result = await adapter.queryNodes(
      {
        type: type as import("../adapter.js").NodeType | undefined,
        status: filters.status,
        domain: filters.domain,
        cycle: filters.cycle,
        severity: filters.severity,
        phase: filters.phase,
        work_item: filters.work_item,
        work_item_type: filters.work_item_type,
      },
      limit,
      offset
    );

    if (result.nodes.length === 0) {
      if (result.total_count === 0) {
        return withNotice("No results found.", false);
      }
      return withNotice(`No results on this page. **Total**: ${result.total_count} — use lower offset.`, false);
    }

    const tableRows = result.nodes.map((n) => [
      n.node.id,
      n.node.type,
      n.node.status ?? "",
      truncate(n.summary),
      n.node.cycle_created !== null && n.node.cycle_created !== undefined
        ? String(n.node.cycle_created)
        : "",
    ]);

    const table = markdownTable(
      ["ID", "Type", "Status", "Summary", "Cycle"],
      tableRows
    );

    return withNotice(`${table}\n\n**Total**: ${result.total_count}`, result.nodes.some((n) => n.node.type === "work_item"));
  }
}
