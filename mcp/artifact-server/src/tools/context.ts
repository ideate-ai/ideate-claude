import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import type { ToolContext } from "../types.js";
import { getConfigWithDefaults } from "../config.js";
import { boardActiveNotice } from "../board-presence.js";

// ---------------------------------------------------------------------------
// Adapter resolution
//
// All handlers require ctx.adapter to be set.  The fallback path that
// constructed a concrete adapter on-the-fly from ctx.db/drizzleDb was removed
// in WI-803 (enforces invariants 1 and 2 from RF-clean-interface-proposal §1).
// ---------------------------------------------------------------------------

function getAdapter(ctx: ToolContext) {
  if (!ctx.adapter) {
    throw new Error(
      "context.ts: ToolContext.adapter is required. " +
        "This is a configuration error — the server and all tests must provide an adapter."
    );
  }
  return ctx.adapter;
}

// ---------------------------------------------------------------------------
// Module-level caches
// ---------------------------------------------------------------------------

/** Cached source code index: maps file path to {mtime, exports} */
interface SourceCacheEntry {
  mtimeMs: number;
  exports: string[];
  language: string;
  relPath: string;
}
let sourceIndexCache: Map<string, SourceCacheEntry> | null = null;
let sourceIndexProjectRoot: string | null = null;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WorkItemRow {
  id: string;
  type: string;
  status: string | null;
  cycle_created: number | null;
  cycle_modified: number | null;
  title: string;
  complexity: string | null;
  scope: string | null;
  depends: string | null;
  blocks: string | null;
  criteria: string | null;
  module: string | null;
  domain: string | null;
  notes: string | null;
}

interface ModuleSpecRow {
  id: string;
  name: string;
  scope: string | null;
  provides: string | null;
  requires: string | null;
  boundary_rules: string | null;
}

interface DomainPolicyRow {
  id: string;
  domain: string;
  derived_from: string | null;
  established: string | null;
  amended: string | null;
  description: string | null;
}

interface ResearchFindingRow {
  id: string;
  topic: string;
  date: string | null;
  content: string | null;
  sources: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean; total: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false, total: lines.length };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    total: lines.length,
  };
}

/** Normalize a work item ID to handle both "WI-185" and "185" forms. */
function normalizeWorkItemId(raw: string): string[] {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  // "185" → also try "WI-185" and zero-padded "WI-185"
  if (/^\d+$/.test(trimmed)) {
    candidates.push(`WI-${trimmed}`);
    const padded = trimmed.padStart(3, "0");
    if (padded !== trimmed) {
      candidates.push(`WI-${padded}`);
    }
  }
  // "WI-185" → also try "185"
  const prefixMatch = trimmed.match(/^WI-(\d+)$/i);
  if (prefixMatch) {
    candidates.push(prefixMatch[1]);
  }
  return candidates;
}

/** Walk a directory recursively, returning all file paths. */
function walkDir(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current: string, depth: number): void {
    if (depth > 8) return; // guard against very deep trees
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__pycache__") continue;
      if (entry.isSymbolicLink()) continue; // skip symlinks to avoid traversing unintended targets
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }

  walk(dir, 0);
  return results;
}

/** Extract export/function/class declarations from source file content. */
function extractExports(content: string, ext: string): string[] {
  const exports: string[] = [];

  if (ext === ".ts" || ext === ".js") {
    // TypeScript / JavaScript patterns
    const patterns = [
      /^export\s+(?:async\s+)?function\s+(\w+)/gm,
      /^export\s+(?:const|let|var)\s+(\w+)/gm,
      /^export\s+(?:class|interface|type|enum)\s+(\w+)/gm,
      /^export\s+default\s+(?:function\s+)?(\w+)/gm,
      /^export\s+\{\s*([^}]+)\}/gm,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1]?.trim();
        if (name && name.length < 80) {
          exports.push(name);
        }
      }
    }
  } else if (ext === ".py") {
    // Python patterns
    const patterns = [
      /^def\s+(\w+)\s*\(/gm,
      /^class\s+(\w+)/gm,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1]?.trim();
        if (name && !name.startsWith("_")) {
          exports.push(name);
        }
      }
    }
  }

  // Deduplicate
  return [...new Set(exports)].slice(0, 20);
}

/** Map file extension to language display name. */
function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".js": "JavaScript",
    ".py": "Python",
    ".sh": "Shell",
    ".json": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
  };
  return map[ext] ?? ext.slice(1).toUpperCase();
}

// ---------------------------------------------------------------------------
// handleGetArtifactContext — generalized dispatcher
// ---------------------------------------------------------------------------

interface NodeMetaRow {
  id: string;
  type: string;
  status: string | null;
  file_path: string | null;
  token_count: number | null;
  cycle_created: number | null;
  cycle_modified: number | null;
}

