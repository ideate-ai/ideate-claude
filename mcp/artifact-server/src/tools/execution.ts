import type { ToolContext } from "../types.js";
import { normalizeWorkItemStatus } from "../node-type-registry.js";
import { boardActiveNotice } from "../board-presence.js";

// ---------------------------------------------------------------------------
// Internal pagination constant
// ---------------------------------------------------------------------------

/**
 * Upper bound for bulk queryNodes calls. Ideate projects are expected to have
 * far fewer than 10 000 work items or findings in practice; this limit guards
 * against unbounded fetches while avoiding a new adapter method.
 */
const QUERY_LIMIT = 10_000;

// ---------------------------------------------------------------------------
// Work-item helpers — composed from StorageAdapter primitives
// ---------------------------------------------------------------------------

interface WorkItemData {
  id: string;
  status: string | null;
  title: string;
  /** May be a JSON string, a pre-parsed array, or null. */
  depends: string | string[] | null;
  scope: string | null;
}

/**
 * Fetch all work items (all statuses) via adapter composition.
 *
 * Strategy: queryNodes({ type: 'work_item' }) applies D-131 by default
 * (excludes done/obsolete when no status filter is given). To capture ALL
 * statuses — including legacy synonyms such as 'complete'/'completed' that
 * predate the WI-220 canonical vocabulary — we run explicit passes for the
 * two terminal statuses plus the legacy synonyms, and one pass for the
 * non-terminal set, then merge unique IDs, fetch full nodes via getNodes(),
 * and extract the needed properties. Raw status values are normalized via
 * normalizeWorkItemStatus() at classification time in
 * handleGetExecutionStatus (not here — this function only collects IDs).
 */
