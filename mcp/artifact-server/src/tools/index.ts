/**
 * Error handling convention for MCP tool handlers:
 * - throw Error for actual error conditions (invalid input, missing required data, internal failures)
 * - return string for soft conditions (no results found, empty query results)
 * MCP transport catches thrown errors and returns them as isError responses.
 * Return-string "no results" are successful responses with informational content.
 */
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../types.js";
export type { ToolContext } from "../types.js";
import { handleGetArtifactContext, handleGetContextPackage, handleAssembleContext } from "./context.js";
import { handleArtifactQuery, handleGetNextId } from "./query.js";
import { handleGetExecutionStatus, handleGetReviewManifest } from "./execution.js";
import { handleGetConvergenceStatus, handleGetDomainState, handleGetWorkspaceStatus } from "./analysis.js";
import { handleCheckWorkspace } from "./diagnostics.js";
import { handleAppendJournal, handleArchiveCycle, handleWriteWorkItems, handleUpdateWorkItems, handleWriteArtifact } from "./write.js";
import { handleEmitEvent } from "./events.js";
import { handleBootstrapWorkspace } from "./bootstrap.js";
import { handleManageAutopilotState } from "./autopilot-state.js";
import { handleUpdateConfig } from "./config.js";
import { handleGetToolUsage } from "./tool-usage.js";
import { getConfigWithDefaults } from "../config.js";
import { instrumentToolDispatch } from "./instrumentation.js";

