/**
 * append-journal-cycle-resolution.test.ts — WI-219 regression coverage.
 *
 * Bug: ideate_append_journal failed deterministically with
 * "Error: cycle must be a positive integer, received 0" during autopilot
 * cycles, even when the domain/autopilot cycle was already set (e.g. 5/6).
 * handleAppendJournal only ever derived its cycle from caller-supplied
 * cycle_number or the max cycle_created across existing journal_entry
 * nodes — never from domain/autopilot state — so a fresh cycle directory
 * (no prior journal entries yet) produced 0, and the production adapter
 * stack (ValidatingAdapter wrapping LocalAdapter, exactly as server.ts
 * wires it) rejected that 0 as an invalid cycle.
 *
 * These tests reproduce the failing workspace state (ValidatingAdapter +
 * domain/autopilot cycle set, no explicit cycle_number arg) and assert the
 * write now succeeds with cycle attribution resolved as
 * max(domain.current_cycle, autopilot.cycles_completed).
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
import { ValidatingAdapter } from "../validating.js";
import { handleAppendJournal } from "../tools/write.js";
import { handleManageAutopilotState } from "../tools/autopilot-state.js";
import { signalIndexReady } from "../tools/index.js";

beforeAll(() => {
  signalIndexReady();
});

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let ctx: ToolContext;

/**
 * Build a ToolContext wired the same way server.ts wires production
 * contexts: adapter = ValidatingAdapter(LocalAdapter(...)). Earlier
 * regression coverage for handleAppendJournal used a bare LocalAdapter,
 * which never exercised the "cycle must be a positive integer" throw at
 * all — this is why the bug shipped undetected.
 */
function setupWorkspace(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-append-journal-cycle-"));
  artifactDir = path.join(tmpDir, "artifact");

  for (const sub of ["archive/incremental", "archive/cycles", "plan/work-items", "plan/notes", "domains"]) {
    fs.mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(artifactDir, "journal.md"), "", "utf8");

  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);
  const drizzleDb = drizzle(db, { schema: dbSchema });

  const rawAdapter = new LocalAdapter({ db, drizzleDb, ideateDir: artifactDir });
  ctx = {
    db,
    drizzleDb,
    ideateDir: artifactDir,
    adapter: new ValidatingAdapter(rawAdapter),
  };
}

function teardownWorkspace(): void {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeDomainCurrentCycle(cycle: number): void {
  fs.writeFileSync(
    path.join(artifactDir, "domains", "index.yaml"),
    `current_cycle: ${cycle}\n`,
    "utf8"
  );
}

async function setAutopilotCyclesCompleted(cycles: number): Promise<void> {
  await handleManageAutopilotState(ctx, {
    action: "update",
    state: { cycles_completed: cycles },
  });
}

describe("WI-219: handleAppendJournal cycle resolution", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  it("reproduces the failing state (ValidatingAdapter, domain/autopilot cycle set, no explicit cycle_number) and now succeeds", async () => {
    // Reproduce exactly the reported scenario: domain cycle 5, autopilot
    // cycles_completed 6, no journal entries yet, no cycle_number arg.
    writeDomainCurrentCycle(5);
    await setAutopilotCyclesCompleted(6);

    const result = await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-06-30",
      entry_type: "work-item-complete",
      body: "Completed WI-219: fix append_journal cycle=0 failure.",
      // cycle_number intentionally omitted — this is the state that used to
      // derive cycleNumber = 0 and throw.
    });

    expect(result).toContain("Wrote journal entry");

    // max(domain.current_cycle=5, autopilot.cycles_completed=6) === 6
    expect(result).toContain("J-006-001");
    const yamlPath = path.join(artifactDir, "cycles", "006", "journal", "J-006-001.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    const row = db.prepare(`SELECT cycle_created FROM nodes WHERE id = ?`).get("J-006-001") as
      | { cycle_created: number }
      | undefined;
    expect(row?.cycle_created).toBe(6);
  });

  it("resolves cycle as max(domain.current_cycle, autopilot.cycles_completed) when domain is ahead", async () => {
    writeDomainCurrentCycle(9);
    await setAutopilotCyclesCompleted(2);

    const result = await handleAppendJournal(ctx, {
      skill: "plan",
      date: "2026-06-30",
      entry_type: "cycle-start",
      body: "Starting cycle 9.",
    });

    expect(result).toContain("J-009-001");
  });

  it("still honors an explicit cycle_number argument over resolved state", async () => {
    writeDomainCurrentCycle(5);
    await setAutopilotCyclesCompleted(6);

    const result = await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-06-30",
      entry_type: "note",
      body: "Explicit cycle override.",
      cycle_number: 3,
    });

    expect(result).toContain("J-003-001");
  });

  it("still rejects an explicit non-positive cycle_number (validation preserved)", async () => {
    writeDomainCurrentCycle(5);
    await setAutopilotCyclesCompleted(6);

    await expect(
      handleAppendJournal(ctx, {
        skill: "execute",
        date: "2026-06-30",
        entry_type: "note",
        body: "Explicit invalid cycle.",
        cycle_number: 0,
      })
    ).rejects.toThrow(/cycle must be a positive integer/);
  });

  it("falls back to legacy journal-history-derived cycle when domain/autopilot state is absent", async () => {
    // No domains/index.yaml, no autopilot-state.yaml. Seed one prior journal
    // entry at cycle 4 via an explicit write, then append without cycle_number.
    await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-06-29",
      entry_type: "note",
      body: "Prior entry at cycle 4.",
      cycle_number: 4,
    });

    const result = await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-06-30",
      entry_type: "note",
      body: "Follow-up entry, no explicit cycle.",
    });

    expect(result).toContain("J-004-002");
  });

  it("defaults to cycle 1 (never throws) when no domain, autopilot, or journal history exists", async () => {
    const result = await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-06-30",
      entry_type: "note",
      body: "First-ever entry in a fresh workspace.",
    });

    expect(result).toContain("J-001-001");
  });

  it("ignores a non-positive domain current_cycle and falls back to autopilot cycles_completed", async () => {
    writeDomainCurrentCycle(0);
    await setAutopilotCyclesCompleted(7);

    const result = await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-06-30",
      entry_type: "note",
      body: "Domain cycle is 0, autopilot is 7.",
    });

    expect(result).toContain("J-007-001");
  });
});
