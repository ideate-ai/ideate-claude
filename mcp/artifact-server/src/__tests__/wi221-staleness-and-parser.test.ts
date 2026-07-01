/**
 * wi221-staleness-and-parser.test.ts — Regression tests for WI-221.
 *
 * WI-221 fixes the Q-160-class bug that bit PR-002 twice: `ideate_get_convergence_status`
 * read a STALE `spec-adherence` artifact left in a REUSED cycle-directory slot (its
 * embedded `cycle` field was from a prior cycle) and either (a) silently returned that
 * stale artifact's verdict as authoritative, or (b) reported a generic
 * "no cycle_summary found" without surfacing that a stale artifact existed — requiring
 * a human to manually diagnose and hand-refresh the artifact.
 *
 * This suite covers:
 *   1. Staleness detection when getConvergenceData DOES return content, but that
 *      content's own embedded `cycle:` field predates the requested cycle (the
 *      "reused cycle-directory slot" reproducer) — the stale verdict must never be
 *      returned as authoritative; the checker must report principle_verdict:unknown
 *      with source:stale and surface stale_artifact_cycle / stale_artifact_cycle_modified.
 *   2. Staleness diagnostics enrichment when getConvergenceData returns NO content for
 *      the requested cycle, but a stale spec-adherence/summary artifact from an earlier
 *      cycle is discoverable via the (cycle-scoped-by-id) node index.
 *   3. Non-stale regression: content whose embedded cycle matches the requested cycle
 *      is NOT flagged as stale and parses normally.
 *   4. Parser corpus: the PR-002 failing phrasings (widened grammar) all resolve to the
 *      correct verdict; unparseable content still resolves to unknown (never fail) with
 *      diagnostics.
 *   5. Three-way branch semantics are unchanged: unknown (including the new stale
 *      sub-case) is never folded into fail — condition_b is false but principle_verdict
 *      stays "unknown", not "fail".
 *
 * See: skills/review/SKILL.md "Cycle-Slot Hygiene (WI-221)", skills/autopilot/phases/review.md
 * "Phase 6c: Convergence Branch (three-way)".
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import type { ToolContext } from "../types.js";
import { LocalAdapter } from "../adapters/local/index.js";
import { handleGetConvergenceStatus } from "../tools/analysis.js";
import { handleWriteArtifact } from "../tools/write.js";
import { signalIndexReady } from "../tools/index.js";

beforeAll(() => {
  signalIndexReady();
});

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-wi221-test-"));
  artifactDir = path.join(tmpDir, "artifact");

  for (const sub of ["archive/incremental", "archive/cycles", "plan/work-items", "plan/notes", "domains"]) {
    fs.mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }

  fs.writeFileSync(path.join(artifactDir, "journal.md"), "", "utf8");
  fs.writeFileSync(
    path.join(artifactDir, "domains", "index.yaml"),
    "current_cycle: 3\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);

  const drizzleDb = drizzle(db, { schema: dbSchema });
  ctx = { db, drizzleDb, ideateDir: artifactDir };
  ctx.adapter = new LocalAdapter({ db, drizzleDb, ideateDir: artifactDir });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertNode(
  id: string,
  type: string,
  options: { status?: string; file_path?: string; cycle_created?: number } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
     VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)`
  ).run(
    id,
    type,
    options.cycle_created ?? null,
    "placeholder-hash",
    options.file_path ?? `/tmp/${id}.yaml`,
    options.status ?? "active"
  );
}

/**
 * Write a canonical spec-adherence.yaml directly to disk under
 * cycles/{dirCycle} (the "slot"), with `cycle: {embeddedCycle}` embedded in
 * the YAML — simulating a slot whose on-disk content was never refreshed
 * for the directory's nominal cycle number. NO document_artifacts row is
 * inserted, forcing getConvergenceData's raw-file fallback path (mirrors
 * the existing WI-797/WI-824/WI-831 "file_path fallback" test pattern).
 */
function seedRawSlotArtifact(dirCycle: number, embeddedCycle: number, verdictBody: string, cycleModified?: number): string {
  const cycleDir = path.join(artifactDir, "cycles", String(dirCycle).padStart(3, "0"));
  fs.mkdirSync(cycleDir, { recursive: true });
  const filePath = path.join(cycleDir, "spec-adherence.yaml");
  const cycleModifiedLine = cycleModified !== undefined ? `cycle_modified: ${cycleModified}\n` : "";
  fs.writeFileSync(
    filePath,
    `id: spec-adherence-${dirCycle}\ntype: cycle_summary\ncycle: ${embeddedCycle}\n${cycleModifiedLine}content: |-\n  ${verdictBody.split("\n").join("\n  ")}\n`,
    "utf8"
  );
  insertNode(`spec-adherence-${dirCycle}`, "cycle_summary", { file_path: filePath, cycle_created: dirCycle });
  return filePath;
}

// ---------------------------------------------------------------------------
// 1. Staleness detection — content returned, but embedded cycle predates request
// ---------------------------------------------------------------------------

