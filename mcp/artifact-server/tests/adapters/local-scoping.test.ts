/**
 * local-scoping.test.ts — LocalAdapter v4 scoping tests (WI-001)
 *
 * Covers AC-9:
 *   - write+read roundtrip under one scope
 *   - isolation between two codebase_id values
 *   - explicit scope override (codebase_id='*') returns cross-codebase
 *   - migration from v3 fixture DB populates org_id='ideate' codebase_id='plugin-claude'
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { runV4Migration } from "../../src/adapters/local/migrations/v4-add-codebase-id.js";
import {
  LOCAL_ADAPTER_SCHEMA_VERSION,
  MIGRATION_DEFAULT_ORG_ID,
  MIGRATION_DEFAULT_CODEBASE_ID,
} from "../../src/adapters/local/schema.js";
import type { ArtifactScope } from "../../src/adapter.js";
import { CROSS_CODEBASE_SENTINEL } from "../../src/adapter.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestSetup {
  adapter: LocalAdapter;
  db: Database.Database;
  tmpDir: string;
  ideateDir: string;
}

function createIdeateDir(parent: string): string {
  const ideateDir = path.join(parent, ".ideate");
  for (const sub of [
    "work-items", "policies", "decisions", "questions", "principles",
    "constraints", "modules", "research", "interviews", "projects",
    "phases", "plan", "steering", "domains", "archive/cycles",
    "archive/incremental",
  ]) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(ideateDir, "domains", "index.yaml"), "current_cycle: 1\n", "utf8");
  return ideateDir;
}

function createLocalAdapter(scope: ArtifactScope, ideateDir: string, db: Database.Database): LocalAdapter {
  const drizzleDb = drizzle(db, { schema: dbSchema });
  return new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scope });
}

// ---------------------------------------------------------------------------
// Suite: write + read roundtrip under one scope
// ---------------------------------------------------------------------------

describe("LocalAdapter scoping — write+read roundtrip", () => {
  let tmpDir: string;
  let ideateDir: string;
  let db: Database.Database;
  let adapter: LocalAdapter;

  const scope: ArtifactScope = { org_id: "ideate", codebase_id: "plugin-claude" };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-scoping-roundtrip-"));
    ideateDir = createIdeateDir(tmpDir);
    db = new Database(path.join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    runV4Migration(db);
    adapter = createLocalAdapter(scope, ideateDir, db);
  });

  afterAll(async () => {
    try { await adapter.shutdown(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes a node and reads it back within the same scope", async () => {
    const result = await adapter.putNode({
      id: "GP-001",
      type: "guiding_principle",
      properties: { name: "Test Principle", description: "Scoping test" },
    });

    expect(result.status).toBe("created");
    expect(result.id).toBe("GP-001");

    const node = await adapter.getNode("GP-001");
    expect(node).not.toBeNull();
    expect(node?.id).toBe("GP-001");
  });

  it("node has org_id and codebase_id set in the database", async () => {
    const row = db
      .prepare(`SELECT org_id, codebase_id FROM nodes WHERE id = 'GP-001'`)
      .get() as { org_id: string; codebase_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.org_id).toBe(scope.org_id);
    expect(row!.codebase_id).toBe(scope.codebase_id);
  });

  it("queryNodes returns nodes within the scope", async () => {
    const result = await adapter.queryNodes({ type: "guiding_principle" }, 100, 0);
    expect(result.nodes.some((n) => n.node.id === "GP-001")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: isolation between two codebase_id values
// ---------------------------------------------------------------------------

describe("LocalAdapter scoping — isolation between codebase_ids", () => {
  let tmpDir: string;
  let ideateDir: string;
  let db: Database.Database;
  let adapterA: LocalAdapter;
  let adapterB: LocalAdapter;

  const scopeA: ArtifactScope = { org_id: "ideate", codebase_id: "plugin-claude" };
  const scopeB: ArtifactScope = { org_id: "ideate", codebase_id: "artifact-server" };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-scoping-isolation-"));
    ideateDir = createIdeateDir(tmpDir);
    db = new Database(path.join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    runV4Migration(db);

    const drizzleDb = drizzle(db, { schema: dbSchema });

    adapterA = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeA });
    adapterB = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeB });
  });

  afterAll(async () => {
    try { await adapterA.shutdown(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes a node in scope A", async () => {
    const result = await adapterA.putNode({
      id: "GP-A-001",
      type: "guiding_principle",
      properties: { name: "Principle A", description: "Belongs to plugin-claude" },
    });
    expect(result.status).toBe("created");
  });

  it("writes a node in scope B", async () => {
    const result = await adapterB.putNode({
      id: "GP-B-001",
      type: "guiding_principle",
      properties: { name: "Principle B", description: "Belongs to artifact-server" },
    });
    expect(result.status).toBe("created");
  });

  it("scope A can read GP-A-001 but not GP-B-001", async () => {
    const nodeA = await adapterA.getNode("GP-A-001");
    expect(nodeA).not.toBeNull();
    expect(nodeA?.id).toBe("GP-A-001");

    const nodeB = await adapterA.getNode("GP-B-001");
    expect(nodeB).toBeNull(); // Cross-codebase: should not be visible
  });

  it("scope B can read GP-B-001 but not GP-A-001", async () => {
    const nodeB = await adapterB.getNode("GP-B-001");
    expect(nodeB).not.toBeNull();
    expect(nodeB?.id).toBe("GP-B-001");

    const nodeA = await adapterB.getNode("GP-A-001");
    expect(nodeA).toBeNull(); // Cross-codebase: should not be visible
  });

  it("queryNodes from scope A only returns scope A nodes", async () => {
    const result = await adapterA.queryNodes({ type: "guiding_principle" }, 100, 0);
    const ids = result.nodes.map((n) => n.node.id);
    expect(ids).toContain("GP-A-001");
    expect(ids).not.toContain("GP-B-001");
  });

  it("queryNodes from scope B only returns scope B nodes", async () => {
    const result = await adapterB.queryNodes({ type: "guiding_principle" }, 100, 0);
    const ids = result.nodes.map((n) => n.node.id);
    expect(ids).toContain("GP-B-001");
    expect(ids).not.toContain("GP-A-001");
  });
});

// ---------------------------------------------------------------------------
// Suite: codebase_id='*' returns cross-codebase
// ---------------------------------------------------------------------------

describe("LocalAdapter scoping — codebase_id='*' sentinel returns cross-codebase", () => {
  let tmpDir: string;
  let ideateDir: string;
  let db: Database.Database;
  let adapterA: LocalAdapter;
  let adapterStar: LocalAdapter;

  const scopeA: ArtifactScope = { org_id: "ideate", codebase_id: "plugin-claude" };
  const scopeB: ArtifactScope = { org_id: "ideate", codebase_id: "artifact-server" };
  const scopeStar: ArtifactScope = { org_id: "ideate", codebase_id: CROSS_CODEBASE_SENTINEL };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-scoping-star-"));
    ideateDir = createIdeateDir(tmpDir);
    db = new Database(path.join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    runV4Migration(db);

    const drizzleDb = drizzle(db, { schema: dbSchema });
    adapterA = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeA });
    const adapterB = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeB });
    adapterStar = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeStar });

    // Write nodes in both scopes
    await adapterA.putNode({
      id: "GP-CROSS-A",
      type: "guiding_principle",
      properties: { name: "Cross A", description: "scope A" },
    });
    await adapterB.putNode({
      id: "GP-CROSS-B",
      type: "guiding_principle",
      properties: { name: "Cross B", description: "scope B" },
    });
  });

  afterAll(async () => {
    try { await adapterA.shutdown(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("sentinel adapter can read nodes from scope A", async () => {
    const node = await adapterStar.getNode("GP-CROSS-A");
    expect(node).not.toBeNull();
  });

  it("sentinel adapter can read nodes from scope B", async () => {
    const node = await adapterStar.getNode("GP-CROSS-B");
    expect(node).not.toBeNull();
  });

  it("queryNodes with sentinel scope returns nodes from all codebases", async () => {
    const result = await adapterStar.queryNodes({ type: "guiding_principle" }, 100, 0);
    const ids = result.nodes.map((n) => n.node.id);
    expect(ids).toContain("GP-CROSS-A");
    expect(ids).toContain("GP-CROSS-B");
  });
});

// ---------------------------------------------------------------------------
// Suite: write methods fail fast when v4 schema exists but no scope configured
// ---------------------------------------------------------------------------

describe("LocalAdapter scoping — write fails fast without scope on v4 schema", () => {
  let tmpDir: string;
  let ideateDir: string;
  let db: Database.Database;
  let adapterNoScope: LocalAdapter;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-scoping-noscope-"));
    ideateDir = createIdeateDir(tmpDir);
    db = new Database(path.join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    runV4Migration(db); // v4 columns exist

    const drizzleDb = drizzle(db, { schema: dbSchema });
    // No default_scope — should fail on write
    adapterNoScope = new LocalAdapter({ db, drizzleDb, ideateDir });
  });

  afterAll(async () => {
    try { await adapterNoScope.shutdown(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("putNode throws MISSING_SCOPE when no scope is configured and v4 schema is active", async () => {
    await expect(
      adapterNoScope.putNode({
        id: "GP-NOSCOPE",
        type: "guiding_principle",
        properties: { name: "No Scope", description: "Should fail" },
      })
    ).rejects.toMatchObject({ code: "MISSING_SCOPE" });
  });

  it("batchMutate throws MISSING_SCOPE when no scope is configured and v4 schema is active", async () => {
    await expect(
      adapterNoScope.batchMutate({
        nodes: [
          { id: "GP-BATCH-NOSCOPE", type: "guiding_principle", properties: { name: "No Scope" } },
        ],
      })
    ).rejects.toMatchObject({ code: "MISSING_SCOPE" });
  });
});

// ---------------------------------------------------------------------------
// Suite: migration from v3 fixture DB
// ---------------------------------------------------------------------------

describe("LocalAdapter scoping — migration from v3 fixture DB", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-scoping-migration-"));
    db = new Database(path.join(tmpDir, "v3.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Create a "v3" DB using raw DDL that intentionally omits org_id/codebase_id.
    // This simulates a DB created before the v4 migration was introduced.
    // We cannot use createSchema() here because it now includes the v4 columns.
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
        id    TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        title TEXT NOT NULL
      )
    `);

    // Insert some test rows to simulate pre-v4 data
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path, status)
       VALUES ('GP-V3-001', 'guiding_principle', 'hash1', '/tmp/gp.yaml', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path, status)
       VALUES ('WI-V3-001', 'work_item', 'hash2', '/tmp/wi.yaml', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO work_items (id, title) VALUES ('WI-V3-001', 'Test WI')`
    ).run();
    db.pragma("foreign_keys = ON");
  });

  afterAll(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("v3 DB does not have org_id column on nodes before migration", () => {
    const cols = db
      .prepare(`PRAGMA table_info(nodes)`)
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "org_id")).toBe(false);
    expect(cols.some((c) => c.name === "codebase_id")).toBe(false);
  });

  it("runV4Migration adds org_id and codebase_id to nodes", () => {
    runV4Migration(db);

    const cols = db
      .prepare(`PRAGMA table_info(nodes)`)
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "org_id")).toBe(true);
    expect(cols.some((c) => c.name === "codebase_id")).toBe(true);
  });

  it("migration is idempotent — running again does not throw", () => {
    expect(() => runV4Migration(db)).not.toThrow();
  });

  it("pre-existing rows are backfilled with org_id='ideate'", () => {
    const row = db
      .prepare(`SELECT org_id FROM nodes WHERE id = 'GP-V3-001'`)
      .get() as { org_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.org_id).toBe(MIGRATION_DEFAULT_ORG_ID);
  });

  it("pre-existing rows are backfilled with codebase_id='plugin-claude'", () => {
    const row = db
      .prepare(`SELECT codebase_id FROM nodes WHERE id = 'GP-V3-001'`)
      .get() as { codebase_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.codebase_id).toBe(MIGRATION_DEFAULT_CODEBASE_ID);
  });

  it("work_items table also has backfilled org_id and codebase_id", () => {
    const row = db
      .prepare(`SELECT org_id, codebase_id FROM work_items WHERE id = 'WI-V3-001'`)
      .get() as { org_id: string; codebase_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.org_id).toBe(MIGRATION_DEFAULT_ORG_ID);
    expect(row!.codebase_id).toBe(MIGRATION_DEFAULT_CODEBASE_ID);
  });

  it("meta table records LOCAL_ADAPTER_SCHEMA_VERSION=4 after migration", () => {
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = 'local_schema_version'`)
      .get() as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(parseInt(row!.value, 10)).toBe(LOCAL_ADAPTER_SCHEMA_VERSION);
  });

  it("idx_nodes_org_codebase index is created on nodes", () => {
    const indexes = db
      .prepare(`PRAGMA index_list(nodes)`)
      .all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name === "idx_nodes_org_codebase")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: S3 — countNodes returns per-scope count (rework requirement)
// ---------------------------------------------------------------------------

describe("LocalAdapter scoping — countNodes returns per-scope count (S3)", () => {
  let tmpDir: string;
  let ideateDir: string;
  let db: Database.Database;
  let adapterA: LocalAdapter;
  let adapterB: LocalAdapter;

  const scopeA: ArtifactScope = { org_id: "ideate", codebase_id: "scope-count-A" };
  const scopeB: ArtifactScope = { org_id: "ideate", codebase_id: "scope-count-B" };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-scoping-count-"));
    ideateDir = createIdeateDir(tmpDir);
    db = new Database(path.join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    runV4Migration(db);

    const drizzleDb = drizzle(db, { schema: dbSchema });
    adapterA = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeA });
    adapterB = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeB });

    // Write 2 nodes in scope A, 3 nodes in scope B
    for (const id of ["GP-CA-001", "GP-CA-002"]) {
      await adapterA.putNode({ id, type: "guiding_principle", properties: { name: id, description: "scope A" } });
    }
    for (const id of ["GP-CB-001", "GP-CB-002", "GP-CB-003"]) {
      await adapterB.putNode({ id, type: "guiding_principle", properties: { name: id, description: "scope B" } });
    }
  });

  afterAll(async () => {
    try { await adapterA.shutdown(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("countNodes from scope A returns count of 2 for guiding_principle", async () => {
    const rows = await adapterA.countNodes({ type: "guiding_principle" }, "type");
    const principleRow = rows.find((r) => r.key === "guiding_principle");
    expect(principleRow).toBeDefined();
    expect(principleRow!.count).toBe(2);
  });

  it("countNodes from scope B returns count of 3 for guiding_principle", async () => {
    const rows = await adapterB.countNodes({ type: "guiding_principle" }, "type");
    const principleRow = rows.find((r) => r.key === "guiding_principle");
    expect(principleRow).toBeDefined();
    expect(principleRow!.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite: S3 — readNodeContent returns empty for out-of-scope IDs (rework requirement)
// ---------------------------------------------------------------------------

describe("LocalAdapter scoping — readNodeContent scope enforcement (S3)", () => {
  let tmpDir: string;
  let ideateDir: string;
  let db: Database.Database;
  let adapterA: LocalAdapter;
  let adapterB: LocalAdapter;

  const scopeA: ArtifactScope = { org_id: "ideate", codebase_id: "scope-content-A" };
  const scopeB: ArtifactScope = { org_id: "ideate", codebase_id: "scope-content-B" };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-scoping-content-"));
    ideateDir = createIdeateDir(tmpDir);
    db = new Database(path.join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    runV4Migration(db);

    const drizzleDb = drizzle(db, { schema: dbSchema });
    adapterA = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeA });
    adapterB = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeB });

    // Write a node in scope A
    await adapterA.putNode({
      id: "GP-CONTENT-A",
      type: "guiding_principle",
      properties: { name: "Content A", description: "in scope A" },
    });
  });

  afterAll(async () => {
    try { await adapterA.shutdown(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("readNodeContent returns content when reading in-scope node", async () => {
    const content = await adapterA.readNodeContent("GP-CONTENT-A");
    expect(content).not.toBe("");
    expect(content).toContain("GP-CONTENT-A");
  });

  it("readNodeContent returns empty string for out-of-scope node", async () => {
    // scope B cannot read a node written by scope A
    const content = await adapterB.readNodeContent("GP-CONTENT-A");
    expect(content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Suite: M2 — getNodes with mixed-scope IDs only returns in-scope nodes
// ---------------------------------------------------------------------------

describe("LocalAdapter scoping — getNodes mixed-scope filter (M2)", () => {
  let tmpDir: string;
  let ideateDir: string;
  let db: Database.Database;
  let adapterA: LocalAdapter;
  let adapterB: LocalAdapter;

  const scopeA: ArtifactScope = { org_id: "ideate", codebase_id: "scope-getnodes-A" };
  const scopeB: ArtifactScope = { org_id: "ideate", codebase_id: "scope-getnodes-B" };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-scoping-getnodes-"));
    ideateDir = createIdeateDir(tmpDir);
    db = new Database(path.join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    runV4Migration(db);

    const drizzleDb = drizzle(db, { schema: dbSchema });
    adapterA = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeA });
    adapterB = new LocalAdapter({ db, drizzleDb, ideateDir, default_scope: scopeB });

    // Write ID-A in scope A, ID-B in scope B
    await adapterA.putNode({
      id: "GP-GN-A",
      type: "guiding_principle",
      properties: { name: "Node A", description: "scope A" },
    });
    await adapterB.putNode({
      id: "GP-GN-B",
      type: "guiding_principle",
      properties: { name: "Node B", description: "scope B" },
    });
  });

  afterAll(async () => {
    try { await adapterA.shutdown(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("adapterA.getNodes([GP-GN-A, GP-GN-B]) returns only GP-GN-A", async () => {
    const result = await adapterA.getNodes(["GP-GN-A", "GP-GN-B"]);
    expect(result.has("GP-GN-A")).toBe(true);
    expect(result.has("GP-GN-B")).toBe(false);
  });

  it("adapterB.getNodes([GP-GN-A, GP-GN-B]) returns only GP-GN-B", async () => {
    const result = await adapterB.getNodes(["GP-GN-A", "GP-GN-B"]);
    expect(result.has("GP-GN-A")).toBe(false);
    expect(result.has("GP-GN-B")).toBe(true);
  });
});
