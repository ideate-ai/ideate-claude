/**
 * tools.test.ts — Integration tests for tool handlers (see tools/index.ts for the full list).
 *
 * Architecture:
 * - Each test creates a fresh temp-file SQLite DB with createSchema applied.
 * - A ToolContext is assembled from that DB + a temp artifact directory.
 * - Tool handlers are called directly (not through MCP plumbing).
 * - Write tools (append_journal, write_work_items, archive_cycle) operate on
 *   a real temp directory structure mirroring .ideate/ layout.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import { TYPE_TO_EXTENSION_TABLE as registryTypeToExtensionTable } from "../node-type-registry.js";
import type { ToolContext } from "../types.js";
import { LocalAdapter } from "../adapters/local/index.js";
import { handleGetArtifactContext, handleGetContextPackage, handleAssembleContext } from "../tools/context.js";
import { handleArtifactQuery, handleGetNextId } from "../tools/query.js";
import { handleGetExecutionStatus, handleGetReviewManifest } from "../tools/execution.js";
import { handleGetConvergenceStatus, handleGetDomainState, handleGetWorkspaceStatus } from "../tools/analysis.js";
import { handleAppendJournal, handleArchiveCycle, handleWriteWorkItems, handleUpdateWorkItems, handleWriteArtifact } from "../tools/write.js";
import { upsertExtensionRow } from "../db-helpers.js";
import { indexFiles } from "../indexer.js";
import { handleTool, signalIndexReady } from "../tools/index.js";
import { handleBootstrapWorkspace } from "../tools/bootstrap.js";
import { handleManageAutopilotState } from "../tools/autopilot-state.js";
import { CONFIG_SCHEMA_VERSION } from "../config.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// Signal the readiness gate so handleTool calls don't block
beforeAll(() => {
  signalIndexReady();
});

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-tools-test-"));
  artifactDir = path.join(tmpDir, "artifact");

  // Create artifact dir structure matching what tools expect
  for (const sub of [
    "archive/incremental",
    "archive/cycles",
    "plan/work-items",
    "plan/notes",
    "domains",
  ]) {
    fs.mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }

  // Create an empty journal.md
  fs.writeFileSync(path.join(artifactDir, "journal.md"), "", "utf8");

  // Create domains/index.md with cycle info
  fs.writeFileSync(
    path.join(artifactDir, "domains", "index.md"),
    "current_cycle: 3\n\n## Domains\n- workflow\n",
    "utf8"
  );

  // Open a temp-file DB so file operations work properly
  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);

  const drizzleDb = drizzle(db, { schema: dbSchema });
  ctx = { db, drizzleDb, ideateDir: artifactDir };
  ctx.adapter = new LocalAdapter({ db, drizzleDb, ideateDir: artifactDir });
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a node row directly */
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

