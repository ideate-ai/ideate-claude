import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ToolContext } from "../types.js";
import { TYPE_TO_EXTENSION_TABLE } from "../node-type-registry.js";
import { BoardActiveError } from "../adapter.js";
import { resolveBoardDbPath } from "../board-presence.js";

// ---------------------------------------------------------------------------
// Adapter resolution
//
// All handlers require ctx.adapter to be set.  The fallback path that
// constructed a concrete adapter on-the-fly from ctx.db/drizzleDb was removed
// in WI-800 (enforces invariants 1 and 2 from RF-clean-interface-proposal §1).
// ---------------------------------------------------------------------------

function getAdapter(ctx: ToolContext) {
  if (!ctx.adapter) {
    throw new Error(
      "write.ts: ToolContext.adapter is required. " +
        "This is a configuration error — the server and all tests must provide an adapter."
    );
  }
  return ctx.adapter;
}

// ---------------------------------------------------------------------------
// Cycle resolution helpers for handleAppendJournal
//
// WI-219: append_journal used to default its cycle to 0 whenever no journal
// entries existed yet (see the "legacy fallback" below), then hand that 0 to
// adapter.appendJournalEntry — which the ValidatingAdapter rejects with
// "cycle must be a positive integer, received 0". This happened even while
// the domain/autopilot cycle was already advanced (e.g. 5/6), because the
// old logic never consulted domain or autopilot state at all.
//
// The fix resolves the cycle the same way ideate_get_convergence_status /
// ideate_get_domain_state do it (tools/analysis.ts): a live read of
// domains/index.yaml's `current_cycle` field, taken at call time rather than
// from any cached/startup value. That is combined with the autopilot
// session's `cycles_completed` counter (tools/autopilot-state.ts), and the
// higher of the two wins — matching the autopilot cycle numbering, which
// tracks one ahead of the last fully-archived domain cycle while a cycle is
// in progress.
// ---------------------------------------------------------------------------

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Parse `current_cycle: N` from domains/index.yaml (or legacy index.md)
 * content. Mirrors tools/analysis.ts's parseCycleFromIndex — kept local
 * to write.ts to avoid introducing a cross-module dependency for a
 * two-line regex.
 */
function parseDomainCurrentCycle(indexContent: string): number | null {
  const match = indexContent.match(/^current_cycle:\s*(\d+)/m);
  if (match) return parseInt(match[1], 10);
  return null;
}

/** Live-read the domain's current_cycle from domains/index.yaml under ctx.ideateDir. */
function resolveDomainCurrentCycle(ctx: ToolContext): number | null {
  const indexYamlPath = path.join(ctx.ideateDir, "domains", "index.yaml");
  const indexMdPath = path.join(ctx.ideateDir, "domains", "index.md");
  const indexContent = readFileSafe(indexYamlPath) ?? readFileSafe(indexMdPath);
  return indexContent !== null ? parseDomainCurrentCycle(indexContent) : null;
}

/**
 * Live-read autopilot-state.yaml's cycles_completed field, preferring the
 * adapter (so this stays consistent with scoped/remote backends) and
 * falling back to a direct filesystem read — matching the pattern used by
 * tools/autopilot-state.ts's readAutopilotState.
 */