// ---------------------------------------------------------------------------
// TOOLS — all 20 tool definitions with inputSchema
// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "ideate_get_artifact_context",
    description:
      "Context package for any artifact by ID. Use before executing work items or reviewing phases. Returns markdown with metadata, dependencies, and related artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: {
          type: "string",
          description: "Artifact identifier (e.g. 'WI-184', 'PH-013', 'GP-01').",
        },
      },
      required: ["artifact_id"],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_get_context_package",
    description:
      "Full project context: principles, constraints, architecture, policies, strategy. Use at session start. Returns JSON with context sections.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_get_config",
    description:
      "Parsed project config with defaults (agent_budgets, model_overrides, ppr). Use for token budget, model selection, and PPR settings. Returns JSON config object.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_artifact_query",
    description:
      "Query artifacts by type with filters. Use for: work items (type=work_item), findings, policies, projects (type=project), phases (type=phase). Graph traversal: related_to + edge_types. Returns array (up to 200 items).",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Artifact type to filter by (e.g. 'work_item', 'finding', 'domain_policy', 'domain_decision', 'domain_question', 'guiding_principle', 'constraint', 'module_spec', 'journal_entry', 'project', 'phase').",
        },
        filters: {
          type: "object",
          description: "Additional field-level filters.",
          properties: {
            domain: { type: "string" },
            status: { type: "string" },
            cycle: { type: "integer" },
            severity: { type: "string" },
            phase: { type: "string" },
            work_item: { type: "string" },
            work_item_type: { type: "string" },
          },
          additionalProperties: false,
        },
        related_to: {
          type: "string",
          description:
            "Artifact ID to traverse edges from. Combined with edge_types and direction.",
        },
        edge_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Edge types to follow when related_to is specified (e.g. ['depends_on', 'blocks']).",
        },
        direction: {
          type: "string",
          enum: ["outgoing", "incoming", "both"],
          description: "Edge traversal direction when related_to is specified.",
        },
        depth: {
          type: "integer",
          description: "Graph traversal depth (default 1, max 10).",
          default: 1,
          maximum: 10,
        },
        limit: {
          type: "integer",
          description: "Maximum number of results (default 50, max 200).",
          default: 50,
          maximum: 200,
        },
        offset: {
          type: "integer",
          description: "Result offset for pagination (default 0).",
          default: 0,
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_get_execution_status",
    description:
      "Execution status: work item counts by status, ready-to-start items. Use during execute phase. Returns ~500 chars.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_get_review_manifest",
    description:
      "Review manifest: work items reviewed, reviewers, verdict. Use during review phase. Defaults to latest cycle. Returns JSON manifest.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_number: {
          type: "integer",
          description: "Cycle number to retrieve. Defaults to the most recent cycle.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_get_convergence_status",
    description:
      "Convergence status: unresolved finding counts by severity and principle verdict (findings with addressed_by set are excluded). Use to check if cycle converged.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_number: {
          type: "integer",
          description: "The cycle number to assess for convergence.",
        },
      },
      required: ["cycle_number"],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_get_domain_state",
    description:
      "Domain knowledge: policies, decisions, questions. Use for domain context. Omit domains for all. Returns ~1KB per domain.",
    inputSchema: {
      type: "object",
      properties: {
        domains: {
          type: "array",
          items: { type: "string" },
          description:
            "Domain names to retrieve (e.g. ['workflow', 'artifact-structure']). Omit to retrieve all domains.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_get_workspace_status",
    description:
      "Workspace status: current cycle, work item counts, findings, open questions, active project/phase. Use for overview. Returns ~800 chars.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["workspace", "project", "phase"],
          description: "View perspective. Default: workspace.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_check_workspace",
    description:
      "Run workspace integrity checks: orphan nodes, unindexed YAML, dangling edges, stale addressed_by. Returns structured report.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_get_tool_usage",
    description:
      "Query MCP tool_usage telemetry. Returns per-tool_name aggregates (count + token/byte totals), raw rows (capped at limit), or both. Filters: tool_name, session_id, cycle, phase, from, to (ISO timestamps, inclusive). Default view=aggregate.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        session_id: { type: "string" },
        cycle: { type: "integer" },
        phase: { type: "string" },
        from: { type: "string", description: "ISO 8601 timestamp (inclusive lower bound)." },
        to: { type: "string", description: "ISO 8601 timestamp (inclusive upper bound)." },
        view: {
          type: "string",
          enum: ["aggregate", "detail", "both"],
          description: "Default 'aggregate'.",
        },
        limit: {
          type: "integer",
          description: "Max rows for detail view. Default 1000, max 10000.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_append_journal",
    description:
      "Append entry to the project journal. Use after significant work. Returns confirmation string.",
    inputSchema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          enum: ["plan", "execute", "review", "refine", "autopilot", "project", "triage"],
          description: "The skill phase that produced this journal entry.",
        },
        date: {
          type: "string",
          description: "ISO 8601 date string for the entry (e.g. '2026-03-25').",
        },
        entry_type: {
          type: "string",
          description:
            "Short label describing the type of entry (e.g. 'work-item-complete', 'cycle-start', 'decision').",
        },
        body: {
          type: "string",
          description: "Markdown body of the journal entry.",
        },
      },
      required: ["skill", "date", "entry_type", "body"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_archive_cycle",
    description:
      "Archive a completed review cycle with its summary artifacts. Use after review completes. Returns confirmation string.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_number: {
          type: "integer",
          description: "The cycle number to archive.",
        },
      },
      required: ["cycle_number"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_write_work_items",
    description:
      "Write or update work items atomically. Use during plan/refine to define work. Returns confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Array of work item objects to write.",
          items: {
            type: "object",
            description: "Work item definition.",
            properties: {
              id: {
                type: "string",
                description: "Work item identifier (e.g. 'WI-224'). Auto-assigned if omitted.",
              },
              title: { type: "string", description: "Short title for the work item." },
              complexity: {
                type: "string",
                enum: ["low", "small", "medium", "large", "high"],
                description: "Complexity estimate.",
              },
              scope: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    op: { type: "string" },
                  },
                  required: ["path", "op"],
                },
                description: "Files this work item touches.",
              },
              depends: {
                type: "array",
                items: { type: "string" },
                description: "Work item IDs this item depends on.",
              },
              blocks: {
                type: "array",
                items: { type: "string" },
                description: "Work item IDs this item blocks.",
              },
              criteria: {
                type: "array",
                items: { type: "string" },
                description: "Acceptance criteria.",
              },
              notes_content: {
                type: "string",
                description: "Implementation notes content.",
              },
              domain: {
                type: "string",
                description: "Domain this work item belongs to.",
              },
              status: {
                type: "string",
                description: "Work item status (default: 'pending').",
              },
              resolution: {
                type: ["string", "null"],
                description: "Resolution note when item is closed/obsolete.",
              },
              cycle_created: {
                type: ["integer", "null"],
                description: "Cycle number when this work item was created.",
              },
              work_item_type: {
                type: "string",
                description: "Work item type (feature, bug, spike, maintenance, chore).",
              },
              phase: {
                type: "string",
                description: "Phase ID this work item belongs to.",
              },
            },
          },
        },
      },
      required: ["items"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_update_work_items",
    description:
      "Update work item fields without full overwrite. Use for status changes, scope updates. Returns confirmation string.",
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string" },
              resolution: { type: "string" },
              title: { type: "string" },
              complexity: { type: "string" },
              depends: { type: "array", items: { type: "string" } },
              blocks: { type: "array", items: { type: "string" } },
              criteria: { type: "array", items: { type: "string" } },
              domain: { type: "string" },
              notes: { type: "string" },
              scope: { type: "array", items: { type: "object" } },
              phase: { type: "string" },
            },
            required: ["id"],
          },
        },
      },
      required: ["updates"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_write_artifact",
    description:
      "Write an artifact to the project store. Use for findings, policies, decisions, projects, phases, and cycle summaries. Returns confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Artifact type (overview, execution_strategy, interview, research, architecture, guiding_principles, constraints, etc.)",
        },
        id: {
          type: "string",
          description: "Artifact identifier",
        },
        content: {
          type: "object",
          description: "Fields to write (type-specific content)",
        },
        cycle: {
          type: "integer",
          description:
            "Cycle number for cycle-scoped artifact types (finding, cycle_summary, review_output, review_manifest, decision_log). Required for these types, ignored for others.",
        },
      },
      required: ["type", "id", "content"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_assemble_context",
    description:
      "PPR-ranked context within token budget. Use before agent tasks. Seeds from artifact IDs. Returns markdown + metadata (sized to budget).",
    inputSchema: {
      type: "object",
      properties: {
        seed_ids: {
          type: "array",
          items: { type: "string" },
          description: "PPR seed node IDs (e.g. ['WI-275', 'PH-013', 'GP-01']).",
        },
        token_budget: {
          type: "number",
          description: "Max tokens in assembled output (default from config, typically 50000).",
        },
        include_types: {
          type: "array",
          items: { type: "string" },
          description: "Artifact types always included regardless of PPR score (default: ['architecture', 'guiding_principle', 'constraint']).",
        },
        edge_type_weights: {
          type: "object",
          description: "Override edge type weights for PPR (merged with config defaults).",
        },
      },
      required: ["seed_ids"],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_emit_event",
    description:
      "Fire registered hooks for event. Use for lifecycle events (plan.complete, review.finding). Returns JSON summary.",
    inputSchema: {
      type: "object",
      properties: {
        event: {
          type: "string",
          description:
            "Event name to fire (e.g. 'plan.complete', 'work_item.started', 'work_item.completed', 'review.finding', 'review.complete', 'cycle.converged', 'andon.triggered').",
        },
        variables: {
          type: "object",
          description:
            "Optional key-value pairs for variable substitution in hook commands and prompts (e.g. { work_item_id: '219' }).",
          additionalProperties: { type: "string" },
        },
      },
      required: ["event"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_bootstrap_workspace",
    description:
      "Initialize workspace artifacts. Use for workspace initialization. Returns confirmation with status.",
    inputSchema: {
      type: "object",
      properties: {
        project_name: {
          type: "string",
          description:
            "Optional project name to store in project config.",
        },
        artifact_directory_name: {
          type: "string",
          description:
            "Optional relative path for the artifact tree directory (default: '.ideate'). Use to create an alternate artifact tree, e.g. '.ideate-experiment'.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_get_next_id",
    description:
      "Next available ID for artifact type. Use before writing new artifacts. For proxy_human_decision, provide cycle. Returns ID string (e.g. 'WI-42' or 'PH-065-01').",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["work_item", "guiding_principle", "constraint", "policy", "decision", "question", "domain_policy", "domain_decision", "domain_question", "proxy_human_decision", "project", "phase"],
          description:
            "Artifact type to generate the next ID for.",
        },
        cycle: {
          type: "integer",
          description:
            "Cycle number (required for proxy_human_decision). Generates cycle-scoped ID: {prefix}{cycle}-{seq}.",
        },
      },
      required: ["type"],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_manage_autopilot_state",
    description:
      "Get or update autopilot state. Use action='get' for recovery, 'update' for persistence. Returns JSON state.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "update"],
          description: "Action to perform: 'get' to read current state, 'update' to merge a partial update.",
        },
        state: {
          type: "object",
          description:
            "Partial state update (required when action='update'). Any subset of autopilot-state fields: cycles_completed, convergence_achieved, started_at, last_phase, last_cycle, deferred, deferred_reason, last_full_review_cycle, full_review_interval.",
        },
      },
      required: ["action"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "ideate_update_config",
    description:
      "Update project config settings. Accepts partial patch; deep-merges into current config. Validates before writing. Pass agent_budgets, model_overrides, or ppr keys. Returns updated keys.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "object",
          description: "Partial IdeateConfigJson to merge into current config.",
        },
      },
      required: ["patch"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Readiness gate — tool calls block until the index is ready
// ---------------------------------------------------------------------------

let resolveReady: () => void;
let rejectReady: (err: Error) => void;
export const indexReady = new Promise<void>((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
export function signalIndexReady(): void { resolveReady(); }
export function signalIndexFailed(err: Error): void { rejectReady(err); }

// ---------------------------------------------------------------------------
// handleTool — dispatcher
// ---------------------------------------------------------------------------

export async function handleTool(
  ctx: ToolContext,
  name: string,
  _args: Record<string, unknown>
): Promise<string> {
  await indexReady; // block until index rebuild completes
  switch (name) {
    case "ideate_get_artifact_context":
      return instrumentToolDispatch(ctx, name, _args, () => handleGetArtifactContext(ctx, _args));

    case "ideate_get_context_package":
      return instrumentToolDispatch(ctx, name, _args, () => handleGetContextPackage(ctx, _args));

    case "ideate_get_config":
      return instrumentToolDispatch(ctx, name, _args, () => Promise.resolve(JSON.stringify(getConfigWithDefaults(ctx.ideateDir), null, 2)));

    case "ideate_artifact_query":
      return instrumentToolDispatch(ctx, name, _args, () => handleArtifactQuery(ctx, _args));

    case "ideate_get_execution_status":
      return instrumentToolDispatch(ctx, name, _args, () => handleGetExecutionStatus(ctx, _args));

    case "ideate_get_review_manifest":
      return instrumentToolDispatch(ctx, name, _args, () => handleGetReviewManifest(ctx, _args));

    case "ideate_get_convergence_status":
      return instrumentToolDispatch(ctx, name, _args, () => handleGetConvergenceStatus(ctx, _args));

    case "ideate_get_domain_state":
      return instrumentToolDispatch(ctx, name, _args, () => handleGetDomainState(ctx, _args));

    case "ideate_get_workspace_status":
      return instrumentToolDispatch(ctx, name, _args, () => handleGetWorkspaceStatus(ctx, _args));

    case "ideate_check_workspace":
      return instrumentToolDispatch(ctx, name, _args, () => handleCheckWorkspace(ctx, _args));

    case "ideate_get_tool_usage":
      return instrumentToolDispatch(ctx, name, _args, () => handleGetToolUsage(ctx, _args));

    case "ideate_append_journal":
      return instrumentToolDispatch(ctx, name, _args, () => handleAppendJournal(ctx, _args));

    case "ideate_archive_cycle":
      return instrumentToolDispatch(ctx, name, _args, () => handleArchiveCycle(ctx, _args));

    case "ideate_write_work_items":
      return instrumentToolDispatch(ctx, name, _args, () => handleWriteWorkItems(ctx, _args));

    case "ideate_update_work_items":
      return instrumentToolDispatch(ctx, name, _args, () => handleUpdateWorkItems(ctx, _args));

    case "ideate_write_artifact":
      return instrumentToolDispatch(ctx, name, _args, () => handleWriteArtifact(ctx, _args));

    case "ideate_assemble_context":
      return instrumentToolDispatch(ctx, name, _args, () => handleAssembleContext(ctx, _args));

    case "ideate_emit_event":
      return instrumentToolDispatch(ctx, name, _args, () => handleEmitEvent(ctx, _args));

    case "ideate_bootstrap_workspace":
      return instrumentToolDispatch(ctx, name, _args, () => handleBootstrapWorkspace(ctx, _args));

    case "ideate_get_next_id":
      return instrumentToolDispatch(ctx, name, _args, () => handleGetNextId(ctx, _args));

    case "ideate_manage_autopilot_state":
      return instrumentToolDispatch(ctx, name, _args, () => handleManageAutopilotState(ctx, _args));

    case "ideate_update_config":
      return instrumentToolDispatch(ctx, name, _args, () => handleUpdateConfig(ctx, _args));

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