export async function handleGetArtifactContext(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const artifactIdRaw = args.artifact_id;

  if (typeof artifactIdRaw !== "string" || artifactIdRaw.trim() === "") {
    throw new Error('Required argument "artifact_id" is missing or empty.');
  }

  const artifactId = artifactIdRaw.trim();

  // -------------------------------------------------------------------------
  // 1. Look up node to determine type
  // -------------------------------------------------------------------------

  // Try exact match first, then normalize for work item IDs (e.g., "185" → "WI-185")
  const idCandidates = normalizeWorkItemId(artifactId);

  let nodeMeta: NodeMetaRow | undefined;

  const adapter = getAdapter(ctx);
  // Try each candidate ID in turn.
  for (const candidateId of idCandidates) {
    const adapterNode = await adapter.getNode(candidateId);
    if (adapterNode) {
      nodeMeta = {
        id: adapterNode.id,
        type: adapterNode.type,
        status: adapterNode.status,
        file_path: null,
        token_count: adapterNode.token_count,
        cycle_created: adapterNode.cycle_created,
        cycle_modified: adapterNode.cycle_modified,
      };
      break;
    }
  }

  if (!nodeMeta) {
    throw new Error(`Artifact not found: "${artifactId}"`);
  }

  // -------------------------------------------------------------------------
  // 2. Dispatch by type
  // -------------------------------------------------------------------------

  if (nodeMeta.type === "work_item") {
    return handleWorkItemContextById(ctx, nodeMeta.id);
  }

  if (nodeMeta.type === "phase") {
    return handlePhaseContext(ctx, nodeMeta);
  }

  // Default: return node metadata + YAML content + edges
  return handleGenericArtifactContext(ctx, nodeMeta);
}

/** Assemble context for a work item by its resolved canonical ID. */
async function handleWorkItemContextById(
  ctx: ToolContext,
  workItemId: string
): Promise<string> {
  // Reuse existing work item context logic via the original handler
  return handleGetWorkItemContext(ctx, { work_item_id: workItemId });
}