async function resolveAutopilotCyclesCompleted(ctx: ToolContext): Promise<number | null> {
  let raw: string | null = null;
  if (ctx.adapter) {
    try {
      raw = await ctx.adapter.readNodeContent("autopilot-state");
    } catch {
      raw = null;
    }
  } else {
    raw = readFileSafe(path.join(ctx.ideateDir, "autopilot-state.yaml"));
  }
  if (!raw) return null;
  try {
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    const value = parsed?.["cycles_completed"];
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the "current cycle" for journal attribution: max(domain's
 * current_cycle, autopilot's cycles_completed), ignoring any non-positive
 * or missing source. Returns null when neither source yields a positive
 * integer.
 */
async function resolveJournalCycle(ctx: ToolContext): Promise<number | null> {
  const domainCycle = resolveDomainCurrentCycle(ctx);
  const autopilotCycles = await resolveAutopilotCyclesCompleted(ctx);

  const candidates = [domainCycle, autopilotCycles].filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0
  );
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

// ---------------------------------------------------------------------------
// handleAppendJournal — per-entry YAML journal write
// ---------------------------------------------------------------------------

export async function handleAppendJournal(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const skill = args.skill as string;
  const date = args.date as string;
  const entryType = args.entry_type as string;
  const body = args.body as string;

  if (!skill || !date || !entryType || !body) {
    throw new Error("Missing required parameters: skill, date, entry_type, body");
  }

  const adapter = getAdapter(ctx);

  // Determine cycle number:
  //   1. Explicit caller-supplied cycle_number wins outright (unchanged
  //      behavior — including that an explicit non-positive value is still
  //      rejected by the adapter's validation, same as before).
  //   2. Otherwise resolve from workspace state: max(domain.current_cycle,
  //      autopilot.cycles_completed). This is what fixes the deterministic
  //      "cycle must be a positive integer, received 0" failure during
  //      autopilot cycles.
  //   3. If workspace state doesn't resolve to a positive cycle (e.g. no
  //      domain index, no autopilot-state.yaml yet), fall back to the
  //      historical max cycle_created observed across existing journal
  //      entries — this preserves the pre-fix behavior for workspaces that
  //      only ever set cycle via journal history.
  //   4. If nothing above resolves to a positive integer (a genuinely fresh,
  //      uninitialized workspace with no domain/autopilot/journal history),
  //      default to cycle 1 rather than throwing.
  let cycleNumber: number;
  if (args.cycle_number !== undefined && args.cycle_number !== null) {
    cycleNumber = args.cycle_number as number;
  } else {
    const resolved = await resolveJournalCycle(ctx);
    if (resolved !== null) {
      cycleNumber = resolved;
    } else {
      // Legacy fallback: max cycle_created observed across existing journal entries.
      let maxObserved = 0;
      const result = await adapter.queryNodes({ type: "journal_entry" }, 1000, 0);
      for (const { node } of result.nodes) {
        if (node.cycle_created !== null && node.cycle_created > maxObserved) {
          maxObserved = node.cycle_created;
        }
      }
      cycleNumber = maxObserved > 0 ? maxObserved : 1;
    }
  }

  // Delegate to adapter's journal write (handles exclusive transaction + sequence numbering)
  const entryId = await adapter.appendJournalEntry({
    skill,
    date,
    entryType,
    body,
    cycle: cycleNumber,
  });

  return `Wrote journal entry ${entryId}.`;
}

// ---------------------------------------------------------------------------
// handleArchiveCycle — atomic cycle archival (3-phase: copy, verify, delete)
// ---------------------------------------------------------------------------

export async function handleArchiveCycle(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const cycleNumber = args.cycle_number as number;

  if (cycleNumber === undefined || cycleNumber === null) {
    throw new Error("Missing required parameters: cycle_number");
  }
  if (typeof cycleNumber !== "number" || !Number.isInteger(cycleNumber) || cycleNumber < 0) {
    throw new Error(`Invalid cycle_number: expected a non-negative integer, got ${JSON.stringify(cycleNumber)}`);
  }

  const adapter = getAdapter(ctx);

  // Delegate to the adapter interface method which returns a human-readable
  // summary string (or an error string beginning with "Error during cycle archival").
  return adapter.archiveCycle(cycleNumber);
}

// ---------------------------------------------------------------------------
// Board-presence sink-guard (WI-321)
//
// Three prior review cycles chased this defect class through prose: skills
// creating v2 work items on a project that has migrated to the v3 delegation
// board, silently splitting new work off the board. Rather than guard every
// prose caller, this guards the single SINK — handleWriteWorkItems is the
// one v2 work-item creation path, and handleWriteArtifact redirects
// `type: "work_item"` into it (see below), so guarding here catches both.
//
// Board-active signal: the configured work_state.path (default
// ".ideate-work") contains board.db, resolved against the project root. A
// pre-v3 project has no .ideate-work/board.db, so this guard never fires
// there — the v2 path stays fully intact for legacy projects and the legacy
// v2 fallback.
//
// WI-326 extracted the board-presence detection (resolveProjectRoot /
// resolveBoardDbPath / isBoardActive) into the shared ../board-presence.js
// module, so the WRITE sink-guard here and the READ loud-incomplete marker
// share one source of truth. assertBoardNotActive stays here because it is
// write-specific — it throws BoardActiveError, whereas the read side emits a
// non-throwing marker.
// ---------------------------------------------------------------------------

/**
 * Throws BoardActiveError when the project's v3 work-state board is active
 * (board.db exists at the resolved work_state path). Call this first, before
 * any other work, in every v2 work-item creation/update path.
 */
function assertBoardNotActive(ctx: ToolContext): void {
  // Resolve the board path once and reuse it for both the existence check and
  // the error message — behavior-identical to the pre-WI-326 (WI-321 original)
  // guard, avoiding a redundant config read on the throw path (F-326-001 M1).
  const boardDbPath = resolveBoardDbPath(ctx);
  if (fs.existsSync(boardDbPath)) {
    throw new BoardActiveError(boardDbPath);
  }
}

// ---------------------------------------------------------------------------
// handleWriteWorkItems — batch work item creation
// ---------------------------------------------------------------------------

interface WorkItemInput {
  id?: string;
  title?: string;
  complexity?: string;
  scope?: Array<{ path: string; op: string }>;
  depends?: string[];
  blocks?: string[];
  criteria?: string[];
  notes_content?: string;
  domain?: string;
  status?: string;
  resolution?: string | null;
  cycle_created?: number | null;
  phase?: string | null;
  work_item_type?: string;
}

export async function handleWriteWorkItems(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // Sink-guard (WI-321): refuse before doing anything else if the v3 board
  // is active. This also covers handleWriteArtifact's type:"work_item"
  // redirect below, since it delegates here.
  assertBoardNotActive(ctx);

  const items = args.items as WorkItemInput[];

  if (!items || !Array.isArray(items)) {
    throw new Error("Missing required parameters: items");
  }

  if (items.length === 0) {
    return "items: []\n";
  }

  const adapter = getAdapter(ctx);

  // Assign IDs to items that don't have one.
  // Use adapter.nextId to get the first available ID, then increment locally.
  let nextIdNum = 0;
  if (items.some(item => !item.id)) {
    const firstId = await adapter.nextId("work_item");
    // Parse the numeric part from "WI-NNN"
    nextIdNum = parseInt(firstId.replace("WI-", ""), 10);
  }

  const resolvedItems: (WorkItemInput & { resolvedId: string })[] = items.map((item) => {
    if (item.id) return { ...item, resolvedId: item.id };
    const assigned = `WI-${String(nextIdNum).padStart(3, "0")}`;
    nextIdNum++;
    return { ...item, resolvedId: assigned };
  });

  // Delegate batch operation to adapter (DAG validation, scope collision,
  // two-phase write, rollback all happen inside adapter.batchMutate)
  const batchResult = await adapter.batchMutate({
    nodes: resolvedItems.map(item => ({
      id: item.resolvedId,
      type: "work_item" as const,
      properties: {
        title: item.title ?? "",
        complexity: item.complexity ?? null,
        scope: item.scope ?? [],
        depends: item.depends ?? [],
        blocks: item.blocks ?? [],
        criteria: item.criteria ?? [],
        domain: item.domain ?? null,
        phase: item.phase ?? null,
        work_item_type: item.work_item_type ?? "feature",
        notes: item.notes_content ?? `# ${item.resolvedId}: ${item.title ?? ""}`,
        resolution: item.resolution !== undefined ? item.resolution : null,
        status: item.status ?? null,
        cycle_created: item.cycle_created ?? null,
        cycle_modified: null,
      },
    })),
  });

  // If batchMutate returns errors, check for DAG cycle / scope collision
  if (batchResult.errors.length > 0) {
    const dagError = batchResult.errors.find(e => e.error.includes("DAG cycle"));
    if (dagError) {
      const cycleDesc = dagError.error.replace("DAG cycle detected: ", "");
      return `Error: DAG cycle detected — no items written. Cycles: ${cycleDesc}`;
    }
    const collisionErrors = batchResult.errors.filter(e => e.error.includes("Scope collision"));
    if (collisionErrors.length > 0) {
      return `Error: Scope collision detected — no items written.\n${collisionErrors.map(e => e.error).join("\n")}`;
    }
    // Other errors
    return `Error writing work items:\n${batchResult.errors.map(e => e.error).join("\n")}`;
  }

  // Format compact YAML response
  const results = batchResult.results.map(r => ({ id: r.id, result: r.status }));
  return stringifyYaml(results);
}

// ---------------------------------------------------------------------------
// handleWriteArtifact — generic artifact write tool
// ---------------------------------------------------------------------------

export async function handleWriteArtifact(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const type = args.type as string;
  const id = args.id as string;
  const content = args.content as Record<string, unknown>;
  const cycle = typeof args.cycle === "number" ? args.cycle : undefined;

  if (!type || !id) {
    throw new Error("Missing required parameters: type, id");
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("Missing required parameter: content (must be an object)");
  }

  // Redirect specialized types to existing handlers
  if (type === "work_item") {
    return handleWriteWorkItems(ctx, { items: [{ ...content, id }] });
  }
  if (type === "journal_entry") {
    return handleAppendJournal(ctx, content);
  }

  // P-42: Validate that the artifact type is known before resolving the file path
  const validTypes = Object.keys(TYPE_TO_EXTENSION_TABLE);
  if (!validTypes.includes(type)) {
    throw new Error(`Unknown artifact type '${type}'. Valid types: ${validTypes.join(", ")}`);
  }

  const adapter = getAdapter(ctx);

  await adapter.putNode({
    id,
    type: type as import("../adapter.js").NodeType,
    properties: content,
    cycle,
  });

  return `Wrote ${type} artifact ${id}.`;
}

// ---------------------------------------------------------------------------
// handleUpdateWorkItems — partial field updates on existing work items
// ---------------------------------------------------------------------------

interface WorkItemUpdate {
  id: string;
  status?: string;
  resolution?: string;
  title?: string;
  complexity?: string;
  depends?: string[];
  blocks?: string[];
  criteria?: string[];
  domain?: string;
  notes?: string;
  scope?: Array<{ path: string; op: string }>;
  phase?: string | null;
  work_item_type?: string;
}

export async function handleUpdateWorkItems(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const updates = args.updates as WorkItemUpdate[];

  if (!updates || !Array.isArray(updates)) {
    throw new Error("Missing required parameter: updates (must be an array)");
  }

  if (updates.length === 0) {
    return "updated: 0\nfailed: 0\nfailures: []\n";
  }

  const adapter = getAdapter(ctx);

  const updatedIds: string[] = [];
  const failures: Array<{ id: string; reason: string }> = [];

  for (const update of updates) {
    const id = update.id;
    if (!id) {
      failures.push({ id: "(unknown)", reason: "Missing required field: id" });
      continue;
    }

    // Build the properties object from the update (only updatable fields)
    const updatableFields: Array<keyof WorkItemUpdate> = [
      "status",
      "resolution",
      "title",
      "complexity",
      "depends",
      "blocks",
      "criteria",
      "domain",
      "notes",
      "scope",
      "phase",
      "work_item_type",
    ];

    const properties: Record<string, unknown> = {};
    for (const field of updatableFields) {
      if (field in update && field !== "id") {
        properties[field] = update[field];
      }
    }

    try {
      const result = await adapter.patchNode({ id, properties });
      if (result.status === "not_found") {
        failures.push({ id, reason: `Work item not found: ${id}` });
      } else {
        updatedIds.push(id);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const reason = e.code ? `${e.code} on work item ${id}` : "internal error updating work item";
      failures.push({ id, reason });
      // Re-throw errors from the DB layer (test expectations rely on this)
      throw err;
    }
  }

  const summary = {
    updated: updatedIds.length,
    failed: failures.length,
    failures,
  };

  return stringifyYaml(summary);
}