describe("WI-221: stale cycle-slot detection (content returned but embedded cycle is prior)", () => {
  it("reused cycle-directory slot: content says Pass but embedded cycle predates the requested cycle → unknown, not pass", async () => {
    // Reproducer: directory cycles/205 exists (the "slot" for cycle 205), but the
    // spec-adherence.yaml sitting there was actually last written for cycle 200
    // (a reused/never-refreshed slot) and its content says Pass.
    seedRawSlotArtifact(205, 200, "**Principle Violation Verdict**: Pass\n\nAll reviewers returned Pass.", 199);

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 205 });

    // Must NEVER return the stale Pass verdict as authoritative.
    expect(result).not.toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: stale");
    expect(result).toContain("condition_b: false");
    expect(result).toContain("converged: false");
    expect(result).toContain("stale_artifact_cycle: 200");
    expect(result).toContain("stale_artifact_cycle_modified: 199");
    expect(result).toContain("principle_verdict_warning:");
    expect(result).toContain("stale");
  });

  it("reused cycle-directory slot: content says Fail but embedded cycle predates the requested cycle → still unknown (not silently fail either)", async () => {
    // Staleness must override the parsed verdict regardless of what that stale
    // verdict happens to be — a stale Fail must not be trusted any more than a
    // stale Pass. Only condition_b:false is a legitimate side effect of unknown.
    seedRawSlotArtifact(210, 190, "## Verdict: Fail\n\nTwo principle violations found.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 210 });

    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: stale");
    expect(result).toContain("stale_artifact_cycle: 190");
  });

  it("boundary: embedded cycle exactly one behind requested cycle is still stale (strict less-than)", async () => {
    seedRawSlotArtifact(50, 49, "**Principle Violation Verdict**: Pass\n");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 50 });

    expect(result).toContain("principle_verdict_source: stale");
    expect(result).toContain("stale_artifact_cycle: 49");
  });
});

// ---------------------------------------------------------------------------
// 2. Staleness diagnostics when no content matches the requested cycle at all
// ---------------------------------------------------------------------------

describe("WI-221: staleness diagnostics enrichment when getConvergenceData returns no content", () => {
  it("no cycle_summary matches the requested cycle, but a stale spec-adherence node exists from an earlier cycle → warning surfaces it", async () => {
    // Write a real spec-adherence artifact for cycle 12 via the production write path
    // (global, non-cycle-scoped id "spec-adherence" — matches skills/review/SKILL.md).
    await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: "spec-adherence",
      cycle: 12,
      content: {
        title: "spec-adherence",
        content: "**Principle Violation Verdict**: Pass\n\nAll reviewers returned Pass.",
      },
    });

    // Query a LATER cycle (20) for which no cycle_summary was ever written.
    // getConvergenceData(20) returns null content (da.cycle=12 != 20, and the
    // file lives under cycles/012/, not cycles/020/) — the generic "no
    // cycle_summary found" path is enriched with staleness diagnostics.
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 20 });

    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).toContain("stale_artifact_cycle: 12");
    expect(result).toContain("principle_verdict_warning:");
    expect(result).toContain("stale artifact detected");
  });

  it("no cycle_summary matches and no artifact exists at all → generic no-data warning, no stale fields", async () => {
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 999 });

    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).not.toContain("stale_artifact_cycle:");
    expect(result).toContain("no cycle_summary found for cycle 999");
  });
});

// ---------------------------------------------------------------------------
// 3. Non-stale regression: matching embedded cycle is trusted
// ---------------------------------------------------------------------------

describe("WI-221: non-stale regression — matching embedded cycle is not flagged", () => {
  it("embedded cycle equals requested cycle → parses normally, no staleness fields", async () => {
    seedRawSlotArtifact(60, 60, "**Principle Violation Verdict**: Pass\n\nAll reviewers returned Pass.");

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 60 });

    expect(result).toContain("principle_verdict: pass");
    expect(result).toContain("principle_verdict_source: step1");
    expect(result).toContain("condition_b: true");
    expect(result).not.toContain("stale_artifact_cycle:");
    expect(result).not.toContain("principle_verdict_source: stale");
  });

  it("content with no embedded cycle field at all (JSON/document_artifacts.content path) is never flagged stale", async () => {
    // Mirrors the real production write path: document_artifacts.content is
    // populated (non-null), so getConvergenceData returns the bare markdown text
    // with no embedded `cycle:` field — detectEmbeddedStaleness must be a no-op.
    await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: "spec-adherence",
      cycle: 30,
      content: {
        title: "spec-adherence",
        content: "**Principle Violation Verdict**: Pass\n\nAll reviewers returned Pass.",
      },
    });

    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 30 });

    expect(result).toContain("principle_verdict: pass");
    expect(result).not.toContain("stale_artifact_cycle:");
  });
});

// ---------------------------------------------------------------------------
// 4. Parser corpus — PR-002 failing phrasings + widened grammar
// ---------------------------------------------------------------------------

