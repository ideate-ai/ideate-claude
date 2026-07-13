/**
 * wi321-board-guard.test.ts — Sink-guard tests for WI-321.
 *
 * The v2 artifact server must REFUSE a work-item write when the project's
 * v3 delegation board is active (i.e. board.db exists at the resolved
 * work_state path). This is the single-sink fix: handleWriteWorkItems is
 * the one v2 work-item creation path, and handleWriteArtifact redirects
 * `type: "work_item"` into it, so guarding handleWriteWorkItems catches
 * both entry points.
 *
 * Covered here:
 *  - board-present -> reject, via handleWriteWorkItems directly
 *  - board-present -> reject, via handleWriteArtifact({type:"work_item"}) redirect
 *  - board-present -> reject when work_state.path is customized in .ideate.json
 *  - board-absent  -> accept, via both entry points (unaffected — today's behavior)
 *  - the thrown error is a distinguishable, typed BoardActiveError naming work_create
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
import { handleWriteWorkItems, handleWriteArtifact } from "../tools/write.js";
import { BoardActiveError, ValidationError } from "../adapter.js";
import { LocalAdapter } from "../adapters/local/index.js";

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-wi321-board-guard-"));
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

/** Count rows in the nodes table. */
function nodeCount(): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM nodes").get() as { cnt: number };
  return row.cnt;
}

/** Create <tmpDir>/<relDir>/board.db (an empty placeholder file is sufficient — existsSync is the signal). */
function createBoardDb(relDir: string): void {
  const dir = path.join(tmpDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "board.db"), "", "utf8");
}

// ---------------------------------------------------------------------------
// board-present -> reject
// ---------------------------------------------------------------------------

describe("WI-321 — board-active sink guard: refuses when board.db is present", () => {
  it("handleWriteWorkItems rejects with a typed, distinguishable error naming work_create", async () => {
    createBoardDb(".ideate-work"); // default work_state.path

    let caughtError: unknown;
    try {
      await handleWriteWorkItems(ctx, { items: [{ title: "Should be refused" }] });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BoardActiveError);
    const error = caughtError as BoardActiveError;
    expect(error.code).toBe("BOARD_ACTIVE");
    expect(error.message).toContain("work_create");
    expect(error.message.toLowerCase()).toContain("board");

    // No node should have been written — the refusal happens before any work.
    expect(nodeCount()).toBe(0);
    expect(fs.readdirSync(path.join(artifactDir, "work-items"))).toHaveLength(0);
  });

  it("handleWriteArtifact({type:'work_item'}) redirect also rejects (same sink)", async () => {
    createBoardDb(".ideate-work");

    let caughtError: unknown;
    try {
      await handleWriteArtifact(ctx, {
        type: "work_item",
        id: "WI-999",
        content: { title: "Should be refused via redirect" },
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BoardActiveError);
    const error = caughtError as BoardActiveError;
    expect(error.code).toBe("BOARD_ACTIVE");
    expect(error.message).toContain("work_create");

    expect(nodeCount()).toBe(0);
    expect(fs.readdirSync(path.join(artifactDir, "work-items"))).toHaveLength(0);
  });

  it("rejects using a customized work_state.path read from .ideate.json", async () => {
    // Configure a non-default work_state path and write .ideate.json at the
    // project root (tmpDir), pointing artifact_directory at "artifact" so
    // findIdeateJson resolves the same ctx.ideateDir used elsewhere.
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
    // Sanity: the default path must NOT be treated as active.
    expect(fs.existsSync(path.join(tmpDir, ".ideate-work", "board.db"))).toBe(false);

    await expect(
      handleWriteWorkItems(ctx, { items: [{ title: "Custom path board" }] })
    ).rejects.toBeInstanceOf(BoardActiveError);

    expect(nodeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// board-absent -> accept (unaffected — today's behavior), both entry points
// ---------------------------------------------------------------------------

describe("WI-321 — board-absent: v2 work-item writes are unaffected", () => {
  it("handleWriteWorkItems writes normally when board.db is absent", async () => {
    // No .ideate-work/ directory created at all.
    await handleWriteWorkItems(ctx, { items: [{ title: "Normal v2 item" }] });

    expect(nodeCount()).toBe(1);
    expect(fs.readdirSync(path.join(artifactDir, "work-items"))).toHaveLength(1);
  });

  it("handleWriteArtifact({type:'work_item'}) redirect writes normally when board.db is absent", async () => {
    await handleWriteArtifact(ctx, {
      type: "work_item",
      id: "WI-100",
      content: { title: "Normal v2 item via redirect" },
    });

    expect(nodeCount()).toBe(1);
    const files = fs.readdirSync(path.join(artifactDir, "work-items"));
    expect(files).toContain("WI-100.yaml");
  });

  it("is unaffected when .ideate-work/ exists but board.db does not (e.g. an empty/partial dir)", async () => {
    fs.mkdirSync(path.join(tmpDir, ".ideate-work"), { recursive: true });
    // Deliberately no board.db inside it.

    await handleWriteWorkItems(ctx, { items: [{ title: "Still v2" }] });

    expect(nodeCount()).toBe(1);
  });

  it("still rejects other invalid input the normal way (guard does not mask ordinary validation)", async () => {
    // Sanity: with board absent, an ordinary validation error (missing items)
    // is unaffected by this change and is not a BoardActiveError.
    let caughtError: unknown;
    try {
      await handleWriteWorkItems(ctx, {});
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).not.toBeInstanceOf(BoardActiveError);
    expect(caughtError).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Error-type distinguishability
// ---------------------------------------------------------------------------

describe("WI-321 — BoardActiveError is distinguishable from ordinary errors", () => {
  it("BoardActiveError is not a ValidationError and carries its own name/code", async () => {
    createBoardDb(".ideate-work");

    let caughtError: unknown;
    try {
      await handleWriteWorkItems(ctx, { items: [{ title: "x" }] });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BoardActiveError);
    expect(caughtError).not.toBeInstanceOf(ValidationError);
    const error = caughtError as BoardActiveError;
    expect(error.name).toBe("BoardActiveError");
    expect(error.details?.boardDbPath).toContain("board.db");
  });
});
