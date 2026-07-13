/**
 * wi332-read-marker-extra.test.ts — WI-332 read-marker tests for the two
 * surfaces cycle-15 found unmarked: ideate_artifact_query({type:"work_item"})
 * (C1) and handlePhaseContext's work_items roster (II1 visibility). Both must
 * carry the board-active loud-incomplete marker (boardActiveNotice) when the
 * board is active, presence-only.
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
import { handleGetArtifactContext } from "../tools/context.js";
import { BOARD_INCOMPLETE_TOKEN } from "../board-presence.js";
import { LocalAdapter } from "../adapters/local/index.js";

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-wi332-read-marker-"));
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

async function seedWorkItem(id: string): Promise<void> {
  await ctx.adapter!.putNode({ id, type: "work_item", properties: { title: `${id} title`, status: "pending" } });
}

// ---------------------------------------------------------------------------
// C1: ideate_artifact_query({type:"work_item"})
// ---------------------------------------------------------------------------

describe("WI-332 — artifact_query({type:work_item}) read marker (C1)", () => {
  it("attaches the marker on a work_item query when board.db exists", async () => {
    await seedWorkItem("WI-001");
    createBoardDb();
    const out = await handleArtifactQuery(ctx, { type: "work_item" });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out).toContain("BOARD ACTIVE");
    expect(out).toContain("**Total**");
  });

  it("marks even a 'No results found.' work_item query on a board project (the silent-miss case)", async () => {
    createBoardDb(); // no work items seeded
    const out = await handleArtifactQuery(ctx, { type: "work_item" });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("does NOT mark a non-work_item query (e.g. type: phase)", async () => {
    await ctx.adapter!.putNode({ id: "PH-001", type: "phase", properties: { name: "x", work_items: [] } });
    createBoardDb();
    const out = await handleArtifactQuery(ctx, { type: "phase" });
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("does NOT mark a work_item query when board.db is absent", async () => {
    await seedWorkItem("WI-001");
    const out = await handleArtifactQuery(ctx, { type: "work_item" });
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("marks the related_to (queryGraph) branch for a work_item query (M1 — both branches)", async () => {
    await seedWorkItem("WI-001");
    createBoardDb();
    // WI-001 has no edges → the queryGraph branch returns "No results found.",
    // which must still carry the marker on a board project.
    const out = await handleArtifactQuery(ctx, { type: "work_item", related_to: "WI-001" });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("marks the pagination ('no results on this page') path for a work_item query (M3)", async () => {
    await seedWorkItem("WI-001");
    createBoardDb();
    const out = await handleArtifactQuery(ctx, { type: "work_item", offset: 10 });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out).toContain("lower offset");
  });
});

// ---------------------------------------------------------------------------
// II1 visibility: handlePhaseContext roster
// ---------------------------------------------------------------------------

describe("WI-332 — handlePhaseContext roster marker (II1 visibility)", () => {
  it("marks the phase roster + warns preserve-on-write-back when board active and members are not-indexed (board-resident)", async () => {
    // WI-001 has a v2 node; WI-002 does not (board-resident → "not indexed").
    await seedWorkItem("WI-001");
    await ctx.adapter!.putNode({
      id: "PH-010",
      type: "phase",
      properties: { name: "fixture", phase_type: "implementation", status: "active", work_items: ["WI-001", "WI-002"] },
    });
    createBoardDb();

    const out = await handleGetArtifactContext(ctx, { artifact_id: "PH-010" });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out).toContain("WI-002"); // the not-indexed board-resident member
    expect(out).toContain("PRESERVE"); // the write-back warning
  });

  it("does NOT mark the phase roster when board.db is absent", async () => {
    await seedWorkItem("WI-001");
    await ctx.adapter!.putNode({
      id: "PH-011",
      type: "phase",
      properties: { name: "fixture", status: "active", work_items: ["WI-001", "WI-002"] },
    });
    const out = await handleGetArtifactContext(ctx, { artifact_id: "PH-011" });
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
  });

  it("does NOT over-fire: board active but every roster member resolves to a v2 node → no marker (M2)", async () => {
    await seedWorkItem("WI-001");
    await seedWorkItem("WI-002");
    await ctx.adapter!.putNode({
      id: "PH-012",
      type: "phase",
      properties: { name: "fixture", status: "active", work_items: ["WI-001", "WI-002"] },
    });
    createBoardDb();
    const out = await handleGetArtifactContext(ctx, { artifact_id: "PH-012" });
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
  });
});