/** Insert a work_item extension row (node must already exist) */
function insertWorkItem(
  id: string,
  title: string,
  options: {
    complexity?: string;
    domain?: string;
    depends?: string[];
    scope?: Array<{ path: string; op: string }>;
    criteria?: string[];
  } = {}
): void {
  db.prepare(`
    INSERT OR REPLACE INTO work_items (id, title, complexity, domain, depends, blocks, criteria, scope)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    title,
    options.complexity ?? "small",
    options.domain ?? null,
    options.depends ? JSON.stringify(options.depends) : null,
    options.criteria ? JSON.stringify(options.criteria) : null,
    options.scope ? JSON.stringify(options.scope) : null
  );
}

/** Insert a domain_policy node + extension */
function insertDomainPolicy(
  id: string,
  domain: string,
  description: string,
  status = "active"
): void {
  insertNode(id, "domain_policy", { status });
  db.prepare(`
    INSERT OR REPLACE INTO domain_policies (id, domain, description)
    VALUES (?, ?, ?)
  `).run(id, domain, description);
}

/** Insert a domain_question node + extension */
function insertDomainQuestion(
  id: string,
  domain: string,
  description: string,
  status = "open"
): void {
  insertNode(id, "domain_question", { status });
  db.prepare(`
    INSERT OR REPLACE INTO domain_questions (id, domain, description)
    VALUES (?, ?, ?)
  `).run(id, domain, description);
}

/** Insert a finding node + extension */
function insertFinding(
  id: string,
  severity: "critical" | "significant" | "minor",
  workItem: string,
  verdict: "pass" | "fail",
  cycle: number,
  status = "open"
): void {
  insertNode(id, "finding", { status });
  db.prepare(`
    INSERT OR REPLACE INTO findings (id, severity, work_item, verdict, cycle, reviewer)
    VALUES (?, ?, ?, ?, ?, 'test-reviewer')
  `).run(id, severity, workItem, verdict, cycle);
}

// ---------------------------------------------------------------------------
// 1. handleGetArtifactContext
// ---------------------------------------------------------------------------

describe("handleGetArtifactContext — work item dispatch", () => {
  it("happy path: returns markdown with work item title and criteria", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Build schema", {
      complexity: "medium",
      domain: "workflow",
      criteria: ["Test passes", "Docs updated"],
    });

    const result = await handleGetArtifactContext(ctx, {
      artifact_id: "WI-001",
    });

    expect(result).toContain("WI-001");
    expect(result).toContain("Build schema");
    expect(result).toContain("Test passes");
    expect(result).toContain("Docs updated");
  });

  it("normalises work item ID: 'WI-002' is found directly", async () => {
    insertNode("WI-002", "work_item");
    insertWorkItem("WI-002", "Numeric ID item");

    const result = await handleGetArtifactContext(ctx, {
      artifact_id: "WI-002",
    });
    expect(result).toContain("WI-002");
    expect(result).toContain("Numeric ID item");
  });

  it("normalises numeric-only ID: '2' resolves to 'WI-002'", async () => {
    insertNode("WI-002", "work_item");
    insertWorkItem("WI-002", "Numeric only item");

    const result = await handleGetArtifactContext(ctx, {
      artifact_id: "2",
    });
    expect(result).toContain("WI-002");
    expect(result).toContain("Numeric only item");
  });

  it("error path: throws when artifact_id is missing", async () => {
    await expect(
      handleGetArtifactContext(ctx, {})
    ).rejects.toThrow(/artifact_id/i);
  });

  it("error path: throws when artifact not found", async () => {
    await expect(
      handleGetArtifactContext(ctx, {
        artifact_id: "WI-999",
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe("handleGetArtifactContext — phase dispatch", () => {
  it("happy path: returns phase metadata and work item summaries", async () => {
    // Insert a project node required by FK
    db.prepare(`
      INSERT OR REPLACE INTO nodes (id, type, cycle_created, content_hash, file_path, status)
      VALUES ('PR-001', 'project', NULL, 'hash', '/tmp/PR-001.yaml', 'active')
    `).run();
    db.prepare(`
      INSERT OR REPLACE INTO projects (id, intent, status)
      VALUES ('PR-001', 'Test project', 'active')
    `).run();

    // Insert work items that belong to the phase
    insertNode("WI-010", "work_item", { status: "done" });
    insertWorkItem("WI-010", "Completed Feature", { complexity: "small" });
    insertNode("WI-011", "work_item", { status: "pending" });
    insertWorkItem("WI-011", "Pending Feature", { complexity: "medium" });

    // Insert phase node and extension row
    const phaseWorkItems = JSON.stringify(["WI-010", "WI-011"]);
    insertNode("PH-001", "phase", { status: "active" });
    db.prepare(`
      INSERT OR REPLACE INTO phases (id, project, phase_type, intent, steering, status, work_items)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("PH-001", "PR-001", "implementation", "Deliver core features", "Follow P-44", "active", phaseWorkItems);

    const result = await handleGetArtifactContext(ctx, { artifact_id: "PH-001" });

    // Phase metadata
    expect(result).toContain("PH-001");
    expect(result).toContain("implementation");
    expect(result).toContain("Deliver core features");
    expect(result).toContain("active");

    // Work item summary table
    expect(result).toContain("WI-010");
    expect(result).toContain("Completed Feature");
    expect(result).toContain("done");
    expect(result).toContain("WI-011");
    expect(result).toContain("Pending Feature");
    expect(result).toContain("pending");
  });

  it("phase with success_criteria in YAML: includes success criteria section", async () => {
    // Insert a project node
    db.prepare(`
      INSERT OR REPLACE INTO nodes (id, type, cycle_created, content_hash, file_path, status)
      VALUES ('PR-002', 'project', NULL, 'hash', '/tmp/PR-002.yaml', 'active')
    `).run();
    db.prepare(`
      INSERT OR REPLACE INTO projects (id, intent, status)
      VALUES ('PR-002', 'Another project', 'active')
    `).run();

    // Write a phase YAML file with success_criteria
    const phaseFilePath = path.join(artifactDir, "phases", "PH-002.yaml");
    fs.mkdirSync(path.join(artifactDir, "phases"), { recursive: true });
    fs.writeFileSync(phaseFilePath, [
      "id: PH-002",
      "type: phase",
      "phase_type: review",
      "intent: Validate deliverables",
      "project: PR-002",
      "status: active",
      "work_items: []",
      "success_criteria:",
      "  - All findings addressed",
      "  - Code review complete",
    ].join("\n"), "utf8");

    insertNode("PH-002", "phase", { status: "active", file_path: phaseFilePath });
    db.prepare(`
      INSERT OR REPLACE INTO phases (id, project, phase_type, intent, steering, status, work_items)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("PH-002", "PR-002", "review", "Validate deliverables", null, "active", JSON.stringify([]));

    const result = await handleGetArtifactContext(ctx, { artifact_id: "PH-002" });

    expect(result).toContain("Phase Success Criteria");
    expect(result).toContain("All findings addressed");
    expect(result).toContain("Code review complete");
  });

  // WI-803: Removed "throws when phase node exists but phases extension row is missing" test.
  // The SQLite-fallback path that threw this error was deleted in WI-803 (all data access
  // now goes through ctx.adapter). With the adapter path, LocalAdapter.getNode returns the
  // node (with empty properties) even when the phases extension row is absent, so the
  // "phase metadata not found" error never fires. The assertion no longer applies at the
  // adapter boundary (Option B from WI-803 spec).
});

describe("handleGetArtifactContext — generic artifact dispatch", () => {
  it("happy path: returns YAML content for a guiding_principle", async () => {
    // Write a GP YAML file
    const gpFilePath = path.join(artifactDir, "principles", "GP-01.yaml");
    fs.mkdirSync(path.join(artifactDir, "principles"), { recursive: true });
    fs.writeFileSync(gpFilePath, [
      "id: GP-01",
      "type: guiding_principle",
      "name: MCP Abstraction Boundary",
      "description: Skills interact with artifacts exclusively through MCP tools.",
    ].join("\n"), "utf8");

    insertNode("GP-01", "guiding_principle", { file_path: gpFilePath, status: "active" });
    db.prepare(`INSERT OR REPLACE INTO guiding_principles (id, name, description) VALUES (?, ?, ?)`)
      .run("GP-01", "MCP Abstraction Boundary", "Skills interact with artifacts exclusively through MCP tools.");

    const result = await handleGetArtifactContext(ctx, { artifact_id: "GP-01" });

    // Node metadata
    expect(result).toContain("GP-01");
    expect(result).toContain("guiding_principle");

    // YAML content
    expect(result).toContain("MCP Abstraction Boundary");
    expect(result).toContain("Skills interact with artifacts");
  });

  it("generic artifact with edges: includes related artifact IDs", async () => {
    // Write a policy YAML file
    const policyFilePath = path.join(artifactDir, "policies", "P-01.yaml");
    fs.mkdirSync(path.join(artifactDir, "policies"), { recursive: true });
    fs.writeFileSync(policyFilePath, [
      "id: P-01",
      "type: domain_policy",
      "domain: workflow",
      "description: Write YAML before SQLite.",
    ].join("\n"), "utf8");

    insertNode("P-01", "domain_policy", { file_path: policyFilePath, status: "active" });
    db.prepare(`INSERT OR REPLACE INTO domain_policies (id, domain, description) VALUES (?, ?, ?)`)
      .run("P-01", "workflow", "Write YAML before SQLite.");

    // Insert a work item that is governed_by P-01
    insertNode("WI-100", "work_item", { status: "pending" });
    insertWorkItem("WI-100", "Policy-governed item");
    db.prepare(`
      INSERT OR IGNORE INTO edges (source_id, target_id, edge_type, props)
      VALUES (?, ?, 'governed_by', '{}')
    `).run("WI-100", "P-01");

    const result = await handleGetArtifactContext(ctx, { artifact_id: "P-01" });

    // Should show the related artifact edge
    expect(result).toContain("Related Artifacts");
    expect(result).toContain("WI-100");
    expect(result).toContain("governed_by");
  });

  // WI-803: Removed "returns 'Content not available' when file_path points to nonexistent file" test.
  // The SQLite-fallback path that produced the "Content not available" placeholder was deleted
  // in WI-803 (all data access now goes through ctx.adapter). With the adapter path,
  // LocalAdapter.readNodeContent returns "" (empty string) when the file is absent — so the
  // content section is simply omitted rather than showing "Content not available".
  // The assertion no longer applies at the adapter boundary (Option B from WI-803 spec).
});

// ---------------------------------------------------------------------------
// 2. handleGetContextPackage
// ---------------------------------------------------------------------------

describe("handleGetContextPackage", () => {
  // Attach a LocalAdapter to ctx so handlers that require ctx.adapter work.
  beforeEach(() => {
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });
  });


  it("happy path: returns markdown sections (Architecture, Guiding Principles, Constraints)", async () => {
    // Insert a document artifact of type 'architecture'
    insertNode("DOC-arch", "architecture", { file_path: path.join(artifactDir, "arch.md") });
    db.prepare(`INSERT OR REPLACE INTO document_artifacts (id, title, content) VALUES ('DOC-arch', 'Architecture', '## Overview\nTest arch content.')`).run();

    const result = await handleGetContextPackage(ctx, {});
    expect(result).toContain("## Architecture");
    expect(result).toContain("## Guiding Principles");
    expect(result).toContain("## Constraints");
  });

  it("empty DB: returns section headers with no content", async () => {
    const result = await handleGetContextPackage(ctx, {});
    expect(result).toContain("## Guiding Principles");
    expect(result).toContain("## Constraints");
  });

  it("architecture content appears in correct section", async () => {
    insertNode("DOC-arch", "architecture", { file_path: path.join(artifactDir, "arch.md") });
    db.prepare(`INSERT OR REPLACE INTO document_artifacts (id, title, content) VALUES ('DOC-arch', 'Architecture', 'unique-arch-marker-xyz')`).run();

    const result = await handleGetContextPackage(ctx, {});
    // The architecture content should appear after the Architecture header
    const archIdx = result.indexOf("## Architecture");
    const markerIdx = result.indexOf("unique-arch-marker-xyz");
    expect(archIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(archIdx);
  });

  it("multiple guiding principles appear in output", async () => {
    insertNode("GP-01", "guiding_principle", { file_path: path.join(artifactDir, "principles", "GP-01.yaml") });
    db.prepare(`INSERT OR REPLACE INTO guiding_principles (id, name, description) VALUES ('GP-01', 'Spec Sufficiency', 'Plans must be complete')`).run();
    insertNode("GP-02", "guiding_principle", { file_path: path.join(artifactDir, "principles", "GP-02.yaml") });
    db.prepare(`INSERT OR REPLACE INTO guiding_principles (id, name, description) VALUES ('GP-02', 'Minimal Inference', 'Executor does not design')`).run();

    const result = await handleGetContextPackage(ctx, {});
    expect(result).toContain("Spec Sufficiency");
    expect(result).toContain("Minimal Inference");
  });

  it("constraints appear in output", async () => {
    insertNode("C-01", "constraint", { file_path: path.join(artifactDir, "constraints", "C-01.yaml") });
    db.prepare(`INSERT OR REPLACE INTO constraints (id, category, description) VALUES ('C-01', 'technology', 'Claude Code plugin format')`).run();

    const result = await handleGetContextPackage(ctx, {});
    expect(result).toContain("Claude Code plugin format");
  });
});

// ---------------------------------------------------------------------------
// 3. handleArtifactQuery
// ---------------------------------------------------------------------------

describe("handleArtifactQuery", () => {
  it("happy path: returns markdown table of work items when type=work_item", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Query test item");

    const result = await handleArtifactQuery(ctx, { type: "work_item" });
    expect(result).toContain("WI-001");
    expect(result).toContain("Query test item");
  });

  it("happy path: filters by domain via filters object", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Workflow item", { domain: "workflow" });
    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Other item", { domain: "infra" });

    const result = await handleArtifactQuery(ctx, {
      type: "work_item",
      filters: { domain: "workflow" },
    });
    expect(result).toContain("WI-001");
    expect(result).not.toContain("WI-002");
  });

  it("happy path: status filter returns only matching nodes", async () => {
    insertNode("WI-001", "work_item", { status: "done" });
    insertWorkItem("WI-001", "Done item");
    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Pending item");

    const result = await handleArtifactQuery(ctx, {
      type: "work_item",
      filters: { status: "done" },
    });
    expect(result).toContain("WI-001");
    expect(result).not.toContain("WI-002");
  });

  it("error path: throws when no filter params given", async () => {
    await expect(handleArtifactQuery(ctx, {})).rejects.toThrow("At least one of");
  });

  it("error path: throws for unknown type", async () => {
    await expect(handleArtifactQuery(ctx, { type: "not_a_real_type" })).rejects.toThrow("not_a_real_type");
  });

  it("error path: lists valid types when type is unknown", async () => {
    // Q-94: refine skill used 'journal' instead of 'journal_entry' and got empty results silently
    await expect(handleArtifactQuery(ctx, { type: "journal" })).rejects.toThrow(/Valid types:/);
  });

  it("error path: returns error when related_to node not found", async () => {
    const result = await handleArtifactQuery(ctx, {
      related_to: "WI-nonexistent",
    });
    expect(result).toContain("Error");
  });

  it("traverses dependency chain at depth > 1", async () => {
    // Create 3-node chain: WI-TEST-A → WI-TEST-B → WI-TEST-C
    insertNode("WI-TEST-A", "work_item", { status: "pending" });
    insertWorkItem("WI-TEST-A", "Node A");
    insertNode("WI-TEST-B", "work_item", { status: "pending" });
    insertWorkItem("WI-TEST-B", "Node B");
    insertNode("WI-TEST-C", "work_item", { status: "pending" });
    insertWorkItem("WI-TEST-C", "Node C");

    // Create depends_on edges: A→B, B→C
    db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type, props)
      VALUES (?, ?, 'depends_on', '{}')
    `).run("WI-TEST-A", "WI-TEST-B");
    db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type, props)
      VALUES (?, ?, 'depends_on', '{}')
    `).run("WI-TEST-B", "WI-TEST-C");

    const result = await handleArtifactQuery(ctx, {
      related_to: "WI-TEST-A",
      edge_types: ["depends_on"],
      direction: "outgoing",
      depth: 3,
    });

    // Result should be a markdown table
    expect(result).toContain("|");

    // Both WI-TEST-B (depth 1) and WI-TEST-C (depth 2) should appear
    expect(result).toContain("WI-TEST-B");
    expect(result).toContain("WI-TEST-C");

    // Parse rows to verify depth values and no duplicates
    const lines = result.split("\n").filter((l) => l.startsWith("|") && !l.match(/^[| -]+$/));
    // Skip header row (first line)
    const dataLines = lines.slice(1);

    // Should have exactly 2 data rows (B at depth 1, C at depth 2)
    expect(dataLines).toHaveLength(2);

    // Verify depth values: B should be at depth 1, C at depth 2
    const bRow = dataLines.find((l) => l.includes("WI-TEST-B"));
    const cRow = dataLines.find((l) => l.includes("WI-TEST-C"));
    expect(bRow).toBeDefined();
    expect(cRow).toBeDefined();
    expect(bRow).toContain("1");
    expect(cRow).toContain("2");

    // No duplicate rows: IDs should appear exactly once each
    const idMatches = (id: string) => dataLines.filter((l) => l.includes(id));
    expect(idMatches("WI-TEST-B")).toHaveLength(1);
    expect(idMatches("WI-TEST-C")).toHaveLength(1);
  });

  it("column structure: Cycle column is populated from cycle_created; no Domain column", async () => {
    // Regression for CR-S1: Domain/Cycle columns were permanently empty in queryNodes path.
    insertNode("WI-COL-01", "work_item", { status: "pending", cycle_created: 7 });
    insertWorkItem("WI-COL-01", "Column structure test item");

    const result = await handleArtifactQuery(ctx, { type: "work_item" });

    // Parse header row
    const lines = result.split("\n");
    const headerLine = lines[0];

    // Cycle header must be present
    expect(headerLine).toContain("Cycle");
    // Domain header must NOT be present
    expect(headerLine).not.toContain("Domain");

    // Find the data row for WI-COL-01 and verify cycle value "7" appears
    const dataRow = lines.find((l) => l.includes("WI-COL-01"));
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain("7");
  });
});

// ---------------------------------------------------------------------------
// handleGetArtifactContext / handleArtifactQuery / handleGetNextId
// adapter-required guard tests (GA-S1)
// ---------------------------------------------------------------------------

describe("adapter-required guard tests", () => {
  it("handleGetArtifactContext throws when ctx.adapter is not set", async () => {
    const noAdapterCtx: ToolContext = {
      ideateDir: ctx.ideateDir,
      // adapter intentionally omitted; db/drizzleDb omitted — not exercised by these guard tests
    };
    await expect(handleGetArtifactContext(noAdapterCtx, { artifact_id: "WI-001" })).rejects.toThrow(
      "context.ts: ToolContext.adapter is required"
    );
  });

  it("handleArtifactQuery throws when ctx.adapter is not set", async () => {
    const noAdapterCtx: ToolContext = {
      ideateDir: ctx.ideateDir,
      // adapter intentionally omitted; db/drizzleDb omitted — not exercised by these guard tests
    };
    await expect(handleArtifactQuery(noAdapterCtx, { type: "work_item" })).rejects.toThrow(
      "query.ts: ToolContext.adapter is required"
    );
  });

  it("handleGetNextId throws when ctx.adapter is not set", async () => {
    const noAdapterCtx: ToolContext = {
      ideateDir: ctx.ideateDir,
      // adapter intentionally omitted; db/drizzleDb omitted — not exercised by these guard tests
    };
    await expect(handleGetNextId(noAdapterCtx, { type: "work_item" })).rejects.toThrow(
      "query.ts: ToolContext.adapter is required"
    );
  });
});

// ---------------------------------------------------------------------------
// 4. handleGetExecutionStatus
// ---------------------------------------------------------------------------

describe("handleGetExecutionStatus", () => {
  // Attach LocalAdapter — handler routes all queries through ctx.adapter.
  beforeEach(() => {
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });
  });

  it("happy path: shows total, completed, pending, ready counts", async () => {
    insertNode("WI-001", "work_item", { status: "done" });
    insertWorkItem("WI-001", "Done item");
    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Pending item");

    const result = await handleGetExecutionStatus(ctx, {});
    expect(result).toContain("Execution Status");
    expect(result).toMatch(/Total:\s*\d+/);
    expect(result).toMatch(/Completed:\s*\d+/);
  });

  it("happy path: blocked items are listed with their unmet deps", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Blocked item", { depends: ["WI-099"] });

    const result = await handleGetExecutionStatus(ctx, {});
    expect(result).toContain("WI-001");
    // WI-099 is unmet
    expect(result).toContain("WI-099");
  });

  it("error path: empty work item list returns zeroed counts", async () => {
    const result = await handleGetExecutionStatus(ctx, {});
    expect(result).toContain("Total: 0");
  });
});

// ---------------------------------------------------------------------------
// 5. handleGetReviewManifest
// ---------------------------------------------------------------------------

describe("handleGetReviewManifest", () => {
  // Attach LocalAdapter — handler routes all queries through ctx.adapter.
  beforeEach(() => {
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });
  });

  it("happy path: returns markdown table with work item rows", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Manifest item");

    const result = await handleGetReviewManifest(ctx, {});
    expect(result).toContain("Manifest item");
  });

  it("happy path: includes review verdict when finding exists in SQLite", async () => {
    insertNode("WI-001", "work_item", { status: "done" });
    insertWorkItem("WI-001", "Reviewed item");

    // Insert a minor finding (pass verdict) via SQLite — v3 approach
    insertFinding("F-001-001", "minor", "WI-001", "pass", 1);

    const result = await handleGetReviewManifest(ctx, { cycle_number: 1 });
    expect(result).toContain("Pass");
  });

  it("error path: empty DB returns just headers", async () => {
    const result = await handleGetReviewManifest(ctx, {});
    // Should return header + divider only (no data rows), not throw
    expect(typeof result).toBe("string");
    expect(result).toContain("#");
  });
});

// ---------------------------------------------------------------------------
// 6. handleGetConvergenceStatus
// ---------------------------------------------------------------------------

describe("handleGetConvergenceStatus", () => {
  /** Helper: insert a cycle_summary node + document_artifacts row */
  function insertCycleSummary(id: string, cycle: number, content: string): void {
    insertNode(id, "cycle_summary", { cycle_created: cycle });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run(id, cycle, content);
  }

  it("happy path: converged=true when no critical/significant findings and principle passes", async () => {
    // WI-824 (fix option c): canonical id required — insertCycleSummary uses
    // file_path /tmp/{id}.yaml which is not canonical; switch to a canonical
    // node whose file_path ends with spec-adherence.yaml.
    const cycleDir = path.join(artifactDir, "cycles", "001");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(
      filePath,
      "id: spec-adherence-001\ntype: cycle_summary\ncycle: 1\n",
      "utf8"
    );
    insertNode("spec-adherence-001", "cycle_summary", { file_path: filePath, cycle_created: 1 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-001", 1, "**Principle Violation Verdict**: Pass\n\n## Summary\nAll good.\n");

    const result = await handleGetConvergenceStatus(ctx, {
      cycle_number: 1,
    });

    expect(result).toContain("converged: true");
    expect(result).toContain("condition_a: true");
    expect(result).toContain("condition_b: true");
  });

  it("happy path: converged=false when critical findings exist", async () => {
    // WI-824 (fix option c): canonical id required (same pattern as above).
    const cycleDir = path.join(artifactDir, "cycles", "001");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(
      filePath,
      "id: spec-adherence-001\ntype: cycle_summary\ncycle: 1\n",
      "utf8"
    );
    insertNode("spec-adherence-001", "cycle_summary", { file_path: filePath, cycle_created: 1 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-001", 1, "**Principle Violation Verdict**: Pass\n\n## Summary\nAll good.\n");
    // Insert 2 critical findings for cycle 1 into the findings table
    insertFinding("F-001-001", "critical", "WI-001", "fail", 1);
    insertFinding("F-001-002", "critical", "WI-001", "fail", 1);

    const result = await handleGetConvergenceStatus(ctx, {
      cycle_number: 1,
    });

    expect(result).toContain("converged: false");
    expect(result).toContain("critical: 2");
  });

  it("Test A: critical finding in findings table → converged=false, condition_a=false", async () => {
    insertCycleSummary(
      "CS-099",
      99,
      "**Principle Violation Verdict**: Pass\n\n## Summary\nAll good.\n"
    );
    // Seed a critical finding for cycle 99
    insertFinding("F-099-001", "critical", "WI-099", "fail", 99);

    const result = await handleGetConvergenceStatus(ctx, {
      cycle_number: 99,
    });

    expect(result).toContain("converged: false");
    expect(result).toContain("condition_a: false");
  });

  it("Test B: no findings for cycle 100 with Pass verdict → converged=true, condition_a=true, condition_b=true", async () => {
    // WI-824 (fix option c): canonical id required — node file_path must end with
    // spec-adherence.yaml so adherenceRow selection finds it.
    const cycleDir = path.join(artifactDir, "cycles", "100");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(
      filePath,
      "id: spec-adherence-100\ntype: cycle_summary\ncycle: 100\n",
      "utf8"
    );
    insertNode("spec-adherence-100", "cycle_summary", { file_path: filePath, cycle_created: 100 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-100", 100, "**Principle Violation Verdict**: Pass\n\n## Summary\nAll good.\n");
    // No findings inserted for cycle 100

    const result = await handleGetConvergenceStatus(ctx, {
      cycle_number: 100,
    });

    expect(result).toContain("converged: true");
    expect(result).toContain("condition_a: true");
    expect(result).toContain("condition_b: true");
  });

  it("Test C: significant finding with Pass verdict → converged=false, condition_a=false", async () => {
    insertCycleSummary(
      "CS-101",
      101,
      "**Principle Violation Verdict**: Pass\n\n## Summary\nAll good.\n"
    );
    // Seed one significant finding for cycle 101
    insertFinding("F-101-001", "significant", "WI-101", "fail", 101);

    const result = await handleGetConvergenceStatus(ctx, {
      cycle_number: 101,
    });

    expect(result).toContain("condition_a: false");
    expect(result).toContain("converged: false");
  });

  it("error path: missing cycle_summary for cycle returns unknown/false convergence", async () => {
    // Cycle 999 has no cycle_summary rows in the DB
    const result = await handleGetConvergenceStatus(ctx, {
      cycle_number: 999,
    });

    expect(result).toContain("converged: false");
    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).toContain("condition_b: false");
  });

  it("error path: missing or invalid cycle_number throws", async () => {
    await expect(handleGetConvergenceStatus(ctx, {})).rejects.toThrow(
      "Missing or invalid required parameter: cycle_number"
    );
    await expect(handleGetConvergenceStatus(ctx, { cycle_number: "bad" })).rejects.toThrow(
      "Missing or invalid required parameter: cycle_number"
    );
  });

  it("file_path fallback: finds cycle_summary when document_artifacts row is absent (canonical filename)", async () => {
    // Write a cycle_summary YAML file on disk under cycles/097/ using canonical filename.
    // WI-824 (fix option c): only canonical filenames (spec-adherence.yaml) are accepted
    // for file-path fallback reads; legacy SA-NNN filenames are no longer found.
    const cycleDir = path.join(artifactDir, "cycles", "097");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(
      filePath,
      "id: spec-adherence-097\ntype: cycle_summary\ncycle: 97\ncontent: |-\n  ## Verdict: Pass\n  **Principle Violation Verdict**: Pass\n",
      "utf8"
    );

    // Insert only a nodes row — intentionally NO document_artifacts row
    insertNode("spec-adherence-097", "cycle_summary", { file_path: filePath, cycle_created: 97 });

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 97 });
    expect(result).toContain("converged: true");
    expect(result).toContain("condition_b: true");
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
  });

  it("file_path fallback: finds cycle_summary when document_artifacts row exists but da.cycle is null (canonical filename)", async () => {
    // Simulate the case where a node IS in document_artifacts but da.cycle was not populated.
    // WI-824 (fix option c): only canonical filenames (spec-adherence.yaml) are accepted
    // for file-path fallback reads; legacy SA-NNN filenames are no longer found.
    const cycleDir = path.join(artifactDir, "cycles", "098");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(
      filePath,
      "id: spec-adherence-098\ntype: cycle_summary\ncycle: 98\ncontent: |-\n  ## Verdict: Pass\n  **Principle Violation Verdict**: Pass\n",
      "utf8"
    );

    // Insert nodes row and a document_artifacts row with NULL cycle
    insertNode("spec-adherence-098", "cycle_summary", { file_path: filePath, cycle_created: 98 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, NULL, NULL)`
    ).run("spec-adherence-098");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 98 });
    expect(result).toContain("converged: true");
    expect(result).toContain("condition_b: true");
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
  });

  it("write→convergence roundtrip: handleWriteArtifact then handleGetConvergenceStatus returns converged:true", async () => {
    // Full roundtrip: write a cycle_summary via handleWriteArtifact (writes YAML + SQLite),
    // then query convergence — exercises the complete write→index→query chain.
    // WI-824 (fix option c): canonical id "spec-adherence" generates spec-adherence.yaml on disk;
    // legacy SA-NNN ids are no longer found by the strict canonical-only file selection.
    await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: "spec-adherence",
      cycle: 8,
      content: {
        title: "SA roundtrip test",
        content: "## Verdict: Pass\n\n**Principle Violation Verdict**: Pass\n\n## Principle Violations\n\nNone.",
      },
    });

    // No critical/significant findings for cycle 8 → condition_a: true
    // spec-adherence artifact has Principle Violation Verdict: Pass → condition_b: true
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 8 });
    expect(result).toContain("converged: true");
    expect(result).toContain("condition_a: true");
    expect(result).toContain("condition_b: true");
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
  });

  it("parsePrincipleVerdict: returns pass when da_content is JSON.stringify({content: '**Principle Violation Verdict**: Pass'})", async () => {
    // Simulate how handleWriteArtifact stores content: JSON.stringify(content object).
    // WI-824 (fix option c): node file_path must end with spec-adherence.yaml so
    // adherenceRow selection finds it; da_content matching alone is no longer sufficient.
    const jsonEncoded = JSON.stringify({ content: "**Principle Violation Verdict**: Pass\n\n## Summary\nAll good." });
    const cycleDir = path.join(artifactDir, "cycles", "009");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-009\ntype: cycle_summary\ncycle: 9\n", "utf8");
    insertNode("spec-adherence-009", "cycle_summary", { file_path: filePath, cycle_created: 9 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-009", 9, jsonEncoded);

    // No findings for cycle 9 → condition_a: true
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 9 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
    expect(result).toContain("converged: true");
  });

  it("regression WI-797: canonical spec-adherence.yaml (Pass) wins over legacy SA-NNN.yaml (Fail) in same cycle dir", async () => {
    // Reproducer: cycle dir contains both spec-adherence.yaml (Pass) and SA-NNN.yaml (Fail).
    // Before fix: condition_b was false because the checker picked up the legacy SA- row.
    // After fix: condition_b is true because canonical filename is preferred.
    const cycleDir = path.join(artifactDir, "cycles", "200");
    fs.mkdirSync(cycleDir, { recursive: true });

    // Legacy SA-200.yaml with Fail verdict — on disk only (file_path fallback path)
    const legacyPath = path.join(cycleDir, "SA-200.yaml");
    fs.writeFileSync(
      legacyPath,
      "id: SA-200\ntype: cycle_summary\ncycle: 200\ncontent: |-\n  ## Verdict: Fail\n\n  Two principle violations found.\n",
      "utf8"
    );
    insertNode("SA-200", "cycle_summary", { file_path: legacyPath, cycle_created: 200 });

    // Canonical spec-adherence.yaml with Pass verdict — on disk only (file_path fallback path)
    const canonicalPath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(
      canonicalPath,
      "id: spec-adherence-200\ntype: cycle_summary\ncycle: 200\ncontent: |-\n  **Principle Violation Verdict**: Pass\n\n  All reviewers returned Pass with zero significant findings.\n",
      "utf8"
    );
    insertNode("spec-adherence-200", "cycle_summary", { file_path: canonicalPath, cycle_created: 200 });

    // No findings for cycle 200 → condition_a: true
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 200 });
    expect(result).toContain("condition_b: true");
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("converged: true");
  });

  it("regression WI-797 (adapter path): canonical spec-adherence.yaml (Pass) wins over legacy SA-NNN.yaml (Fail) via LocalAdapter.getConvergenceData", async () => {
    // Mirrors the SQLite-fallback regression test above, but exercises the adapter path
    // (reader.ts:getConvergenceData) by attaching a LocalAdapter to ctx.
    const cycleDir = path.join(artifactDir, "cycles", "201");
    fs.mkdirSync(cycleDir, { recursive: true });

    // Legacy SA-201.yaml with Fail verdict — on disk only (file_path fallback path)
    const legacyPath = path.join(cycleDir, "SA-201.yaml");
    fs.writeFileSync(
      legacyPath,
      "id: SA-201\ntype: cycle_summary\ncycle: 201\ncontent: |-\n  ## Verdict: Fail\n\n  Two principle violations found.\n",
      "utf8"
    );
    insertNode("SA-201", "cycle_summary", { file_path: legacyPath, cycle_created: 201 });

    // Canonical spec-adherence.yaml with Pass verdict — on disk only (file_path fallback path)
    const canonicalPath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(
      canonicalPath,
      "id: spec-adherence-201\ntype: cycle_summary\ncycle: 201\ncontent: |-\n  **Principle Violation Verdict**: Pass\n\n  All reviewers returned Pass with zero significant findings.\n",
      "utf8"
    );
    insertNode("spec-adherence-201", "cycle_summary", { file_path: canonicalPath, cycle_created: 201 });

    // Attach LocalAdapter — routes handleGetConvergenceStatus through reader.ts:getConvergenceData
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });

    // No findings for cycle 201 → condition_a: true
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 201 });
    expect(result).toContain("condition_b: true");
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("converged: true");
  });

  it("regression WI-824 (strict canonical-only): legacy SA-NNN.yaml (Fail) with NO canonical file yields null cycle_summary_content — condition_b not falsely set", async () => {
    // Reproducer: a reused cycle slot has ONLY a legacy SA-NNN.yaml (from a prior
    // archive) and no canonical spec-adherence.yaml. Before fix option (c), the
    // legacy file was returned as a fallback, causing condition_b:false even when
    // the current cycle genuinely has no convergence data. After fix option (c),
    // canonical-only selection treats the absence of spec-adherence.yaml as null
    // (no data), so handleGetConvergenceStatus does not misread the legacy verdict.
    const cycleDir = path.join(artifactDir, "cycles", "202");
    fs.mkdirSync(cycleDir, { recursive: true });

    // Legacy SA-202.yaml with Fail verdict — on disk only (file_path fallback path)
    // No canonical spec-adherence.yaml exists in this cycle directory.
    const legacyPath = path.join(cycleDir, "SA-202.yaml");
    fs.writeFileSync(
      legacyPath,
      "id: SA-202\ntype: cycle_summary\ncycle: 202\ncontent: |-\n  ## Verdict: Fail\n\n  Stale artifact from a prior archive.\n",
      "utf8"
    );
    insertNode("SA-202", "cycle_summary", { file_path: legacyPath, cycle_created: 202 });

    // Attach LocalAdapter — routes handleGetConvergenceStatus through reader.ts:getConvergenceData
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });

    // With strict canonical-only, getConvergenceData returns cycle_summary_content: null.
    // condition_b is therefore "unknown" / not driven by the stale legacy file.
    const data = await ctx.adapter.getConvergenceData(202);
    expect(data.cycle_summary_content).toBeNull();
  });

  it("regression WI-824 (reindex-leak): legacy SA-NNN with da_content populated by reindex yields null — da_content alone is not a provenance guard", async () => {
    // Reproducer: after rebuildIndex/indexFiles processes a legacy SA-NNN.yaml that
    // has an embedded `cycle:` field, the indexer populates document_artifacts with
    // da.cycle = N and da_content from the file. The dbContentRow fallback (now
    // removed) would have matched this row, re-leaking the stale verdict. This test
    // asserts that even with a document_artifacts row present and da_content non-null
    // for a legacy-named node, canonical-only selection still returns null.
    const cycleDir = path.join(artifactDir, "cycles", "203");
    fs.mkdirSync(cycleDir, { recursive: true });

    // Legacy SA-203.yaml — simulates a file reindexed from a prior archive.
    const legacyPath = path.join(cycleDir, "SA-203.yaml");
    fs.writeFileSync(
      legacyPath,
      "id: SA-203\ntype: cycle_summary\ncycle: 203\ncontent: |-\n  ## Verdict: Fail\n\n  Stale from prior archive, reindexed.\n",
      "utf8"
    );
    insertNode("SA-203", "cycle_summary", { file_path: legacyPath, cycle_created: 203 });
    // Simulate what rebuildIndex does: populate document_artifacts with da.cycle + da_content
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("SA-203", 203, "## Verdict: Fail\n\n  Stale from prior archive, reindexed.\n");

    // No canonical spec-adherence.yaml exists — cycle_summary_content must be null.
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });
    const data = await ctx.adapter.getConvergenceData(203);
    expect(data.cycle_summary_content).toBeNull();
  });

  it("regression WI-831: legacy SA-NNN.yaml Fail + canonical passing files yields converged:true", async () => {
    // Reproducer: cycle dir contains SA-NNN.yaml (legacy, verdict:Fail) alongside
    // canonical code-quality.yaml, spec-adherence.yaml, and gap-analysis.yaml all
    // with Pass verdicts.
    //
    // Before fix option (c): the legacy SA-NNN.yaml could be picked up as a
    // cycle_summary, driving condition_b:false and converged:false even though
    // the current cycle's spec-adherence.yaml shows Pass.
    //
    // After fix option (c) (WI-824): strict canonical-only file selection ignores
    // SA-NNN.yaml entirely because its file_path does not end with /spec-adherence.yaml
    // or /summary.yaml. Only spec-adherence.yaml drives condition_b, which is true.
    const cycleDir = path.join(artifactDir, "cycles", "204");
    fs.mkdirSync(cycleDir, { recursive: true });

    // Legacy SA-204.yaml with Fail verdict — present in same directory as canonical files
    const legacyPath = path.join(cycleDir, "SA-204.yaml");
    fs.writeFileSync(
      legacyPath,
      "id: SA-204\ntype: cycle_summary\ncycle: 204\ncontent: |-\n  ## Verdict: Fail\n\n  Stale archive from a prior cycle slot.\n",
      "utf8"
    );
    insertNode("SA-204", "cycle_summary", { file_path: legacyPath, cycle_created: 204 });

    // Canonical code-quality.yaml with Pass (not a cycle_summary type, so not
    // selected by getConvergenceData — included here to mirror the exact WI-831
    // reproducer where all three canonical review files are present)
    const cqPath = path.join(cycleDir, "code-quality.yaml");
    fs.writeFileSync(
      cqPath,
      "id: code-quality-204\ntype: cycle_review\ncycle: 204\ncontent: |-\n  ## Verdict: Pass\n\n  No quality issues found.\n",
      "utf8"
    );
    insertNode("code-quality-204", "cycle_review", { file_path: cqPath, cycle_created: 204 });

    // Canonical spec-adherence.yaml with Pass verdict — this is the cycle_summary
    // that getConvergenceData must select; it drives condition_b
    const adherencePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(
      adherencePath,
      "id: spec-adherence-204\ntype: cycle_summary\ncycle: 204\ncontent: |-\n  **Principle Violation Verdict**: Pass\n\n  All reviewers returned Pass. Zero significant findings.\n",
      "utf8"
    );
    insertNode("spec-adherence-204", "cycle_summary", { file_path: adherencePath, cycle_created: 204 });

    // Canonical gap-analysis.yaml with Pass (not a cycle_summary type)
    const gaPath = path.join(cycleDir, "gap-analysis.yaml");
    fs.writeFileSync(
      gaPath,
      "id: gap-analysis-204\ntype: cycle_review\ncycle: 204\ncontent: |-\n  ## Verdict: Pass\n\n  No gaps found.\n",
      "utf8"
    );
    insertNode("gap-analysis-204", "cycle_review", { file_path: gaPath, cycle_created: 204 });

    // Attach LocalAdapter — routes through reader.ts:getConvergenceData
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });

    // No findings for cycle 204 → condition_a: true
    // spec-adherence-204 has Principle Violation Verdict: Pass → condition_b: true
    // SA-204.yaml (Fail) must be ignored — converged must be true
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 204 });
    expect(result).toContain("condition_b: true");
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("converged: true");
  });

  it("regression WI-836 (symmetric): legacy SA-NNN.yaml Pass + canonical spec-adherence.yaml Fail yields condition_b:false", async () => {
    // Symmetric case of WI-831: legacy file has Pass, canonical has Fail.
    // Canonical file must win — condition_b must be false.
    const cycleDir = path.join(artifactDir, "cycles", "205");
    fs.mkdirSync(cycleDir, { recursive: true });

    // Legacy SA-205.yaml with Pass verdict — must be ignored
    const legacyPath = path.join(cycleDir, "SA-205.yaml");
    fs.writeFileSync(
      legacyPath,
      "id: SA-205\ntype: cycle_summary\ncycle: 205\ncontent: |-\n  ## Verdict: Pass\n\n  Legacy archive with Pass verdict.\n",
      "utf8"
    );
    insertNode("SA-205", "cycle_summary", { file_path: legacyPath, cycle_created: 205 });

    // Canonical spec-adherence.yaml with Fail verdict — this must drive condition_b
    const adherencePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(
      adherencePath,
      "id: spec-adherence-205\ntype: cycle_summary\ncycle: 205\ncontent: |-\n  **Principle Violation Verdict**: Fail\n\n  Two principle violations found in current cycle.\n",
      "utf8"
    );
    insertNode("spec-adherence-205", "cycle_summary", { file_path: adherencePath, cycle_created: 205 });

    // Attach LocalAdapter
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });

    // condition_b must be false because canonical spec-adherence.yaml has Fail
    // SA-205.yaml (Pass) must be ignored
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 205 });
    expect(result).toContain("condition_b: false");
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("converged: false");
  });

  // ---------------------------------------------------------------------------
  // WI-876: parsePrincipleVerdict hardening — additional pattern coverage
  // ---------------------------------------------------------------------------

  it("WI-876: missing cycle_summary warning includes cycle dir path and checked filenames", async () => {
    // Cycle 998 has no cycle_summary rows — warning must name the directory searched
    // and the canonical filenames checked.
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 998 });

    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).toContain("condition_b: false");
    expect(result).toContain("converged: false");
    // Warning must include directory path
    const warningLine = result.split("\n").find((l) => l.startsWith("principle_verdict_warning:"));
    expect(warningLine).toBeDefined();
    expect(warningLine).toContain("cycles");
    expect(warningLine).toContain("998");
    // Warning must include the checked filenames
    expect(warningLine).toContain("spec-adherence.yaml");
    expect(warningLine).toContain("summary.yaml");
  });

  it("WI-876: malformed cycle_summary warning includes content snippet", async () => {
    // Insert a cycle_summary with content that doesn't match any accepted verdict pattern.
    const cycleDir = path.join(artifactDir, "cycles", "300");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-300\ntype: cycle_summary\ncycle: 300\n", "utf8");
    insertNode("spec-adherence-300", "cycle_summary", { file_path: filePath, cycle_created: 300 });
    const malformedContent = "Verdict: unclear — reviewer did not follow template";
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-300", 300, malformedContent);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 300 });

    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).toContain("condition_b: false");
    // Warning must include a snippet of the actual content
    const warningLine = result.split("\n").find((l) => l.startsWith("principle_verdict_warning:"));
    expect(warningLine).toBeDefined();
    expect(warningLine).toContain("unexpected format");
    expect(warningLine).toContain("content snippet");
    // The snippet must contain some of the actual content
    expect(warningLine).toContain("Verdict: unclear");
  });

  it("WI-876: parsePrincipleVerdict accepts **Principle Adherence Verdict**: Pass (colon outside bold)", async () => {
    // Pattern 1: **Principle Adherence Verdict**: Pass
    const cycleDir = path.join(artifactDir, "cycles", "301");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-301\ntype: cycle_summary\ncycle: 301\n", "utf8");
    insertNode("spec-adherence-301", "cycle_summary", { file_path: filePath, cycle_created: 301 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-301", 301, "**Principle Adherence Verdict**: Pass\n\nAll good.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 301 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  it("WI-876: parsePrincipleVerdict accepts **Principle Adherence Verdict:** Pass (colon inside bold)", async () => {
    // Pattern 2: **Principle Adherence Verdict:** Pass
    const cycleDir = path.join(artifactDir, "cycles", "302");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-302\ntype: cycle_summary\ncycle: 302\n", "utf8");
    insertNode("spec-adherence-302", "cycle_summary", { file_path: filePath, cycle_created: 302 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-302", 302, "**Principle Adherence Verdict:** Pass\n\nAll good.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 302 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  it("WI-876: parsePrincipleVerdict accepts Principle Adherence Verdict: Pass (no bold)", async () => {
    // Pattern 3: Principle Adherence Verdict: Pass (no bold markers)
    const cycleDir = path.join(artifactDir, "cycles", "303");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-303\ntype: cycle_summary\ncycle: 303\n", "utf8");
    insertNode("spec-adherence-303", "cycle_summary", { file_path: filePath, cycle_created: 303 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-303", 303, "Principle Adherence Verdict: Pass\n\nAll good.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 303 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  it("WI-876: parsePrincipleVerdict accepts **Principle Adherence Verdict**: Fail (colon outside bold, Fail)", async () => {
    // Pattern 1 variant: Fail verdict
    const cycleDir = path.join(artifactDir, "cycles", "304");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-304\ntype: cycle_summary\ncycle: 304\n", "utf8");
    insertNode("spec-adherence-304", "cycle_summary", { file_path: filePath, cycle_created: 304 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-304", 304, "**Principle Adherence Verdict**: Fail\n\nViolation found.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 304 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: false");
  });

  it("WI-876: parsePrincipleVerdict accepts case-insensitive verdict keywords (pass, PASS, Pass)", async () => {
    // Case-insensitive: "PASS" and "pass" should both match
    const cycleDir = path.join(artifactDir, "cycles", "305");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-305\ntype: cycle_summary\ncycle: 305\n", "utf8");
    insertNode("spec-adherence-305", "cycle_summary", { file_path: filePath, cycle_created: 305 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-305", 305, "**Principle Adherence Verdict**: PASS\n\nAll good.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 305 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  it("WI-876 rejected variant: no verdict keyword at all → unknown", async () => {
    // A line that has "Principle Adherence Verdict" but no Pass/Fail keyword
    const cycleDir = path.join(artifactDir, "cycles", "306");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-306\ntype: cycle_summary\ncycle: 306\n", "utf8");
    insertNode("spec-adherence-306", "cycle_summary", { file_path: filePath, cycle_created: 306 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-306", 306, "**Principle Adherence Verdict**: Conditional\n\nSome conditions apply.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 306 });
    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).toContain("condition_b: false");
    // Should include a content snippet in the warning
    const warningLine = result.split("\n").find((l) => l.startsWith("principle_verdict_warning:"));
    expect(warningLine).toBeDefined();
    expect(warningLine).toContain("content snippet");
  });

  it("WI-876 rejected variant: completely unrecognized format → unknown with snippet", async () => {
    // Content that has no recognizable verdict pattern at all
    const cycleDir = path.join(artifactDir, "cycles", "307");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-307\ntype: cycle_summary\ncycle: 307\n", "utf8");
    insertNode("spec-adherence-307", "cycle_summary", { file_path: filePath, cycle_created: 307 });
    const unrecognized = "This is just free-form text without any verdict structure at all.";
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-307", 307, unrecognized);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 307 });
    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    const warningLine = result.split("\n").find((l) => l.startsWith("principle_verdict_warning:"));
    expect(warningLine).toBeDefined();
    expect(warningLine).toContain("unexpected format");
    expect(warningLine).toContain("content snippet");
    expect(warningLine).toContain("free-form text");
  });

  // WI-878: S1 word-boundary tests — "Passed"/"Failed" must NOT match Pass/Fail
  it("WI-878 S1: Verdict: Passed → unknown (word boundary prevents match)", async () => {
    const cycleDir = path.join(artifactDir, "cycles", "310");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-310\ntype: cycle_summary\ncycle: 310\n", "utf8");
    insertNode("spec-adherence-310", "cycle_summary", { file_path: filePath, cycle_created: 310 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-310", 310, "**Principle Adherence Verdict**: Passed\n\nSee details.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 310 });
    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).toContain("condition_b: false");
  });

  it("WI-878 S1: Verdict: Failed → unknown (word boundary prevents match)", async () => {
    const cycleDir = path.join(artifactDir, "cycles", "311");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-311\ntype: cycle_summary\ncycle: 311\n", "utf8");
    insertNode("spec-adherence-311", "cycle_summary", { file_path: filePath, cycle_created: 311 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-311", 311, "**Principle Adherence Verdict**: Failed\n\nSee details.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 311 });
    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).toContain("condition_b: false");
  });

  it("WI-878 S1: Verdict: Pass → pass (exact word boundary match)", async () => {
    const cycleDir = path.join(artifactDir, "cycles", "312");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-312\ntype: cycle_summary\ncycle: 312\n", "utf8");
    insertNode("spec-adherence-312", "cycle_summary", { file_path: filePath, cycle_created: 312 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-312", 312, "**Principle Adherence Verdict**: Pass\n\nAll clear.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 312 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  // WI-878: S2 step-2 section-body heuristic tests
  it("WI-878 S2: ## Principle Adherence heading with Pass verdict in section body → pass (step2)", async () => {
    // Step 2 heuristic: heading recognized, body is 'None.' → pass
    const cycleDir = path.join(artifactDir, "cycles", "313");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-313\ntype: cycle_summary\ncycle: 313\n", "utf8");
    insertNode("spec-adherence-313", "cycle_summary", { file_path: filePath, cycle_created: 313 });
    // Content uses ## Principle Adherence heading followed by "None." body
    const content = "# Summary\n\nSome intro.\n\n## Principle Adherence\n\nNone.\n\n## Other Section\n\nstuff";
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-313", 313, content);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 313 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step2");
    expect(result).toContain("condition_b: true");
  });

  it("WI-878 S2: ## Principle Adherence section with verdict line beyond window → falls through to step3 (unknown)", async () => {
    // Step 2 heuristic: heading recognized, but verdict content is beyond STEP2_WINDOW_LINES
    // non-empty lines, so step 2 should fall through to step 3 → unknown.
    const cycleDir = path.join(artifactDir, "cycles", "314");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-314\ntype: cycle_summary\ncycle: 314\n", "utf8");
    insertNode("spec-adherence-314", "cycle_summary", { file_path: filePath, cycle_created: 314 });
    // 21 non-empty lines in the section body before any verdict signal — exceeds window of 20
    const bodyLines = Array.from({ length: 21 }, (_, i) => `line ${i + 1} content here`).join("\n");
    const content = `# Summary\n\n## Principle Adherence\n\n${bodyLines}\n\nNone.\n`;
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-314", 314, content);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 314 });
    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).toContain("condition_b: false");
  });

  // WI-878: S2 YAML validity — warning field must be parseable YAML
  it("WI-878 S2: principle_verdict_warning YAML is parseable by yaml.parse", async () => {
    // A malformed (step3) summary with content that triggers YAML single-quote emission.
    // The warning might contain single quotes (e.g. from content or pattern descriptions).
    const yaml = await import("yaml");
    const cycleDir = path.join(artifactDir, "cycles", "315");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-315\ntype: cycle_summary\ncycle: 315\n", "utf8");
    insertNode("spec-adherence-315", "cycle_summary", { file_path: filePath, cycle_created: 315 });
    // Content includes a single quote to stress-test YAML escaping
    const content = "Verdict: it's unclear what happened here; no structured verdict found.";
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-315", 315, content);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 315 });
    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");

    // The full result should be parseable as YAML
    const parsed = yaml.parse(result) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(typeof parsed["principle_verdict_warning"]).toBe("string");
    // The parsed warning should contain the original content (with ' restored from '')
    expect(parsed["principle_verdict_warning"] as string).toContain("it's unclear");
  });

  // WI-879 C1: multiline content in snippet must not break YAML single-quoted scalar
  it("WI-879 C1: multiline content produces parseable YAML", async () => {
    const yaml = await import("yaml");
    const cycleDir = path.join(artifactDir, "cycles", "316");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-316\ntype: cycle_summary\ncycle: 316\n", "utf8");
    insertNode("spec-adherence-316", "cycle_summary", { file_path: filePath, cycle_created: 316 });
    // "Passed" hits the \b rejection in step1 → falls through to step3 with embedded newlines
    const content = "**Principle Adherence Verdict**: Passed\n\nSome trailing explanation.\n";
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-316", 316, content);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 316 });

    // Must be parseable as YAML (newlines in snippet would break single-quoted scalar without fix)
    const parsed = yaml.parse(result) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(typeof parsed["principle_verdict_warning"]).toBe("string");
    // Newlines collapsed to spaces — both fragments must appear in the warning
    const warning = parsed["principle_verdict_warning"] as string;
    expect(warning).toContain("Passed");
    expect(warning).toContain("Some trailing");
  });

  // WI-878: S3 P-33 — missing-summary warning must not contain absolute paths
  it("WI-878 S3: missing cycle_summary warning contains no absolute .ideate/ path (P-33)", async () => {
    const PATH_LEAK_RE = /\/[\w/.-]*\.ideate\//;
    // Cycle 997 has no data — triggers missing-summary code path
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 997 });
    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).not.toMatch(PATH_LEAK_RE);
    // Should not contain any absolute path (starts with /)
    const warningLine = result.split("\n").find((l) => l.startsWith("principle_verdict_warning:"));
    expect(warningLine).toBeDefined();
    // No absolute path component: no substring starting with / followed by word chars (filesystem root)
    expect(warningLine).not.toMatch(/\/Users\/|\/home\/|\/tmp\/|\/var\//);
  });

  // WI-878: S5 retroactive — cycles 27..35 principle_verdict stays pass
  // Note: cycles 27-35 are live production cycles. This test exercises the adapter
  // with whatever data exists in the test DB (which starts empty). Since no fixture
  // data exists for real cycles 27-35 in this unit test context, all will return
  // "unknown" (no cycle_summary found). This is expected and documented here.
  // The assertion is that the warning does NOT contain absolute paths (P-33),
  // not that the verdict is "pass" (which would require fixture data).
  it("WI-878 S5: cycles 27..35 — principle_verdict_warning contains no absolute paths", async () => {
    const PATH_LEAK_RE = /\/[\w/.-]*\.ideate\//;
    for (let cycle = 27; cycle <= 35; cycle++) {
      const result = await handleGetConvergenceStatus(ctx, { cycle_number: cycle });
      // principle_verdict is unknown (no fixture data) — that is expected and documented
      const verdict = result.split("\n").find((l) => l.startsWith("principle_verdict:"))?.split(": ")[1]?.trim();
      // All should be either pass (if data exists) or unknown (if not) — never a path leak
      expect(["pass", "unknown", "fail"]).toContain(verdict);
      // P-33: no absolute path in the response
      expect(result).not.toMatch(PATH_LEAK_RE);
    }
  });

  // WI-879 S1: S5 retroactive fixture test — cycle 998 seeded with "Pass" verdict must return pass
  // Closes F-CYCLE-37-S1 by demonstrating retroactive verdict preservation for cycles
  // that use "Pass" (the actual shape of cycles 27-35).
  it("WI-879 S1: cycle seeded with 'Pass' verdict returns principle_verdict: pass", async () => {
    const cycleDir = path.join(artifactDir, "cycles", "998");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-998\ntype: cycle_summary\ncycle: 998\n", "utf8");
    insertNode("spec-adherence-998", "cycle_summary", { file_path: filePath, cycle_created: 998 });
    // Matches shape of real cycles 27-35: "Pass" (not "Passed") with trailing explanation
    const content =
      "## Summary\n\n## Principle Adherence\n\n**Principle Adherence Verdict**: Pass\n\nGP-14 upheld.";
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-998", 998, content);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 998 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  // WI-879 M3: Step 2 Fail branch — section body with bullet triggers fail via step2
  it("WI-879 M3: ## Principle Adherence section with bullet body → fail (step2)", async () => {
    const cycleDir = path.join(artifactDir, "cycles", "999");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-999\ntype: cycle_summary\ncycle: 999\n", "utf8");
    insertNode("spec-adherence-999", "cycle_summary", { file_path: filePath, cycle_created: 999 });
    const content =
      "## Summary\n\n## Principle Adherence\n\n### GP-14 Violation\n\n- Executor bypassed MCP.\n";
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-999", 999, content);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 999 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step2");
  });

  // ---------------------------------------------------------------------------
  // WI-881: Fail-side pattern 2 and 3 coverage + all-bold pattern coverage
  // Addresses cycle 28 findings S2 (Fail-side pattern gap) and closes WI-880 deferred S1
  // ---------------------------------------------------------------------------

  it("WI-881 S2: parsePrincipleVerdict pattern 2 Fail — **Principle Adherence Verdict:** Fail (colon inside bold)", async () => {
    // Pattern 2 (STEP1_FAIL_RES index 1): colon inside bold closing tag
    // Regex: /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict:\*\*\s*Fail\b/i
    const cycleDir = path.join(artifactDir, "cycles", "320");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-320\ntype: cycle_summary\ncycle: 320\n", "utf8");
    insertNode("spec-adherence-320", "cycle_summary", { file_path: filePath, cycle_created: 320 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-320", 320, "**Principle Adherence Verdict:** Fail\n\nViolation found.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 320 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: false");
  });

  it("WI-881 S2: parsePrincipleVerdict pattern 3 Fail — Principle Adherence Verdict: Fail (no bold)", async () => {
    // Pattern 3 (STEP1_FAIL_RES index 2): no bold markers at all
    // Regex: /(?<!\*)Principle\s+(?:Adherence|Violation)\s+Verdict:\s*Fail\b(?!\*)/i
    const cycleDir = path.join(artifactDir, "cycles", "321");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-321\ntype: cycle_summary\ncycle: 321\n", "utf8");
    insertNode("spec-adherence-321", "cycle_summary", { file_path: filePath, cycle_created: 321 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-321", 321, "Principle Adherence Verdict: Fail\n\nViolation found.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 321 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: false");
  });

  it("WI-881 WI-880 all-bold Pass: **Principle Adherence Verdict: Pass** (verdict keyword inside bold)", async () => {
    // All-bold pattern (STEP1_PASS_RES index 3, added in WI-880):
    // Regex: /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict:\s*Pass\b\*\*/i
    // Matches cycle 003 shape where label + colon + verdict are all inside one bold span.
    const cycleDir = path.join(artifactDir, "cycles", "322");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-322\ntype: cycle_summary\ncycle: 322\n", "utf8");
    insertNode("spec-adherence-322", "cycle_summary", { file_path: filePath, cycle_created: 322 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-322", 322, "**Principle Adherence Verdict: Pass**\n\nGP-14 upheld.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 322 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  it("WI-881 WI-880 all-bold Fail: **Principle Adherence Verdict: Fail** (verdict keyword inside bold)", async () => {
    // All-bold pattern (STEP1_FAIL_RES index 3, added in WI-880):
    // Regex: /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict:\s*Fail\b\*\*/i
    const cycleDir = path.join(artifactDir, "cycles", "323");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-323\ntype: cycle_summary\ncycle: 323\n", "utf8");
    insertNode("spec-adherence-323", "cycle_summary", { file_path: filePath, cycle_created: 323 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-323", 323, "**Principle Adherence Verdict: Fail**\n\nGP-14 violated.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 323 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: false");
  });

  // WI-883 S1 multiline regression test a: ### subheading on later line triggers step2 fail
  it("WI-883 S1a: ## Principle Adherence body with prose on line 1 and '### P-14 violated' on later line → fail (step2)", async () => {
    // Reproducer for the /m flag bug: body starts with a prose sentence, then a ### heading
    // on a subsequent line. Without /m, ^###\s would not match because ^ only anchors to
    // string start, not line start. With /m added, ^ matches any line start.
    const cycleDir = path.join(artifactDir, "cycles", "330");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-330\ntype: cycle_summary\ncycle: 330\n", "utf8");
    insertNode("spec-adherence-330", "cycle_summary", { file_path: filePath, cycle_created: 330 });
    // Prose on line 1 of section body, ### subheading on line 3 — requires /m to detect
    const content =
      "## Principle Adherence\n\n" +
      "The following principles were evaluated during this review.\n\n" +
      "### P-14 violated\n\n" +
      "Executor bypassed MCP write path.\n";
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-330", 330, content);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 330 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step2");
    expect(result).toContain("condition_b: false");
  });

  // WI-883 S1 multiline regression test b: bullet on later line triggers step2 fail
  it("WI-883 S1b: ## Principle Adherence body with prose on line 1 and '- Item A' on later line → fail (step2)", async () => {
    // Reproducer for the /m flag bug: body starts with a prose sentence, then a bullet
    // on a subsequent line. Without /m, ^\s*-\s would not match because ^ only anchors
    // to string start. With /m added, ^ matches any line start.
    const cycleDir = path.join(artifactDir, "cycles", "331");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-331\ntype: cycle_summary\ncycle: 331\n", "utf8");
    insertNode("spec-adherence-331", "cycle_summary", { file_path: filePath, cycle_created: 331 });
    // Prose on line 1 of section body, bullet item on line 3 — requires /m to detect
    const content =
      "## Principle Adherence\n\n" +
      "The following violations were identified:\n\n" +
      "- Item A: executor wrote files directly without MCP.\n";
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-331", 331, content);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 331 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step2");
    expect(result).toContain("condition_b: false");
  });

  // WI-883 S5 Violation all-bold Pass test — mirrors Adherence all-bold test at cycle 322
  it("WI-883 S5 all-bold Pass: **Principle Violation Verdict: Pass** → verdict: pass (step1)", async () => {
    // All-bold pattern: /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict:\s*Pass\b\*\*/i
    // Tests the Violation variant of the all-bold pass pattern (Adherence covered by cycle 322).
    const cycleDir = path.join(artifactDir, "cycles", "332");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-332\ntype: cycle_summary\ncycle: 332\n", "utf8");
    insertNode("spec-adherence-332", "cycle_summary", { file_path: filePath, cycle_created: 332 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-332", 332, "**Principle Violation Verdict: Pass**\n\nGP-14 upheld.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 332 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  // WI-883 S5 Violation all-bold Fail test — mirrors Adherence all-bold test at cycle 323
  it("WI-883 S5 all-bold Fail: **Principle Violation Verdict: Fail** → verdict: fail (step1)", async () => {
    // All-bold pattern: /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict:\s*Fail\b\*\*/i
    // Tests the Violation variant of the all-bold fail pattern (Adherence covered by cycle 323).
    const cycleDir = path.join(artifactDir, "cycles", "333");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-333\ntype: cycle_summary\ncycle: 333\n", "utf8");
    insertNode("spec-adherence-333", "cycle_summary", { file_path: filePath, cycle_created: 333 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-333", 333, "**Principle Violation Verdict: Fail**\n\nGP-14 violated.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 333 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: false");
  });

  // WI-889 bare synonym tests — "Principle Verdict:" (no Adherence/Violation qualifier)
  it("WI-889 bare synonym Pass: 'Principle Verdict: Pass' → verdict: pass (step1)", async () => {
    // Bare pattern: /(?<!\*)Principle\s+Verdict:\s*Pass\b(?!\*)/i
    // Tests the bare synonym form emitted by spec-reviewer skill and some agent prompts.
    const cycleDir = path.join(artifactDir, "cycles", "334");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-334\ntype: cycle_summary\ncycle: 334\n", "utf8");
    insertNode("spec-adherence-334", "cycle_summary", { file_path: filePath, cycle_created: 334 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-334", 334, "Principle Verdict: Pass\n\nGP-14 upheld.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 334 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  it("WI-889 bare synonym Fail: 'Principle Verdict: Fail' → verdict: fail (step1)", async () => {
    // Bare pattern: /(?<!\*)Principle\s+Verdict:\s*Fail\b(?!\*)/i
    // Tests the bare synonym fail form.
    const cycleDir = path.join(artifactDir, "cycles", "335");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-335\ntype: cycle_summary\ncycle: 335\n", "utf8");
    insertNode("spec-adherence-335", "cycle_summary", { file_path: filePath, cycle_created: 335 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-335", 335, "Principle Verdict: Fail\n\nGP-14 violated.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 335 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: false");
  });

  it("WI-889 bare synonym all-bold Pass: '**Principle Verdict: Pass**' → verdict: pass (step1)", async () => {
    // All-bold bare pattern: /\*\*Principle\s+Verdict:\s*Pass\b\*\*/i
    // Tests the all-bold variant of the bare synonym pass form.
    const cycleDir = path.join(artifactDir, "cycles", "336");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-336\ntype: cycle_summary\ncycle: 336\n", "utf8");
    insertNode("spec-adherence-336", "cycle_summary", { file_path: filePath, cycle_created: 336 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-336", 336, "**Principle Verdict: Pass**\n\nGP-14 upheld.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 336 });
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
  });

  it("WI-889 bare synonym all-bold Fail: '**Principle Verdict: Fail**' → verdict: fail (step1)", async () => {
    // All-bold bare pattern: /\*\*Principle\s+Verdict:\s*Fail\b\*\*/i
    // Tests the all-bold variant of the bare synonym fail form.
    const cycleDir = path.join(artifactDir, "cycles", "337");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-337\ntype: cycle_summary\ncycle: 337\n", "utf8");
    insertNode("spec-adherence-337", "cycle_summary", { file_path: filePath, cycle_created: 337 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-337", 337, "**Principle Verdict: Fail**\n\nGP-14 violated.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 337 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: false");
  });

  it("WI-881 EC5: P-33 realistic fixture via handleWriteArtifact write path — warning must not leak absolute paths", async () => {
    // Criterion 4: seed content through the real write path (handleWriteArtifact with
    // type: cycle_summary) so content flows through actual file I/O, not a hand-assembled
    // synthetic string. The content includes a file path reference (realistic spec-adherence
    // content that references source files) to test that any absolute path in the warning
    // window is sanitized. After writing, handleGetConvergenceStatus is called on cycle 324.
    // Addresses cycle 28 finding EC5 (P-33 snippet test used synthetic content).
    const PATH_LEAK_RE = /\/[\w/.-]*\.ideate\//;
    // Content that mimics a real spec-adherence artifact: has an absolute source file path
    // in the body (so PATH_LEAK_RE fires on the raw content) but does NOT have a recognized
    // verdict tag — exercises the step-3 warning path and verifies snippet sanitization.
    const realisticContent =
      "## Summary\n\nSpec adherence review for cycle 324.\n\n" +
      "## Principle Adherence\n\n" +
      "Reviewed mcp/artifact-server/src/tools/analysis.ts and /workspace/.ideate/cycles/028/spec-adherence.yaml.\n" +
      "No structured verdict tag present — manual review required.\n";
    // Meta-assertion: the raw content MUST match PATH_LEAK_RE to prove the regex would fire
    // if an absolute path leaked through. If this fails the fixture is broken (not the code).
    expect(realisticContent).toMatch(PATH_LEAK_RE);
    await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: "spec-adherence",
      cycle: 324,
      content: {
        title: "Spec adherence — cycle 324 P-33 realistic fixture",
        content: realisticContent,
      },
    });

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 324 });
    // No absolute .ideate/ path may appear in the response (P-33)
    expect(result).not.toMatch(PATH_LEAK_RE);
    // Warning line specifically must also be clean
    const warningLine = result.split("\n").find((l) => l.startsWith("principle_verdict_warning:"));
    if (warningLine !== undefined) {
      expect(warningLine).not.toMatch(PATH_LEAK_RE);
    }
    // P-91: assert the parser provenance field is present so regressions in
    // which step matched are caught. This fixture intentionally lacks a
    // recognized verdict tag, so parsing must fall through to step3 (warning).
    expect(result).toContain("principle_verdict_source: step3");
  });
});

// ---------------------------------------------------------------------------
// 7. handleGetDomainState
// ---------------------------------------------------------------------------

describe("handleGetDomainState", () => {
  it("happy path: returns domain with policies and open questions", async () => {
    insertDomainPolicy("DP-001", "workflow", "Write files before DB");
    insertDomainQuestion("DQ-001", "workflow", "Should we use YAML?");

    const result = await handleGetDomainState(ctx, {});
    expect(result).toContain("## workflow");
    expect(result).toContain("DP-001");
    expect(result).toContain("DQ-001");
  });

  it("happy path: domains filter restricts output", async () => {
    insertDomainPolicy("DP-001", "workflow", "Workflow policy");
    insertDomainPolicy("DP-002", "infra", "Infra policy");

    const result = await handleGetDomainState(ctx, {
      domains: ["workflow"],
    });
    expect(result).toContain("workflow");
    expect(result).not.toContain("infra");
  });

  it("error path: empty DB returns 'No domain data found'", async () => {
    const result = await handleGetDomainState(ctx, {});
    expect(result).toContain("No domain data found");
  });

  it("excludes deprecated and superseded policies from output", async () => {
    // Active policy — should appear
    insertDomainPolicy("P-active-01", "workflow", "Active policy stays", "active");
    // Deprecated policy — should be excluded
    insertDomainPolicy("P-depr-01", "workflow", "Deprecated policy is hidden", "deprecated");
    // Superseded policy — should be excluded
    insertDomainPolicy("P-supr-01", "workflow", "Superseded policy is hidden", "superseded");

    const result = await handleGetDomainState(ctx, {});
    expect(result).toContain("P-active-01");
    expect(result).not.toContain("P-depr-01");
    expect(result).not.toContain("P-supr-01");
  });
});

// ---------------------------------------------------------------------------
// 8. handleGetWorkspaceStatus
// ---------------------------------------------------------------------------

describe("handleGetWorkspaceStatus", () => {
  it("happy path: returns dashboard with work item counts and open questions", async () => {
    insertNode("WI-001", "work_item", { status: "done" });
    insertWorkItem("WI-001", "Done item");
    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Pending item");
    insertDomainQuestion("DQ-001", "workflow", "Open question");

    const result = await handleGetWorkspaceStatus(ctx, {});
    expect(result).toContain("Workspace Status Dashboard");
    expect(result).toContain("Total: 2");
    expect(result).toContain("Done: 1");
  });

  it("happy path: shows current cycle from domains/index.md", async () => {
    const result = await handleGetWorkspaceStatus(ctx, {});
    expect(result).toContain("Current cycle");
    expect(result).toContain("3");
  });

  it("error path: empty DB returns zeroed work items section", async () => {
    const result = await handleGetWorkspaceStatus(ctx, {});
    expect(result).toContain("Total: 0");
  });

  it("shows correct finding counts from findings table", async () => {
    // Insert 2 critical, 1 significant, 3 minor findings for cycle 3
    for (let i = 1; i <= 2; i++) {
      db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES (?, 'finding', 3, 'hash', '/tmp/f.yaml', 'active')`).run(`F-003-00${i}`);
      db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES (?, 'critical', 'WI-001', 'fail', 3, 'code-reviewer')`).run(`F-003-00${i}`);
    }
    db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('F-003-003', 'finding', 3, 'hash', '/tmp/f.yaml', 'open')`).run();
    db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('F-003-003', 'significant', 'WI-001', 'fail', 3, 'code-reviewer')`).run();
    for (let i = 4; i <= 6; i++) {
      db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES (?, 'finding', 3, 'hash', '/tmp/f.yaml', 'active')`).run(`F-003-00${i}`);
      db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES (?, 'minor', 'WI-001', 'pass', 3, 'code-reviewer')`).run(`F-003-00${i}`);
    }

    const result = await handleGetWorkspaceStatus(ctx, {});

    expect(result).toContain("Critical: 2");
    expect(result).toContain("Significant: 1");
    expect(result).toContain("Minor: 3");
  });

  it("shows Active Project and Current Phase sections when both are active", async () => {
    // Insert active project
    insertNode("PROJ-001", "project", { status: "active" });
    db.prepare(`
      INSERT INTO projects (id, intent, scope_boundary, success_criteria, appetite, steering, horizon, status)
      VALUES (?, ?, NULL, NULL, 6, NULL, NULL, 'active')
    `).run("PROJ-001", "Build a great product");

    // Insert active phase (project must exist in nodes for FK)
    insertNode("PH-001", "phase", { status: "active" });
    db.prepare(`
      INSERT INTO phases (id, project, phase_type, intent, steering, status, work_items)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL)
    `).run("PH-001", "PROJ-001", "execution", "Deliver core features");

    const result = await handleGetWorkspaceStatus(ctx, {});

    expect(result).toContain("## Active Project");
    expect(result).toContain("PROJ-001");
    expect(result).toContain("Build a great product");
    expect(result).toContain("Appetite: 6");

    expect(result).toContain("## Current Phase");
    expect(result).toContain("PH-001");
    expect(result).toContain("execution");
    expect(result).toContain("Deliver core features");
  });

  it("omits Active Project and Current Phase sections when neither exists", async () => {
    // No project or phase rows inserted
    const result = await handleGetWorkspaceStatus(ctx, {});

    expect(result).not.toContain("## Active Project");
    expect(result).not.toContain("## Current Phase");
  });

  it("view=workspace returns same format as default (backward compatible)", async () => {
    insertNode("WI-V01", "work_item", { status: "done" });
    insertWorkItem("WI-V01", "View test item");

    const defaultResult = await handleGetWorkspaceStatus(ctx, {});
    const workspaceResult = await handleGetWorkspaceStatus(ctx, { view: "workspace" });
    expect(workspaceResult).toBe(defaultResult);
  });

  it("view=project returns project view with phase progress", async () => {
    // Insert active project
    insertNode("PR-001", "project", { status: "active" });
    ctx.db!.prepare(`
      INSERT INTO projects (id, name, intent, appetite, status)
      VALUES (?, ?, ?, ?, ?)
    `).run("PR-001", "Test Project", "Build something", 6, "active");

    // Insert active phase
    insertNode("PH-001", "phase", { status: "active" });
    ctx.db!.prepare(`
      INSERT INTO phases (id, name, phase_type, project, intent, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("PH-001", "Phase One", "implementation", "PR-001", "Do work", "active");

    // Insert work items in phase
    insertNode("WI-P01", "work_item", { status: "done" });
    insertWorkItem("WI-P01", "Done item");
    ctx.db!.prepare(`UPDATE work_items SET phase = ? WHERE id = ?`).run("PH-001", "WI-P01");
    insertNode("WI-P02", "work_item", { status: "pending" });
    insertWorkItem("WI-P02", "Pending item");
    ctx.db!.prepare(`UPDATE work_items SET phase = ? WHERE id = ?`).run("PH-001", "WI-P02");

    const result = await handleGetWorkspaceStatus(ctx, { view: "project" });
    expect(result).toContain("# Project View");
    expect(result).toContain("PR-001");
    expect(result).toContain("Test Project");
    expect(result).toContain("Build something");
    expect(result).toContain("Phase One");
    expect(result).toContain("1/2 work items done");
  });

  it("view=project with no active project returns message", async () => {
    const result = await handleGetWorkspaceStatus(ctx, { view: "project" });
    expect(result).toContain("No active project");
  });

  it("view=phase returns phase view with work items table", async () => {
    // Insert active phase
    insertNode("PH-001", "phase", { status: "active" });
    ctx.db!.prepare(`
      INSERT INTO phases (id, name, phase_type, project, intent, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("PH-001", "Phase One", "implementation", "PR-001", "Do work", "active");

    // Insert work items. Per D-131, the adapter excludes done/obsolete from
    // queryNodes("work_item"), so seed both as non-terminal statuses.
    insertNode("WI-T01", "work_item", { status: "in_progress" });
    insertWorkItem("WI-T01", "Table test in progress", { complexity: "small" });
    ctx.db!.prepare(`UPDATE work_items SET phase = ?, work_item_type = ? WHERE id = ?`).run("PH-001", "feature", "WI-T01");
    insertNode("WI-T02", "work_item", { status: "pending" });
    insertWorkItem("WI-T02", "Table test pending", { complexity: "medium" });
    ctx.db!.prepare(`UPDATE work_items SET phase = ?, work_item_type = ? WHERE id = ?`).run("PH-001", "bug", "WI-T02");

    const result = await handleGetWorkspaceStatus(ctx, { view: "phase" });
    expect(result).toContain("# Phase View");
    expect(result).toContain("Phase One");
    expect(result).toContain("implementation");
    expect(result).toContain("WI-T01");
    expect(result).toContain("WI-T02");
    expect(result).toContain("| ID |");
  });

  it("view=phase with no active phase returns message", async () => {
    const result = await handleGetWorkspaceStatus(ctx, { view: "phase" });
    expect(result).toContain("No active phase");
  });

  it("view=project shows horizon phase names from JSON column", async () => {
    // Insert active project with horizon
    insertNode("PR-002", "project", { status: "active" });
    ctx.db!.prepare(`
      INSERT INTO projects (id, name, intent, appetite, status, horizon)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("PR-002", "Horizon Test", "Test horizon", 6, "active", JSON.stringify({ next: ["PH-H01"], later: [] }));

    // Insert the horizon phase so name lookup works
    insertNode("PH-H01", "phase", { status: "pending" });
    ctx.db!.prepare(`
      INSERT INTO phases (id, name, phase_type, project, intent, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("PH-H01", "Next Phase", "design", "PR-002", "Design work", "pending");

    const result = await handleGetWorkspaceStatus(ctx, { view: "project" });
    expect(result).toContain("## Horizon");
    expect(result).toContain("PH-H01");
    expect(result).toContain("Next Phase");
  });

  it("view=project shows 'No phases planned' when horizon is null", async () => {
    insertNode("PR-003", "project", { status: "active" });
    ctx.db!.prepare(`
      INSERT INTO projects (id, name, intent, appetite, status)
      VALUES (?, ?, ?, ?, ?)
    `).run("PR-003", "No Horizon", "Test null horizon", 6, "active");

    const result = await handleGetWorkspaceStatus(ctx, { view: "project" });
    expect(result).toContain("## Horizon");
    expect(result).toContain("No phases planned");
  });

  it("view=phase shows status field", async () => {
    insertNode("PH-002", "phase", { status: "active" });
    ctx.db!.prepare(`
      INSERT INTO phases (id, name, phase_type, project, intent, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("PH-002", "Status Test", "implementation", "PR-001", "Test", "active");

    const result = await handleGetWorkspaceStatus(ctx, { view: "phase" });
    expect(result).toContain("**Status**: active");
  });

  it("view=phase shows dependency edges between phase items", async () => {
    insertNode("PH-003", "phase", { status: "active" });
    ctx.db!.prepare(`
      INSERT INTO phases (id, name, phase_type, project, intent, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("PH-003", "Dep Test", "implementation", "PR-001", "Test", "active");

    insertNode("WI-D01", "work_item", { status: "pending" });
    insertWorkItem("WI-D01", "First item");
    ctx.db!.prepare(`UPDATE work_items SET phase = ? WHERE id = ?`).run("PH-003", "WI-D01");

    insertNode("WI-D02", "work_item", { status: "pending" });
    insertWorkItem("WI-D02", "Second item", { depends: ["WI-D01"] });
    ctx.db!.prepare(`UPDATE work_items SET phase = ? WHERE id = ?`).run("PH-003", "WI-D02");

    // Insert the dependency edge
    ctx.db!.prepare(`
      INSERT OR IGNORE INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, ?)
    `).run("WI-D02", "WI-D01", "depends_on");

    const result = await handleGetWorkspaceStatus(ctx, { view: "phase" });
    expect(result).toContain("## Dependencies");
    expect(result).toContain("WI-D02 depends on WI-D01");
  });
});

// ---------------------------------------------------------------------------
// 9. handleAppendJournal
// ---------------------------------------------------------------------------

describe("handleAppendJournal", () => {
  it("happy path: writes YAML journal entry and returns file path", async () => {
    const result = await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-03-25",
      entry_type: "work-item-complete",
      body: "Completed WI-001: Build schema.",
      cycle_number: 3,
    });

    // Result should reference the journal entry ID (1-based indexing per S10/P2)
    expect(result).toContain("J-003-001");

    // The YAML file should exist under cycles/003/journal/
    const yamlPath = path.join(artifactDir, "cycles", "003", "journal", "J-003-001.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    const content = fs.readFileSync(yamlPath, "utf8");
    expect(content).toContain("work-item-complete");
    expect(content).toContain("Completed WI-001");
    expect(content).toContain("journal_entry");
  });

  it("happy path: multiple entries get sequential IDs in separate YAML files", async () => {
    await handleAppendJournal(ctx, {
      skill: "plan",
      date: "2026-03-24",
      entry_type: "cycle-start",
      body: "Starting cycle 4.",
      cycle_number: 3,
    });

    await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-03-25",
      entry_type: "work-item-complete",
      body: "WI-001 done.",
      cycle_number: 3,
    });

    const journalDir = path.join(artifactDir, "cycles", "003", "journal");
    const files = fs.readdirSync(journalDir).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(2);
    // 1-based indexing per S10/P2 fix
    expect(files).toContain("J-003-001.yaml");
    expect(files).toContain("J-003-002.yaml");

    const first = fs.readFileSync(path.join(journalDir, "J-003-001.yaml"), "utf8");
    expect(first).toContain("cycle-start");

    const second = fs.readFileSync(path.join(journalDir, "J-003-002.yaml"), "utf8");
    expect(second).toContain("work-item-complete");
  });

  it("error path: throws when required params missing", async () => {
    await expect(
      handleAppendJournal(ctx, {
        skill: "execute",
        // missing date, entry_type, body
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. handleArchiveCycle
// ---------------------------------------------------------------------------

describe("handleArchiveCycle", () => {
  it("happy path: archives incremental reviews and returns count", async () => {
    // Seed a work item
    await handleWriteWorkItems(ctx, {
      items: [{ id: "WI-500", title: "happy path archive test" }],
    });

    // Create a v3 finding file in cycles/001/findings/ with work_item field
    const findingsDir = path.join(artifactDir, "cycles", "001", "findings");
    fs.mkdirSync(findingsDir, { recursive: true });
    const findingPath = path.join(findingsDir, "F-001-001.yaml");
    fs.writeFileSync(
      findingPath,
      "id: F-001-001\ntype: finding\nwork_item: WI-500\nseverity: minor\nverdict: pass\ncycle: 1\nreviewer: code-reviewer\n",
      "utf8"
    );

    // Insert into database so archiveCycle finds it
    db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('F-001-001', 'finding', 1, 'hash', ?, 'active')`).run(findingPath);
    db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('F-001-001', 'minor', 'WI-500', 'pass', 1, 'code-reviewer')`).run();

    // Ensure the work item has status='active' and cycle_created matches
    db.prepare(`UPDATE nodes SET status = 'active', cycle_created = 1 WHERE id = 'WI-500'`).run();
    db.prepare(`INSERT OR REPLACE INTO work_items (id, complexity, work_item_type, domain, title) VALUES ('WI-500', 'medium', 'feature', 'test', 'happy path archive test')`).run();

    const result = await handleArchiveCycle(ctx, { cycle_number: 1 });

    expect(result).toContain("Archived cycle 1");
    expect(result).toContain("1 work items");
    expect(result).toContain("1 incremental reviews moved");

    // Finding file should be deleted from source
    expect(fs.existsSync(path.join(findingsDir, "F-001-001.yaml"))).toBe(false);

    // Work item file should be deleted from source
    const wiPath = path.join(artifactDir, "work-items", "WI-500.yaml");
    expect(fs.existsSync(wiPath)).toBe(false);

    // Both should exist at archive destinations
    const archivedFinding = path.join(artifactDir, "archive", "cycles", "001", "incremental", "F-001-001.yaml");
    const archivedWi = path.join(artifactDir, "archive", "cycles", "001", "work-items", "WI-500.yaml");
    expect(fs.existsSync(archivedFinding)).toBe(true);
    expect(fs.existsSync(archivedWi)).toBe(true);
  });

  it("happy path: returns 0-count message when no incremental files exist", async () => {
    const result = await handleArchiveCycle(ctx, {
      cycle_number: 5,
    });
    expect(result).toContain("0");
  });

  it("error path: throws when required params missing", async () => {
    await expect(
      handleArchiveCycle(ctx, {})
    ).rejects.toThrow();
  });

  it("archive path fix: reads findings from cycles/{NNN}/findings/ not archive/incremental/", async () => {
    // Create findings in the correct new location: cycles/002/findings/
    const findingsDir = path.join(artifactDir, "cycles", "002", "findings");
    fs.mkdirSync(findingsDir, { recursive: true });
    const findingPath = path.join(findingsDir, "F-001-build-schema.yaml");
    fs.writeFileSync(
      findingPath,
      "id: F-001\ntype: finding\nverdict: pass\ncycle: 2\nwork_item: WI-001\nseverity: minor\n",
      "utf8"
    );

    // Create a work item YAML in the correct new location: work-items/ (not plan/work-items/)
    const wiDir = path.join(artifactDir, "work-items");
    fs.mkdirSync(wiDir, { recursive: true });
    const wiPath = path.join(wiDir, "WI-001.yaml");
    fs.writeFileSync(
      wiPath,
      "id: WI-001\ntype: work_item\ntitle: Build schema\nstatus: active\n",
      "utf8"
    );

    // Insert into database so archiveCycle finds them
    db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('F-001', 'finding', 2, 'hash', ?, 'active')`).run(findingPath);
    db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('F-001', 'minor', 'WI-001', 'pass', 2, 'code-reviewer')`).run();
    db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('WI-001', 'work_item', 2, 'hash', ?, 'active')`).run(wiPath);
    db.prepare(`INSERT INTO work_items (id, complexity, work_item_type, domain, title) VALUES ('WI-001', 'medium', 'feature', 'test', 'Build schema')`).run();

    const result = await handleArchiveCycle(ctx, {
      cycle_number: 2,
    });

    // Should have found and archived the finding file
    expect(result).toContain("Archived cycle 2");
    expect(result).toContain("1"); // at least 1 finding archived

    // Finding file should have been moved (deleted from source)
    expect(fs.existsSync(path.join(findingsDir, "F-001-build-schema.yaml"))).toBe(false);

    // archive/cycles/002/incremental/ should contain the finding
    const archivedIncremental = path.join(artifactDir, "archive", "cycles", "002", "incremental");
    expect(fs.existsSync(path.join(archivedIncremental, "F-001-build-schema.yaml"))).toBe(true);
  });

  it("error path: copy failure message contains no .ideate/ path (P-33)", async () => {
    // Create a finding file so archival is attempted
    const findingsDir = path.join(artifactDir, "cycles", "003", "findings");
    fs.mkdirSync(findingsDir, { recursive: true });
    const findingPath = path.join(findingsDir, "F-003-test.yaml");
    fs.writeFileSync(findingPath, "id: F-003-test\ntype: finding\ncycle: 3\nwork_item: WI-999\nseverity: minor\nverdict: pass\n");

    // Insert into database so archiveCycle finds it
    db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('F-003-test', 'finding', 3, 'hash', ?, 'active')`).run(findingPath);
    db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('F-003-test', 'minor', 'WI-999', 'pass', 3, 'code-reviewer')`).run();

    // Place a regular file where the destination incremental directory would be created,
    // so the copy step fails (can't copy into a path that is a file, not a dir)
    const archiveCycleDir = path.join(artifactDir, "archive", "cycles", "003");
    fs.mkdirSync(archiveCycleDir, { recursive: true });
    fs.writeFileSync(path.join(archiveCycleDir, "incremental"), "blocker"); // file, not directory

    const result = await handleArchiveCycle(ctx, { cycle_number: 3 });

    // Result should describe the error but must NOT contain any .ideate/ path or absolute path
    expect(result).toContain("Error during cycle archival");
    expect(result).not.toMatch(/\.ideate\//);
    expect(result).not.toContain(os.tmpdir());
    expect(result).not.toContain(artifactDir);
  });

  it("identifies work items from YAML work_item field (v3 naming)", async () => {
    // Seed a work item via handleWriteWorkItems
    await handleWriteWorkItems(ctx, {
      items: [{ id: "WI-501", title: "v3 naming test" }],
    });

    // Create a finding file with v3 naming: F-{cycle}-{seq}.yaml
    const findingsDir = path.join(artifactDir, "cycles", "005", "findings");
    fs.mkdirSync(findingsDir, { recursive: true });
    const findingPath = path.join(findingsDir, "F-005-001.yaml");
    fs.writeFileSync(
      findingPath,
      "id: F-005-001\ntype: finding\nwork_item: WI-501\nseverity: minor\nverdict: pass\ncycle: 5\nreviewer: code-reviewer\n",
      "utf8"
    );

    // Insert into database so archiveCycle finds it
    db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('F-005-001', 'finding', 5, 'hash', ?, 'active')`).run(findingPath);
    db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('F-005-001', 'minor', 'WI-501', 'pass', 5, 'code-reviewer')`).run();

    // Ensure the work item has status='active' in the database
    db.prepare(`UPDATE nodes SET status = 'active', cycle_created = 5 WHERE id = 'WI-501'`).run();
    db.prepare(`INSERT OR REPLACE INTO work_items (id, complexity, work_item_type, domain, title) VALUES ('WI-501', 'medium', 'feature', 'test', 'v3 naming test')`).run();

    const result = await handleArchiveCycle(ctx, { cycle_number: 5 });

    // Should archive 1 work item (WI-501) and 1 incremental review
    expect(result).toContain("1 work items");
    expect(result).toContain("1 incremental reviews moved");

    // Work item file should have been moved
    const wiPath = path.join(artifactDir, "work-items", "WI-501.yaml");
    expect(fs.existsSync(wiPath)).toBe(false);

    // Work item must exist at the archive destination
    const archivedWiPath = path.join(artifactDir, "archive", "cycles", "005", "work-items", "WI-501.yaml");
    expect(fs.existsSync(archivedWiPath)).toBe(true);
  });

  it("removes SQLite nodes for archived finding files after successful archival", async () => {
    // Seed a work item
    await handleWriteWorkItems(ctx, {
      items: [{ id: "WI-502", title: "SQLite cleanup test" }],
    });

    // Create a finding node in SQLite and a corresponding YAML file
    const findingsDir = path.join(artifactDir, "cycles", "006", "findings");
    fs.mkdirSync(findingsDir, { recursive: true });
    const findingPath = path.join(findingsDir, "F-006-001.yaml");
    fs.writeFileSync(
      findingPath,
      "id: F-006-001\ntype: finding\nwork_item: WI-502\nseverity: minor\nverdict: pass\ncycle: 6\nreviewer: code-reviewer\n",
      "utf8"
    );
    // Insert a node row pointing to the finding file path
    db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('F-006-001', 'finding', 6, 'testhash', ?, 'active')`).run(findingPath);
    db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('F-006-001', 'minor', 'WI-502', 'pass', 6, 'code-reviewer')`).run();

    const nodeCountBefore = (db.prepare(`SELECT COUNT(*) as cnt FROM nodes WHERE id = 'F-006-001'`).get() as { cnt: number }).cnt;
    expect(nodeCountBefore).toBe(1);

    await handleArchiveCycle(ctx, { cycle_number: 6 });

    // The finding node should be removed from SQLite
    const nodeCountAfter = (db.prepare(`SELECT COUNT(*) as cnt FROM nodes WHERE id = 'F-006-001'`).get() as { cnt: number }).cnt;
    expect(nodeCountAfter).toBe(0);

    // Work item node must NOT be deleted — work items remain queryable after archival
    const wiNodeAfter = (db.prepare(`SELECT COUNT(*) as cnt FROM nodes WHERE id = 'WI-502'`).get() as { cnt: number }).cnt;
    expect(wiNodeAfter).toBe(1);
  });

  it("DELETE is atomic: multiple finding nodes are deleted in a single transaction", async () => {
    // Seed a work item referenced by both findings
    await handleWriteWorkItems(ctx, {
      items: [{ id: "WI-503", title: "transaction atomicity test" }],
    });

    // Create two finding files for cycle 7
    const findingsDir = path.join(artifactDir, "cycles", "007", "findings");
    fs.mkdirSync(findingsDir, { recursive: true });

    const finding1Path = path.join(findingsDir, "F-007-001.yaml");
    const finding2Path = path.join(findingsDir, "F-007-002.yaml");
    fs.writeFileSync(
      finding1Path,
      "id: F-007-001\ntype: finding\nwork_item: WI-503\nseverity: minor\nverdict: pass\ncycle: 7\nreviewer: code-reviewer\n",
      "utf8"
    );
    fs.writeFileSync(
      finding2Path,
      "id: F-007-002\ntype: finding\nwork_item: WI-503\nseverity: minor\nverdict: pass\ncycle: 7\nreviewer: code-reviewer\n",
      "utf8"
    );

    // Insert both nodes into SQLite
    db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('F-007-001', 'finding', 7, 'hash1', ?, 'active')`).run(finding1Path);
    db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('F-007-001', 'minor', 'WI-503', 'pass', 7, 'code-reviewer')`).run();
    db.prepare(`INSERT INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('F-007-002', 'finding', 7, 'hash2', ?, 'active')`).run(finding2Path);
    db.prepare(`INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('F-007-002', 'minor', 'WI-503', 'pass', 7, 'code-reviewer')`).run();

    const beforeCount = (db.prepare(`SELECT COUNT(*) as cnt FROM nodes WHERE id IN ('F-007-001', 'F-007-002')`).get() as { cnt: number }).cnt;
    expect(beforeCount).toBe(2);

    await handleArchiveCycle(ctx, { cycle_number: 7 });

    // Both nodes must be removed — verifies the DELETE loop ran atomically
    const afterCount = (db.prepare(`SELECT COUNT(*) as cnt FROM nodes WHERE id IN ('F-007-001', 'F-007-002')`).get() as { cnt: number }).cnt;
    expect(afterCount).toBe(0);

    // Work item node must still exist
    const wiCount = (db.prepare(`SELECT COUNT(*) as cnt FROM nodes WHERE id = 'WI-503'`).get() as { cnt: number }).cnt;
    expect(wiCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. handleWriteWorkItems
// ---------------------------------------------------------------------------

describe("handleWriteWorkItems", () => {
  it("happy path: creates individual YAML file at .ideate/work-items/{id}.yaml", async () => {
    const result = await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-100",
          title: "Write work item test",
          complexity: "small",
          criteria: ["Tests pass"],
        },
      ],
    });

    // YAML response with id and result
    expect(result).toContain("created");
    expect(result).toContain("WI-100");

    // Individual YAML file must exist at {ideateDir}/work-items/WI-100.yaml
    const yamlPath = path.join(artifactDir, "work-items", "WI-100.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    // No plan/notes file should be created
    const notesPath = path.join(artifactDir, "plan", "notes", "WI-100.md");
    expect(fs.existsSync(notesPath)).toBe(false);

    // No plan/work-items.yaml should be created
    const consolidatedPath = path.join(artifactDir, "plan", "work-items.yaml");
    expect(fs.existsSync(consolidatedPath)).toBe(false);

    // Check SQLite row was inserted with correct file_path
    const row = db
      .prepare(`SELECT id, file_path, status FROM nodes WHERE id = 'WI-100'`)
      .get() as { id: string; file_path: string; status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe("WI-100");
    expect(row!.file_path).toContain("work-items");
    expect(row!.file_path).toContain("WI-100.yaml");
    expect(row!.status).toBeNull();
  });

  it("happy path: YAML file contains all required fields", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-101",
          title: "Full fields test",
          complexity: "medium",
          scope: [{ path: "src/foo.ts", op: "modify" }],
          depends: [],
          blocks: [],
          criteria: ["Criterion A", "Criterion B"],
          notes_content: "# Implementation Notes\nDo the thing.",
          domain: "workflow",
          status: "pending",
          resolution: null,
          cycle_created: 2,
        },
      ],
    });

    const yamlPath = path.join(artifactDir, "work-items", "WI-101.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    const content = fs.readFileSync(yamlPath, "utf8");
    // All required fields must be present
    expect(content).toContain("id:");
    expect(content).toContain("WI-101");
    expect(content).toContain("type:");
    expect(content).toContain("work_item");
    expect(content).toContain("title:");
    expect(content).toContain("Full fields test");
    expect(content).toContain("status:");
    expect(content).toContain("pending");
    expect(content).toContain("complexity:");
    expect(content).toContain("medium");
    expect(content).toContain("scope:");
    expect(content).toContain("src/foo.ts");
    expect(content).toContain("depends:");
    expect(content).toContain("blocks:");
    expect(content).toContain("criteria:");
    expect(content).toContain("Criterion A");
    expect(content).toContain("domain:");
    expect(content).toContain("workflow");
    // notes field must contain inline content (not a path to a .md file)
    expect(content).toContain("notes:");
    expect(content).toContain("Implementation Notes");
    expect(content).not.toContain("plan/notes");
    // resolution, cycle fields
    expect(content).toContain("resolution:");
    expect(content).toContain("cycle_created:");
    // computed fields
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");
    // file_path is not written to YAML — storage detail per P-33
    expect(content).not.toContain("file_path:");
  });

  it("happy path: notes content is stored inline in YAML (not as a .md path)", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-102",
          title: "Notes inline test",
          notes_content: "# My Notes\nSome implementation detail.",
        },
      ],
    });

    const yamlPath = path.join(artifactDir, "work-items", "WI-102.yaml");
    const content = fs.readFileSync(yamlPath, "utf8");

    // notes field contains the actual content, not a file path reference
    expect(content).toContain("My Notes");
    expect(content).toContain("Some implementation detail");
    // must NOT contain a path to a separate notes file
    expect(content).not.toContain("plan/notes/WI-102.md");
    // no separate .md file should be created
    expect(fs.existsSync(path.join(artifactDir, "plan", "notes", "WI-102.md"))).toBe(false);
  });

  it("happy path: resolution field is included when provided", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-103",
          title: "Obsolete item",
          status: "obsolete",
          resolution: "Superseded by WI-200",
        },
      ],
    });

    const yamlPath = path.join(artifactDir, "work-items", "WI-103.yaml");
    const content = fs.readFileSync(yamlPath, "utf8");

    expect(content).toContain("resolution:");
    expect(content).toContain("Superseded by WI-200");
    expect(content).toContain("status:");
    expect(content).toContain("obsolete");
  });

  it("happy path: SQLite file_path points to the .yaml file", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-104",
          title: "SQLite path test",
        },
      ],
    });

    const row = db
      .prepare(`SELECT file_path FROM nodes WHERE id = 'WI-104'`)
      .get() as { file_path: string } | undefined;
    expect(row).toBeDefined();
    // file_path must end in .yaml, not .md
    expect(row!.file_path).toMatch(/WI-104\.yaml$/);
    expect(row!.file_path).not.toMatch(/\.md$/);
    // file_path must not reference plan/notes
    expect(row!.file_path).not.toContain("plan/notes");
    // file_path must reference work-items directory
    expect(row!.file_path).toContain("work-items");
  });

  it("happy path: status from input is used (not hardcoded 'pending')", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-105",
          title: "Custom status test",
          status: "in-progress",
        },
      ],
    });

    const row = db
      .prepare(`SELECT status FROM nodes WHERE id = 'WI-105'`)
      .get() as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("in-progress");

    const yamlPath = path.join(artifactDir, "work-items", "WI-105.yaml");
    const content = fs.readFileSync(yamlPath, "utf8");
    expect(content).toContain("in-progress");
  });

  it("happy path: returns items: [] for empty items array", async () => {
    const result = await handleWriteWorkItems(ctx, {
      items: [],
    });
    expect(result).toContain("items");
  });

  it("error path: throws when items is not an array", async () => {
    await expect(
      handleWriteWorkItems(ctx, {
        items: "not-an-array",
      })
    ).rejects.toThrow();
  });

  it("error path: throws with 'null' message when a required field is null", () => {
    expect(() =>
      upsertExtensionRow(ctx.drizzleDb!, "work_items", "WI-NULL-1", { title: null })
    ).toThrow(/required field 'title' is null/);
  });

  it("error path: returns cycle error when dependency graph creates a cycle", async () => {
    const result = await handleWriteWorkItems(ctx, {
      items: [
        { id: "WI-A", title: "A", depends: ["WI-B"] },
        { id: "WI-B", title: "B", depends: ["WI-A"] },
      ],
    });
    // Should return an error string (not throw), mentioning DAG cycle
    expect(result).toContain("cycle");
  });

  it("backward compat: writes individual files even when plan/work-items.yaml exists", async () => {
    // Pre-create the consolidated file
    const consolidatedPath = path.join(artifactDir, "plan", "work-items.yaml");
    fs.writeFileSync(consolidatedPath, "items:\n  WI-OLD:\n    title: Old item\n", "utf8");

    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-106",
          title: "Backward compat test",
        },
      ],
    });

    // Individual YAML file must be created
    const yamlPath = path.join(artifactDir, "work-items", "WI-106.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    // The consolidated file should still exist but NOT be modified (new item not appended)
    const consolidatedContent = fs.readFileSync(consolidatedPath, "utf8");
    expect(consolidatedContent).not.toContain("WI-106");
  });

  it("auto-assignment: produces WI-051 when highest existing ID is WI-050", async () => {
    // Step 1: Create a work item with explicit id WI-050
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-050",
          title: "Explicit seed item",
          complexity: "small",
        },
      ],
    });

    // Step 2: Call writeWorkItems with an item that has no id
    const result = await handleWriteWorkItems(ctx, {
      items: [
        {
          title: "Auto-assigned item",
          complexity: "small",
        },
      ],
    });

    // Step 3: Verify the auto-assigned id is WI-051 (not WI-001)
    expect(result).toContain("WI-051");

    // Confirm the YAML file was written with the correct id
    const yamlPath = path.join(artifactDir, "work-items", "WI-051.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    // Confirm SQLite has WI-051, not WI-001
    const row = db
      .prepare(`SELECT id FROM nodes WHERE id = 'WI-051'`)
      .get() as { id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe("WI-051");

    // WI-001 must NOT have been created
    const wrongRow = db
      .prepare(`SELECT id FROM nodes WHERE id = 'WI-001'`)
      .get() as { id: string } | undefined;
    expect(wrongRow).toBeUndefined();
  });

  it("phase field: writing a work item with phase field stores phase in YAML, extension table, and indexer creates belongs_to_phase edge", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-PH01",
          title: "Phase-scoped item",
          phase: "PH-001",
        },
      ],
    });

    // The YAML file must contain the phase field
    const yamlPath = path.join(artifactDir, "work-items", "WI-PH01.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);
    const content = fs.readFileSync(yamlPath, "utf8");
    expect(content).toContain("phase:");
    expect(content).toContain("PH-001");

    // The phase value must be stored directly in the work_items extension table
    const wiRow = db
      .prepare(`SELECT phase FROM work_items WHERE id = 'WI-PH01'`)
      .get() as { phase: string | null } | undefined;
    expect(wiRow).toBeDefined();
    expect(wiRow!.phase).toBe("PH-001");

    // Force re-index by invalidating the stored hash
    db.prepare(`UPDATE nodes SET content_hash = 'stale' WHERE id = 'WI-PH01'`).run();

    // Rebuild index from the written YAML — this triggers edge extraction
    const { rebuildIndex } = await import("../indexer.js");
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    rebuildIndex(db, drizzle(db), artifactDir);

    // belongs_to_phase edge should now exist
    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-PH01' AND target_id = 'PH-001' AND edge_type = 'belongs_to_phase'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("belongs_to_phase");
  });

  it("work_item_type roundtrip: write with 'bug', YAML and SQLite both reflect 'bug'", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-WIT01",
          title: "Bug fix item",
          complexity: "small",
          work_item_type: "bug",
        },
      ],
    });

    // YAML file must contain work_item_type: bug
    const yamlPath = path.join(artifactDir, "work-items", "WI-WIT01.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);
    const content = fs.readFileSync(yamlPath, "utf8");
    expect(content).toContain("work_item_type:");
    expect(content).toContain("bug");

    // SQLite extension row must have work_item_type = 'bug'
    const wiRow = db
      .prepare(`SELECT work_item_type FROM work_items WHERE id = 'WI-WIT01'`)
      .get() as { work_item_type: string | null } | undefined;
    expect(wiRow).toBeDefined();
    expect(wiRow!.work_item_type).toBe("bug");
  });

  it("work_item_type defaults to 'feature' when not provided", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-WIT02",
          title: "Feature item without explicit type",
          complexity: "small",
        },
      ],
    });

    // YAML file must contain work_item_type: feature
    const yamlPath = path.join(artifactDir, "work-items", "WI-WIT02.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);
    const content = fs.readFileSync(yamlPath, "utf8");
    expect(content).toContain("work_item_type:");
    expect(content).toContain("feature");

    // SQLite extension row must default to 'feature'
    const wiRow = db
      .prepare(`SELECT work_item_type FROM work_items WHERE id = 'WI-WIT02'`)
      .get() as { work_item_type: string | null } | undefined;
    expect(wiRow).toBeDefined();
    expect(wiRow!.work_item_type).toBe("feature");
  });

  it("work_item_type filter: handleArtifactQuery filters by work_item_type", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        { id: "WI-WIT03", title: "Bug A", complexity: "small", work_item_type: "bug", status: "pending" },
        { id: "WI-WIT04", title: "Spike B", complexity: "small", work_item_type: "spike", status: "pending" },
        { id: "WI-WIT05", title: "Feature C", complexity: "small", work_item_type: "feature", status: "pending" },
      ],
    });

    const result = await handleArtifactQuery(ctx, {
      type: "work_item",
      filters: { work_item_type: "bug", status: "pending" },
    });

    expect(result).toContain("WI-WIT03");
    expect(result).not.toContain("WI-WIT04");
    expect(result).not.toContain("WI-WIT05");
  });

  it("work_item_type indexer roundtrip: indexer defaults missing field to 'feature'", async () => {
    // Write a YAML file without work_item_type field
    const workItemsDir = path.join(artifactDir, "work-items");
    fs.mkdirSync(workItemsDir, { recursive: true });
    const yamlContent = `id: WI-WIT06\ntype: work_item\ntitle: Legacy item\nstatus: pending\ncomplexity: small\nscope: []\ndepends: []\nblocks: []\ncriteria: []\ndomain: null\nphase: null\nnotes: '# WI-WIT06'\nresolution: null\ncycle_created: null\ncycle_modified: null\ncontent_hash: placeholder\ntoken_count: 0\n`;
    const filePath = path.join(workItemsDir, "WI-WIT06.yaml");
    fs.writeFileSync(filePath, yamlContent, "utf8");

    // Index the file
    indexFiles(db, ctx.drizzleDb!, [filePath]);

    // work_item_type must default to 'feature'
    const wiRow = db
      .prepare(`SELECT work_item_type FROM work_items WHERE id = 'WI-WIT06'`)
      .get() as { work_item_type: string | null } | undefined;
    expect(wiRow).toBeDefined();
    expect(wiRow!.work_item_type).toBe("feature");
  });
});

// ---------------------------------------------------------------------------
// 12. handleUpdateWorkItems
// ---------------------------------------------------------------------------

describe("handleUpdateWorkItems", () => {
  /** Helper: create a work item file via handleWriteWorkItems and return its path */
  async function createWorkItem(id: string, overrides: Record<string, unknown> = {}): Promise<string> {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id,
          title: `Test item ${id}`,
          complexity: "small",
          status: "pending",
          domain: "workflow",
          criteria: ["Initial criterion"],
          notes_content: `# Notes for ${id}`,
          ...overrides,
        },
      ],
    });
    return path.join(artifactDir, "work-items", `${id}.yaml`);
  }

  it("single-field update: status only", async () => {
    const filePath = await createWorkItem("WI-U01");

    const beforeContent = fs.readFileSync(filePath, "utf8");
    const beforeObj = JSON.parse(JSON.stringify(
      (await import("yaml")).parse(beforeContent)
    ));

    const result = await handleUpdateWorkItems(ctx, {
      updates: [{ id: "WI-U01", status: "done" }],
    });

    // Summary reports 1 updated, 0 failed
    expect(result).toContain("updated: 1");
    expect(result).toContain("failed: 0");

    // Read updated file
    const afterContent = fs.readFileSync(filePath, "utf8");
    const afterObj = (await import("yaml")).parse(afterContent);

    // Status changed
    expect(afterObj.status).toBe("done");

    // Other fields preserved
    expect(afterObj.title).toBe(beforeObj.title);
    expect(afterObj.complexity).toBe(beforeObj.complexity);
    expect(afterObj.domain).toBe(beforeObj.domain);
    expect(afterObj.id).toBe(beforeObj.id);
    expect(afterObj.type).toBe("work_item");
    expect(afterObj.cycle_created).toBe(beforeObj.cycle_created);

    // SQLite updated
    const row = db
      .prepare(`SELECT status FROM nodes WHERE id = 'WI-U01'`)
      .get() as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("done");
  });

  it("multi-field update: status + resolution", async () => {
    const filePath = await createWorkItem("WI-U02");

    const result = await handleUpdateWorkItems(ctx, {
      updates: [
        { id: "WI-U02", status: "obsolete", resolution: "Superseded by WI-U10" },
      ],
    });

    expect(result).toContain("updated: 1");
    expect(result).toContain("failed: 0");

    const afterContent = fs.readFileSync(filePath, "utf8");
    const afterObj = (await import("yaml")).parse(afterContent);

    expect(afterObj.status).toBe("obsolete");
    expect(afterObj.resolution).toBe("Superseded by WI-U10");

    // Immutable fields preserved
    expect(afterObj.id).toBe("WI-U02");
    expect(afterObj.type).toBe("work_item");

    // Other fields still present
    expect(afterObj.title).toBe("Test item WI-U02");
    expect(afterObj.domain).toBe("workflow");

    // SQLite reflects new status
    const row = db
      .prepare(`SELECT status FROM nodes WHERE id = 'WI-U02'`)
      .get() as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("obsolete");
  });

  it("nonexistent ID returns error and continues processing others", async () => {
    // Create one real work item
    await createWorkItem("WI-U03");

    const result = await handleUpdateWorkItems(ctx, {
      updates: [
        { id: "WI-NONEXISTENT", status: "done" },
        { id: "WI-U03", status: "in-progress" },
      ],
    });

    // 1 updated (WI-U03), 1 failed (WI-NONEXISTENT)
    expect(result).toContain("updated: 1");
    expect(result).toContain("failed: 1");
    expect(result).toContain("WI-NONEXISTENT");

    // The real item was still updated
    const filePath = path.join(artifactDir, "work-items", "WI-U03.yaml");
    const afterContent = fs.readFileSync(filePath, "utf8");
    const afterObj = (await import("yaml")).parse(afterContent);
    expect(afterObj.status).toBe("in-progress");
  });

  it("empty updates array returns zeroed summary", async () => {
    const result = await handleUpdateWorkItems(ctx, { updates: [] });
    expect(result).toContain("updated: 0");
    expect(result).toContain("failed: 0");
  });

  it("updating depends replaces old edges in SQLite", async () => {
    // Create two work items: WI-U10 (the dependency) and WI-U11 (the dependent)
    await createWorkItem("WI-U10");
    await createWorkItem("WI-U11");

    // Initially WI-U11 has no depends edges
    const edgesBefore = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'WI-U11' AND edge_type = 'depends_on'`)
      .all();
    expect(edgesBefore).toHaveLength(0);

    // Update WI-U11 to depend on WI-U10
    const result = await handleUpdateWorkItems(ctx, {
      updates: [{ id: "WI-U11", depends: ["WI-U10"] }],
    });
    expect(result).toContain("updated: 1");
    expect(result).toContain("failed: 0");

    // Verify the depends_on edge was created in SQLite
    const edgesAfter = db
      .prepare(`SELECT source_id, target_id, edge_type FROM edges WHERE source_id = 'WI-U11' AND edge_type = 'depends_on'`)
      .all() as { source_id: string; target_id: string; edge_type: string }[];
    expect(edgesAfter).toHaveLength(1);
    expect(edgesAfter[0].target_id).toBe("WI-U10");

    // Update WI-U11 again with a different depends to verify old edges are removed
    await handleUpdateWorkItems(ctx, {
      updates: [{ id: "WI-U11", depends: [] }],
    });
    const edgesCleared = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'WI-U11' AND edge_type = 'depends_on'`)
      .all();
    expect(edgesCleared).toHaveLength(0);
  });

  it("throws when updates param is missing", async () => {
    await expect(
      handleUpdateWorkItems(ctx, {})
    ).rejects.toThrow(/updates/i);
  });
});

describe("handleUpdateWorkItems — P-33 path sanitization", () => {
  it("failures[].reason must not contain absolute paths when a filesystem error occurs", async () => {
    // Seed a work item so the YAML file and DB entry both exist
    await handleWriteWorkItems(ctx, {
      items: [{ id: "WI-300", title: "P-33 test item" }],
    });

    // Make the file unreadable — existsSync returns true but readFileSync throws EACCES
    const wiPath = path.join(artifactDir, "work-items", "WI-300.yaml");
    fs.chmodSync(wiPath, 0o000);

    let result: string;
    try {
      result = await handleUpdateWorkItems(ctx, {
        updates: [{ id: "WI-300", status: "done" }],
      });
    } finally {
      // Restore permissions for cleanup
      fs.chmodSync(wiPath, 0o644);
    }

    // Result is YAML — must contain failures but no absolute paths
    expect(result).toContain("failures:");
    expect(result).not.toContain(artifactDir);
    expect(result).not.toContain(os.tmpdir());
  });
});

// ---------------------------------------------------------------------------
// 13. handleWriteArtifact
// ---------------------------------------------------------------------------

describe("handleWriteArtifact", () => {
  it("write overview: creates file at plan/overview.yaml with correct content", async () => {
    const result = await handleWriteArtifact(ctx, {
      type: "overview",
      id: "overview",
      content: {
        title: "Project Overview",
        summary: "An overview of the project.",
        goals: ["Build fast", "Stay correct"],
      },
    });

    expect(result).toContain("overview");

    const filePath = path.join(artifactDir, "plan", "overview.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("id:");
    expect(content).toContain("overview");
    expect(content).toContain("type:");
    expect(content).toContain("title:");
    expect(content).toContain("Project Overview");
    expect(content).toContain("summary:");
    expect(content).toContain("An overview of the project.");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");
    // file_path is not written to YAML — storage detail per P-33
    expect(content).not.toContain("file_path:");

    // Verify SQLite upsert
    const row = db
      .prepare(`SELECT id, type, file_path FROM nodes WHERE id = 'overview'`)
      .get() as { id: string; type: string; file_path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe("overview");
    expect(row!.file_path).toContain("plan");
    expect(row!.file_path).toContain("overview.yaml");
  });

  it("write execution_strategy: creates file at plan/execution-strategy.yaml", async () => {
    const result = await handleWriteArtifact(ctx, {
      type: "execution_strategy",
      id: "execution-strategy",
      content: {
        title: "Execution Strategy",
        approach: "serial",
        phases: ["planning", "execution", "review"],
      },
    });

    expect(result).toContain("execution_strategy");

    const filePath = path.join(artifactDir, "plan", "execution-strategy.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("id:");
    expect(content).toContain("execution-strategy");
    expect(content).toContain("type:");
    expect(content).toContain("execution_strategy");
    expect(content).toContain("approach:");
    expect(content).toContain("serial");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");

    // SQLite row
    const row = db
      .prepare(`SELECT id, type FROM nodes WHERE id = 'execution-strategy'`)
      .get() as { id: string; type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe("execution_strategy");
  });

  it("write interview: creates file at interviews/refine-029/_general.yaml with nested path", async () => {
    const result = await handleWriteArtifact(ctx, {
      type: "interview",
      id: "refine-029/_general",
      content: {
        title: "General Interview",
        questions: ["What changed?", "Any blockers?"],
        responses: { "What changed?": "Completed WI-230." },
      },
    });

    expect(result).toContain("interview");

    const filePath = path.join(artifactDir, "interviews", "refine-029", "_general.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("id:");
    expect(content).toContain("refine-029/_general");
    expect(content).toContain("type:");
    expect(content).toContain("interview");
    expect(content).toContain("title:");
    expect(content).toContain("General Interview");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");

    // SQLite row
    const row = db
      .prepare(`SELECT id, type FROM nodes WHERE id = 'refine-029/_general'`)
      .get() as { id: string; type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe("interview");
  });

  it("write research: creates file at steering/research/{id}.yaml", async () => {
    await handleWriteArtifact(ctx, {
      type: "research",
      id: "sqlite-performance",
      content: {
        title: "SQLite Performance Research",
        findings: "WAL mode improves throughput.",
      },
    });

    const filePath = path.join(artifactDir, "steering", "research", "sqlite-performance.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("sqlite-performance");
    expect(content).toContain("research");
  });

  it("write guiding_principles: creates file at steering/{id}.yaml", async () => {
    await handleWriteArtifact(ctx, {
      type: "guiding_principles",
      id: "guiding-principles",
      content: {
        title: "Guiding Principles",
        principles: ["Write YAML first", "SQLite is secondary"],
      },
    });

    const filePath = path.join(artifactDir, "steering", "guiding-principles.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("guiding-principles");
    expect(content).toContain("guiding_principles");
  });

  it("unknown type throws error with list of valid types", async () => {
    await expect(
      handleWriteArtifact(ctx, {
        type: "custom_artifact",
        id: "my-artifact",
        content: { title: "Custom", data: 42 },
      })
    ).rejects.toThrow(/Unknown artifact type 'custom_artifact'/);
  });


  it("error path: throws when type is missing", async () => {
    await expect(
      handleWriteArtifact(ctx, { id: "foo", content: {} })
    ).rejects.toThrow(/type.*id/i);
  });

  it("error path: throws when id is missing", async () => {
    await expect(
      handleWriteArtifact(ctx, { type: "overview", content: {} })
    ).rejects.toThrow(/type.*id/i);
  });

  it("error path: throws when content is not an object", async () => {
    await expect(
      handleWriteArtifact(ctx, { type: "overview", id: "foo", content: "not-an-object" })
    ).rejects.toThrow(/content/i);
  });

  it("guiding_principle: extension table row is created", async () => {
    await handleWriteArtifact(ctx, {
      type: "guiding_principle",
      id: "GP-01",
      content: {
        name: "MCP Abstraction Boundary",
        description: "Skills interact with artifacts only through MCP tools.",
      },
    });

    // Node should exist
    const node = db.prepare(`SELECT id, type FROM nodes WHERE id = 'GP-01'`).get() as { id: string; type: string } | undefined;
    expect(node).toBeDefined();
    expect(node!.type).toBe("guiding_principle");

    // Extension table row should exist
    const row = db.prepare(`SELECT id, name, description FROM guiding_principles WHERE id = 'GP-01'`).get() as { id: string; name: string; description: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("MCP Abstraction Boundary");
  });

  it("constraint: extension table row is created", async () => {
    await handleWriteArtifact(ctx, {
      type: "constraint",
      id: "C-01",
      content: {
        category: "technology",
        description: "Use TypeScript strict mode.",
      },
    });

    // Node should exist
    const node = db.prepare(`SELECT id, type FROM nodes WHERE id = 'C-01'`).get() as { id: string; type: string } | undefined;
    expect(node).toBeDefined();
    expect(node!.type).toBe("constraint");

    // Extension table row should exist
    const row = db.prepare(`SELECT id, category, description FROM constraints WHERE id = 'C-01'`).get() as { id: string; category: string; description: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.category).toBe("technology");
  });

  it("project: name and description roundtrip via write + index rebuild + query", async () => {
    // Create projects directory
    fs.mkdirSync(path.join(artifactDir, "projects"), { recursive: true });

    await handleWriteArtifact(ctx, {
      type: "project",
      id: "PR-NAME-01",
      content: {
        name: "My Test Project",
        description: "A project to test name/description roundtrip.",
        intent: "Validate the new name column.",
        status: "active",
      },
    });

    // Verify write stored name in the extension table
    const rowAfterWrite = db
      .prepare(`SELECT id, name, description FROM projects WHERE id = 'PR-NAME-01'`)
      .get() as { id: string; name: string | null; description: string | null } | undefined;
    expect(rowAfterWrite).toBeDefined();
    expect(rowAfterWrite!.name).toBe("My Test Project");
    expect(rowAfterWrite!.description).toBe("A project to test name/description roundtrip.");

    // Invalidate stored hash to force re-index
    db.prepare(`UPDATE nodes SET content_hash = 'stale' WHERE id = 'PR-NAME-01'`).run();

    // Rebuild index
    const { rebuildIndex } = await import("../indexer.js");
    rebuildIndex(db, drizzle(db, { schema: dbSchema }), artifactDir);

    // Verify name persists after re-index
    const rowAfterRebuild = db
      .prepare(`SELECT id, name, description FROM projects WHERE id = 'PR-NAME-01'`)
      .get() as { id: string; name: string | null; description: string | null } | undefined;
    expect(rowAfterRebuild).toBeDefined();
    expect(rowAfterRebuild!.name).toBe("My Test Project");
    expect(rowAfterRebuild!.description).toBe("A project to test name/description roundtrip.");
  });

  it("phase: name and description roundtrip via write + index rebuild + query", async () => {
    // Create required directories
    fs.mkdirSync(path.join(artifactDir, "projects"), { recursive: true });
    fs.mkdirSync(path.join(artifactDir, "phases"), { recursive: true });

    // Write a parent project first (needed for FK)
    await handleWriteArtifact(ctx, {
      type: "project",
      id: "PR-PH-PARENT",
      content: {
        intent: "Parent project for phase name test.",
        status: "active",
      },
    });

    await handleWriteArtifact(ctx, {
      type: "phase",
      id: "PH-NAME-01",
      content: {
        name: "My Test Phase",
        description: "A phase to test name/description roundtrip.",
        project: "PR-PH-PARENT",
        phase_type: "implementation",
        intent: "Validate the new name column on phases.",
        status: "active",
      },
    });

    // Verify write stored name in the extension table
    const rowAfterWrite = db
      .prepare(`SELECT id, name, description FROM phases WHERE id = 'PH-NAME-01'`)
      .get() as { id: string; name: string | null; description: string | null } | undefined;
    expect(rowAfterWrite).toBeDefined();
    expect(rowAfterWrite!.name).toBe("My Test Phase");
    expect(rowAfterWrite!.description).toBe("A phase to test name/description roundtrip.");

    // Invalidate stored hashes to force re-index
    db.prepare(`UPDATE nodes SET content_hash = 'stale' WHERE id IN ('PR-PH-PARENT', 'PH-NAME-01')`).run();

    // Rebuild index
    const { rebuildIndex } = await import("../indexer.js");
    rebuildIndex(db, drizzle(db, { schema: dbSchema }), artifactDir);

    // Verify name persists after re-index
    const rowAfterRebuild = db
      .prepare(`SELECT id, name, description FROM phases WHERE id = 'PH-NAME-01'`)
      .get() as { id: string; name: string | null; description: string | null } | undefined;
    expect(rowAfterRebuild).toBeDefined();
    expect(rowAfterRebuild!.name).toBe("My Test Phase");
    expect(rowAfterRebuild!.description).toBe("A phase to test name/description roundtrip.");
  });

  it("phase: title field in YAML maps to name column via indexer (title→name fallback)", async () => {
    // Create required directories
    fs.mkdirSync(path.join(artifactDir, "projects"), { recursive: true });
    fs.mkdirSync(path.join(artifactDir, "phases"), { recursive: true });

    // Write a legacy-style phase YAML using `title` instead of `name`
    const phaseFilePath = path.join(artifactDir, "phases", "PH-TITLE-01.yaml");
    fs.writeFileSync(phaseFilePath, [
      "id: PH-TITLE-01",
      "type: phase",
      "title: Legacy Phase Title",
      "project: PR-LEGACY-PARENT",
      "phase_type: implementation",
      "intent: Test title-to-name fallback.",
      "status: active",
    ].join("\n"), "utf8");

    // Also write the parent project file so rebuildIndex can index it
    const projectFilePath = path.join(artifactDir, "projects", "PR-LEGACY-PARENT.yaml");
    fs.writeFileSync(projectFilePath, [
      "id: PR-LEGACY-PARENT",
      "type: project",
      "intent: Legacy parent project.",
      "status: active",
    ].join("\n"), "utf8");

    // Rebuild index from scratch
    const { rebuildIndex } = await import("../indexer.js");
    rebuildIndex(db, drizzle(db, { schema: dbSchema }), artifactDir);

    // The indexer should have mapped title → name
    const row = db
      .prepare(`SELECT id, name FROM phases WHERE id = 'PH-TITLE-01'`)
      .get() as { id: string; name: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("Legacy Phase Title");
  });
});

// ---------------------------------------------------------------------------
// handleAssembleContext — PPR-based context assembly with token budgeting
// ---------------------------------------------------------------------------

describe("handleAssembleContext", () => {
  // Attach a LocalAdapter to ctx so traverse() flows through the StorageAdapter contract.
  beforeEach(() => {
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });
  });

  /** Insert an edge between two existing nodes */
  function insertEdge(sourceId: string, targetId: string, edgeType: string): void {
    db.prepare(`
      INSERT OR IGNORE INTO edges (source_id, target_id, edge_type, props)
      VALUES (?, ?, ?, '{}')
    `).run(sourceId, targetId, edgeType);
  }

  /** Write a YAML file to the artifact directory and return its path */
  function writeArtifactFile(relPath: string, content: string): string {
    const fullPath = path.join(artifactDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    return fullPath;
  }

  it("basic assembly: seed a work item, verify related artifacts appear in output", async () => {
    // Set up a work item node with a YAML file
    const wiFilePath = writeArtifactFile("work-items/WI-001.yaml", [
      "id: WI-001",
      "type: work_item",
      "title: Test Work Item",
      "content: Implementation of the test feature.",
    ].join("\n"));

    insertNode("WI-001", "work_item", {
      file_path: wiFilePath,
      status: "pending",
    });
    insertWorkItem("WI-001", "Test Work Item");

    // Add a related guiding principle
    const gpFilePath = writeArtifactFile("principles/GP-01.yaml", [
      "id: GP-01",
      "type: guiding_principle",
      "name: Test Principle",
      "description: Always test your code.",
    ].join("\n"));

    insertNode("GP-01", "guiding_principle", { file_path: gpFilePath });
    db.prepare(`INSERT OR REPLACE INTO guiding_principles (id, name, description) VALUES (?, ?, ?)`)
      .run("GP-01", "Test Principle", "Always test your code.");

    // Connect them via a governed_by edge
    insertEdge("WI-001", "GP-01", "governed_by");

    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-001"],
      token_budget: 100000,
      include_types: [],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      total_tokens: number;
      ppr_scores: Array<{ id: string; score: number }>;
      context: string;
    };

    // Both the seed and the related artifact should appear
    expect(result.artifact_ids).toContain("WI-001");
    expect(result.artifact_ids).toContain("GP-01");
    expect(result.context).toContain("WI-001");
    expect(result.context).toContain("GP-01");
    expect(result.total_tokens).toBeGreaterThan(0);
    expect(result.ppr_scores.length).toBeGreaterThan(0);
  });

  it("token budget cutoff: small budget limits included artifacts", async () => {
    // Create multiple nodes, each with some content
    for (let i = 1; i <= 5; i++) {
      const id = `WI-B0${i}`;
      // Each file is about 200 characters = ~50 tokens
      const content = `id: ${id}\ntype: work_item\ntitle: Budget Test Item ${i}\ncontent: ${"x".repeat(150)}\n`;
      const filePath = writeArtifactFile(`work-items/${id}.yaml`, content);
      insertNode(id, "work_item", { file_path: filePath, status: "pending" });
      insertWorkItem(id, `Budget Test Item ${i}`);
    }

    // Link them all: WI-B01 → WI-B02 → WI-B03 → WI-B04 → WI-B05
    for (let i = 1; i <= 4; i++) {
      insertEdge(`WI-B0${i}`, `WI-B0${i + 1}`, "depends_on");
    }

    // Token budget tight enough to exclude some artifacts (~50 tokens each, budget = 120)
    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-B01"],
      token_budget: 120,
      include_types: [],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      total_tokens: number;
    };

    // Should have included the seed (WI-B01) plus at most 1-2 more due to budget
    expect(result.artifact_ids).toContain("WI-B01");
    // Should not include all 5 — total_tokens should be within budget
    expect(result.total_tokens).toBeLessThanOrEqual(120);
    // Not all 5 items should be included
    expect(result.artifact_ids.length).toBeLessThan(5);
  });

  it("always-include types: artifacts matching include_types appear even without PPR connection", async () => {
    // Create the seed work item
    const wiFilePath = writeArtifactFile("work-items/WI-AIT-01.yaml", [
      "id: WI-AIT-01",
      "type: work_item",
      "title: Always Include Test",
    ].join("\n"));
    insertNode("WI-AIT-01", "work_item", { file_path: wiFilePath, status: "pending" });
    insertWorkItem("WI-AIT-01", "Always Include Test");

    // Create a guiding_principle with NO edge to the seed (zero PPR score)
    const gpFilePath = writeArtifactFile("principles/GP-AIT-01.yaml", [
      "id: GP-AIT-01",
      "type: guiding_principle",
      "name: Isolated Principle",
      "description: This principle has no edge to the work item.",
    ].join("\n"));
    insertNode("GP-AIT-01", "guiding_principle", { file_path: gpFilePath });
    db.prepare(`INSERT OR REPLACE INTO guiding_principles (id, name, description) VALUES (?, ?, ?)`)
      .run("GP-AIT-01", "Isolated Principle", "This principle has no edge to the work item.");

    // No edge between WI-AIT-01 and GP-AIT-01

    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-AIT-01"],
      token_budget: 100000,
      include_types: ["guiding_principle"],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      context: string;
    };

    // The guiding principle should be included despite having no PPR score
    expect(result.artifact_ids).toContain("GP-AIT-01");
    expect(result.context).toContain("GP-AIT-01");
    expect(result.context).toContain("Isolated Principle");
  });

  it("error path: empty seed_ids array throws error", async () => {
    await expect(
      handleAssembleContext(ctx, { seed_ids: [], token_budget: 50000, include_types: [] })
    ).rejects.toThrow(/seed_ids/i);
  });

  it("edge case: seed_ids with non-existent IDs returns always-include items only", async () => {
    // Insert a guiding_principle that will be always-included
    const gpFilePath = path.join(artifactDir, "principles", "GP-ONLY.yaml");
    fs.mkdirSync(path.dirname(gpFilePath), { recursive: true });
    fs.writeFileSync(gpFilePath, [
      "id: GP-ONLY",
      "type: guiding_principle",
      "name: Only Principle",
      "description: This should always be included.",
    ].join("\n"), "utf8");
    insertNode("GP-ONLY", "guiding_principle", { file_path: gpFilePath });
    db.prepare(`INSERT OR REPLACE INTO guiding_principles (id, name, description) VALUES (?, ?, ?)`)
      .run("GP-ONLY", "Only Principle", "This should always be included.");

    // Seed with an ID that does not exist in the DB
    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-DOES-NOT-EXIST"],
      token_budget: 100000,
      include_types: ["guiding_principle"],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      context: string;
    };

    // Always-include type should be present
    expect(result.artifact_ids).toContain("GP-ONLY");
    // The non-existent seed should not appear in the output
    expect(result.artifact_ids).not.toContain("WI-DOES-NOT-EXIST");
  });

  it("edge case: token_budget of 0 returns always-include items only", async () => {
    // Insert a seed work item
    const wiFilePath = path.join(artifactDir, "work-items", "WI-TB0.yaml");
    fs.mkdirSync(path.dirname(wiFilePath), { recursive: true });
    fs.writeFileSync(wiFilePath, [
      "id: WI-TB0",
      "type: work_item",
      "title: Token Budget Zero",
    ].join("\n"), "utf8");
    insertNode("WI-TB0", "work_item", { file_path: wiFilePath, status: "pending" });
    insertWorkItem("WI-TB0", "Token Budget Zero");

    // Insert a ranked node connected via edge (should be excluded by budget)
    const relFilePath = path.join(artifactDir, "work-items", "WI-TB0-REL.yaml");
    fs.writeFileSync(relFilePath, [
      "id: WI-TB0-REL",
      "type: work_item",
      "title: Related Item",
    ].join("\n"), "utf8");
    insertNode("WI-TB0-REL", "work_item", { file_path: relFilePath, status: "pending" });
    insertWorkItem("WI-TB0-REL", "Related Item");
    db.prepare(`INSERT OR IGNORE INTO edges (source_id, target_id, edge_type, props) VALUES (?, ?, 'depends_on', '{}')`)
      .run("WI-TB0", "WI-TB0-REL");

    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-TB0"],
      token_budget: 0,
      include_types: [],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      total_tokens: number;
    };

    // The seed (always-include) should be present
    expect(result.artifact_ids).toContain("WI-TB0");
    // The ranked related item should be excluded since budget is 0
    expect(result.artifact_ids).not.toContain("WI-TB0-REL");
  });
});

// ---------------------------------------------------------------------------
// ideate_get_config dispatch
// ---------------------------------------------------------------------------

describe("ideate_get_config", () => {
  it("handleTool dispatch returns JSON with agent_budgets and ppr keys with correct defaults", async () => {
    const resultStr = await handleTool(ctx, "ideate_get_config", {});

    const result = JSON.parse(resultStr) as Record<string, unknown>;

    // Must have both top-level keys
    expect(result).toHaveProperty("agent_budgets");
    expect(result).toHaveProperty("ppr");

    // agent_budgets should contain default entries
    const agentBudgets = result.agent_budgets as Record<string, number>;
    expect(agentBudgets["code-reviewer"]).toBe(80);
    expect(agentBudgets["architect"]).toBe(160);
    expect(agentBudgets["proxy-human"]).toBe(160);

    // ppr should contain default sub-keys
    const ppr = result.ppr as Record<string, unknown>;
    expect(ppr).toHaveProperty("alpha");
    expect(ppr).toHaveProperty("max_iterations");
    expect(ppr).toHaveProperty("convergence_threshold");
    expect(ppr).toHaveProperty("edge_type_weights");
    expect(ppr).toHaveProperty("default_token_budget");
    expect(ppr.alpha).toBe(0.15);
    expect(ppr.default_token_budget).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// Integration: write → read (append_journal → artifact_query)
// ---------------------------------------------------------------------------

describe("integration: append_journal → artifact_query sync", () => {
  it("journal entry written by handleAppendJournal is queryable via handleArtifactQuery", async () => {
    // Write a journal entry
    await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-03-25",
      entry_type: "integration-test",
      body: "Integration test body.",
      cycle_number: 3,
    });

    // Query the artifact index for journal_entry type
    const queryResult = await handleArtifactQuery(ctx, {
      type: "journal_entry",
    });

    // Should find the entry in SQLite
    expect(queryResult).not.toBe("No results found.");
    expect(queryResult).toContain("journal_entry");

    // Verify the SQLite file_path points to the YAML file (not journal.md)
    const row = db
      .prepare(`SELECT file_path FROM nodes WHERE type = 'journal_entry' LIMIT 1`)
      .get() as { file_path: string } | undefined;
    expect(row).toBeDefined();
    // 1-based indexing per S10/P2 fix
    expect(row!.file_path).toContain("J-003-001.yaml");
    expect(row!.file_path).not.toContain("journal.md");
  });
});

// ---------------------------------------------------------------------------
// handleBootstrapWorkspace
// ---------------------------------------------------------------------------

describe("handleBootstrapWorkspace", () => {
  it("creates .ideate.json at project root and artifact directory structure", async () => {
    // Use a fresh temp dir as the project root (not the existing artifactDir)
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-bootstrap-test-"));
    const bootstrapIdeateDir = path.join(projectRoot, ".ideate");

    // Create a temporary context pointing to the new .ideate dir
    const bootstrapCtx: ToolContext = { ...ctx, ideateDir: bootstrapIdeateDir };

    const result = await handleBootstrapWorkspace(bootstrapCtx, { project_name: "test-project" });
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe("initialized");
    expect(parsed.subdirectories).toContain("work-items");
    expect(parsed.subdirectories).toContain("plan");

    // Verify .ideate.json exists at project root with correct schema_version
    const ideateJsonPath = path.join(projectRoot, ".ideate.json");
    expect(fs.existsSync(ideateJsonPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(ideateJsonPath, "utf8"));
    expect(config.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(config.project_name).toBe("test-project");

    // Verify config.json does NOT exist inside the artifact directory (AC2)
    const legacyConfigPath = path.join(bootstrapIdeateDir, "config.json");
    expect(fs.existsSync(legacyConfigPath)).toBe(false);

    // Verify artifact subdirectories exist
    expect(fs.existsSync(path.join(bootstrapIdeateDir, "work-items"))).toBe(true);
    expect(fs.existsSync(path.join(bootstrapIdeateDir, "cycles"))).toBe(true);

    // Cleanup
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// handleGetNextId
// ---------------------------------------------------------------------------

describe("handleGetNextId", () => {
  it("returns correct next ID with existing work items indexed", async () => {
    // Insert some work item nodes
    insertNode("WI-001", "work_item", { status: "done" });
    insertNode("WI-002", "work_item", { status: "done" });
    insertNode("WI-010", "work_item", { status: "pending" });

    const result = await handleGetNextId(ctx, { type: "work_item" });
    expect(result).toBe("WI-011");
  });

  it("returns first ID when no artifacts exist", async () => {
    const result = await handleGetNextId(ctx, { type: "guiding_principle" });
    expect(result).toBe("GP-01");
  });

  it("throws on unknown type", async () => {
    await expect(handleGetNextId(ctx, { type: "invalid" })).rejects.toThrow("Unknown type");
  });

  it("throws when type is missing", async () => {
    await expect(handleGetNextId(ctx, {})).rejects.toThrow("Missing required parameter: type");
  });

  it("type=project on empty DB returns PR-001", async () => {
    const result = await handleGetNextId(ctx, { type: "project" });
    expect(result).toBe("PR-001");
  });

  it("type=phase on empty DB returns PH-001", async () => {
    const result = await handleGetNextId(ctx, { type: "phase" });
    expect(result).toBe("PH-001");
  });
});

// ---------------------------------------------------------------------------
// handleWriteArtifact — project and phase
// ---------------------------------------------------------------------------

describe("handleWriteArtifact — project and phase types", () => {
  it("type=project creates YAML at projects/{id}.yaml and upserts DB row", async () => {
    const result = await handleWriteArtifact(ctx, {
      type: "project",
      id: "PR-001",
      content: {
        intent: "Build ideate 3.0 with YAML backend",
        success_criteria: ["All tests pass", "Build succeeds"],
        appetite: 6,
        status: "active",
      },
    });

    expect(result).toContain("project");
    expect(result).toContain("PR-001");

    // YAML file created
    const filePath = path.join(artifactDir, "projects", "PR-001.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("PR-001");
    expect(content).toContain("project");
    expect(content).toContain("Build ideate 3.0");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");
    expect(content).not.toContain("file_path:");

    // SQLite node row
    const nodeRow = db.prepare(`SELECT id, type, status FROM nodes WHERE id = 'PR-001'`).get() as { id: string; type: string; status: string } | undefined;
    expect(nodeRow).toBeDefined();
    expect(nodeRow!.type).toBe("project");
    expect(nodeRow!.status).toBe("active");

    // Extension table row
    const projRow = db.prepare(`SELECT id, intent, status, appetite FROM projects WHERE id = 'PR-001'`).get() as { id: string; intent: string; status: string; appetite: number | null } | undefined;
    expect(projRow).toBeDefined();
    expect(projRow!.intent).toBe("Build ideate 3.0 with YAML backend");
    expect(projRow!.status).toBe("active");
    expect(projRow!.appetite).toBe(6);
  });

  it("type=phase creates YAML at phases/{id}.yaml and upserts DB row", async () => {
    // First create a project node so FK is satisfied
    db.prepare(`INSERT OR REPLACE INTO nodes (id, type, cycle_created, content_hash, file_path, status) VALUES ('PR-001', 'project', NULL, 'hash', '/tmp/PR-001.yaml', 'active')`).run();
    db.prepare(`INSERT OR REPLACE INTO projects (id, intent, status) VALUES ('PR-001', 'Test project', 'active')`).run();

    const result = await handleWriteArtifact(ctx, {
      type: "phase",
      id: "PH-001",
      content: {
        project: "PR-001",
        phase_type: "implementation",
        intent: "Build MCP tools for project and phase",
        steering: "Follow P-44 two-phase write pattern",
        status: "active",
        work_items: ["WI-432", "WI-433", "WI-434"],
      },
    });

    expect(result).toContain("phase");
    expect(result).toContain("PH-001");

    // YAML file created
    const filePath = path.join(artifactDir, "phases", "PH-001.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("PH-001");
    expect(content).toContain("phase");
    expect(content).toContain("Build MCP tools");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");
    expect(content).not.toContain("file_path:");

    // SQLite node row
    const nodeRow = db.prepare(`SELECT id, type, status FROM nodes WHERE id = 'PH-001'`).get() as { id: string; type: string; status: string } | undefined;
    expect(nodeRow).toBeDefined();
    expect(nodeRow!.type).toBe("phase");
    expect(nodeRow!.status).toBe("active");

    // Extension table row
    const phaseRow = db.prepare(`SELECT id, project, phase_type, intent, status FROM phases WHERE id = 'PH-001'`).get() as { id: string; project: string; phase_type: string; intent: string; status: string } | undefined;
    expect(phaseRow).toBeDefined();
    expect(phaseRow!.project).toBe("PR-001");
    expect(phaseRow!.phase_type).toBe("implementation");
    expect(phaseRow!.intent).toBe("Build MCP tools for project and phase");
    expect(phaseRow!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// handleGetAutopilotState
// ---------------------------------------------------------------------------

describe("handleManageAutopilotState (get action)", () => {
  beforeEach(() => {
    // Tests in this describe exercise the filesystem fallback path of
    // autopilot-state.ts (not modified by WI-800). Clear the adapter so
    // those legacy paths run.
    ctx.adapter = undefined;
  });

  it("returns default state when no file exists", async () => {
    const result = await handleManageAutopilotState(ctx, { action: "get" });
    const state = JSON.parse(result);

    expect(state.cycles_completed).toBe(0);
    expect(state.convergence_achieved).toBe(false);
    expect(state.started_at).toBeNull();
    expect(state.last_phase).toBeNull();
    expect(state.deferred).toBe(false);
  });

  it("returns persisted state when file exists", async () => {
    // Write a autopilot-state.yaml directly
    const statePath = path.join(artifactDir, "autopilot-state.yaml");
    fs.writeFileSync(statePath, "cycles_completed: 3\nconvergence_achieved: true\nstarted_at: '2026-03-25T10:00:00Z'\n", "utf8");

    const result = await handleManageAutopilotState(ctx, { action: "get" });
    const state = JSON.parse(result);

    expect(state.cycles_completed).toBe(3);
    expect(state.convergence_achieved).toBe(true);
    expect(state.started_at).toBe("2026-03-25T10:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// handleUpdateAutopilotState
// ---------------------------------------------------------------------------

describe("handleManageAutopilotState (update action)", () => {
  beforeEach(() => {
    // Tests in this describe exercise the filesystem fallback path of
    // autopilot-state.ts (not modified by WI-800). Clear the adapter so
    // those legacy paths run.
    ctx.adapter = undefined;
  });

  it("creates state file and merges update when no file exists", async () => {
    const result = await handleManageAutopilotState(ctx, {
      action: "update",
      state: { cycles_completed: 1, started_at: "2026-03-26T09:00:00Z" },
    });
    const state = JSON.parse(result);

    expect(state.cycles_completed).toBe(1);
    expect(state.started_at).toBe("2026-03-26T09:00:00Z");
    expect(state.convergence_achieved).toBe(false); // default preserved

    // Verify file was written
    const statePath = path.join(artifactDir, "autopilot-state.yaml");
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("merges partial update onto existing state", async () => {
    // Create initial state
    await handleManageAutopilotState(ctx, {
      action: "update",
      state: { cycles_completed: 2, started_at: "2026-03-26T09:00:00Z" },
    });

    // Update only convergence
    const result = await handleManageAutopilotState(ctx, {
      action: "update",
      state: { convergence_achieved: true, last_phase: "review" },
    });
    const state = JSON.parse(result);

    expect(state.cycles_completed).toBe(2); // preserved
    expect(state.convergence_achieved).toBe(true); // updated
    expect(state.last_phase).toBe("review"); // added
    expect(state.started_at).toBe("2026-03-26T09:00:00Z"); // preserved
  });

  it("throws when state parameter is missing for update action", async () => {
    await expect(handleManageAutopilotState(ctx, { action: "update" })).rejects.toThrow("Missing required parameter: state");
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactPath routing via handleWriteArtifact
// ---------------------------------------------------------------------------

describe("handleWriteArtifact routing", () => {
  it("routes guiding_principle to principles/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "principles"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "guiding_principle",
      id: "GP-99",
      content: { name: "Test Principle", description: "A test guiding principle" },
    });

    expect(result).toContain("guiding_principle");
    expect(result).toContain("GP-99");
    const filePath = path.join(artifactDir, "principles", "GP-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("routes constraint to constraints/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "constraints"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "constraint",
      id: "C-99",
      content: { category: "technical", description: "A test constraint" },
    });

    expect(result).toContain("constraint");
    expect(result).toContain("C-99");
    const filePath = path.join(artifactDir, "constraints", "C-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("routes domain_policy to policies/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "policies"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "domain_policy",
      id: "P-99",
      content: { domain: "workflow", description: "Test policy" },
    });

    expect(result).toContain("domain_policy");
    expect(result).toContain("P-99");
    const filePath = path.join(artifactDir, "policies", "P-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
    const policyRow = ctx.db!.prepare("SELECT * FROM domain_policies WHERE id = ?").get("P-99");
    expect(policyRow).toBeTruthy();
  });

  it("routes domain_decision to decisions/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "decisions"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "domain_decision",
      id: "D-99",
      content: { domain: "workflow", description: "Test decision" },
    });

    expect(result).toContain("domain_decision");
    expect(result).toContain("D-99");
    const filePath = path.join(artifactDir, "decisions", "D-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
    const decisionRow = ctx.db!.prepare("SELECT * FROM domain_decisions WHERE id = ?").get("D-99");
    expect(decisionRow).toBeTruthy();
  });

  it("routes domain_question to questions/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "questions"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "domain_question",
      id: "Q-99",
      content: { domain: "workflow", description: "Test question" },
    });

    expect(result).toContain("domain_question");
    expect(result).toContain("Q-99");
    const filePath = path.join(artifactDir, "questions", "Q-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
    const questionRow = ctx.db!.prepare("SELECT * FROM domain_questions WHERE id = ?").get("Q-99");
    expect(questionRow).toBeTruthy();
  });

  it("writes cycle_summary to document_artifacts", async () => {
    const result = await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: "CS-test-001",
      cycle: 5,
      content: { title: "Test Summary", content: "Some content" },
    });

    expect(result).toContain("cycle_summary");
    expect(result).toContain("CS-test-001");
    const filePath = path.join(artifactDir, "cycles", "005", "CS-test-001.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
    const row = ctx.db!.prepare("SELECT * FROM document_artifacts WHERE id = ?").get("CS-test-001");
    expect(row).toBeTruthy();
    expect((row as Record<string, unknown>).cycle).toBe(5);
  });

  it("handleWriteArtifact injects cycle into YAML so rebuild populates document_artifacts.cycle", async () => {
    // Content deliberately has no 'cycle' field — the write handler must inject it
    await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: "CS-cycle-inject-001",
      cycle: 3,
      content: { title: "Injection Test", content: "body text" },
    });

    // 1. Live write must have populated document_artifacts.cycle immediately
    const liveRow = ctx.db!.prepare("SELECT cycle FROM document_artifacts WHERE id = 'CS-cycle-inject-001'").get() as { cycle: number | null } | undefined;
    expect(liveRow, "row should exist after live write").toBeDefined();
    expect(liveRow!.cycle, "live write must populate cycle").toBe(3);

    // 2. The written YAML file must contain a top-level 'cycle: 3' field so that
    //    a full rebuild (rebuildIndex) also produces document_artifacts.cycle = 3.
    const yamlPath = path.join(artifactDir, "cycles", "003", "CS-cycle-inject-001.yaml");
    expect(fs.existsSync(yamlPath), "YAML file must exist").toBe(true);
    const yamlContent = fs.readFileSync(yamlPath, "utf8");
    expect(yamlContent, "YAML must contain top-level cycle: 3").toMatch(/^cycle:\s*3\s*$/m);

    // 3. Simulate a rebuild: fresh in-memory DB, index just this file, assert cycle propagates
    const freshDb = new Database(":memory:");
    const { createSchema: cs } = await import("../schema.js");
    cs(freshDb);
    const { drizzle: dz } = await import("drizzle-orm/better-sqlite3");
    const freshDrizzle = dz(freshDb, { schema: dbSchema });
    indexFiles(freshDb, freshDrizzle, [yamlPath]);
    const rebuildRow = freshDb.prepare("SELECT cycle FROM document_artifacts WHERE id = 'CS-cycle-inject-001'").get() as { cycle: number | null } | undefined;
    expect(rebuildRow, "row should exist after rebuild").toBeDefined();
    expect(rebuildRow!.cycle, "rebuild must also populate cycle").toBe(3);
    freshDb.close();
  });

  it("writes research_finding to research_findings", async () => {
    fs.mkdirSync(path.join(artifactDir, "research"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "research_finding",
      id: "RF-test-001",
      content: { topic: "testing", content: "test research content" },
    });

    expect(result).toContain("research_finding");
    expect(result).toContain("RF-test-001");
    const row = ctx.db!.prepare("SELECT * FROM research_findings WHERE id = ?").get("RF-test-001");
    expect(row).toBeTruthy();
    expect((row as Record<string, unknown>).content).toBeTruthy();
  });

  it("writes module_spec to module_specs", async () => {
    fs.mkdirSync(path.join(artifactDir, "modules"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "module_spec",
      id: "MS-test-001",
      content: { name: "test-module", description: "desc" },
    });

    expect(result).toContain("module_spec");
    expect(result).toContain("MS-test-001");
    const row = ctx.db!.prepare("SELECT * FROM module_specs WHERE id = ?").get("MS-test-001");
    expect(row).toBeTruthy();
  });

  it("routes domain_index to domains/index.yaml", async () => {
    // domains dir already created in beforeEach

    const result = await handleWriteArtifact(ctx, {
      type: "domain_index",
      id: "index",
      content: { current_cycle: 5, domains: ["workflow", "infra"] },
    });

    expect(result).toContain("domain_index");
    expect(result).toContain("index");
    const filePath = path.join(artifactDir, "domains", "index.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("work_item redirect: caller-supplied id wins over content.id", async () => {
    // content contains a conflicting id (WI-999); the top-level id param (WI-001) must win
    await handleWriteArtifact(ctx, {
      type: "work_item",
      id: "WI-001",
      content: { id: "WI-999", title: "id override test" },
    });

    // The written YAML file should be at work-items/WI-001.yaml, not WI-999.yaml
    const correctPath = path.join(artifactDir, "work-items", "WI-001.yaml");
    const wrongPath = path.join(artifactDir, "work-items", "WI-999.yaml");
    expect(fs.existsSync(correctPath), "WI-001.yaml must exist").toBe(true);
    expect(fs.existsSync(wrongPath), "WI-999.yaml must not exist").toBe(false);

    // The DB node must record WI-001, not WI-999
    const row = ctx.db!.prepare("SELECT id FROM nodes WHERE id = 'WI-001'").get() as { id: string } | undefined;
    expect(row, "DB row for WI-001 must exist").toBeDefined();
    expect(row!.id).toBe("WI-001");
    const wrongRow = ctx.db!.prepare("SELECT id FROM nodes WHERE id = 'WI-999'").get();
    expect(wrongRow, "DB row for WI-999 must not exist").toBeUndefined();
  });

  it('redirects journal_entry to handleAppendJournal', async () => {
    await handleWriteArtifact(ctx, {
      type: 'journal_entry',
      id: 'J-001-001',
      content: {
        skill: 'execute',
        date: '2026-03-31',
        entry_type: 'test',
        body: 'body text',
        cycle_number: 1,
      },
    });
    const row = db.prepare("SELECT type FROM nodes WHERE type = 'journal_entry'").get();
    expect(row).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// P-46: TYPE_TO_EXTENSION_TABLE completeness
// Every type registered in TYPE_TO_EXTENSION_TABLE must have a dispatch branch
// in handleWriteArtifact that populates the corresponding extension table row.
// Excluded types (redirect to dedicated handlers, no extension row written by handleWriteArtifact):
//   work_item → handleWriteWorkItems
//   journal_entry → handleAppendJournal
// ---------------------------------------------------------------------------
describe("P-46: TYPE_TO_EXTENSION_TABLE completeness", () => {
  // Types that redirect to dedicated handlers and do NOT produce extension rows via handleWriteArtifact
  const EXCLUDED_TYPES = new Set(["work_item", "journal_entry"]);

  type TestCase = {
    type: string;
    id: string;
    content: Record<string, unknown>;
    tableName: string;
    cycle?: number;
    checkFields?: (row: Record<string, unknown>) => void;
  };

  const cases: TestCase[] = [
    {
      type: "finding", id: "F-p46-001",
      content: { severity: "minor", work_item: "WI-p46", verdict: "Pass", cycle: 999, reviewer: "test-reviewer" },
      tableName: "findings", cycle: 999,
      checkFields: (row) => {
        expect(row.severity).toBe("minor");
        expect(row.work_item).toBe("WI-p46");
        expect(row.verdict).toBe("Pass");
        expect(row.cycle).toBe(999);
        expect(row.reviewer).toBe("test-reviewer");
      },
    },
    { type: "domain_policy", id: "P-p46", content: { domain: "workflow" }, tableName: "domain_policies" },
    { type: "domain_decision", id: "D-p46", content: { domain: "workflow" }, tableName: "domain_decisions" },
    { type: "domain_question", id: "Q-p46", content: { domain: "workflow" }, tableName: "domain_questions" },
    { type: "guiding_principle", id: "GP-p46", content: { name: "test principle" }, tableName: "guiding_principles" },
    { type: "constraint", id: "C-p46", content: { category: "technical" }, tableName: "constraints" },
    { type: "module_spec", id: "MS-p46", content: { name: "p46-module" }, tableName: "module_specs" },
    { type: "research_finding", id: "RF-p46", content: { topic: "test", content: "test content" }, tableName: "research_findings" },
    {
      type: "interview_question", id: "IQ-p46",
      content: { interview_id: "refine-001", question: "q?", answer: "a-answer", seq: 1 },
      tableName: "interview_questions",
      checkFields: (row) => {
        expect(row.interview_id).toBe("refine-001");
        expect(row.question).toBe("q?");
        expect(row.answer).toBe("a-answer");
        expect(row.seq).toBe(1);
      },
    },
    { type: "proxy_human_decision", id: "PHD-p46", content: { cycle: 777, trigger: "test", decision: "proceed", timestamp: "2026-03-29T00:00:00Z" }, tableName: "proxy_human_decisions", cycle: 777 },
    { type: "cycle_summary", id: "CS-p46", content: { title: "p46 summary" }, tableName: "document_artifacts", cycle: 888 },
    { type: "review_output", id: "RO-p46", content: { title: "p46 review" }, tableName: "document_artifacts", cycle: 888 },
    { type: "review_manifest", id: "RM-p46", content: { title: "p46 manifest" }, tableName: "document_artifacts", cycle: 888 },
    { type: "decision_log", id: "DL-p46", content: { title: "p46 decisions" }, tableName: "document_artifacts", cycle: 888 },
    { type: "overview", id: "overview-p46", content: { title: "p46 overview" }, tableName: "document_artifacts" },
    { type: "architecture", id: "arch-p46", content: { title: "p46 arch" }, tableName: "document_artifacts" },
    { type: "execution_strategy", id: "exec-p46", content: { title: "p46 exec" }, tableName: "document_artifacts" },
    { type: "guiding_principles", id: "gp-all-p46", content: { title: "all principles" }, tableName: "document_artifacts" },
    { type: "constraints", id: "c-all-p46", content: { title: "all constraints" }, tableName: "document_artifacts" },
    { type: "research", id: "rs-p46", content: { title: "research" }, tableName: "document_artifacts" },
    { type: "interview", id: "refine-p46", content: { title: "interview" }, tableName: "document_artifacts" },
    { type: "domain_index", id: "index", content: { current_cycle: 1 }, tableName: "document_artifacts" },
    {
      type: "project", id: "PR-p46",
      content: { intent: "p46 project intent", status: "active" },
      tableName: "projects",
      checkFields: (row) => {
        expect(row.intent).toBe("p46 project intent");
        expect(row.status).toBe("active");
      },
    },
    {
      type: "phase", id: "PH-p46",
      content: { project: "PR-p46", phase_type: "implementation", intent: "p46 phase intent", status: "pending" },
      tableName: "phases",
      checkFields: (row) => {
        expect(row.project).toBe("PR-p46");
        expect(row.phase_type).toBe("implementation");
        expect(row.intent).toBe("p46 phase intent");
      },
    },
  ];

  it("cases array covers all TYPE_TO_EXTENSION_TABLE types (except redirected) — bidirectional", () => {
    const expectedTypes = Object.keys(registryTypeToExtensionTable).filter(t => !EXCLUDED_TYPES.has(t));
    const coveredTypes = cases.map(c => c.type);
    // Every registry type must have a test case
    for (const t of expectedTypes) {
      expect(coveredTypes).toContain(t);
    }
    // Every test case must correspond to a registry type (no stale entries)
    for (const t of coveredTypes) {
      expect(expectedTypes).toContain(t);
    }
  });

  it.each(cases)("type '$type' populates extension table '$tableName'", async ({ type, id, content, tableName, cycle, checkFields }) => {
    const args: Record<string, unknown> = { type, id, content };
    if (cycle !== undefined) args.cycle = cycle;

    await handleWriteArtifact(ctx, args);

    const row = ctx.db!.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row).toBeTruthy();
    if (checkFields) checkFields(row);
  });
});

// ---------------------------------------------------------------------------
// WI-491: interview_question dispatch branch
// ---------------------------------------------------------------------------
describe("handleWriteArtifact — interview_question dispatch branch", () => {
  it("populates both nodes and interview_questions extension table", async () => {
    await handleWriteArtifact(ctx, {
      type: "interview_question",
      id: "IQ-491-001",
      content: {
        interview_id: "refine-491",
        question: "What is the target audience?",
        answer: "Developers using Claude Code.",
        seq: 1,
      },
    });

    const nodeRow = ctx.db!.prepare("SELECT * FROM nodes WHERE id = ?").get("IQ-491-001") as Record<string, unknown>;
    expect(nodeRow).toBeTruthy();
    expect(nodeRow.type).toBe("interview_question");

    const extRow = ctx.db!.prepare("SELECT interview_id, question, answer, seq FROM interview_questions WHERE id = ?").get("IQ-491-001") as Record<string, unknown>;
    expect(extRow).toBeTruthy();
    expect(extRow.interview_id).toBe("refine-491");
    expect(extRow.question).toBe("What is the target audience?");
    expect(extRow.answer).toBe("Developers using Claude Code.");
    expect(extRow.seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Write-to-convergence roundtrip
// ---------------------------------------------------------------------------

describe("write-to-convergence roundtrip", () => {
  it("Pass verdict: writing cycle_summary with Pass verdict yields condition_b=true and principle_verdict=pass", async () => {
    // Write a spec-adherence cycle_summary with a Pass verdict via handleWriteArtifact.
    // WI-824: canonical id "spec-adherence" is required — legacy SA-NNN ids are no longer
    // visible to getConvergenceData under strict canonical-only selection (fix option c).
    await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: "spec-adherence",
      cycle: 1,
      content: {
        title: "Spec adherence cycle 1",
        content: "## Spec Adherence\n\n**Principle Violation Verdict**: Pass\n\n## Principle Violations\n\nNone.",
      },
    });

    // No critical/significant findings for cycle 1 → condition_a: true
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 1 });

    expect(result).toContain("condition_b: true");
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_a: true");
    expect(result).toContain("converged: true");
  });

  it("Fail verdict: writing cycle_summary with Fail verdict yields condition_b=false and principle_verdict=fail", async () => {
    // Write a spec-adherence cycle_summary with a Fail verdict via handleWriteArtifact.
    // WI-824: canonical id "spec-adherence" is required — legacy SA-NNN ids are no longer
    // visible to getConvergenceData under strict canonical-only selection (fix option c).
    await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: "spec-adherence",
      cycle: 2,
      content: {
        title: "Spec adherence cycle 2",
        content: "## Spec Adherence\n\n**Principle Violation Verdict**: Fail\n\n## Principle Violations\n\n### GP-01: Spec Sufficiency\n- Executor made design decisions not present in spec.",
      },
    });

    // No critical/significant findings for cycle 2 (condition_a independent of verdict)
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 2 });

    expect(result).toContain("condition_b: false");
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_a: true");
    expect(result).toContain("converged: false");
  });

  it("writes spec-adherence with verdict Pass and convergence reports condition_b true", async () => {
    // GA-II1 roundtrip: write spec-adherence artifact via handleWriteArtifact then verify
    // getConvergenceData picks it up correctly — exercises the DB write→query chain end-to-end.
    await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: "spec-adherence",
      cycle: 88,
      content: {
        reviewer: "spec-reviewer",
        content: "## Principle Violation Verdict: Pass\n\nNone.",
      },
    });

    // No critical/significant findings for cycle 88 → condition_a: true
    // spec-adherence content contains Principle Violation section with None. → condition_b: true
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 88 });

    expect(result).toContain("condition_b: true");
    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
  });
});

// ---------------------------------------------------------------------------
// P-33 compliance: tool responses must not leak absolute .ideate/ paths
// ---------------------------------------------------------------------------

describe("P-33 compliance: no absolute .ideate/ paths in tool responses", () => {
  // Matches any absolute path containing .ideate/ (e.g. /Users/foo/.ideate/work-items/...)
  const PATH_LEAK_RE = /\/[\w/.-]*\.ideate\//;

  it("handleWriteWorkItems response contains no .ideate/ path", async () => {
    const result = await handleWriteWorkItems(ctx, {
      items: [{ id: "WI-P33-01", title: "P-33 write work item test" }],
    });
    expect(result).not.toMatch(PATH_LEAK_RE);
  });

  it("handleUpdateWorkItems response contains no .ideate/ path", async () => {
    // Seed the work item first
    await handleWriteWorkItems(ctx, {
      items: [{ id: "WI-P33-02", title: "P-33 update work item test" }],
    });
    const result = await handleUpdateWorkItems(ctx, {
      updates: [{ id: "WI-P33-02", status: "done" }],
    });
    expect(result).not.toMatch(PATH_LEAK_RE);
  });

  it("handleWriteArtifact response contains no .ideate/ path", async () => {
    fs.mkdirSync(path.join(artifactDir, "policies"), { recursive: true });
    const result = await handleWriteArtifact(ctx, {
      type: "domain_policy",
      id: "P-P33-01",
      content: { domain: "workflow", description: "P-33 compliance policy" },
    });
    expect(result).not.toMatch(PATH_LEAK_RE);
  });

  it("handleAppendJournal response contains no .ideate/ path", async () => {
    const result = await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-03-31",
      entry_type: "work-item-complete",
      body: "P-33 compliance test entry.",
      cycle_number: 5,
    });
    expect(result).not.toMatch(PATH_LEAK_RE);
  });

  it("handleArtifactQuery response contains no .ideate/ path", async () => {
    insertNode("WI-P33-03", "work_item", { status: "pending" });
    insertWorkItem("WI-P33-03", "P-33 query test item");
    const result = await handleArtifactQuery(ctx, { type: "work_item" });
    expect(result).not.toMatch(PATH_LEAK_RE);
  });

  it("handleGetExecutionStatus response contains no .ideate/ path", async () => {
    ctx.adapter = new LocalAdapter({ db, drizzleDb: ctx.drizzleDb!, ideateDir: artifactDir });
    insertNode("WI-P33-04", "work_item", { status: "pending" });
    insertWorkItem("WI-P33-04", "P-33 execution status item");
    const result = await handleGetExecutionStatus(ctx, {});
    expect(result).not.toMatch(PATH_LEAK_RE);
  });

  it("handleGetWorkspaceStatus response contains no .ideate/ path", async () => {
    insertNode("WI-P33-05", "work_item", { status: "done" });
    insertWorkItem("WI-P33-05", "P-33 workspace status item");
    const result = await handleGetWorkspaceStatus(ctx, {});
    expect(result).not.toMatch(PATH_LEAK_RE);
  });

  // WI-878 S6: handleGetConvergenceStatus — principle_verdict_warning must not contain absolute paths
  it("handleGetConvergenceStatus response contains no .ideate/ path (missing summary code path)", async () => {
    // Cycle 996 has no data — exercises the missing-summary warning path (S3 in analysis.ts).
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 996 });
    expect(result).not.toMatch(PATH_LEAK_RE);
    // Also assert the warning line specifically does not leak
    const warningLine = result.split("\n").find((l) => l.startsWith("principle_verdict_warning:"));
    if (warningLine !== undefined) {
      expect(warningLine).not.toMatch(PATH_LEAK_RE);
    }
  });

  it("handleGetConvergenceStatus principle_verdict_warning contains no .ideate/ path (malformed content path)", async () => {
    // Step 3 (malformed content) also emits a warning — confirm no path leak.
    const cycleDir = path.join(artifactDir, "cycles", "995");
    fs.mkdirSync(cycleDir, { recursive: true });
    const filePath = path.join(cycleDir, "spec-adherence.yaml");
    fs.writeFileSync(filePath, "id: spec-adherence-995\ntype: cycle_summary\ncycle: 995\n", "utf8");
    insertNode("spec-adherence-995", "cycle_summary", { file_path: filePath, cycle_created: 995 });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run("spec-adherence-995", 995, "Verdict: unclear — no structured format present");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 995 });
    expect(result).not.toMatch(PATH_LEAK_RE);
    const warningLine = result.split("\n").find((l) => l.startsWith("principle_verdict_warning:"));
    if (warningLine !== undefined) {
      expect(warningLine).not.toMatch(PATH_LEAK_RE);
    }
  });
});
