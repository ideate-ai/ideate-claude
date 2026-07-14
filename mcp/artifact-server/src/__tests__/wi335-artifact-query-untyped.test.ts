/**
 * wi335-artifact-query-untyped.test.ts — WI-335 (C1/C2 fix, P-49).
 *
 * The board-active incomplete marker on ideate_artifact_query must be gated on
 * RESULT CONTENT, not the request `type` argument. The prior WI-332 form left
 * UNTYPED paths board-blind: a related_to traversal or a filters-only query
 * returns work_item rows unmarked. A static census (WI-333) cannot catch that
 * conditional misapplication (C2), so this is a BEHAVIORAL test per P-49 —
 * it exercises the handler and asserts the marker on the actual output.
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
import { handleArtifactQuery } from "../tools/query.js";
import { BOARD_INCOMPLETE_TOKEN } from "../board-presence.js";
import { LocalAdapter } from "../adapters/local/index.js";

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-wi335-untyped-"));
  artifactDir = path.join(tmpDir, "artifact");
  for (const sub of ["work-items", "policies", "decisions", "questions", "domains", "phases"]) {
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

function createBoardDb(): void {
  const dir = path.join(tmpDir, ".ideate-work");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "board.db"), "", "utf8");
}

describe("WI-335 — artifact_query marks on RESULT CONTENT, not the type argument (C1/C2, P-49)", () => {
  it("marks an UNTYPED filters-only query that returns work_item rows (the C1 gap)", async () => {
    await ctx.adapter!.putNode({ id: "WI-001", type: "work_item", properties: { title: "t", status: "pending" } });
    createBoardDb();
    // No `type` — filters only. The result contains a work_item row.
    const out = await handleArtifactQuery(ctx, { filters: { status: "pending" } });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("marks an UNTYPED related_to query (untyped can return work_item — conservative marking)", async () => {
    await ctx.adapter!.putNode({ id: "WI-002", type: "work_item", properties: { title: "dep", status: "pending" } });
    await ctx.adapter!.putNode({ id: "WI-001", type: "work_item", properties: { title: "t", status: "pending", depends: ["WI-002"] } });
    createBoardDb();
    const out = await handleArtifactQuery(ctx, { related_to: "WI-001" });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("does NOT over-fire: a type:phase query returning only a phase row is NOT marked", async () => {
    await ctx.adapter!.putNode({ id: "PH-001", type: "phase", properties: { name: "x", work_items: [] } });
    createBoardDb();
    const out = await handleArtifactQuery(ctx, { type: "phase" });
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("still marks the explicit type:work_item path (WI-332 behavior preserved)", async () => {
    await ctx.adapter!.putNode({ id: "WI-001", type: "work_item", properties: { title: "t", status: "pending" } });
    createBoardDb();
    const out = await handleArtifactQuery(ctx, { type: "work_item" });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("board-absent: an untyped work_item-returning query is unaffected", async () => {
    await ctx.adapter!.putNode({ id: "WI-001", type: "work_item", properties: { title: "t", status: "pending" } });
    const out = await handleArtifactQuery(ctx, { filters: { status: "pending" } });
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("isolates the type===undefined branch: an untyped query returning ONLY non-work_item rows is STILL marked (F-335-001 M1)", async () => {
    // No work_item nodes exist at all — only a phase. An untyped query can, in
    // general, return work_item rows, so the conservative marker must fire even
    // when this particular result set is work-item-free. This proves the
    // `type === undefined` disjunct, independent of resultHasWorkItems.
    await ctx.adapter!.putNode({ id: "PH-001", type: "phase", properties: { name: "x", status: "active", work_items: [] } });
    createBoardDb();
    const out = await handleArtifactQuery(ctx, { filters: { status: "active" } });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN); // marked purely because untyped
  });
});
