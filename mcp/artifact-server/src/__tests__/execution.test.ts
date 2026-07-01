/**
 * execution.test.ts — Tests for handleGetExecutionStatus focusing on
 * obsolete status handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import type { ToolContext } from "../types.js";
import { LocalAdapter } from "../adapters/local/index.js";
import { handleGetExecutionStatus, handleGetReviewManifest } from "../tools/execution.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-execution-test-"));
  artifactDir = path.join(tmpDir, "artifact");

  for (const sub of [
    "archive/incremental",
    "archive/cycles",
    "plan/work-items",
    "domains",
    "work-items",
    "policies",
    "decisions",
    "questions",
    "principles",
    "constraints",
    "modules",
    "research",
    "interviews",
    "projects",
    "phases",
    "plan",
    "steering",
  ]) {
    fs.mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }

  fs.writeFileSync(path.join(artifactDir, "journal.md"), "", "utf8");
  fs.writeFileSync(
    path.join(artifactDir, "domains", "index.md"),
    "current_cycle: 1\n\n## Domains\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);

  const drizzleDb = drizzle(db, { schema: dbSchema });
  const adapter = new LocalAdapter({ db, drizzleDb, ideateDir: artifactDir });
  await adapter.initialize();
  ctx = { db, drizzleDb, ideateDir: artifactDir, adapter };
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertNode(
  id: string,
  type: string,
  options: {
    status?: string;
    file_path?: string;
    cycle_created?: number;
    content_hash?: string;
  } = {}
): void {
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
    VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)
  `).run(
    id,
    type,
    options.cycle_created ?? null,
    options.content_hash ?? "testhash",
    options.file_path ?? `/tmp/${id}.yaml`,
    options.status ?? "pending"
  );
}

function insertWorkItem(
  id: string,
  title: string,
  options: {
    depends?: string[];
  } = {}
): void {
  db.prepare(`
    INSERT OR REPLACE INTO work_items (id, title, complexity, domain, depends, blocks, criteria, scope)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
  `).run(
    id,
    title,
    "small",
    null,
    options.depends ? JSON.stringify(options.depends) : null
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleGetExecutionStatus — obsolete items", () => {
  it("obsolete items are excluded from execution status counts", async () => {
    // Insert one obsolete work item and two regular ones
    insertNode("WI-001", "work_item", { status: "obsolete" });
    insertWorkItem("WI-001", "Obsolete item");

    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Pending item");

    insertNode("WI-003", "work_item", { status: "done" });
    insertWorkItem("WI-003", "Done item");

    const result = await handleGetExecutionStatus(ctx, {});

    // WI-001 should appear in the Obsolete count, not in pending/ready/blocked
    expect(result).toContain("Obsolete: 1");

    // Pending count should not include the obsolete item
    // WI-002 has no deps, so it goes to ready (not pending)
    expect(result).not.toMatch(/Pending:\s*[1-9]/); // pending should be 0
    expect(result).toContain("Ready to execute: 1"); // only WI-002 is ready
    expect(result).toContain("Completed: 1"); // WI-003

    // Blocked count should be 0
    expect(result).toContain("Blocked: 0");

    // Obsolete count includes WI-001 (count-only, no ID list)
    expect(result).toContain("Obsolete: 1");
  });

  it("obsolete items satisfy dependencies for downstream items", async () => {
    // WI-A is obsolete; WI-B depends on WI-A
    insertNode("WI-A", "work_item", { status: "obsolete" });
    insertWorkItem("WI-A", "Obsolete dependency");

    insertNode("WI-B", "work_item", { status: "pending" });
    insertWorkItem("WI-B", "Downstream item", { depends: ["WI-A"] });

    const result = await handleGetExecutionStatus(ctx, {});

    // WI-B's dependency on WI-A is satisfied because WI-A is obsolete
    // So WI-B should appear as ready, not blocked
    expect(result).toContain("Ready to execute: 1");
    expect(result).toContain("WI-B");
    expect(result).toContain("Blocked: 0");

    // WI-A should be reported as obsolete (count-only, no ID list)
    expect(result).toContain("Obsolete: 1");

    // WI-B should NOT appear in blocked
    expect(result).not.toMatch(/WI-B blocked by/);
  });
});

// ---------------------------------------------------------------------------
// WI-220 — legacy status synonyms ('complete', 'completed') must be treated
// as terminal (done) and excluded from the ready list, matching the
// canonical vocabulary in node-type-registry.ts (only done/obsolete are
// terminal). This regression-tests the "finished legacy items surfaced as
// ready" bug.
// ---------------------------------------------------------------------------

describe("handleGetExecutionStatus — legacy status synonym normalization", () => {
  it("'completed' items are counted as Completed, not Ready", async () => {
    insertNode("WI-101", "work_item", { status: "completed" });
    insertWorkItem("WI-101", "Legacy completed item");

    const result = await handleGetExecutionStatus(ctx, {});

    expect(result).toContain("Completed: 1");
    expect(result).toContain("Ready to execute: 0");
    expect(result).not.toContain("WI-101");
  });

  it("'complete' items are counted as Completed, not Ready", async () => {
    insertNode("WI-102", "work_item", { status: "complete" });
    insertWorkItem("WI-102", "Legacy complete item");

    const result = await handleGetExecutionStatus(ctx, {});

    expect(result).toContain("Completed: 1");
    expect(result).toContain("Ready to execute: 0");
  });

  it("legacy-synonym items satisfy dependencies for downstream items (treated as done)", async () => {
    insertNode("WI-201", "work_item", { status: "completed" });
    insertWorkItem("WI-201", "Legacy completed dependency");

    insertNode("WI-202", "work_item", { status: "pending" });
    insertWorkItem("WI-202", "Downstream item", { depends: ["WI-201"] });

    const result = await handleGetExecutionStatus(ctx, {});

    expect(result).toContain("Ready to execute: 1");
    expect(result).toContain("WI-202");
    expect(result).toContain("Blocked: 0");
    expect(result).not.toMatch(/WI-202 blocked by/);
  });

  it("only done/obsolete are terminal — 'blocked' and 'in_progress' status items remain actionable, not silently completed", async () => {
    insertNode("WI-301", "work_item", { status: "in_progress" });
    insertWorkItem("WI-301", "In-progress item");

    const result = await handleGetExecutionStatus(ctx, {});

    // 'in_progress' is not terminal, so with no unsatisfied deps it is ready.
    expect(result).toContain("Completed: 0");
    expect(result).toContain("Ready to execute: 1");
    expect(result).toContain("WI-301");
  });
});

// ---------------------------------------------------------------------------
// Helper: insert a finding row
// ---------------------------------------------------------------------------

function insertFinding(
  id: string,
  workItem: string,
  severity: "critical" | "significant" | "minor",
  verdict: "pass" | "fail",
  cycle: number
): void {
  insertNode(id, "finding", { cycle_created: cycle });
  db.prepare(`
    INSERT OR REPLACE INTO findings (id, severity, work_item, verdict, cycle, reviewer, file_refs)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(id, severity, workItem, verdict, cycle, "code-reviewer");
}

describe("handleGetReviewManifest — SQLite-based verdicts", () => {
  it("returns None verdict for work items with no findings", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Item with no findings");

    const result = await handleGetReviewManifest(ctx, {});

    expect(result).toContain("Item with no findings");
    expect(result).toContain("None");
  });

  it("returns Pass verdict for work items with only minor findings", async () => {
    insertNode("WI-010", "work_item", { status: "pending" });
    insertWorkItem("WI-010", "Item with minor finding");
    insertFinding("F-001-001", "WI-010", "minor", "pass", 1);

    const result = await handleGetReviewManifest(ctx, { cycle_number: 1 });

    expect(result).toContain("Item with minor finding");
    expect(result).toContain("Pass");
  });

  it("returns Fail verdict for work items with significant findings", async () => {
    insertNode("WI-020", "work_item", { status: "pending" });
    insertWorkItem("WI-020", "Item with significant finding");
    insertFinding("F-002-001", "WI-020", "significant", "fail", 2);

    const result = await handleGetReviewManifest(ctx, { cycle_number: 2 });

    expect(result).toContain("Item with significant finding");
    expect(result).toContain("Fail");
  });

  it("filters by cycle_number when provided", async () => {
    insertNode("WI-030", "work_item", { status: "pending" });
    insertWorkItem("WI-030", "Filtered item");
    // Cycle 1 finding
    insertFinding("F-003-001", "WI-030", "critical", "fail", 1);
    // Cycle 2 finding (minor)
    insertFinding("F-003-002", "WI-030", "minor", "pass", 2);

    // Requesting cycle 2 — should show Pass (only minor), not Fail
    const result = await handleGetReviewManifest(ctx, { cycle_number: 2 });
    expect(result).toContain("Pass");
    expect(result).not.toContain("Fail");
  });

  it("returns most recent cycle when no cycle_number is provided", async () => {
    insertNode("WI-040", "work_item", { status: "pending" });
    insertWorkItem("WI-040", "Recent cycle item");
    insertFinding("F-004-001", "WI-040", "minor", "pass", 3);

    // No cycle_number — should use max cycle (3)
    const result = await handleGetReviewManifest(ctx, {});
    expect(result).toContain("Pass");
    expect(result).toContain("Cycle 3");
  });

  it("returns Fail verdict for critical-severity finding", async () => {
    insertNode("WI-900", "work_item", { status: "pending" });
    insertWorkItem("WI-900", "Item with critical finding");
    insertFinding("F-900-001", "WI-900", "critical", "fail", 9);

    const result = await handleGetReviewManifest(ctx, { cycle_number: 9 });

    expect(result).toContain("Item with critical finding");
    expect(result).toContain("Fail");
  });
});
