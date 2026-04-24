import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { runPendingMigrations, MIGRATIONS } from "../migrations.js";
import { writeConfig, readRawConfig } from "../config.js";
import { createSchema } from "../schema.js";
import { log } from "../logger.js";

let tmpDir: string;
let ideateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-migrations-test-"));
  ideateDir = path.join(tmpDir, ".ideate");
  fs.mkdirSync(ideateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// runPendingMigrations
// ---------------------------------------------------------------------------

describe("runPendingMigrations", () => {
  it("is a no-op when config schema_version already equals target (9)", () => {
    writeConfig(ideateDir, { schema_version: 9 });

    const result = runPendingMigrations(ideateDir);

    expect(result.migrationsRun).toBe(0);
    expect(result.errors).toHaveLength(0);
    // schema_version must remain 9
    const config = readRawConfig(ideateDir);
    expect(config.schema_version).toBe(9);
  });

  it("runs v4→v9 migration chain when config schema_version is 4 and arrives at target (9)", () => {
    writeConfig(ideateDir, { schema_version: 4 });
    // No index.db — the v4→v5 migration short-circuits when there is no DB,
    // but runPendingMigrations must still update schema_version through all
    // pending migrations (v4→v5, v5→v6, v6→v7, v7→v8, v8→v9) to reach the current target.

    const result = runPendingMigrations(ideateDir);

    expect(result.errors).toHaveLength(0);
    expect(result.migrationsRun).toBeGreaterThanOrEqual(1);
    const config = readRawConfig(ideateDir);
    expect(config.schema_version).toBe(9);
  });

  it("updates schema_version to 9 after full migration chain on a DB with schema version 4", () => {
    writeConfig(ideateDir, { schema_version: 4 });

    // Create a DB without the v5 columns (simulate a v4 database by building
    // tables without the columns that the v4→v5 migration adds).
    const dbPath = path.join(ideateDir, "index.db");
    const db = new Database(dbPath);
    try {
      // Create a minimal schema at user_version 4 (missing v5 columns)
      db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          id             TEXT PRIMARY KEY,
          type           TEXT NOT NULL,
          cycle_created  INTEGER,
          cycle_modified INTEGER,
          content_hash   TEXT NOT NULL,
          token_count    INTEGER,
          file_path      TEXT NOT NULL,
          status         TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS work_items (
          id         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          title      TEXT NOT NULL,
          complexity TEXT,
          scope      TEXT,
          depends    TEXT,
          blocks     TEXT,
          criteria   TEXT,
          module     TEXT,
          domain     TEXT,
          phase      TEXT,
          notes      TEXT,
          work_item_type TEXT DEFAULT 'feature'
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS findings (
          id          TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          severity    TEXT NOT NULL,
          work_item   TEXT NOT NULL,
          file_refs   TEXT,
          verdict     TEXT NOT NULL,
          cycle       INTEGER NOT NULL,
          reviewer    TEXT NOT NULL,
          description TEXT,
          suggestion  TEXT,
          addressed_by TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS domain_decisions (
          id          TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          domain      TEXT NOT NULL,
          cycle       INTEGER,
          supersedes  TEXT,
          description TEXT,
          rationale   TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS phases (
          id         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          name       TEXT,
          description TEXT,
          project    TEXT NOT NULL,
          phase_type TEXT NOT NULL,
          intent     TEXT NOT NULL,
          steering   TEXT,
          status     TEXT NOT NULL,
          work_items TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id               TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          name             TEXT,
          description      TEXT,
          intent           TEXT NOT NULL,
          scope_boundary   TEXT,
          success_criteria TEXT,
          appetite         INTEGER,
          steering         TEXT,
          horizon          TEXT,
          status           TEXT NOT NULL
        )
      `);
      db.pragma("user_version = 4");
    } finally {
      db.close();
    }

    const result = runPendingMigrations(ideateDir);

    expect(result.errors).toHaveLength(0);
    // v4→v5 (real transform) + v5→v6 (no-op stub) + v6→v7 (no-op stub) + v7→v8 (additive DDL) + v8→v9 (no-op stub)
    expect(result.migrationsRun).toBe(5);
    const config = readRawConfig(ideateDir);
    expect(config.schema_version).toBe(9);

    // Verify the columns were actually added by the v4→v5 migration
    const db2 = new Database(dbPath);
    try {
      const workItemCols = db2.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
      expect(workItemCols.some((c) => c.name === "resolution")).toBe(true);

      const findingCols = db2.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string }>;
      expect(findingCols.some((c) => c.name === "title")).toBe(true);

      const decisionCols = db2.prepare("PRAGMA table_info(domain_decisions)").all() as Array<{ name: string }>;
      expect(decisionCols.some((c) => c.name === "title")).toBe(true);
      expect(decisionCols.some((c) => c.name === "source")).toBe(true);

      const phaseCols = db2.prepare("PRAGMA table_info(phases)").all() as Array<{ name: string }>;
      expect(phaseCols.some((c) => c.name === "completed_date")).toBe(true);

      const projectCols = db2.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      expect(projectCols.some((c) => c.name === "current_phase_id")).toBe(true);
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Error path: migration throws
// ---------------------------------------------------------------------------

describe("runPendingMigrations — error path", () => {
  it("propagates the error, leaves schema_version unchanged, creates snapshot, and calls log.error with snapshot path", () => {
    // Start at v4 so the v4→v5 migration would normally run
    writeConfig(ideateDir, { schema_version: 4 });

    // Create a real index.db so snapshot can copy it
    const dbPath = path.join(ideateDir, "index.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS test (id TEXT PRIMARY KEY)");
    db.close();

    // Spy on log.error
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});

    // Temporarily replace the v4→v5 migration's migrate function with one that throws
    const v4ToV5 = MIGRATIONS.find((m) => m.fromVersion === 4 && m.toVersion === 5);
    expect(v4ToV5).toBeDefined();

    const originalMigrate = v4ToV5!.migrate;
    v4ToV5!.migrate = () => {
      throw new Error("simulated migration failure");
    };

    let snapshotDir: string | undefined;

    try {
      expect(() => runPendingMigrations(ideateDir)).toThrow("simulated migration failure");

      // schema_version must remain at the pre-migration value
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(4);

      // A snapshot directory must have been created
      const backupsDir = path.join(ideateDir, "backups");
      expect(fs.existsSync(backupsDir)).toBe(true);
      const entries = fs.readdirSync(backupsDir);
      expect(entries).toHaveLength(1);
      snapshotDir = path.join(backupsDir, entries[0]);

      // Snapshot contains index.db
      expect(fs.existsSync(path.join(snapshotDir, "index.db"))).toBe(true);

      // log.error was called with the snapshot path
      const errorCalls = errorSpy.mock.calls;
      expect(errorCalls.some((args) => args[0] === "migrations" && String(args[1]).includes(snapshotDir!))).toBe(true);
    } finally {
      // Restore the original migrate function
      v4ToV5!.migrate = originalMigrate;
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshot: exactly one snapshot created for a multi-step migration chain
// ---------------------------------------------------------------------------

describe("runPendingMigrations — snapshot behavior", () => {
  it("creates exactly ONE snapshot directory when running a v4→v9 chain (not one per step)", () => {
    writeConfig(ideateDir, { schema_version: 4 });

    // Create a real index.db at user_version 4 (pre-migration state)
    const dbPath = path.join(ideateDir, "index.db");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS work_items (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          complexity TEXT,
          scope TEXT,
          depends TEXT,
          blocks TEXT,
          criteria TEXT,
          module TEXT,
          domain TEXT,
          phase TEXT,
          notes TEXT,
          work_item_type TEXT DEFAULT 'feature'
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS findings (
          id TEXT PRIMARY KEY,
          severity TEXT NOT NULL,
          work_item TEXT NOT NULL,
          file_refs TEXT,
          verdict TEXT NOT NULL,
          cycle INTEGER NOT NULL,
          reviewer TEXT NOT NULL,
          description TEXT,
          suggestion TEXT,
          addressed_by TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS domain_decisions (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          cycle INTEGER,
          supersedes TEXT,
          description TEXT,
          rationale TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS phases (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          project TEXT NOT NULL,
          phase_type TEXT NOT NULL,
          intent TEXT NOT NULL,
          steering TEXT,
          status TEXT NOT NULL,
          work_items TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          intent TEXT NOT NULL,
          scope_boundary TEXT,
          success_criteria TEXT,
          appetite INTEGER,
          steering TEXT,
          horizon TEXT,
          status TEXT NOT NULL
        )
      `);
      db.pragma("user_version = 4");
    } finally {
      db.close();
    }

    const result = runPendingMigrations(ideateDir);

    expect(result.errors).toHaveLength(0);
    expect(result.migrationsRun).toBe(5);

    // Exactly ONE snapshot directory must exist
    const backupsDir = path.join(ideateDir, "backups");
    expect(fs.existsSync(backupsDir)).toBe(true);
    const entries = fs.readdirSync(backupsDir);
    expect(entries).toHaveLength(1);

    // The snapshot contains index.db (pre-migration state at v4)
    const snapshotDir = path.join(backupsDir, entries[0]);
    expect(fs.existsSync(path.join(snapshotDir, "index.db"))).toBe(true);

    // The snapshot's DB is at user_version 4 (pre-migration)
    const snapshotDb = new Database(path.join(snapshotDir, "index.db"));
    try {
      const version = snapshotDb.pragma("user_version", { simple: true }) as number;
      expect(version).toBe(4);
    } finally {
      snapshotDb.close();
    }
  });

  it("does NOT create a snapshot when already at target version (no migrations run)", () => {
    writeConfig(ideateDir, { schema_version: 9 });

    runPendingMigrations(ideateDir);

    // No backups directory should be created when no migrations run
    const backupsDir = path.join(ideateDir, "backups");
    expect(fs.existsSync(backupsDir)).toBe(false);
  });

  it("calling runPendingMigrations a second time (already at latest) does NOT create an additional snapshot", () => {
    writeConfig(ideateDir, { schema_version: 4 });

    // First run: creates snapshot and migrates
    const result1 = runPendingMigrations(ideateDir);
    expect(result1.errors).toHaveLength(0);

    const backupsDir = path.join(ideateDir, "backups");
    const entriesAfterFirst = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];

    // Second run: already at latest — no new snapshot
    const result2 = runPendingMigrations(ideateDir);
    expect(result2.migrationsRun).toBe(0);
    expect(result2.errors).toHaveLength(0);

    const entriesAfterSecond = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
    expect(entriesAfterSecond).toHaveLength(entriesAfterFirst.length);
  });
});

// ---------------------------------------------------------------------------
// Multi-step chain: v3→v4→v5→v6→v7
// ---------------------------------------------------------------------------

describe("runPendingMigrations — multi-step chain", () => {
  it("applies all migrations in order when starting at v3, arriving at v9", () => {
    // Start at v3 — all six migrations (v3→v4, v4→v5, v5→v6, v6→v7, v7→v8, v8→v9) should run
    writeConfig(ideateDir, { schema_version: 3 });

    // Track which migrations were called and in what order
    const migrationsCalled: string[] = [];

    const v3ToV4 = MIGRATIONS.find((m) => m.fromVersion === 3 && m.toVersion === 4);
    const v4ToV5 = MIGRATIONS.find((m) => m.fromVersion === 4 && m.toVersion === 5);
    const v5ToV6 = MIGRATIONS.find((m) => m.fromVersion === 5 && m.toVersion === 6);
    const v6ToV7 = MIGRATIONS.find((m) => m.fromVersion === 6 && m.toVersion === 7);
    const v7ToV8 = MIGRATIONS.find((m) => m.fromVersion === 7 && m.toVersion === 8);
    const v8ToV9 = MIGRATIONS.find((m) => m.fromVersion === 8 && m.toVersion === 9);
    expect(v3ToV4).toBeDefined();
    expect(v4ToV5).toBeDefined();
    expect(v5ToV6).toBeDefined();
    expect(v6ToV7).toBeDefined();
    expect(v7ToV8).toBeDefined();
    expect(v8ToV9).toBeDefined();

    const originalV3ToV4 = v3ToV4!.migrate;
    const originalV4ToV5 = v4ToV5!.migrate;
    const originalV5ToV6 = v5ToV6!.migrate;
    const originalV6ToV7 = v6ToV7!.migrate;
    const originalV7ToV8 = v7ToV8!.migrate;
    const originalV8ToV9 = v8ToV9!.migrate;

    v3ToV4!.migrate = (dir: string) => { migrationsCalled.push("v3→v4"); originalV3ToV4(dir); };
    v4ToV5!.migrate = (dir: string) => { migrationsCalled.push("v4→v5"); originalV4ToV5(dir); };
    v5ToV6!.migrate = (dir: string) => { migrationsCalled.push("v5→v6"); originalV5ToV6(dir); };
    v6ToV7!.migrate = (dir: string) => { migrationsCalled.push("v6→v7"); originalV6ToV7(dir); };
    v7ToV8!.migrate = (dir: string) => { migrationsCalled.push("v7→v8"); originalV7ToV8(dir); };
    v8ToV9!.migrate = (dir: string) => { migrationsCalled.push("v8→v9"); originalV8ToV9(dir); };

    try {
      const result = runPendingMigrations(ideateDir);

      expect(result.errors).toHaveLength(0);
      expect(result.migrationsRun).toBe(6);

      // All steps ran in order
      expect(migrationsCalled).toEqual(["v3→v4", "v4→v5", "v5→v6", "v6→v7", "v7→v8", "v8→v9"]);

      // Final schema_version is 9
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(9);
    } finally {
      v3ToV4!.migrate = originalV3ToV4;
      v4ToV5!.migrate = originalV4ToV5;
      v5ToV6!.migrate = originalV5ToV6;
      v6ToV7!.migrate = originalV6ToV7;
      v7ToV8!.migrate = originalV7ToV8;
      v8ToV9!.migrate = originalV8ToV9;
    }
  });
});

// ---------------------------------------------------------------------------
// Already-at-target: no migration functions called
// ---------------------------------------------------------------------------

describe("runPendingMigrations — already at target version", () => {
  it("runs no migrations and calls no migrate functions when schema_version equals the target", () => {
    // Start at the current target version (9)
    writeConfig(ideateDir, { schema_version: 9 });

    // Wrap every migration's migrate function to detect if any are called
    const called: string[] = [];
    const originals = MIGRATIONS.map((m) => m.migrate);

    MIGRATIONS.forEach((m) => {
      const orig = m.migrate;
      m.migrate = (dir: string) => {
        called.push(`v${m.fromVersion}→v${m.toVersion}`);
        orig(dir);
      };
    });

    try {
      const result = runPendingMigrations(ideateDir);

      expect(result.errors).toHaveLength(0);
      expect(result.migrationsRun).toBe(0);
      // No migration functions should have been invoked
      expect(called).toHaveLength(0);

      // schema_version stays at target
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(9);
    } finally {
      MIGRATIONS.forEach((m, i) => {
        m.migrate = originals[i];
      });
    }
  });
});

// ---------------------------------------------------------------------------
// v5→v6, v6→v7, v7→v8, and v8→v9 stubs: loaded from v5, all run, arrive at v9
// ---------------------------------------------------------------------------

describe("runPendingMigrations — v5→v6, v6→v7, v7→v8, v8→v9 stubs", () => {
  it("starting at v5 runs all four stubs exactly once and arrives at v9", () => {
    writeConfig(ideateDir, { schema_version: 5 });

    const v5ToV6 = MIGRATIONS.find((m) => m.fromVersion === 5 && m.toVersion === 6);
    const v6ToV7 = MIGRATIONS.find((m) => m.fromVersion === 6 && m.toVersion === 7);
    const v7ToV8 = MIGRATIONS.find((m) => m.fromVersion === 7 && m.toVersion === 8);
    const v8ToV9 = MIGRATIONS.find((m) => m.fromVersion === 8 && m.toVersion === 9);
    expect(v5ToV6).toBeDefined();
    expect(v6ToV7).toBeDefined();
    expect(v7ToV8).toBeDefined();
    expect(v8ToV9).toBeDefined();

    let v5ToV6CallCount = 0;
    let v6ToV7CallCount = 0;
    let v7ToV8CallCount = 0;
    let v8ToV9CallCount = 0;

    const originalV5ToV6 = v5ToV6!.migrate;
    const originalV6ToV7 = v6ToV7!.migrate;
    const originalV7ToV8 = v7ToV8!.migrate;
    const originalV8ToV9 = v8ToV9!.migrate;

    v5ToV6!.migrate = (dir: string) => { v5ToV6CallCount++; originalV5ToV6(dir); };
    v6ToV7!.migrate = (dir: string) => { v6ToV7CallCount++; originalV6ToV7(dir); };
    v7ToV8!.migrate = (dir: string) => { v7ToV8CallCount++; originalV7ToV8(dir); };
    v8ToV9!.migrate = (dir: string) => { v8ToV9CallCount++; originalV8ToV9(dir); };

    try {
      const result = runPendingMigrations(ideateDir);

      expect(result.errors).toHaveLength(0);
      expect(result.migrationsRun).toBe(4);

      // Each stub invoked exactly once
      expect(v5ToV6CallCount).toBe(1);
      expect(v6ToV7CallCount).toBe(1);
      expect(v7ToV8CallCount).toBe(1);
      expect(v8ToV9CallCount).toBe(1);

      // Arrived at v9
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(9);
    } finally {
      v5ToV6!.migrate = originalV5ToV6;
      v6ToV7!.migrate = originalV6ToV7;
      v7ToV8!.migrate = originalV7ToV8;
      v8ToV9!.migrate = originalV8ToV9;
    }
  });

  it("starting at v9 invokes no migration stubs (idempotent + forward-only)", () => {
    writeConfig(ideateDir, { schema_version: 9 });

    const v5ToV6 = MIGRATIONS.find((m) => m.fromVersion === 5 && m.toVersion === 6);
    const v6ToV7 = MIGRATIONS.find((m) => m.fromVersion === 6 && m.toVersion === 7);
    const v7ToV8 = MIGRATIONS.find((m) => m.fromVersion === 7 && m.toVersion === 8);
    const v8ToV9 = MIGRATIONS.find((m) => m.fromVersion === 8 && m.toVersion === 9);
    expect(v5ToV6).toBeDefined();
    expect(v6ToV7).toBeDefined();
    expect(v7ToV8).toBeDefined();
    expect(v8ToV9).toBeDefined();

    let v5ToV6CallCount = 0;
    let v6ToV7CallCount = 0;
    let v7ToV8CallCount = 0;
    let v8ToV9CallCount = 0;

    const originalV5ToV6 = v5ToV6!.migrate;
    const originalV6ToV7 = v6ToV7!.migrate;
    const originalV7ToV8 = v7ToV8!.migrate;
    const originalV8ToV9 = v8ToV9!.migrate;

    v5ToV6!.migrate = (dir: string) => { v5ToV6CallCount++; originalV5ToV6(dir); };
    v6ToV7!.migrate = (dir: string) => { v6ToV7CallCount++; originalV6ToV7(dir); };
    v7ToV8!.migrate = (dir: string) => { v7ToV8CallCount++; originalV7ToV8(dir); };
    v8ToV9!.migrate = (dir: string) => { v8ToV9CallCount++; originalV8ToV9(dir); };

    try {
      const result = runPendingMigrations(ideateDir);

      expect(result.errors).toHaveLength(0);
      expect(result.migrationsRun).toBe(0);

      // No stubs invoked
      expect(v5ToV6CallCount).toBe(0);
      expect(v6ToV7CallCount).toBe(0);
      expect(v7ToV8CallCount).toBe(0);
      expect(v8ToV9CallCount).toBe(0);

      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(9);
    } finally {
      v5ToV6!.migrate = originalV5ToV6;
      v6ToV7!.migrate = originalV6ToV7;
      v7ToV8!.migrate = originalV7ToV8;
      v8ToV9!.migrate = originalV8ToV9;
    }
  });
});

// ---------------------------------------------------------------------------
// v7→v8 migration idempotency
// ---------------------------------------------------------------------------

describe("v7→v8 migration idempotency", () => {
  it("v7→v8 migrate() does not throw when called on a DB that already has derived_from", () => {
    const v7ToV8 = MIGRATIONS.find((m) => m.fromVersion === 7 && m.toVersion === 8);
    expect(v7ToV8).toBeDefined();

    // Create a fresh DB using createSchema — it already has derived_from
    const dbPath = path.join(ideateDir, "index.db");
    const db = new Database(dbPath);
    createSchema(db);
    db.close();

    // Running the migration again must not throw (column already exists)
    expect(() => v7ToV8!.migrate(ideateDir)).not.toThrow();
  });

  it("v7→v8 migrate() adds derived_from column to a v7-era DB that lacks it", () => {
    const v7ToV8 = MIGRATIONS.find((m) => m.fromVersion === 7 && m.toVersion === 8);
    expect(v7ToV8).toBeDefined();

    // Build a DB at user_version=7 without the derived_from column
    const dbPath = path.join(ideateDir, "index.db");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS domain_decisions (
          id          TEXT PRIMARY KEY,
          domain      TEXT NOT NULL,
          cycle       INTEGER,
          supersedes  TEXT,
          description TEXT,
          rationale   TEXT,
          title       TEXT,
          source      TEXT
        )
      `);
      db.pragma(`user_version = 7`);
    } finally {
      db.close();
    }

    // Run the migration
    v7ToV8!.migrate(ideateDir);

    // Verify column was added
    const db2 = new Database(dbPath);
    try {
      const cols = db2.prepare("PRAGMA table_info(domain_decisions)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "derived_from")).toBe(true);
      const version = db2.pragma("user_version", { simple: true }) as number;
      expect(version).toBe(8);
    } finally {
      db2.close();
    }
  });

  it("v7→v8 migrate() is a no-op when user_version is already >= 8", () => {
    const v7ToV8 = MIGRATIONS.find((m) => m.fromVersion === 7 && m.toVersion === 8);
    expect(v7ToV8).toBeDefined();

    // Create DB already at v8
    const dbPath = path.join(ideateDir, "index.db");
    const db = new Database(dbPath);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS domain_decisions (id TEXT PRIMARY KEY, domain TEXT NOT NULL, derived_from TEXT)`);
      db.pragma(`user_version = 8`);
    } finally {
      db.close();
    }

    // Running migration again must not throw and must leave user_version at 8
    expect(() => v7ToV8!.migrate(ideateDir)).not.toThrow();

    const db2 = new Database(dbPath);
    try {
      const version = db2.pragma("user_version", { simple: true }) as number;
      expect(version).toBe(8);
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Fallback warn path: log.warn fires when out-of-registry version is encountered
//
// Simulate by temporarily removing all migrations from the MIGRATIONS array
// while pointing at a schema_version below the target. This exercises the
// fallback branch at migrations.ts (migrationsRun===0, no errors, version behind).
// ---------------------------------------------------------------------------

describe("runPendingMigrations — fallback warn path", () => {
  it("emits log.warn when no registry entries cover the version gap", () => {
    // Use a version that is below target but has no registry entry after we
    // splice out all MIGRATIONS temporarily
    writeConfig(ideateDir, { schema_version: 5 });

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    // Temporarily drain the registry so no entries match
    const saved = MIGRATIONS.splice(0, MIGRATIONS.length);

    try {
      const result = runPendingMigrations(ideateDir);

      // Fallback fired: schema stamped to target without transforms
      expect(result.migrationsRun).toBe(0);
      expect(result.errors).toHaveLength(0);
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(9);

      // log.warn was called at least once with the migrations prefix
      const warnCalls = warnSpy.mock.calls;
      expect(warnCalls.some((args) => args[0] === "migrations")).toBe(true);
    } finally {
      // Restore the registry
      MIGRATIONS.splice(0, 0, ...saved);
    }
  });
});

// ---------------------------------------------------------------------------
// v4→v5 migration idempotency
// ---------------------------------------------------------------------------

describe("v4→v5 migration idempotency", () => {
  it("calling migration.migrate() on a DB created by createSchema does not throw", () => {
    const v4ToV5 = MIGRATIONS.find(
      (m) => m.fromVersion === 4 && m.toVersion === 5
    );
    expect(v4ToV5).toBeDefined();

    // Create a fresh DB using createSchema — it already has all v5 columns
    const dbPath = path.join(ideateDir, "index.db");
    const db = new Database(dbPath);
    createSchema(db);
    db.close();

    // Running the migration again must not throw
    expect(() => v4ToV5!.migrate(ideateDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// v5→v6 and v6→v7 stub idempotency
// ---------------------------------------------------------------------------

describe("v5→v6 and v6→v7 stub idempotency", () => {
  it("v5→v6 migrate() does not throw when called multiple times", () => {
    const v5ToV6 = MIGRATIONS.find((m) => m.fromVersion === 5 && m.toVersion === 6);
    expect(v5ToV6).toBeDefined();
    // Should be callable any number of times without error
    expect(() => v5ToV6!.migrate(ideateDir)).not.toThrow();
    expect(() => v5ToV6!.migrate(ideateDir)).not.toThrow();
  });

  it("v6→v7 migrate() does not throw when called multiple times", () => {
    const v6ToV7 = MIGRATIONS.find((m) => m.fromVersion === 6 && m.toVersion === 7);
    expect(v6ToV7).toBeDefined();
    // Should be callable any number of times without error
    expect(() => v6ToV7!.migrate(ideateDir)).not.toThrow();
    expect(() => v6ToV7!.migrate(ideateDir)).not.toThrow();
  });
});
