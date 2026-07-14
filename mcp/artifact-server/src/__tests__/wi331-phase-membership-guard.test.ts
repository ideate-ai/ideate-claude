/**
 * wi331-phase-membership-guard.test.ts — II1 backstop tests for WI-331.
 *
 * A board-active phase write must not silently DROP existing work_items
 * membership. The phase read-merge-rewrite path (project skill) can drop
 * board-resident WI IDs (relegated to handlePhaseContext's "not indexed"
 * footnote) on a full putNode REPLACE, truncating the phase's only v2-side
 * record of board-item membership and corrupting the P-47 gate's census. The
 * backstop refuses such a write. Presence-only + self-comparison (Q-55): it
 * reads board.db EXISTENCE and the on-disk phase's OWN work_items, never
 * board.db contents.
 *
 * Covered here:
 *  - board-present + truncating write (strict subset) -> refuse, typed error naming dropped IDs
 *  - board-present + preserving/growing write -> accept
 *  - board-absent + truncating write -> accept (backstop off)
 *  - new phase (no on-disk predecessor) -> accept
 *  - the error is distinguishable from BoardActiveError
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
import { handleWriteArtifact } from "../tools/write.js";
import { PhaseMembershipTruncationError, BoardActiveError } from "../adapter.js";
import { LocalAdapter } from "../adapters/local/index.js";

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-wi331-phase-guard-"));
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

/** Create <tmpDir>/<relDir>/board.db (empty placeholder — existsSync is the signal). */
function createBoardDb(relDir: string): void {
  const dir = path.join(tmpDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "board.db"), "", "utf8");
}

/** Write a phase artifact with the given work_items (board must be absent to seed). */
async function writePhase(id: string, workItems: string[]): Promise<string> {
  return handleWriteArtifact(ctx, {
    type: "phase",
    id,
    content: { name: "fixture", phase_type: "implementation", status: "active", work_items: workItems },
  });
}

// ---------------------------------------------------------------------------
// board-present -> refuse a truncating write
// ---------------------------------------------------------------------------

describe("WI-331 — board-active phase-membership backstop: refuses silent truncation", () => {
  it("refuses a board-active phase write that drops an existing work_items member, naming the dropped ID", async () => {
    await writePhase("PH-001", ["WI-001", "WI-002", "WI-003"]);
    createBoardDb(".ideate-work");

    let caught: unknown;
    try {
      await writePhase("PH-001", ["WI-001", "WI-003"]); // drops WI-002
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PhaseMembershipTruncationError);
    const error = caught as PhaseMembershipTruncationError;
    expect(error.code).toBe("PHASE_MEMBERSHIP_TRUNCATION");
    expect(error.message).toContain("WI-002");
    expect(error.message).toContain("PH-001");
    expect(error.details?.droppedIds).toEqual(["WI-002"]);
  });

  it("accepts a board-active write that PRESERVES all members (status-only merge)", async () => {
    await writePhase("PH-002", ["WI-001", "WI-002"]);
    createBoardDb(".ideate-work");

    // Same membership, e.g. a status change — must succeed.
    await expect(writePhase("PH-002", ["WI-001", "WI-002"])).resolves.toContain("Wrote phase");
  });

  it("accepts a board-active write that GROWS work_items (adds a new member)", async () => {
    await writePhase("PH-003", ["WI-001"]);
    createBoardDb(".ideate-work");

    await expect(writePhase("PH-003", ["WI-001", "WI-002"])).resolves.toContain("Wrote phase");
  });

  it("refuses the LITERAL II1 shape: a write that OMITS the work_items field entirely against an existing phase (F-331-001 M1)", async () => {
    await writePhase("PH-004", ["WI-001", "WI-002"]);
    createBoardDb(".ideate-work");

    let caught: unknown;
    try {
      // The read-merge-rewrite defect: content carries a {status} change but
      // drops work_items entirely (never carried forward).
      await handleWriteArtifact(ctx, {
        type: "phase",
        id: "PH-004",
        content: { name: "fixture", status: "complete" }, // no work_items key
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PhaseMembershipTruncationError);
    expect((caught as PhaseMembershipTruncationError).details?.droppedIds).toEqual(["WI-001", "WI-002"]);
  });

  it("fails CLOSED when the on-disk work_items is present but unparseable (F-331-001 M2)", async () => {
    // Seed a phase whose stored work_items is a corrupted, non-empty string.
    createBoardDb(".ideate-work");
    await ctx.adapter!.putNode({
      id: "PH-005",
      type: "phase",
      properties: { name: "corrupt", status: "active", work_items: "{not valid json" },
    });

    let caught: unknown;
    try {
      await writePhase("PH-005", ["WI-001"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PhaseMembershipTruncationError);
    expect((caught as PhaseMembershipTruncationError).message).toContain("unverifiable");
  });
});

// ---------------------------------------------------------------------------
// board-absent -> unaffected; new phase -> unaffected
// ---------------------------------------------------------------------------

describe("WI-331 — backstop is off when the board is absent or the phase is new", () => {
  it("a truncating write is allowed when board.db is absent (pre-v3 project unaffected)", async () => {
    await writePhase("PH-010", ["WI-001", "WI-002"]);
    // No board.db.
    await expect(writePhase("PH-010", ["WI-001"])).resolves.toContain("Wrote phase");
  });

  it("a brand-new phase (no on-disk predecessor) writes normally even with the board active", async () => {
    createBoardDb(".ideate-work");
    await expect(writePhase("PH-020", ["WI-001", "WI-002"])).resolves.toContain("Wrote phase");
  });

  it("is off when .ideate-work/ exists but board.db does not", async () => {
    await writePhase("PH-030", ["WI-001", "WI-002"]);
    fs.mkdirSync(path.join(tmpDir, ".ideate-work"), { recursive: true }); // no board.db
    await expect(writePhase("PH-030", ["WI-001"])).resolves.toContain("Wrote phase");
  });
});

// ---------------------------------------------------------------------------
// Error-type distinguishability
// ---------------------------------------------------------------------------

describe("WI-331 — PhaseMembershipTruncationError is distinguishable from BoardActiveError", () => {
  it("is its own typed error, not a BoardActiveError", async () => {
    await writePhase("PH-040", ["WI-001", "WI-002"]);
    createBoardDb(".ideate-work");

    let caught: unknown;
    try {
      await writePhase("PH-040", ["WI-001"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PhaseMembershipTruncationError);
    expect(caught).not.toBeInstanceOf(BoardActiveError);
    expect((caught as PhaseMembershipTruncationError).name).toBe("PhaseMembershipTruncationError");
  });
});
