import * as fs from "fs";
import * as path from "path";
import type { ToolContext } from "./types.js";
import { findIdeateJson, readRawConfig, DEFAULT_WORK_STATE_PATH } from "./config.js";

// ---------------------------------------------------------------------------
// Board-presence detection (shared) — WI-326
//
// The v3 work-state delegation board lives at the configured work_state.path
// (default DEFAULT_WORK_STATE_PATH = ".ideate-work") and is "active" for a
// project once its board.db file exists. This module is the single source of
// truth for that presence signal, consumed by:
//
//   - the WRITE sink-guard (WI-321, tools/write.ts): refuses v2 work-item
//     creation/update when the board is active (assertBoardNotActive);
//   - the READ loud-incomplete marker (WI-326): v2 work-item read/aggregation
//     tools mark their counts INCOMPLETE when the board is active, because
//     board-resident items are invisible to them (boardActiveNotice).
//
// Presence-only by deliberate design (D-42): this reads only the EXISTENCE of
// board.db, never its CONTENTS. Reading board contents from the v2 server
// would cross the three-thin-seams boundary; the marker/guard need only
// existence. A pre-v3 project has no .ideate-work/board.db, so neither the
// guard nor the marker ever fires there — the v2 path stays fully intact for
// legacy projects and the legacy v2 fallback.
// ---------------------------------------------------------------------------

/**
 * Resolve the project root (the directory containing .ideate.json) from
 * ctx.ideateDir. Prefers walking up from ideateDir to find the actual
 * .ideate.json pointer (handles nested/absolute artifact_directory values);
 * falls back to the parent of ideateDir when no pointer exists yet (e.g.
 * fresh/test contexts that never wrote .ideate.json), which matches the
 * default artifact_directory (".ideate") layout.
 */
export function resolveProjectRoot(ctx: ToolContext): string {
  const found = findIdeateJson(ctx.ideateDir);
  return found ? path.dirname(found.configPath) : path.dirname(ctx.ideateDir);
}

/**
 * Resolve the absolute path to the v3 work-state board's database file,
 * reading work_state.path from .ideate.json when present and defaulting to
 * DEFAULT_WORK_STATE_PATH otherwise.
 */
export function resolveBoardDbPath(ctx: ToolContext): string {
  const config = readRawConfig(ctx.ideateDir);
  const configuredPath = config.work_state?.path?.trim();
  const workStatePath =
    configuredPath && configuredPath !== "" ? configuredPath : DEFAULT_WORK_STATE_PATH;
  const projectRoot = resolveProjectRoot(ctx);
  const workStateDir = path.isAbsolute(workStatePath)
    ? workStatePath
    : path.join(projectRoot, workStatePath);
  return path.join(workStateDir, "board.db");
}

/**
 * True when the project's v3 work-state board is active — board.db exists at
 * the resolved work_state path. Existence-only; never reads board contents.
 */
export function isBoardActive(ctx: ToolContext): boolean {
  return fs.existsSync(resolveBoardDbPath(ctx));
}

/**
 * Stable machine token embedded in the loud-incomplete marker (WI-326). Skill
 * and agent consumers (WI-328) detect this token to know a v2 work-item count
 * is board-incomplete and must be merged with work_list; WI-327's board-
 * awareness check asserts read tools carry it.
 */
export const BOARD_INCOMPLETE_TOKEN = "work_item_counts_incomplete: true";

/**
 * The loud-incomplete marker (D-42 / WI-326) prepended to a v2 work-item
 * read/aggregation tool's response when the board is active, or null when the
 * board is absent (in which case the tool's output is unchanged — byte-
 * identical to pre-WI-326 behavior). Presence-only: the marker is emitted from
 * board.db EXISTENCE alone, carrying no board contents.
 *
 * The marker makes read-blindness impossible-to-be-SILENT by construction: a
 * caller cannot report the v2-only counts below it as complete without also
 * surfacing that the board is active and the counts exclude board items.
 */
export function boardActiveNotice(ctx: ToolContext): string | null {
  if (!isBoardActive(ctx)) return null;
  return [
    `> ⚠ BOARD ACTIVE — ${BOARD_INCOMPLETE_TOKEN}`,
    "> The v3 work-state board (.ideate-work/) is active. The work-item counts and rows",
    "> below are derived from v2 artifacts ONLY and do NOT include board-resident items.",
    "> Call work_list (spec_format ideate/wi-v1) for the authoritative board items and",
    "> merge before reporting any completeness/progress judgment.",
  ].join("\n");
}