/** Assemble context for a phase artifact. */
async function handlePhaseContext(
  ctx: ToolContext,
  nodeMeta: NodeMetaRow
): Promise<string> {
  interface WISummaryRow {
    id: string;
    title: string;
    status: string | null;
    complexity: string | null;
  }

  let phaseId: string;
  let phaseProject: string;
  let phaseType: string;
  let phaseIntent: string;
  let phaseSteering: string | null;
  let phaseStatus: string;
  let phaseWorkItemsRaw: string | null;

  const adapter = getAdapter(ctx);
  // Read phase properties from the node.
  const phaseNode = await adapter.getNode(nodeMeta.id);
  if (!phaseNode) {
    throw new Error(`Phase metadata not found for: "${nodeMeta.id}"`);
  }
  const p = phaseNode.properties;
  phaseId = phaseNode.id;
  phaseProject = (p.project as string) ?? "";
  phaseType = (p.phase_type as string) ?? "";
  phaseIntent = (p.intent as string) ?? "";
  phaseSteering = (p.steering as string | null) ?? null;
  phaseStatus = (p.status as string) ?? (phaseNode.status ?? "unknown");
  // work_items may be a JSON string or an array depending on how the adapter stores it
  const wiVal = p.work_items;
  phaseWorkItemsRaw = Array.isArray(wiVal) ? JSON.stringify(wiVal) : ((wiVal as string | null) ?? null);

  const sections: string[] = [];

  // Phase header
  const phaseSection: string[] = [
    `## Phase: ${phaseId}`,
    "",
    `**Type**: ${phaseType}`,
    `**Project**: ${phaseProject}`,
    `**Status**: ${phaseStatus}`,
    `**Intent**: ${phaseIntent}`,
  ];

  if (phaseSteering) {
    phaseSection.push(`**Steering**: ${phaseSteering}`);
  }

  if (nodeMeta.cycle_created != null) {
    phaseSection.push(`**Cycle Created**: ${nodeMeta.cycle_created}`);
  }

  sections.push(phaseSection.join("\n"));

  // Load work item summaries.
  //
  // WI-332 (II1 visibility / D-42): the roster resolves work_items via v2
  // getNodes ONLY. Board-resident IDs (no v2 node, by design) fall into the
  // "not indexed" footnote. On a board-active project, mark the section
  // INCOMPLETE and warn that those IDs must be PRESERVED on any write-back — a
  // read-merge-rewrite that drops them is the II1 truncation the WI-331 backstop
  // refuses. Presence-only; no board.db content read.
  const boardMarker = boardActiveNotice(ctx);
  const workItemIds = parseJsonArray(phaseWorkItemsRaw);
  if (workItemIds.length > 0) {
    let wiRows: WISummaryRow[];

    // Fetch all work item nodes at once, extract properties.
    const wiNodesMap = await adapter.getNodes(workItemIds);
    wiRows = workItemIds
      .filter((id) => wiNodesMap.has(id))
      .map((id) => {
        const n = wiNodesMap.get(id)!;
        return {
          id: n.id,
          title: (n.properties.title as string) ?? n.id,
          status: n.status,
          complexity: (n.properties.complexity as string | null) ?? null,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    if (wiRows.length > 0) {
      const wiSection: string[] = [
        `## Work Items`,
        "",
        `| ID | Title | Status | Complexity |`,
        `|----|-------|--------|------------|`,
      ];

      for (const wi of wiRows) {
        wiSection.push(
          `| ${wi.id} | ${wi.title} | ${wi.status ?? "pending"} | ${wi.complexity ?? "unknown"} |`
        );
      }

      // List any IDs not found in DB.
      const foundIds = new Set(wiRows.map((r) => r.id));
      const missingIds = workItemIds.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        wiSection.push(
          "",
          boardMarker
            ? `*Work items not indexed: ${missingIds.join(", ")}* — on a board-active project these are BOARD-RESIDENT items (no v2 node, by design). PRESERVE them in work_items on any write-back: a merge that drops them silently truncates board-item phase membership (the WI-331 backstop refuses such a write).`
            : `*Work items not indexed: ${missingIds.join(", ")}*`
        );
      }

      const wiBody = wiSection.join("\n");
      sections.push(boardMarker && missingIds.length > 0 ? `${boardMarker}\n\n${wiBody}` : wiBody);
    } else {
      const body =
        `## Work Items\n\n*Work items listed in phase not found in index: ${workItemIds.join(", ")}*` +
        (boardMarker
          ? ` — on a board-active project these are likely BOARD-RESIDENT (no v2 node). PRESERVE them on any write-back; the WI-331 backstop refuses a phase write that drops them.`
          : "");
      sections.push(boardMarker ? `${boardMarker}\n\n${body}` : body);
    }
  }

  // Read phase YAML for success criteria if available — use readNodeContent via adapter.
  try {
    const yamlContent = await adapter.readNodeContent(nodeMeta.id);
    if (yamlContent) {
      const parsed = parseYaml(yamlContent) as Record<string, unknown>;
      const successCriteria = parsed.success_criteria;

      if (Array.isArray(successCriteria) && successCriteria.length > 0) {
        const criteriaSection: string[] = [`## Phase Success Criteria`, ""];
        for (const c of successCriteria as unknown[]) {
          criteriaSection.push(`- ${c}`);
        }
        sections.push(criteriaSection.join("\n"));
      }
    }
  } catch {
    // If we can't read the content, skip success criteria
  }

  return sections.join("\n\n---\n\n");
}

/** Assemble context for a generic artifact (non-work-item, non-phase). */
async function handleGenericArtifactContext(
  ctx: ToolContext,
  nodeMeta: NodeMetaRow
): Promise<string> {
  const sections: string[] = [];

  // Node metadata header
  const metaSection: string[] = [
    `## Artifact: ${nodeMeta.id}`,
    "",
    `**Type**: ${nodeMeta.type}`,
    `**Status**: ${nodeMeta.status ?? "unknown"}`,
  ];

  if (nodeMeta.cycle_created != null) {
    metaSection.push(`**Cycle Created**: ${nodeMeta.cycle_created}`);
  }
  if (nodeMeta.cycle_modified != null) {
    metaSection.push(`**Cycle Modified**: ${nodeMeta.cycle_modified}`);
  }

  sections.push(metaSection.join("\n"));

  const adapter = getAdapter(ctx);

  // Full YAML content — read via adapter.
  try {
    const yamlContent = await adapter.readNodeContent(nodeMeta.id);
    if (yamlContent && yamlContent.trim()) {
      sections.push(`## Content\n\n\`\`\`yaml\n${yamlContent.trim()}\n\`\`\``);
    }
  } catch {
    sections.push(`## Content\n\n*Content not available*`);
  }

  // Edges (both directions)
  interface EdgeRow {
    source_id: string;
    target_id: string;
    edge_type: string;
  }

  let outgoingEdges: EdgeRow[];
  let incomingEdges: EdgeRow[];

  // Fetch edges via adapter.getEdges().
  const allEdges = await adapter.getEdges(nodeMeta.id, "both");
  outgoingEdges = allEdges
    .filter((e) => e.source_id === nodeMeta.id)
    .sort((a, b) => a.edge_type.localeCompare(b.edge_type) || a.target_id.localeCompare(b.target_id));
  incomingEdges = allEdges
    .filter((e) => e.target_id === nodeMeta.id)
    .sort((a, b) => a.edge_type.localeCompare(b.edge_type) || a.source_id.localeCompare(b.source_id));

  if (outgoingEdges.length > 0 || incomingEdges.length > 0) {
    const edgeSection: string[] = [`## Related Artifacts`, ""];

    if (outgoingEdges.length > 0) {
      edgeSection.push("**Outgoing edges** (this artifact → other):");
      for (const e of outgoingEdges) {
        edgeSection.push(`- ${e.edge_type} → ${e.target_id}`);
      }
    }

    if (incomingEdges.length > 0) {
      if (outgoingEdges.length > 0) edgeSection.push("");
      edgeSection.push("**Incoming edges** (other → this artifact):");
      for (const e of incomingEdges) {
        edgeSection.push(`- ${e.source_id} → ${e.edge_type}`);
      }
    }

    sections.push(edgeSection.join("\n"));
  }

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// handleGetWorkItemContext (legacy name — delegates to work-item path)
// ---------------------------------------------------------------------------

async function handleGetWorkItemContext(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  const workItemIdRaw = args.work_item_id;

  if (typeof workItemIdRaw !== "string" || workItemIdRaw.trim() === "") {
    throw new Error('Required argument "work_item_id" is missing or empty.');
  }

  const idCandidates = normalizeWorkItemId(workItemIdRaw);

  // -------------------------------------------------------------------------
  // 1. Look up work item (JOIN nodes + work_items)
  // -------------------------------------------------------------------------

  let workItemRow: WorkItemRow | undefined;

  const adapter = getAdapter(ctx);
  // Try each candidate ID in turn.
  for (const candidateId of idCandidates) {
    const wiNode = await adapter.getNode(candidateId);
    if (wiNode && wiNode.type === "work_item") {
      const p = wiNode.properties;
      workItemRow = {
        id: wiNode.id,
        type: wiNode.type,
        status: wiNode.status,
        cycle_created: wiNode.cycle_created,
        cycle_modified: wiNode.cycle_modified,
        title: (p.title as string) ?? wiNode.id,
        complexity: (p.complexity as string | null) ?? null,
        scope: Array.isArray(p.scope) ? JSON.stringify(p.scope) : ((p.scope as string | null) ?? null),
        depends: Array.isArray(p.depends) ? JSON.stringify(p.depends) : ((p.depends as string | null) ?? null),
        blocks: Array.isArray(p.blocks) ? JSON.stringify(p.blocks) : ((p.blocks as string | null) ?? null),
        criteria: Array.isArray(p.criteria) ? JSON.stringify(p.criteria) : ((p.criteria as string | null) ?? null),
        module: (p.module as string | null) ?? null,
        domain: (p.domain as string | null) ?? null,
        notes: (p.notes as string | null) ?? null,
      };
      break;
    }
  }

  if (!workItemRow) {
    throw new Error(
      `Work item not found: "${workItemIdRaw}". Tried IDs: ${idCandidates.join(", ")}`
    );
  }

  const sections: string[] = [];

  // -------------------------------------------------------------------------
  // 2. Work Item section
  // -------------------------------------------------------------------------

  const criteria = parseJsonArray(workItemRow.criteria);
  const depends = parseJsonArray(workItemRow.depends);
  const blocks = parseJsonArray(workItemRow.blocks);

  let scopeEntries: Array<{ path: string; op: string }> = [];
  try {
    const parsed = workItemRow.scope ? JSON.parse(workItemRow.scope) : [];
    scopeEntries = Array.isArray(parsed) ? parsed : [];
  } catch {
    // ignore
  }

  const workItemSection: string[] = [
    `## Work Item: ${workItemRow.id} — ${workItemRow.title}`,
    "",
    `**Status**: ${workItemRow.status ?? "pending"}`,
    `**Complexity**: ${workItemRow.complexity ?? "unknown"}`,
    `**Domain**: ${workItemRow.domain ?? "unassigned"}`,
    `**Module**: ${workItemRow.module ?? "unassigned"}`,
  ];

  if (workItemRow.cycle_created != null) {
    workItemSection.push(`**Cycle Created**: ${workItemRow.cycle_created}`);
  }

  if (depends.length > 0) {
    workItemSection.push("", `**Depends on**: ${depends.join(", ")}`);
  }
  if (blocks.length > 0) {
    workItemSection.push(`**Blocks**: ${blocks.join(", ")}`);
  }

  if (scopeEntries.length > 0) {
    workItemSection.push("", "**Scope**:");
    for (const entry of scopeEntries) {
      workItemSection.push(`- \`${entry.path}\` (${entry.op})`);
    }
  }

  if (criteria.length > 0) {
    workItemSection.push("", "**Acceptance Criteria**:");
    for (const c of criteria) {
      workItemSection.push(`- ${c}`);
    }
  }

  sections.push(workItemSection.join("\n"));

  // -------------------------------------------------------------------------
  // 3. Render inline implementation notes from DB column
  // -------------------------------------------------------------------------

  if (workItemRow.notes) {
    const { text: notesText, truncated, total } = truncateLines(workItemRow.notes, 200);
    const notesSection: string[] = [
      `## Implementation Notes`,
      "",
      `> Source: Implementation notes`,
      "",
      notesText,
    ];
    if (truncated) {
      notesSection.push(
        "",
        `*(truncated — showing 200 of ${total} lines)*`
      );
    }
    sections.push(notesSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 4. Find module spec via belongs_to_module edge
  // -------------------------------------------------------------------------

  let moduleRow: ModuleSpecRow | undefined;

  // Get outgoing belongs_to_module edges, then fetch the target node.
  const moduleEdges = await adapter.getEdges(workItemRow.id, "outgoing");
  const moduleEdge = moduleEdges.find((e) => e.edge_type === "belongs_to_module");
  if (moduleEdge) {
    const msNode = await adapter.getNode(moduleEdge.target_id);
    if (msNode && msNode.type === "module_spec") {
      const p = msNode.properties;
      moduleRow = {
        id: msNode.id,
        name: (p.name as string) ?? msNode.id,
        scope: (p.scope as string | null) ?? null,
        provides: Array.isArray(p.provides) ? JSON.stringify(p.provides) : ((p.provides as string | null) ?? null),
        requires: Array.isArray(p.requires) ? JSON.stringify(p.requires) : ((p.requires as string | null) ?? null),
        boundary_rules: Array.isArray(p.boundary_rules) ? JSON.stringify(p.boundary_rules) : ((p.boundary_rules as string | null) ?? null),
      };
    }
  }

  if (moduleRow) {
    const provides = parseJsonArray(moduleRow.provides);
    const requires = parseJsonArray(moduleRow.requires);
    const boundaryRules = parseJsonArray(moduleRow.boundary_rules);

    const moduleSection: string[] = [
      `## Module Spec: ${moduleRow.name}`,
      "",
    ];

    if (moduleRow.scope) {
      moduleSection.push(`**Scope**: ${moduleRow.scope}`, "");
    }

    if (provides.length > 0) {
      moduleSection.push("**Provides**:");
      for (const p of provides) {
        moduleSection.push(`- ${p}`);
      }
      moduleSection.push("");
    }

    if (requires.length > 0) {
      moduleSection.push("**Requires**:");
      for (const r of requires) {
        moduleSection.push(`- ${r}`);
      }
      moduleSection.push("");
    }

    if (boundaryRules.length > 0) {
      moduleSection.push("**Boundary Rules**:");
      for (const rule of boundaryRules) {
        moduleSection.push(`- ${rule}`);
      }
    }

    sections.push(moduleSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 5. Find domain policies where domain = work_item.domain
  // -------------------------------------------------------------------------

  if (workItemRow.domain) {
    let policyRows: DomainPolicyRow[];

    // Query nodes of type domain_policy filtered by domain.
    const policyResult = await adapter.queryNodes(
      { type: "domain_policy", domain: workItemRow.domain },
      100,
      0
    );
    // Fetch full properties for each policy node.
    const policyIds = policyResult.nodes.map((n) => n.node.id);
    const policyNodesMap = policyIds.length > 0
      ? await adapter.getNodes(policyIds)
      : new Map();
    policyRows = policyIds
      .filter((id) => policyNodesMap.has(id))
      .map((id) => {
        const n = policyNodesMap.get(id)!;
        const p = n.properties;
        return {
          id: n.id,
          domain: (p.domain as string) ?? "",
          derived_from: (p.derived_from as string | null) ?? null,
          established: (p.established as string | null) ?? null,
          amended: (p.amended as string | null) ?? null,
          description: (p.description as string | null) ?? null,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    if (policyRows.length > 0) {
      const policySection: string[] = [
        `## Domain Policies (${workItemRow.domain})`,
        "",
      ];

      for (const policy of policyRows) {
        policySection.push(`### ${policy.id}`);
        if (policy.description) {
          const { text: descText, truncated, total } = truncateLines(policy.description, 30);
          policySection.push(descText);
          if (truncated) {
            policySection.push(`*(description truncated at 30 of ${total} lines)*`);
          }
        }
        const details: string[] = [];
        if (policy.established) details.push(`Established: ${policy.established}`);
        if (policy.amended) details.push(`Amended: ${policy.amended}`);
        if (details.length > 0) {
          policySection.push(`*${details.join(" | ")}*`);
        }
        policySection.push("");
      }

      sections.push(policySection.join("\n"));
    }
  }

  // -------------------------------------------------------------------------
  // 6. Find relevant research by topic match
  // -------------------------------------------------------------------------

  // Filter research by topic relevance using SQL WHERE clause
  const relevanceTokens: string[] = [];
  if (workItemRow.domain) relevanceTokens.push(workItemRow.domain.toLowerCase());
  if (workItemRow.module) relevanceTokens.push(workItemRow.module.toLowerCase());

  let relevantResearch: ResearchFindingRow[];

  // Fetch all research_finding nodes and filter by topic in JS.
  const researchResult = await adapter.queryNodes({ type: "research_finding" }, 200, 0);
  const researchIds = researchResult.nodes.map((n) => n.node.id);
  const researchNodesMap = researchIds.length > 0
    ? await adapter.getNodes(researchIds)
    : new Map();

  const allResearch: ResearchFindingRow[] = researchIds
    .filter((id) => researchNodesMap.has(id))
    .map((id) => {
      const n = researchNodesMap.get(id)!;
      const p = n.properties;
      return {
        id: n.id,
        topic: (p.topic as string) ?? "",
        date: (p.date as string | null) ?? null,
        content: (p.content as string | null) ?? null,
        sources: Array.isArray(p.sources) ? JSON.stringify(p.sources) : ((p.sources as string | null) ?? null),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  if (relevanceTokens.length > 0) {
    relevantResearch = allResearch.filter((r) =>
      relevanceTokens.some((token) => r.topic.toLowerCase().includes(token))
    );
  } else {
    relevantResearch = allResearch.slice(0, 3);
  }

  if (relevantResearch.length > 0) {
    const researchSection: string[] = [
      `## Relevant Research`,
      "",
    ];

    let researchLineCount = 0;
    const MAX_RESEARCH_LINES = 150;

    for (const research of relevantResearch) {
      if (researchLineCount >= MAX_RESEARCH_LINES) {
        researchSection.push(
          `*(additional research entries omitted — total matched: ${relevantResearch.length})*`
        );
        break;
      }

      researchSection.push(`### ${research.id}: ${research.topic}`);
      researchLineCount += 2;

      if (research.date) {
        researchSection.push(`*Date: ${research.date}*`);
        researchLineCount++;
      }

      if (research.content) {
        const remaining = MAX_RESEARCH_LINES - researchLineCount;
        const { text: contentText, truncated, total } = truncateLines(research.content, remaining);
        researchSection.push(contentText);
        researchLineCount += contentText.split("\n").length;
        if (truncated) {
          researchSection.push(
            `*(truncated — showing ${remaining} of ${total} lines)*`
          );
          researchLineCount++;
        }
      }

      const sources = parseJsonArray(research.sources);
      if (sources.length > 0) {
        researchSection.push("", `**Sources**: ${sources.join(", ")}`);
        researchLineCount += 2;
      }

      researchSection.push("");
      researchLineCount++;
    }

    sections.push(researchSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 7. Assemble final response, enforcing 500-line target
  // -------------------------------------------------------------------------

  let result = sections.join("\n\n---\n\n");

  const totalLines = result.split("\n").length;
  if (totalLines > 500) {
    // Trim the last section (research) first
    const trimmedLines = result.split("\n").slice(0, 500);
    result =
      trimmedLines.join("\n") +
      `\n\n*(response truncated at 500 lines; total was ${totalLines} lines)*`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// handleGetContextPackage
// ---------------------------------------------------------------------------

export async function handleGetContextPackage(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  void args; // args unused now

  const sections: string[] = [];

  const adapter = getAdapter(ctx);

  // -------------------------------------------------------------------------
  // 1. Architecture document
  // Compose using queryNodes({type:'architecture'}, 1, 0) → getNodes([id])
  // to retrieve id, title, cycle, and content from Node.properties.
  // -------------------------------------------------------------------------

  const archQueryResult = await adapter.queryNodes({ type: "architecture" }, 1, 0);
  const archNodeMeta = archQueryResult.nodes[0]?.node ?? null;
  const archRow = archNodeMeta
    ? (await adapter.getNodes([archNodeMeta.id])).get(archNodeMeta.id) ?? null
    : null;

  if (archRow) {
    const archContent = typeof archRow.properties.content === "string"
      ? archRow.properties.content
      : null;
    if (archContent) {
      const archLines = archContent.split("\n");
      const archSection: string[] = [`## Architecture`];

      if (archLines.length <= 300) {
        archSection.push("", archContent);
      } else {
        // Provide a component/interface summary by scanning headings and key lines
        archSection.push(
          "",
          `> Document is ${archLines.length} lines — summary shown below`,
          ""
        );

        // Extract headings and first sentence of each section
        let inSection = false;
        let sectionLines = 0;
        const MAX_ARCH_SUMMARY_LINES = 150;
        let summaryCount = 0;

        for (const line of archLines) {
          if (summaryCount >= MAX_ARCH_SUMMARY_LINES) break;
          if (/^#{1,3}\s/.test(line)) {
            archSection.push(line);
            summaryCount++;
            inSection = true;
            sectionLines = 0;
          } else if (inSection && sectionLines < 3 && line.trim()) {
            archSection.push(line);
            summaryCount++;
            sectionLines++;
          }
        }
      }

      sections.push(archSection.join("\n"));
    }
  } else {
    sections.push(`## Architecture\n\n*No architecture document found in the index.*`);
  }

  // -------------------------------------------------------------------------
  // 2. Guiding Principles
  // Compose using queryNodes({type:'guiding_principle'}, 1000, 0) → getNodes(ids)
  // to retrieve name and description from Node.properties.
  // -------------------------------------------------------------------------

  const gpQueryResult = await adapter.queryNodes({ type: "guiding_principle" }, 1000, 0);
  const gpIds = gpQueryResult.nodes.map((n) => n.node.id);
  const gpNodesMap = gpIds.length > 0 ? await adapter.getNodes(gpIds) : new Map();
  // Preserve order returned by queryNodes (sorted by id ASC)
  const principleNodes = gpIds
    .map((id) => gpNodesMap.get(id))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);

  if (principleNodes.length > 0) {
    const principleSection: string[] = [`## Guiding Principles`, ""];

    for (let i = 0; i < principleNodes.length; i++) {
      const gp = principleNodes[i];
      const gpName = typeof gp.properties.name === "string" ? gp.properties.name : gp.id;
      const gpDescription = typeof gp.properties.description === "string"
        ? gp.properties.description
        : null;
      principleSection.push(`### ${i + 1}. ${gpName}`);
      if (gpDescription) {
        const { text, truncated, total } = truncateLines(gpDescription, 20);
        principleSection.push(text);
        if (truncated) {
          principleSection.push(`*(truncated — showing 20 of ${total} lines)*`);
        }
      }
      principleSection.push("");
    }

    sections.push(principleSection.join("\n"));
  } else {
    sections.push(`## Guiding Principles\n\n*No guiding principles found in the index.*`);
  }

  // -------------------------------------------------------------------------
  // 3. Constraints
  // Compose using queryNodes({type:'constraint'}, 1000, 0) → getNodes(ids)
  // to retrieve category and description from Node.properties.
  // Sort client-side by category then id so output is deterministic regardless
  // of adapter-specific row ordering.
  // -------------------------------------------------------------------------

  const cQueryResult = await adapter.queryNodes({ type: "constraint" }, 1000, 0);
  const cIds = cQueryResult.nodes.map((n) => n.node.id);
  const cNodesMap = cIds.length > 0 ? await adapter.getNodes(cIds) : new Map();
  const constraintNodes = cIds
    .map((id) => cNodesMap.get(id))
    .filter((n): n is NonNullable<typeof n> => n !== undefined)
    // Sort by category ASC, then id ASC to produce deterministic output
    // regardless of adapter ordering.
    .sort((a, b) => {
      const catA = typeof a.properties.category === "string" ? a.properties.category : "";
      const catB = typeof b.properties.category === "string" ? b.properties.category : "";
      if (catA !== catB) return catA.localeCompare(catB);
      return a.id.localeCompare(b.id);
    });

  if (constraintNodes.length > 0) {
    const constraintSection: string[] = [`## Constraints`, ""];

    let currentCategory = "";
    for (const constraint of constraintNodes) {
      const constraintCategory = typeof constraint.properties.category === "string"
        ? constraint.properties.category
        : "";
      const constraintDescription = typeof constraint.properties.description === "string"
        ? constraint.properties.description
        : null;
      if (constraintCategory !== currentCategory) {
        currentCategory = constraintCategory;
        constraintSection.push(`### ${currentCategory}`);
      }

      constraintSection.push(`**${constraint.id}**`);
      if (constraintDescription) {
        const { text, truncated, total } = truncateLines(constraintDescription, 10);
        constraintSection.push(text);
        if (truncated) {
          constraintSection.push(`*(truncated — showing 10 of ${total} lines)*`);
        }
      }
      constraintSection.push("");
    }

    sections.push(constraintSection.join("\n"));
  } else {
    sections.push(`## Constraints\n\n*No constraints found in the index.*`);
  }

  // -------------------------------------------------------------------------
  // 4. Active Project
  // Compose using queryNodes({type:'project', status:'active'}, 1, 0) → getNodes([id])
  // to retrieve intent, success_criteria, appetite, horizon from Node.properties.
  // -------------------------------------------------------------------------

  const projQueryResult = await adapter.queryNodes({ type: "project", status: "active" }, 1, 0);
  const projNodeMeta = projQueryResult.nodes[0]?.node ?? null;
  const activeProjectNode = projNodeMeta
    ? (await adapter.getNodes([projNodeMeta.id])).get(projNodeMeta.id) ?? null
    : null;

  if (activeProjectNode) {
    const projectSection: string[] = [`## Active Project`, ""];
    projectSection.push(`**ID**: ${activeProjectNode.id}`);
    const projIntent = typeof activeProjectNode.properties.intent === "string"
      ? activeProjectNode.properties.intent
      : "";
    projectSection.push(`**Intent**: ${projIntent}`);

    const projAppetite = activeProjectNode.properties.appetite;
    if (projAppetite) {
      projectSection.push(`**Appetite**: ${projAppetite}`);
    }

    const projSuccessCriteria = typeof activeProjectNode.properties.success_criteria === "string"
      ? activeProjectNode.properties.success_criteria
      : null;
    if (projSuccessCriteria) {
      try {
        const criteria = JSON.parse(projSuccessCriteria);
        if (Array.isArray(criteria) && criteria.length > 0) {
          projectSection.push("", "**Success Criteria**:");
          for (const c of criteria as string[]) {
            projectSection.push(`- ${c}`);
          }
        }
      } catch {
        projectSection.push(`**Success Criteria**: ${projSuccessCriteria}`);
      }
    }

    const projHorizon = typeof activeProjectNode.properties.horizon === "string"
      ? activeProjectNode.properties.horizon
      : null;
    if (projHorizon) {
      try {
        const horizon = JSON.parse(projHorizon);
        projectSection.push(`**Horizon**: ${JSON.stringify(horizon)}`);
      } catch {
        projectSection.push(`**Horizon**: ${projHorizon}`);
      }
    }

    sections.push(projectSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 5. Current Phase
  // Compose using queryNodes({type:'phase', status:'active'}, 1, 0) → getNodes([id])
  // to retrieve phase_type, intent, steering, work_items from Node.properties.
  // -------------------------------------------------------------------------

  const phaseQueryResult = await adapter.queryNodes({ type: "phase", status: "active" }, 1, 0);
  const phaseNodeMeta = phaseQueryResult.nodes[0]?.node ?? null;
  const activePhaseNode = phaseNodeMeta
    ? (await adapter.getNodes([phaseNodeMeta.id])).get(phaseNodeMeta.id) ?? null
    : null;

  if (activePhaseNode) {
    const phaseSection: string[] = [`## Current Phase`, ""];
    phaseSection.push(`**ID**: ${activePhaseNode.id}`);
    const phaseType = typeof activePhaseNode.properties.phase_type === "string"
      ? activePhaseNode.properties.phase_type
      : "";
    const phaseIntent = typeof activePhaseNode.properties.intent === "string"
      ? activePhaseNode.properties.intent
      : "";
    phaseSection.push(`**Type**: ${phaseType}`);
    phaseSection.push(`**Intent**: ${phaseIntent}`);

    const phaseSteering = typeof activePhaseNode.properties.steering === "string"
      ? activePhaseNode.properties.steering
      : null;
    if (phaseSteering) {
      phaseSection.push(`**Steering**: ${phaseSteering}`);
    }

    const phaseWorkItems = typeof activePhaseNode.properties.work_items === "string"
      ? activePhaseNode.properties.work_items
      : null;
    if (phaseWorkItems) {
      try {
        const workItems = JSON.parse(phaseWorkItems);
        if (Array.isArray(workItems) && workItems.length > 0) {
          phaseSection.push("", `**Work Items**: ${(workItems as string[]).join(", ")}`);
        }
      } catch {
        phaseSection.push(`**Work Items**: ${phaseWorkItems}`);
      }
    }

    sections.push(phaseSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 6. Source Code Index
  // -------------------------------------------------------------------------

  // Derive project source root: ideateDir is <project>/.ideate/,
  // so path.dirname gives <project>/.
  const projectRoot = path.dirname(ctx.ideateDir);

  // Look for source directories: src/, lib/, agents/, skills/, scripts/
  const SOURCE_DIRS = ["src", "lib", "agents", "skills", "scripts", "mcp"];
  const SOURCE_EXTS = [".ts", ".js", ".py"];

  // Initialize or invalidate cache if project root changed
  if (sourceIndexProjectRoot !== projectRoot) {
    sourceIndexCache = new Map();
    sourceIndexProjectRoot = projectRoot;
  }

  const sourceFiles: Array<{ file: string; relPath: string; ext: string }> = [];
  for (const srcDir of SOURCE_DIRS) {
    const fullSrcDir = path.join(projectRoot, srcDir);
    const files = walkDir(fullSrcDir, SOURCE_EXTS);
    for (const file of files) {
      sourceFiles.push({
        file,
        relPath: path.relative(projectRoot, file),
        ext: path.extname(file),
      });
    }
  }

  if (sourceFiles.length > 0) {
    const indexSection: string[] = [
      `## Source Code Index`,
      "",
      `| File | Language | Key Exports |`,
      `|------|----------|-------------|`,
    ];

    const MAX_INDEX_FILES = 80;
    const shown = sourceFiles.slice(0, MAX_INDEX_FILES);

    for (const { file, relPath, ext } of shown) {
      const language = extToLanguage(ext);
      let exports: string[] = [];

      // Use mtime-based cache to avoid re-reading unchanged files
      try {
        const stat = fs.statSync(file);
        const cached = sourceIndexCache!.get(file);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
          exports = cached.exports;
        } else {
          const content = fs.readFileSync(file, "utf8");
          exports = extractExports(content, ext);
          sourceIndexCache!.set(file, { mtimeMs: stat.mtimeMs, exports, language, relPath });
        }
      } catch {
        // skip unreadable files
      }
      const exportsStr = exports.length > 0 ? exports.slice(0, 8).join(", ") : "—";
      indexSection.push(`| \`${relPath}\` | ${language} | ${exportsStr} |`);
    }

    if (sourceFiles.length > MAX_INDEX_FILES) {
      indexSection.push(
        "",
        `*(showing ${MAX_INDEX_FILES} of ${sourceFiles.length} source files)*`
      );
    }

    sections.push(indexSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 7. Assemble final response, target 500-800 lines
  // -------------------------------------------------------------------------

  let result = sections.join("\n\n---\n\n");

  const totalLines = result.split("\n").length;
  if (totalLines > 800) {
    const trimmedLines = result.split("\n").slice(0, 800);
    result =
      trimmedLines.join("\n") +
      `\n\n*(response truncated at 800 lines; total was ${totalLines} lines)*`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// handleAssembleContext — PPR-based context assembly with token budgeting
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable label for an artifact based on its YAML content.
 */
function extractArtifactLabel(id: string, type: string, yamlContent: string): string {
  if (!yamlContent) return id;
  try {
    const parsed = parseYaml(yamlContent) as Record<string, unknown>;
    // Try common title fields
    for (const field of ["title", "name", "topic", "domain"]) {
      const val = parsed[field];
      if (typeof val === "string" && val.trim()) {
        return `${id} — ${val.trim()}`;
      }
    }
  } catch {
    // ignore parse errors
  }
  return `${id} (${type})`;
}

export async function handleAssembleContext(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // -------------------------------------------------------------------------
  // 1. Parse and validate arguments
  // -------------------------------------------------------------------------

  const seedIds = args.seed_ids;
  if (!Array.isArray(seedIds) || seedIds.length === 0) {
    throw new Error('Required argument "seed_ids" must be a non-empty array of artifact IDs.');
  }
  const seedNodeIds = seedIds.filter((s): s is string => typeof s === "string");
  if (seedNodeIds.length === 0) {
    throw new Error('"seed_ids" must contain at least one string ID.');
  }

  // -------------------------------------------------------------------------
  // 2. Load config defaults for PPR and token budget
  // -------------------------------------------------------------------------

  const config = getConfigWithDefaults(ctx.ideateDir);
  const pprConfig = config.ppr;

  const tokenBudget: number = typeof args.token_budget === "number"
    ? args.token_budget
    : (pprConfig.default_token_budget ?? 50000);

  const includeTypes: string[] = Array.isArray(args.include_types)
    ? (args.include_types as unknown[]).filter((s): s is string => typeof s === "string")
    : ["architecture", "guiding_principle", "constraint"];

  const edgeTypeWeightsOverride: Record<string, number> | undefined =
    args.edge_type_weights && typeof args.edge_type_weights === "object" && !Array.isArray(args.edge_type_weights)
      ? (args.edge_type_weights as Record<string, number>)
      : undefined;

  const edgeTypeWeights = edgeTypeWeightsOverride
    ? { ...pprConfig.edge_type_weights, ...edgeTypeWeightsOverride }
    : pprConfig.edge_type_weights;

  // -------------------------------------------------------------------------
  // 3. Run PPR and assemble context via adapter
  //
  // Delegate traverse() to ctx.adapter so all PPR logic flows through the
  // StorageAdapter contract. ctx.adapter is always set by the server and
  // by updated test setups.
  // -------------------------------------------------------------------------

  const adapter = getAdapter(ctx);

  const traverseOptions = {
    seed_ids: seedNodeIds,
    alpha: pprConfig.alpha,
    max_iterations: pprConfig.max_iterations,
    convergence_threshold: pprConfig.convergence_threshold,
    edge_type_weights: edgeTypeWeights,
    token_budget: tokenBudget,
    always_include_types: includeTypes as import("../adapter.js").NodeType[],
  };

  const traversalResult = await adapter.traverse(traverseOptions);

  // -------------------------------------------------------------------------
  // 4. Assemble markdown context grouped by artifact type
  // -------------------------------------------------------------------------

  // Group included nodes by type
  const byType = new Map<string, typeof traversalResult.ranked_nodes>();
  for (const entry of traversalResult.ranked_nodes) {
    const type = entry.node.type;
    const existing = byType.get(type) ?? [];
    existing.push(entry);
    byType.set(type, existing);
  }

  const sections: string[] = [];

  for (const [type, entries] of byType) {
    const typeHeader = type
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const typeSection: string[] = [`## ${typeHeader}`];

    for (const entry of entries) {
      const { node, content } = entry;
      const label = extractArtifactLabel(node.id, node.type, content);
      typeSection.push("", `### ${label}`);
      if (content) {
        typeSection.push("", "```yaml", content.trim(), "```");
      } else {
        typeSection.push("", `*Content not available for ${node.id} (${node.type})*`);
      }
    }

    sections.push(typeSection.join("\n"));
  }

  const assembledContext = sections.join("\n\n---\n\n");

  // -------------------------------------------------------------------------
  // 5. Return assembled context + metadata as JSON string
  // -------------------------------------------------------------------------

  // WI-787: surface budget overflow metadata so callers can detect when
  // always_include_types or ranked artifacts were dropped due to token_budget.
  const metadata: {
    artifact_ids: string[];
    total_tokens: number;
    ppr_scores: Array<{ id: string; score: number }>;
    context: string;
    budget_exhausted?: boolean;
    truncated_types?: string[];
  } = {
    artifact_ids: traversalResult.ranked_nodes.map((e) => e.node.id),
    total_tokens: traversalResult.total_tokens,
    ppr_scores: traversalResult.ppr_scores,
    context: assembledContext,
  };
  if (traversalResult.budget_exhausted) {
    metadata.budget_exhausted = true;
  }
  if (
    traversalResult.truncated_types &&
    traversalResult.truncated_types.length > 0
  ) {
    metadata.truncated_types = traversalResult.truncated_types;
  }

  return JSON.stringify(metadata, null, 2);
}
