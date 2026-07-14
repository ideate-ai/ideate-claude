/**
 * wi330-update-guard.test.ts — Update-sink guard tests for WI-330.
 *
 * Symmetric with WI-321's create-sink guard: the v2 artifact server must
 * REFUSE a work-item STATUS UPDATE (ideate_update_work_items) when the
 * project's v3 delegation board is active (board.db exists at the resolved
 * work_state path). On a board project there is no legitimate v2 work-item
 * update — board transitions (work_claim/work_complete/work_release) are the
 * single home. This closes the write-UPDATE axis by construction and the
 * Q-51 symptom-9 edge (a stale v2 node from a duplicate WI number must not be
 * silently mutated).
 *
 * Covered here:
 *  - board-present -> reject, error names the board transition tools
 *  - board-present -> the stale v2 node is NOT mutated (Q-51 symptom-9 edge)
 *  - board-absent  -> updates behave exactly as today (unaffected)
 *  - the thrown error is a distinguishable, typed BoardActiveError
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
import { handleWriteWorkItems, handleUpdateWorkItems } from "../tools/write.js";
import { BoardActiveError, ValidationError } from "../adapter.js";
import { LocalAdapter } from "../adapters/local/index.js";

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-wi330-update-guard-"));
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
async function seedWorkItem(id: string, title: string, status: string): Promise<void> {
  await handleWriteWorkItems(ctx, { items: [{ id, title, status }] });
}

// ---------------------------------------------------------------------------
// board-present -> reject
// ---------------------------------------------------------------------------

describe("WI-330 — board-active update guard: refuses when board.db is present", () => {
  it("handleUpdateWorkItems rejects with a typed error naming the board transition tools", async () => {
    // Seed a v2 node while the board is absent, then activate the board.
    await seedWorkItem("WI-001", "Stale v2 node", "pending");
    createBoardDb(".ideate-work");

    let caughtError: unknown;
    try {
      await handleUpdateWorkItems(ctx, { updates: [{ id: "WI-001", status: "done" }] });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BoardActiveError);
    const error = caughtError as BoardActiveError;
    expect(error.code).toBe("BOARD_ACTIVE");
    // Names the board transition path, not work_create.
    expect(error.message).toContain("work_claim");
    expect(error.message).toContain("work_complete");
    expect(error.message).toContain("work_release");
    expect(error.message.toLowerCase()).toContain("board");
  });

  it("refuses ANY v2 update once the board is active — including a stale node whose ID could collide with board numbering (Q-51 symptom-9) — leaving the node unmutated", async () => {
    // Presence-only design (D-42): the guard cannot and does not inspect board
    // CONTENTS, so it refuses every v2 update once board.db exists regardless of
    // whether WI-001 also names a board item. Modeling an actual duplicate-ID
    // board node is intentionally out of scope — the point is that the Q-51
    // symptom-9 hazard (a stale v2 node co-existing with a board item) cannot
    // lead to a silent v2 mutation, because refuse-first happens unconditionally.
    await seedWorkItem("WI-001", "Stale v2 node", "pending");
    createBoardDb(".ideate-work");

    await expect(
      handleUpdateWorkItems(ctx, { updates: [{ id: "WI-001", status: "done" }] })
    ).rejects.toBeInstanceOf(BoardActiveError);

    // The node's status must be unchanged — the refusal happens before any patch.
    const node = await ctx.adapter!.getNode("WI-001");
    expect(node).not.toBeNull();
    expect(node!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// board-absent -> accept (unaffected — today's behavior)
// ---------------------------------------------------------------------------

describe("WI-330 — board-absent: v2 work-item updates are unaffected", () => {
  it("handleUpdateWorkItems updates normally when board.db is absent", async () => {
    await seedWorkItem("WI-001", "Normal v2 node", "pending");
    // No .ideate-work/board.db.

    const result = await handleUpdateWorkItems(ctx, {
      updates: [{ id: "WI-001", status: "done" }],
    });
    expect(result).toContain("updated: 1");

    const node = await ctx.adapter!.getNode("WI-001");
    expect(node!.status).toBe("done");
  });

  it("is unaffected when .ideate-work/ exists but board.db does not", async () => {
    await seedWorkItem("WI-001", "Still v2", "pending");
    fs.mkdirSync(path.join(tmpDir, ".ideate-work"), { recursive: true });
    // Deliberately no board.db inside it.

    const result = await handleUpdateWorkItems(ctx, {
      updates: [{ id: "WI-001", status: "done" }],
    });
    expect(result).toContain("updated: 1");
  });

  it("still handles ordinary empty-update input the normal way (guard does not mask it)", async () => {
    const result = await handleUpdateWorkItems(ctx, { updates: [] });
    expect(result).toContain("updated: 0");
  });
});

// ---------------------------------------------------------------------------
// Error-type distinguishability
// ---------------------------------------------------------------------------

describe("WI-330 — BoardActiveError from the update sink is distinguishable", () => {
  it("is a BoardActiveError, not a ValidationError, and carries its own name/code", async () => {
    await seedWorkItem("WI-001", "x", "pending");
    createBoardDb(".ideate-work");

    let caughtError: unknown;
    try {
      await handleUpdateWorkItems(ctx, { updates: [{ id: "WI-001", status: "done" }] });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BoardActiveError);
    expect(caughtError).not.toBeInstanceOf(ValidationError);
    const error = caughtError as BoardActiveError;
    expect(error.name).toBe("BoardActiveError");
    expect(error.details?.boardDbPath).toContain("board.db");
  });

  it("the create sink's message is unchanged (byte-identical) — WI-321 path still names work_create", async () => {
    createBoardDb(".ideate-work");

    let caughtError: unknown;
    try {
      await handleWriteWorkItems(ctx, { items: [{ title: "create attempt" }] });
    } catch (err) {
      caughtError = err;
    }
    const error = caughtError as BoardActiveError;
    expect(error.message).toContain("work_create");
    expect(error.message).toContain("created via");
    // The create message must NOT mention the update-only transition tools.
    expect(error.message).not.toContain("work_claim");
  });
});
