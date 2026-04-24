/**
 * default-scope-resolver.ts — Resolve (org_id, codebase_id) scope for the
 * local adapter from configuration and/or cwd heuristics.
 *
 * Resolution order:
 *   1. Explicit config.codebase_id (plus config.org_id) — wins immediately
 *      when both fields are present and non-empty in IdeateConfigJson.
 *   2. cwd heuristic: maps monorepo sub-paths to canonical codebase_ids:
 *        plugins/claude/**  → plugin-claude
 *        services/server/** → artifact-server
 *        infra/**           → infra
 *        (default)          → product
 *   3. Hard error: throws if no config and cwd heuristic cannot resolve
 *      (currently always resolves to "product" as the final fallback, but
 *      the error path is preserved for future heuristic extensibility).
 *
 * Runs once at MCP server startup; callers should cache the result.
 */

import type { IdeateConfigJson } from "./config.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ResolvedScope {
  org_id: string;
  codebase_id: string;
}

// ---------------------------------------------------------------------------
// cwd heuristic table
// ---------------------------------------------------------------------------

/**
 * Ordered list of path prefix → codebase_id mappings.
 * Matching is done by checking whether the normalised cwd contains
 * the prefix as a sub-path segment. Entries are checked in order;
 * the first match wins.
 */
/**
 * Path sub-segment patterns matched against the normalised cwd.
 * Each prefix is tested with a leading slash to ensure segment-level matching
 * (e.g., "plugins/claude" matches "/ideate/plugins/claude/..." but not
 * "/my-plugins/claude-utils/...").
 */
const CWD_HEURISTICS: Array<{ segment: string; codebase_id: string }> = [
  { segment: "/plugins/claude", codebase_id: "plugin-claude" },
  { segment: "/services/server", codebase_id: "artifact-server" },
  { segment: "/infra", codebase_id: "infra" },
];

/**
 * Default org_id used when the heuristic resolves a codebase_id but
 * no org_id is explicitly configured.
 */
const DEFAULT_ORG_ID = "ideate";

/**
 * Default codebase_id used as the final fallback when no cwd heuristic
 * matches (broad "product" bucket).
 */
const DEFAULT_CODEBASE_ID = "product";

// ---------------------------------------------------------------------------
// resolveDefaultScope
// ---------------------------------------------------------------------------

/**
 * Resolve the default (org_id, codebase_id) scope for the local adapter.
 *
 * @param config - Parsed IdeateConfigJson (may be a partial/empty object).
 * @param cwd    - Working directory to use for the heuristic. Defaults to
 *                 process.cwd() when omitted.
 * @returns Resolved scope with org_id and codebase_id.
 * @throws {Error} when all resolution paths fail (currently unreachable, but
 *                 preserved for future stricter heuristics).
 */
export function resolveDefaultScope(
  config: Partial<IdeateConfigJson>,
  cwd?: string
): ResolvedScope {
  // ------------------------------------------------------------------
  // 1. Explicit config wins
  // ------------------------------------------------------------------
  if (
    typeof config.codebase_id === "string" &&
    config.codebase_id.trim() !== "" &&
    typeof config.org_id === "string" &&
    config.org_id.trim() !== ""
  ) {
    return {
      org_id: config.org_id.trim(),
      codebase_id: config.codebase_id.trim(),
    };
  }

  // ------------------------------------------------------------------
  // 2. cwd heuristic
  // ------------------------------------------------------------------
  const dir = cwd ?? process.cwd();
  // Normalise to forward-slash separators for cross-platform matching
  const normalised = dir.replace(/\\/g, "/");

  for (const { segment, codebase_id } of CWD_HEURISTICS) {
    // Match segment with a leading slash to avoid partial segment matches.
    // e.g., "/plugins/claude" matches "/ideate/plugins/claude/src" and
    // "/ideate/plugins/claude" but NOT "/my-plugins/claude-utils"
    if (normalised.includes(segment + "/") || normalised.endsWith(segment)) {
      return {
        org_id: DEFAULT_ORG_ID,
        codebase_id,
      };
    }
  }

  // Final fallback: map to "product" (broadest codebase bucket)
  return {
    org_id: DEFAULT_ORG_ID,
    codebase_id: DEFAULT_CODEBASE_ID,
  };
}
