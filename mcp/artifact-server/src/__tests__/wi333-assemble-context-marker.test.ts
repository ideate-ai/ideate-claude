/**
 * wi333-assemble-context-marker.test.ts — WI-333 (F-333-001 C1).
 *
 * ideate_assemble_context runs a PPR traversal over the v2 graph ONLY, so on a
 * board-active project the assembled context omits board-resident items/edges.
 * handleAssembleContext must mark its result INCOMPLETE (presence-only),
 * consistent with the other v2 read tools. This was the false-green C1 exposed:
 * assemble_context shared context.ts with a marked handlePhaseContext but its
 * own handler was unmarked.
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
import { handleAssembleContext } from "../tools/context.js";
import { BOARD_INCOMPLETE_TOKEN } from "../board-presence.js";
import { LocalAdapter } from "../adapters/local/index.js";

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-wi333-assemble-"));
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

describe("WI-333 — handleAssembleContext carries the board-active marker (F-333-001 C1)", () => {
  it("marks the assembled context INCOMPLETE when board.db exists", async () => {
    await ctx.adapter!.putNode({ id: "WI-001", type: "work_item", properties: { title: "seed", status: "pending" } });
    createBoardDb();
    const out = await handleAssembleContext(ctx, { seed_ids: ["WI-001"], token_budget: 50000 });
    expect(out).toContain(BOARD_INCOMPLETE_TOKEN);
    expect(out).toContain("board_active");
  });

  it("does NOT mark when board.db is absent", async () => {
    await ctx.adapter!.putNode({ id: "WI-001", type: "work_item", properties: { title: "seed", status: "pending" } });
    const out = await handleAssembleContext(ctx, { seed_ids: ["WI-001"], token_budget: 50000 });
    expect(out).not.toContain(BOARD_INCOMPLETE_TOKEN);
  });
});