async function fetchAllWorkItems(ctx: ToolContext): Promise<WorkItemData[]> {
  if (!ctx.adapter) {
    throw new Error(
      "fetchAllWorkItems requires ctx.adapter — ensure a StorageAdapter is initialized before calling execution handlers."
    );
  }
  const adapter = ctx.adapter;

  // Collect IDs across all status buckets.
  const idSet = new Set<string>();

  const passes = [
    adapter.queryNodes({ type: "work_item", status: "done" }, QUERY_LIMIT, 0),
    adapter.queryNodes({ type: "work_item", status: "obsolete" }, QUERY_LIMIT, 0),
    // Legacy synonyms (pre-WI-220 data) — normally already covered by the
    // no-filter pass below (D-131 only excludes done/obsolete), but queried
    // explicitly for defensiveness/clarity.
    adapter.queryNodes({ type: "work_item", status: "complete" }, QUERY_LIMIT, 0),
    adapter.queryNodes({ type: "work_item", status: "completed" }, QUERY_LIMIT, 0),
    // No status filter → D-131 returns non-terminal items (everything except done/obsolete)
    adapter.queryNodes({ type: "work_item" }, QUERY_LIMIT, 0),
  ];

  const results = await Promise.all(passes);
  for (const result of results) {
    for (const entry of result.nodes) {
      idSet.add(entry.node.id);
    }
  }

  if (idSet.size === 0) return [];

  // Fetch full nodes (properties include title, depends, scope from work_items table).
  const nodeMap = await adapter.getNodes([...idSet]);

  const items: WorkItemData[] = [];
  for (const [id, node] of nodeMap) {
    const props = node.properties;
    // depends may be stored as a JSON string or as an already-parsed array
    const rawDepends = props.depends;
    const depends: string | string[] | null = Array.isArray(rawDepends)
      ? (rawDepends as string[])
      : typeof rawDepends === "string"
      ? rawDepends
      : null;

    items.push({
      id,
      status: node.status,
      title: typeof props.title === "string" ? props.title : String(props.title ?? ""),
      depends,
      scope: typeof props.scope === "string" ? props.scope : null,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Journal-entry helper — composed from StorageAdapter primitives
// ---------------------------------------------------------------------------

/**
 * Build the set of work-item IDs recorded as complete in journal entries.
 *
 * Scans all journal_entry nodes for the pattern:
 *   title:   "Work item WI-NNN: …"
 *   content: contains "Status: complete"
 */
async function buildJournalCompletedSet(ctx: ToolContext): Promise<Set<string>> {
  if (!ctx.adapter) {
    throw new Error(
      "buildJournalCompletedSet requires ctx.adapter — ensure a StorageAdapter is initialized before calling execution handlers."
    );
  }
  const completed = new Set<string>();
  const adapter = ctx.adapter;

  let result;
  try {
    result = await adapter.queryNodes({ type: "journal_entry" }, QUERY_LIMIT, 0);
  } catch {
    return completed;
  }

  if (result.nodes.length === 0) return completed;

  const ids = result.nodes.map((n) => n.node.id);
  const nodeMap = await adapter.getNodes(ids);

  for (const node of nodeMap.values()) {
    const rawTitle = node.properties.title;
    const rawContent = node.properties.content;
    const title = typeof rawTitle === "string" ? rawTitle : null;
    const content = typeof rawContent === "string" ? rawContent : null;
    if (!title || !content) continue;

    const titleMatch = title.match(/Work item\s+(WI-\d+):/i);
    if (!titleMatch) continue;
    if (content.toLowerCase().includes("status: complete")) {
      completed.add(titleMatch[1]);
    }
  }

  return completed;
}

// ---------------------------------------------------------------------------
// Finding helper — composed from StorageAdapter primitives
// ---------------------------------------------------------------------------

interface FindingData {
  work_item: string;
  severity: string;
  verdict: string;
  cycle: number;
}

/**
 * Fetch all findings, optionally filtered to a specific cycle.
 * Also returns the maximum cycle seen across all findings (for auto-detection).
 */
async function fetchFindings(
  ctx: ToolContext,
  targetCycle: number | null
): Promise<{ findings: FindingData[]; maxCycle: number | null }> {
  if (!ctx.adapter) {
    throw new Error(
      "fetchFindings requires ctx.adapter — ensure a StorageAdapter is initialized before calling execution handlers."
    );
  }
  const adapter = ctx.adapter;

  let result;
  if (targetCycle !== null) {
    result = await adapter.queryNodes(
      { type: "finding", cycle: targetCycle },
      QUERY_LIMIT,
      0
    );
  } else {
    result = await adapter.queryNodes({ type: "finding" }, QUERY_LIMIT, 0);
  }

  if (result.nodes.length === 0) return { findings: [], maxCycle: null };

  const ids = result.nodes.map((n) => n.node.id);
  const nodeMap = await adapter.getNodes(ids);

  const findings: FindingData[] = [];
  let maxCycle: number | null = null;

  for (const node of nodeMap.values()) {
    const props = node.properties;
    const workItem = typeof props.work_item === "string" ? props.work_item : null;
    const severity = typeof props.severity === "string" ? props.severity : "";
    const verdict = typeof props.verdict === "string" ? props.verdict : "";
    const cycle =
      typeof props.cycle === "number"
        ? props.cycle
        : typeof props.cycle === "string"
        ? parseInt(props.cycle, 10)
        : null;

    if (!workItem || cycle === null || isNaN(cycle as number)) continue;

    findings.push({ work_item: workItem, severity, verdict, cycle: cycle as number });

    if (maxCycle === null || (cycle as number) > maxCycle) {
      maxCycle = cycle as number;
    }
  }

  return { findings, maxCycle };
}

// ---------------------------------------------------------------------------
// handleGetExecutionStatus
// ---------------------------------------------------------------------------

export async function handleGetExecutionStatus(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  void args;

  const [workItems, journalCompleted] = await Promise.all([
    fetchAllWorkItems(ctx),
    buildJournalCompletedSet(ctx),
  ]);

  // Build dependency map: id → array of dependency IDs
  // depends may come back as a JSON string ("[]", "[\"WI-001\"]") or as an
  // already-parsed array if the adapter surfaces it that way.
  const dependsMap = new Map<string, string[]>();
  for (const item of workItems) {
    let deps: string[] = [];
    const raw = item.depends;
    if (Array.isArray(raw)) {
      deps = raw as string[];
    } else if (typeof raw === "string" && raw.trim() !== "") {
      try {
        const parsed = JSON.parse(raw);
        deps = Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        deps = [];
      }
    }
    dependsMap.set(item.id, deps);
  }

  // Categorise each work item
  const completedSet = new Set<string>();
  const obsoleteSet = new Set<string>();
  const readySet = new Set<string>();
  const blockedMap = new Map<string, string[]>(); // id → unsatisfied dep IDs

  // First pass: determine completed and obsolete items.
  //
  // WI-220: status values are normalized through the canonical work_item
  // status vocabulary (node-type-registry.ts) before classification. Only
  // 'done' and 'obsolete' are terminal — legacy synonyms ('complete',
  // 'completed') normalize to 'done'; null/'unknown'/unrecognized values
  // normalize to 'pending' (non-terminal). This ensures finished legacy
  // items are correctly excluded from the "ready" set instead of leaking
  // through as actionable work.
  for (const item of workItems) {
    const status = normalizeWorkItemStatus(item.status);
    if (status === "obsolete") {
      obsoleteSet.add(item.id);
      continue;
    }
    const isComplete = status === "done" || journalCompleted.has(item.id);
    if (isComplete) {
      completedSet.add(item.id);
    }
  }

  // Second pass: categorise remaining items
  for (const item of workItems) {
    if (completedSet.has(item.id)) continue;
    if (obsoleteSet.has(item.id)) continue;

    const deps = dependsMap.get(item.id) ?? [];
    const unsatisfied = deps.filter(
      (dep) => !completedSet.has(dep) && !obsoleteSet.has(dep)
    );

    if (unsatisfied.length === 0) {
      readySet.add(item.id);
    } else {
      blockedMap.set(item.id, unsatisfied);
    }
  }

  const total = workItems.length;
  const readyList = [...readySet].sort();

  // WI-326 (D-42): mark v2-only counts INCOMPLETE when the board is active.
  // Board-resident items are invisible to fetchAllWorkItems (v2 nodes only),
  // so the counts below exclude them; the notice makes that loud, not silent.
  const notice = boardActiveNotice(ctx);

  const lines: string[] = [
    ...(notice ? [notice, ""] : []),
    "## Execution Status",
    `Completed: ${completedSet.size}`,
    `Obsolete: ${obsoleteSet.size}`,
    `Ready to execute: ${readySet.size} (${readyList.join(", ") || "none"})`,
    `Blocked: ${blockedMap.size}`,
  ];

  for (const [id, unsatisfied] of [
    ...blockedMap.entries(),
  ].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${id} blocked by: ${unsatisfied.join(", ")}`);
  }

  lines.push(`Total: ${total}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// handleGetReviewManifest
// ---------------------------------------------------------------------------

export async function handleGetReviewManifest(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const cycleArg = typeof args.cycle_number === "number" ? args.cycle_number : null;

  // Fetch all work items (all statuses)
  const workItems = await fetchAllWorkItems(ctx);

  // Determine which cycle to show
  let targetCycle: number | null = cycleArg;
  let allFindings: FindingData[];

  if (targetCycle !== null) {
    const { findings } = await fetchFindings(ctx, targetCycle);
    allFindings = findings;
  } else {
    // Need to discover the max cycle from all findings
    const { findings, maxCycle } = await fetchFindings(ctx, null);
    targetCycle = maxCycle;
    // If we found a max cycle, re-filter to only that cycle's findings
    if (targetCycle !== null) {
      allFindings = findings.filter((f) => f.cycle === targetCycle);
    } else {
      allFindings = findings;
    }
  }

  // Group findings by work_item
  interface WorkItemReview {
    critical: number;
    significant: number;
    minor: number;
    hasFailVerdictFinding: boolean;
    hasFindingsAtAll: boolean;
  }

  const reviewMap = new Map<string, WorkItemReview>();
  for (const f of allFindings) {
    if (!reviewMap.has(f.work_item)) {
      reviewMap.set(f.work_item, {
        critical: 0,
        significant: 0,
        minor: 0,
        hasFailVerdictFinding: false,
        hasFindingsAtAll: false,
      });
    }
    const r = reviewMap.get(f.work_item)!;
    r.hasFindingsAtAll = true;
    if (f.severity === "critical") r.critical++;
    else if (f.severity === "significant") r.significant++;
    else if (f.severity === "minor") r.minor++;
    if (f.verdict === "fail") r.hasFailVerdictFinding = true;
  }

  function deriveVerdict(r: WorkItemReview | undefined): string {
    if (!r || !r.hasFindingsAtAll) return "None";
    if (r.critical > 0 || r.significant > 0 || r.hasFailVerdictFinding) return "Fail";
    return "Pass";
  }

  const header =
    "| # | Title | File Scope | Incremental Verdict | Findings (C/S/M) |";
  const divider =
    "|---|-------|------------|---------------------|------------------|";

  const tableRows: string[] = [];

  for (let i = 0; i < workItems.length; i++) {
    const item = workItems[i];
    const review = reviewMap.get(item.id);

    // Resolve scope from properties
    let scopeDisplay = "";
    const rawScope = item.scope ?? null;
    if (rawScope) {
      try {
        const scopeEntries = JSON.parse(rawScope) as Array<
          { path?: string; op?: string } | string
        >;
        const paths = scopeEntries
          .map((e) => (typeof e === "string" ? e : (e.path ?? "")))
          .filter(Boolean)
          .join(", ");
        scopeDisplay = paths;
      } catch {
        scopeDisplay = rawScope;
      }
    }

    const verdict = deriveVerdict(review);
    const findings =
      review && review.hasFindingsAtAll
        ? `${review.critical}/${review.significant}/${review.minor}`
        : "—";

    tableRows.push(
      `| ${i + 1} | ${item.title} | ${scopeDisplay} | ${verdict} | ${findings} |`
    );
  }

  const cycleInfo =
    targetCycle !== null ? `(Cycle ${targetCycle})` : "(all cycles)";
  // WI-326 (D-42): mark the manifest INCOMPLETE when the board is active — its
  // rows come from v2 work_item nodes only and omit board-resident items.
  const notice = boardActiveNotice(ctx);
  const lines = [
    ...(notice ? [notice, ""] : []),
    `## Review Manifest ${cycleInfo}`,
    "",
    header,
    divider,
    ...tableRows,
  ];
  return lines.join("\n");
}
