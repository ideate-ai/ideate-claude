/**
 * migrate-status-vocab.test.ts — Tests for scripts/migrate-status-vocab.ts (WI-220)
 *
 * Covers:
 *   - legacy synonym mapping (complete/completed -> done, unknown/null -> pending)
 *   - preservation of already-canonical values (pending/in_progress/done/obsolete/blocked)
 *   - unanticipated values are normalized (not silently passed through) and reported
 *   - backup is created before any writes
 *   - YAML files AND the SQLite index are both updated (writer/indexer consistency)
 *   - idempotency: re-running the migration after a successful run performs zero writes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

import { migrateStatusVocab } from "../scripts/migrate-status-vocab.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;

function writeWorkItem(
  id: string,
  title: string,
  status: string | null | undefined
): void {
  const lines = [`id: ${id}`, `type: work_item`, `title: "${title}"`];
  if (status !== undefined) {
    lines.push(`status: ${status === null ? "null" : status}`);
  }
  fs.writeFileSync(
    path.join(workspaceDir, "work-items", `${id}.yaml`),
    lines.join("\n") + "\n",
    "utf8"
  );
}

function readStatusFromYaml(id: string): string | null {
  const content = fs.readFileSync(
    path.join(workspaceDir, "work-items", `${id}.yaml`),
    "utf8"
  );
  const match = content.match(/^status:\s*(.*)$/m);
  if (!match) return null;
  const val = match[1].trim();
  return val === "null" || val === "" ? null : val;
}

function readStatusFromIndex(id: string): string | null {
  const db = new Database(path.join(workspaceDir, "index.db"), { readonly: true });
  try {
    const row = db.prepare(`SELECT status FROM nodes WHERE id = ?`).get(id) as
      | { status: string | null }
      | undefined;
    return row?.status ?? null;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-migrate-status-test-"));
  workspaceDir = path.join(tmpDir, ".ideate");

  for (const sub of ["work-items", "domains"]) {
    fs.mkdirSync(path.join(workspaceDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(workspaceDir, "domains", "index.yaml"),
    "current_cycle: 1\n",
    "utf8"
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Legacy synonym mapping
// ---------------------------------------------------------------------------

describe("migrateStatusVocab — legacy synonym mapping", () => {
  it("maps 'completed' -> 'done'", async () => {
    writeWorkItem("WI-001", "Completed item", "completed");

    await migrateStatusVocab(workspaceDir, false);

    expect(readStatusFromYaml("WI-001")).toBe("done");
    expect(readStatusFromIndex("WI-001")).toBe("done");
  });

  it("maps 'complete' -> 'done'", async () => {
    writeWorkItem("WI-002", "Complete item", "complete");

    await migrateStatusVocab(workspaceDir, false);

    expect(readStatusFromYaml("WI-002")).toBe("done");
    expect(readStatusFromIndex("WI-002")).toBe("done");
  });

  it("maps null/missing status -> 'pending'", async () => {
    writeWorkItem("WI-003", "No-status item", null);

    await migrateStatusVocab(workspaceDir, false);

    expect(readStatusFromYaml("WI-003")).toBe("pending");
    expect(readStatusFromIndex("WI-003")).toBe("pending");
  });

  it("preserves already-canonical values unchanged", async () => {
    writeWorkItem("WI-004", "Pending item", "pending");
    writeWorkItem("WI-005", "In-progress item", "in_progress");
    writeWorkItem("WI-006", "Done item", "done");
    writeWorkItem("WI-007", "Obsolete item", "obsolete");
    writeWorkItem("WI-008", "Blocked item", "blocked");

    const summary = await migrateStatusVocab(workspaceDir, false);

    expect(readStatusFromYaml("WI-004")).toBe("pending");
    expect(readStatusFromYaml("WI-005")).toBe("in_progress");
    expect(readStatusFromYaml("WI-006")).toBe("done");
    expect(readStatusFromYaml("WI-007")).toBe("obsolete");
    expect(readStatusFromYaml("WI-008")).toBe("blocked");
    expect(summary.patched).toBe(0);
    expect(summary.unchanged).toBe(5);
  });

  it("normalizes an unanticipated value to 'pending' and reports it (not silently passed through)", async () => {
    writeWorkItem("WI-009", "Weird status item", "totally_bogus_status");

    const summary = await migrateStatusVocab(workspaceDir, false);

    expect(readStatusFromYaml("WI-009")).toBe("pending");
    expect(summary.unanticipated).toEqual([
      { id: "WI-009", raw: "totally_bogus_status" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Backup safety
// ---------------------------------------------------------------------------

describe("migrateStatusVocab — backup", () => {
  it("creates a timestamped backup sibling directory before writing", async () => {
    writeWorkItem("WI-010", "Completed item", "completed");

    const summary = await migrateStatusVocab(workspaceDir, false);

    expect(fs.existsSync(summary.backupDir)).toBe(true);
    // The backup preserves the ORIGINAL (pre-migration) status.
    const backupYaml = fs.readFileSync(
      path.join(summary.backupDir, "work-items", "WI-010.yaml"),
      "utf8"
    );
    expect(backupYaml).toContain("status: completed");
  });

  it("does not create a backup or write anything in --dry-run mode", async () => {
    writeWorkItem("WI-011", "Completed item", "completed");

    const summary = await migrateStatusVocab(workspaceDir, true);

    expect(fs.existsSync(summary.backupDir)).toBe(false);
    expect(readStatusFromYaml("WI-011")).toBe("completed"); // unchanged on disk
  });
});

// ---------------------------------------------------------------------------
// YAML + SQLite index consistency
// ---------------------------------------------------------------------------

describe("migrateStatusVocab — YAML/index consistency", () => {
  it("updates both the YAML file and the SQLite index for a patched node", async () => {
    writeWorkItem("WI-012", "Completed item", "completed");

    await migrateStatusVocab(workspaceDir, false);

    expect(readStatusFromYaml("WI-012")).toBe(readStatusFromIndex("WI-012"));
    expect(readStatusFromYaml("WI-012")).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("migrateStatusVocab — idempotency", () => {
  it("re-running after a successful migration performs zero writes", async () => {
    writeWorkItem("WI-020", "Completed item", "completed");
    writeWorkItem("WI-021", "Complete item", "complete");
    writeWorkItem("WI-022", "No-status item", null);
    writeWorkItem("WI-023", "Already-canonical item", "obsolete");

    const first = await migrateStatusVocab(workspaceDir, false);
    expect(first.patched).toBe(3);

    const second = await migrateStatusVocab(workspaceDir, false);
    expect(second.patched).toBe(0);
    expect(second.unchanged).toBe(4);

    // Status values are stable across the second run.
    expect(readStatusFromYaml("WI-020")).toBe("done");
    expect(readStatusFromYaml("WI-021")).toBe("done");
    expect(readStatusFromYaml("WI-022")).toBe("pending");
    expect(readStatusFromYaml("WI-023")).toBe("obsolete");
  });

  it("before/after counts reconcile to only canonical buckets after migration", async () => {
    writeWorkItem("WI-030", "a", "completed");
    writeWorkItem("WI-031", "b", "complete");
    writeWorkItem("WI-032", "c", null);
    writeWorkItem("WI-033", "d", "done");
    writeWorkItem("WI-034", "e", "obsolete");
    writeWorkItem("WI-035", "f", "pending");

    const summary = await migrateStatusVocab(workspaceDir, false);

    const canonical = ["pending", "in_progress", "done", "obsolete", "blocked"];
    for (const key of Object.keys(summary.after)) {
      expect(canonical, `unexpected non-canonical status bucket: ${key}`).toContain(key);
    }
    expect(summary.after.done).toBe(3); // completed, complete, done
    expect(summary.after.pending).toBe(2); // null, pending
    expect(summary.after.obsolete).toBe(1);
  });
});