describe("WI-221: parser corpus (widened verdict grammar)", () => {
  /** Drive parsePrincipleVerdict indirectly via handleGetConvergenceStatus. */
  async function verdictFor(cycle: number, content: string): Promise<string> {
    seedRawSlotArtifact(cycle, cycle, content);
    return handleGetConvergenceStatus(ctx, { cycle_number: cycle });
  }

  const PASS_CASES: Array<[string, string]> = [
    ["**Principle Adherence Verdict**: Pass (bold, colon outside)", "**Principle Adherence Verdict**: Pass\n\nNone."],
    ["**Principle Adherence Verdict:** Pass (bold, colon inside)", "**Principle Adherence Verdict:** Pass\n\nNone."],
    ["Principle Adherence Verdict: Pass (plain)", "Principle Adherence Verdict: Pass\n\nNone."],
    ["**Principle Adherence Verdict: Pass** (all-bold)", "**Principle Adherence Verdict: Pass**\n\nNone."],
    ["**Principle Violation Verdict**: Pass (legacy, bold)", "**Principle Violation Verdict**: Pass\n\nNone."],
    ["Principle Violation Verdict: Pass (legacy, plain)", "Principle Violation Verdict: Pass\n\nNone."],
    ["Principle Verdict: Pass (bare synonym)", "Principle Verdict: Pass\n\nNone."],
    ["**Principle Verdict: Pass** (bare synonym all-bold)", "**Principle Verdict: Pass**\n\nNone."],
    ["## Verdict: Pass (heading fallback)", "## Verdict: Pass\n\nAll reviewers returned Pass."],
  ];

  const FAIL_CASES: Array<[string, string]> = [
    ["**Principle Adherence Verdict**: Fail", "**Principle Adherence Verdict**: Fail\n\n### Violation\nSomething broke."],
    ["Principle Violation Verdict: Fail (legacy)", "Principle Violation Verdict: Fail\n\n### Violation\nSomething broke."],
    ["Principle Verdict: Fail (bare synonym)", "Principle Verdict: Fail\n\n### Violation\nSomething broke."],
    ["## Verdict: Fail (heading fallback)", "## Verdict: Fail\n\nTwo principle violations found."],
  ];

  let cycleCounter = 400;

  for (const [label, content] of PASS_CASES) {
    it(`resolves pass — ${label}`, async () => {
      const cycle = cycleCounter++;
      const result = await verdictFor(cycle, content);
      expect(result).toContain("principle_verdict: pass");
      expect(result).toContain("principle_verdict_source: step1");
    });
  }

  for (const [label, content] of FAIL_CASES) {
    it(`resolves fail — ${label}`, async () => {
      const cycle = cycleCounter++;
      const result = await verdictFor(cycle, content);
      expect(result).toContain("principle_verdict: fail");
      expect(result).toContain("principle_verdict_source: step1");
    });
  }

  it("word-boundary guard: 'Passed'/'Failed' prose does not false-positive as Pass/Fail", async () => {
    const cycle = cycleCounter++;
    const result = await verdictFor(
      cycle,
      "The build Passed CI and the deploy Failed later due to an unrelated infra issue.\n\nNone."
    );
    // Neither Pass nor Fail should match via the word-boundary-guarded Step 1
    // patterns; this falls through to unknown (step3), never silently to fail.
    expect(result).toContain("principle_verdict: unknown");
    expect(result).not.toContain("principle_verdict: fail");
  });

  it("unparseable content resolves to unknown (never fail) with diagnostics in the warning", async () => {
    const cycle = cycleCounter++;
    const result = await verdictFor(cycle, "This review has no recognizable verdict tag anywhere in it.");

    expect(result).toContain("principle_verdict: unknown");
    expect(result).toContain("principle_verdict_source: step3");
    expect(result).not.toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict_warning:");
    expect(result).toContain("patterns tried:");
    expect(result).toContain("content snippet:");
  });
});

// ---------------------------------------------------------------------------
// 5. Three-way branch semantics unchanged — unknown (including stale) != fail
// ---------------------------------------------------------------------------

describe("WI-221: three-way branch semantics preserved (unknown, including stale, never folds into fail)", () => {
  it("stale detection never emits principle_verdict: fail", async () => {
    seedRawSlotArtifact(70, 10, "## Verdict: Fail\n\nSevere violations.");
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 70 });
    expect(result).not.toContain("principle_verdict: fail");
    expect(result).toContain("principle_verdict: unknown");
  });

  it("genuine fail (non-stale) is still reported as fail, not folded into unknown", async () => {
    seedRawSlotArtifact(80, 80, "**Principle Adherence Verdict**: Fail\n\n### Violation\nReal violation.");
    const result = await handleGetConvergenceStatus(ctx, { cycle_number: 80 });
    expect(result).toContain("principle_verdict: fail");
    expect(result).toContain("condition_b: false");
  });
});
