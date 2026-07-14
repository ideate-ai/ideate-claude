/**
 * wi326-read-marker.test.ts — Read-side loud-incomplete marker tests for WI-326 (D-42).
 *
 * The v2 artifact server's work-item read/aggregation tools must mark their
 * responses INCOMPLETE when the project's v3 delegation board is active
 * (board.db exists at the resolved work_state path). Board-resident items are
 * invisible to these v2-only reads, so an unmarked count could be silently
 * under-reported. The marker (boardActiveNotice) is the read-side analogue of
 * WI-321's write sink-guard, and is presence-only — it reads board EXISTENCE,
 * never board CONTENTS (staying inside the three-thin-seams boundary).
 *
 * Covered here:
 *  - board-present -> marker present on get_execution_status, get_review_manifest,
 *    and get_workspace_status (workspace / project / phase views)
 *  - board-absent  -> NO marker; output unchanged (v2-only behavior intact)
 *  - custom work_state.path from .ideate.json is honored
 *  - unit behavior of isBoardActive / boardActiveNotice
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import type { DrizzleDb } from "../db-helpers.js";
import type { ToolContext } from "../types.js";
import { handleWriteWorkItems } from "../tools/write.js";
import { handleGetExecutionStatus, handleGetReviewManifest } from "../tools/execution.js";
import { handleGetWorkspaceStatus } from "../tools/analysis.js";
import { isBoardActive, boardActiveNotice, BOARD_INCOMPLETE_TOKEN } from "../board-presence.js";
import { LocalAdapter } from "../adapters/local/index.js";

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-wi326-read-marker-"));
  artifactDir = path.join(tmpDir, "artifact");

  for (const sub of ["work-items", "policies", "decisions", "questions", "domains"]) {
    fs.mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }

  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);

  drizzleDb = drizzle(db, { schema: dbSchema });
  ctx = { db, drizzleDb, ideateDir: artifactDir, adapter: undefined };
  ctx.adapter = new LocalAdapter({ db, drizzleDb, ideateDir: artifactDir });
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create <tmpDir>/<relDir>/board.db (an empty placeholder is sufficient — existsSync is the signal). */
function createBoardDb(relDir: string): void {
  const dir = path.join(tmpDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "board.db"), "", "utf8");
}

/** Seed one v2 work item. Must run while the board is ABSENT (else WI-321 refuses). */
async function seedWorkItem(id: string, title: string): Promise<void> {
  await handleWriteWorkItems(ctx, { items: [{ id, title, status: "pending" }] });
}

// ---------------------------------------------------------------------------
// board-present -> marker present on all three read/aggregation tools
// ---------------------------------------------------------------------------

describe("WI-326 — board-active read marker: v2 counts marked incomplete", () => {
  it("get_execution_status carries the loud-incomplete marker when board.db is present", async () => {
    await seedWorkItem("WI-001", "Seeded item");
    createBoardDb(".ideate-work");

    const out = await handleGetExecutionStatus(ctx, {});
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out).toContain("BOARD ACTIVE");
    expect(out).toContain("work_list");
    // The actual status section is still present after the marker.
    expect(out).toContain("## Execution Status");
  });

  it("get_review_manifest carries the marker when board.db is present", async () => {
    await seedWorkItem("WI-001", "Seeded item");
    createBoardDb(".ideate-work");

    const out = await handleGetReviewManifest(ctx, {});
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out).toContain("BOARD ACTIVE");
    expect(out).toContain("## Review Manifest");
  });

  it("get_workspace_status (workspace view) carries the marker when board.db is present", async () => {
    await seedWorkItem("WI-001", "Seeded item");
    createBoardDb(".ideate-work");

    const out = await handleGetWorkspaceStatus(ctx, {});
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out).toContain("BOARD ACTIVE");
    expect(out).toContain("# Workspace Status Dashboard");
  });

  it("get_workspace_status project and phase views also carry the marker", async () => {
    createBoardDb(".ideate-work");

    const projectView = await handleGetWorkspaceStatus(ctx, { view: "project" });
    expect(projectView).toContain(BOARD_INCOMPLETE_TOKEN);

    const phaseView = await handleGetWorkspaceStatus(ctx, { view: "phase" });
    expect(phaseView).toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("honors a customized work_state.path from .ideate.json", async () => {
    await seedWorkItem("WI-001", "Seeded item");
    fs.writeFileSync(
      path.join(tmpDir, ".ideate.json"),
      JSON.stringify({
        schema_version: 9,
        artifact_directory: "artifact",
        work_state: { path: "custom-work-dir" },
      }),
      "utf8"
    );
    createBoardDb("custom-work-dir");
    // The default path must NOT be treated as active.
    expect(fs.existsSync(path.join(tmpDir, ".ideate-work", "board.db"))).toBe(false);

    const out = await handleGetExecutionStatus(ctx, {});
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// board-absent -> NO marker; v2-only behavior unchanged
// ---------------------------------------------------------------------------

describe("WI-326 — board-absent: read tools are unaffected (no marker)", () => {
  it("get_execution_status has no marker and starts with the normal header", async () => {
    await seedWorkItem("WI-001", "Seeded item");

    const out = await handleGetExecutionStatus(ctx, {});
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out).not.toContain("BOARD ACTIVE");
    expect(out.startsWith("## Execution Status")).toBe(true);
  });

  it("get_review_manifest has no marker when board.db is absent", async () => {
    await seedWorkItem("WI-001", "Seeded item");

    const out = await handleGetReviewManifest(ctx, {});
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out.startsWith("## Review Manifest")).toBe(true);
  });

  it("get_workspace_status has no marker when board.db is absent", async () => {
    const out = await handleGetWorkspaceStatus(ctx, {});
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out.startsWith("# Workspace Status Dashboard")).toBe(true);
  });

  it("is unaffected when .ideate-work/ exists but board.db does not", async () => {
    fs.mkdirSync(path.join(tmpDir, ".ideate-work"), { recursive: true });
    // Deliberately no board.db inside it.
    const out = await handleGetExecutionStatus(ctx, {});
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Unit behavior of the shared presence helpers
// ---------------------------------------------------------------------------

describe("WI-326 — board-presence helpers", () => {
  it("isBoardActive reflects board.db existence; boardActiveNotice is null when absent", () => {
    expect(isBoardActive(ctx)).toBe(false);
    expect(boardActiveNotice(ctx)).toBeNull();

    createBoardDb(".ideate-work");
    expect(isBoardActive(ctx)).toBe(true);
    const notice = boardActiveNotice(ctx);
    expect(notice).not.toBeNull();
    expect(notice as string).toContain(BOARD_INCOMPLETE_TOKEN);
  });
});
