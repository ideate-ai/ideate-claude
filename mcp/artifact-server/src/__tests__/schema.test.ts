import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSchema, checkSchemaVersion, CURRENT_SCHEMA_VERSION, EDGE_TYPES, EDGE_TYPE_REGISTRY, CONTAINMENT_EDGE_TYPES } from "../schema.js";
import { indexFiles } from "../indexer.js";
import * as dbSchema from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  createSchema(db);
  return db;
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare(`PRAGMA table_info('${table}')`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare(`PRAGMA index_list('${table}')`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// nodes table — 10 columns (including v4 scoping columns org_id, codebase_id)
// ---------------------------------------------------------------------------

describe("createSchema — nodes table", () => {
  it("nodes table exists", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).toContain("nodes");
  });

  it("nodes table has exactly 10 columns: id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status, org_id, codebase_id", () => {
    const db = freshDb();
    const cols = columnNames(db, "nodes");
    const expected = [
      "id",
      "type",
      "cycle_created",
      "cycle_modified",
      "content_hash",
      "token_count",
      "file_path",
      "status",
      "org_id",
      "codebase_id",
    ];
    for (const col of expected) {
      expect(cols, `expected nodes to have column '${col}'`).toContain(col);
    }
    expect(cols.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Extension tables — 15 tables, each with FK to nodes(id)
// ---------------------------------------------------------------------------

describe("createSchema — extension tables", () => {
  const extensionTables = [
    "work_items",
    "findings",
    "domain_policies",
    "domain_decisions",
    "domain_questions",
    "guiding_principles",
    "constraints",
    "module_specs",
    "research_findings",
    "journal_entries",
    "document_artifacts",
    "interview_questions",
    "projects",
    "proxy_human_decisions",
    "phases",
  ];

  it("creates all 15 extension tables", () => {
    const db = freshDb();
    const tables = tableNames(db);
    for (const name of extensionTables) {
      expect(tables, `expected extension table '${name}' to exist`).toContain(name);
    }
    const dbTables = tableNames(db);
    const dbExtensionTables = dbTables
      .filter((t) => !["nodes", "edges", "node_file_refs", "tool_usage"].includes(t) && !t.startsWith("sqlite_"))
      .sort();
    expect(dbExtensionTables).toEqual([...extensionTables].sort());
  });

  it("does not create an interview_responses table", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).not.toContain("interview_responses");
  });
});

// ---------------------------------------------------------------------------
// ON DELETE CASCADE — nodes → extension tables
// ---------------------------------------------------------------------------

describe("createSchema — ON DELETE CASCADE (nodes → extension)", () => {
  it("deleting a node cascades to work_items extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    // Insert node + work_item extension
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('WI-001', 'work_item', 'abc', '/tmp/wi-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO work_items (id, title) VALUES ('WI-001', 'Test Work Item')`
    ).run();

    // Verify it exists
    const before = db.prepare(`SELECT id FROM work_items WHERE id = 'WI-001'`).get();
    expect(before).toBeDefined();

    // Delete from nodes
    db.prepare(`DELETE FROM nodes WHERE id = 'WI-001'`).run();

    // Extension row should be gone
    const after = db.prepare(`SELECT id FROM work_items WHERE id = 'WI-001'`).get();
    expect(after).toBeUndefined();
  });

  it("deleting a node cascades to findings extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('FIND-001', 'finding', 'hash1', '/tmp/find.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('FIND-001', 'minor', 'WI-001', 'pass', 1, 'reviewer')`
    ).run();

    db.prepare(`DELETE FROM nodes WHERE id = 'FIND-001'`).run();
    const after = db.prepare(`SELECT id FROM findings WHERE id = 'FIND-001'`).get();
    expect(after).toBeUndefined();
  });

  it("deleting a node cascades to domain_policies extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('P-001', 'domain_policy', 'hash', '/tmp/p-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO domain_policies (id, domain) VALUES ('P-001', 'test-domain')`
    ).run();
    const before = db.prepare(`SELECT id FROM domain_policies WHERE id = 'P-001'`).get();
    expect(before).toBeDefined();
    db.prepare(`DELETE FROM nodes WHERE id = 'P-001'`).run();
    const after2 = db.prepare(`SELECT id FROM domain_policies WHERE id = 'P-001'`).get();
    expect(after2).toBeUndefined();
  });

  it("deleting a node cascades to domain_decisions extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('D-001', 'domain_decision', 'hash', '/tmp/d-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO domain_decisions (id, domain) VALUES ('D-001', 'test-domain')`
    ).run();
    db.prepare(`DELETE FROM nodes WHERE id = 'D-001'`).run();
    const after3 = db.prepare(`SELECT id FROM domain_decisions WHERE id = 'D-001'`).get();
    expect(after3).toBeUndefined();
  });

  it("deleting a node cascades to domain_questions extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('Q-001', 'domain_question', 'hash', '/tmp/q-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO domain_questions (id, domain) VALUES ('Q-001', 'test-domain')`
    ).run();
    db.prepare(`DELETE FROM nodes WHERE id = 'Q-001'`).run();
    const after4 = db.prepare(`SELECT id FROM domain_questions WHERE id = 'Q-001'`).get();
    expect(after4).toBeUndefined();
  });

  it("deleting a node cascades to guiding_principles extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('GP-01', 'guiding_principle', 'hash', '/tmp/gp-01.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO guiding_principles (id, name) VALUES ('GP-01', 'Test Principle')`
    ).run();
    db.prepare(`DELETE FROM nodes WHERE id = 'GP-01'`).run();
    const after5 = db.prepare(`SELECT id FROM guiding_principles WHERE id = 'GP-01'`).get();
    expect(after5).toBeUndefined();
  });

  it("deleting a node cascades to constraints extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('C-01', 'constraint', 'hash', '/tmp/c-01.yaml')`
    ).run();
    // NOTE: "constraints" is a SQL reserved keyword but SQLite accepts it unquoted as a table name
    db.prepare(
      `INSERT INTO constraints (id, category) VALUES ('C-01', 'design')`
    ).run();
    db.prepare(`DELETE FROM nodes WHERE id = 'C-01'`).run();
    const after6 = db.prepare(`SELECT id FROM constraints WHERE id = 'C-01'`).get();
    expect(after6).toBeUndefined();
  });

  it("deleting a node cascades to module_specs extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('MOD-001', 'module_spec', 'hash', '/tmp/mod-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO module_specs (id, name) VALUES ('MOD-001', 'Test Module')`
    ).run();
    db.prepare(`DELETE FROM nodes WHERE id = 'MOD-001'`).run();
    const after7 = db.prepare(`SELECT id FROM module_specs WHERE id = 'MOD-001'`).get();
    expect(after7).toBeUndefined();
  });

  it("deleting a node cascades to research_findings extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('RF-001', 'research', 'hash', '/tmp/rf-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO research_findings (id, topic) VALUES ('RF-001', 'Test Topic')`
    ).run();
    db.prepare(`DELETE FROM nodes WHERE id = 'RF-001'`).run();
    const after8 = db.prepare(`SELECT id FROM research_findings WHERE id = 'RF-001'`).get();
    expect(after8).toBeUndefined();
  });

  it("deleting a node cascades to journal_entries extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('J-023-001', 'journal_entry', 'hash', '/tmp/j-023-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO journal_entries (id) VALUES ('J-023-001')`
    ).run();
    db.prepare(`DELETE FROM nodes WHERE id = 'J-023-001'`).run();
    const after9 = db.prepare(`SELECT id FROM journal_entries WHERE id = 'J-023-001'`).get();
    expect(after9).toBeUndefined();
  });

  it("deleting a node cascades to document_artifacts extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('DOC-001', 'cycle_summary', 'hash', '/tmp/doc-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO document_artifacts (id) VALUES ('DOC-001')`
    ).run();
    db.prepare(`DELETE FROM nodes WHERE id = 'DOC-001'`).run();
    const after11 = db.prepare(`SELECT id FROM document_artifacts WHERE id = 'DOC-001'`).get();
    expect(after11).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ON DELETE CASCADE — nodes → edges
// ---------------------------------------------------------------------------

describe("createSchema — ON DELETE CASCADE (nodes → edges)", () => {
  it("deleting the source node cascades and removes the edge row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    // Insert two nodes
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('A', 'work_item', 'ha', '/tmp/a.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('B', 'work_item', 'hb', '/tmp/b.yaml')`
    ).run();
    // Insert edge
    db.prepare(
      `INSERT INTO edges (source_id, target_id, edge_type) VALUES ('A', 'B', 'depends_on')`
    ).run();

    // Verify edge exists
    const before = db.prepare(`SELECT id FROM edges WHERE source_id='A'`).get();
    expect(before).toBeDefined();

    // Delete source node
    db.prepare(`DELETE FROM nodes WHERE id = 'A'`).run();

    // Edge should be gone
    const after = db.prepare(`SELECT id FROM edges WHERE source_id='A'`).get();
    expect(after).toBeUndefined();
  });

  it("deleting the target node cascades and removes the edge row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('SRC', 'work_item', 'h1', '/tmp/s.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('TGT', 'work_item', 'h2', '/tmp/t.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO edges (source_id, target_id, edge_type) VALUES ('SRC', 'TGT', 'depends_on')`
    ).run();

    db.prepare(`DELETE FROM nodes WHERE id = 'TGT'`).run();
    const after = db.prepare(`SELECT id FROM edges WHERE source_id='SRC'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ON DELETE CASCADE — nodes → node_file_refs
// ---------------------------------------------------------------------------

describe("createSchema — ON DELETE CASCADE (nodes → node_file_refs)", () => {
  it("deleting a node cascades to its file_refs rows", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('WI-002', 'work_item', 'abc2', '/tmp/wi-002.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO node_file_refs (node_id, file_path) VALUES ('WI-002', 'src/foo.ts')`
    ).run();

    db.prepare(`DELETE FROM nodes WHERE id = 'WI-002'`).run();
    const after = db
      .prepare(`SELECT node_id FROM node_file_refs WHERE node_id = 'WI-002'`)
      .get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// edges table — no source_type or target_type columns
// ---------------------------------------------------------------------------

describe("createSchema — edges table columns", () => {
  it("edges table does NOT have a source_type column", () => {
    const db = freshDb();
    const cols = columnNames(db, "edges");
    expect(cols).not.toContain("source_type");
  });

  it("edges table does NOT have a target_type column", () => {
    const db = freshDb();
    const cols = columnNames(db, "edges");
    expect(cols).not.toContain("target_type");
  });

  it("edges table has: id, source_id, target_id, edge_type, props", () => {
    const db = freshDb();
    const cols = columnNames(db, "edges");
    for (const col of ["id", "source_id", "target_id", "edge_type", "props"]) {
      expect(cols).toContain(col);
    }
  });

  it("enforces UNIQUE(source_id, target_id, edge_type) constraint (insert with FK OFF)", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, ?)
    `);
    insert.run("A", "B", "depends_on");
    expect(() => {
      insert.run("A", "B", "depends_on");
    }).toThrow();
    db.pragma("foreign_keys = ON");
  });

  it("INSERT OR IGNORE on duplicate edge leaves only 1 row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT OR IGNORE INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, ?)
    `);
    insert.run("A", "B", "depends_on");
    insert.run("A", "B", "depends_on");
    const count = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM edges WHERE source_id='A' AND target_id='B' AND edge_type='depends_on'`)
        .get() as { cnt: number }
    ).cnt;
    expect(count).toBe(1);
    db.pragma("foreign_keys = ON");
  });

  it("edges.id is auto-increment", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES ('X', 'Y', 'depends_on')
    `).run();
    const row = db
      .prepare(`SELECT id FROM edges WHERE source_id='X'`)
      .get() as { id: number } | undefined;
    expect(row).toBeDefined();
    expect(typeof row!.id).toBe("number");
    expect(row!.id).toBeGreaterThan(0);
    db.pragma("foreign_keys = ON");
  });
});

// ---------------------------------------------------------------------------
// node_file_refs — PRIMARY KEY (node_id, file_path), no node_type column
// ---------------------------------------------------------------------------

describe("createSchema — node_file_refs table", () => {
  it("does NOT have a node_type column", () => {
    const db = freshDb();
    const cols = columnNames(db, "node_file_refs");
    expect(cols).not.toContain("node_type");
  });

  it("enforces PRIMARY KEY (node_id, file_path) — duplicate throws (insert with FK OFF)", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO node_file_refs (node_id, file_path)
      VALUES (?, ?)
    `);
    insert.run("WI-001", "src/foo.ts");
    expect(() => {
      insert.run("WI-001", "src/foo.ts");
    }).toThrow();
    db.pragma("foreign_keys = ON");
  });

  it("allows same node_id with different file_path", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO node_file_refs (node_id, file_path)
      VALUES (?, ?)
    `);
    insert.run("WI-001", "src/foo.ts");
    expect(() => {
      insert.run("WI-001", "src/bar.ts");
    }).not.toThrow();
    db.pragma("foreign_keys = ON");
  });
});

// ---------------------------------------------------------------------------
// Schema version — CURRENT_SCHEMA_VERSION is 7
// ---------------------------------------------------------------------------

describe("createSchema — schema version", () => {
  it("CURRENT_SCHEMA_VERSION is 9", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
  });

  it("sets user_version = 9 after createSchema", () => {
    const db = freshDb();
    const version = db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Index existence
// ---------------------------------------------------------------------------

describe("createSchema — indexes", () => {
  // Shared DB instance — createSchema is deterministic, index checks are read-only
  const db = freshDb();

  it("creates idx_nodes_type on nodes", () => {
    expect(indexNames(db, "nodes")).toContain("idx_nodes_type");
  });

  it("creates idx_nodes_file_path on nodes", () => {
    expect(indexNames(db, "nodes")).toContain("idx_nodes_file_path");
  });

  it("creates idx_edges_source on edges", () => {
    expect(indexNames(db, "edges")).toContain("idx_edges_source");
  });

  it("creates idx_edges_target on edges", () => {
    expect(indexNames(db, "edges")).toContain("idx_edges_target");
  });

  it("creates idx_file_refs_path on node_file_refs", () => {
    expect(indexNames(db, "node_file_refs")).toContain("idx_file_refs_path");
  });

  it("creates idx_work_items_domain on work_items", () => {
    expect(indexNames(db, "work_items")).toContain("idx_work_items_domain");
  });

  it("creates idx_findings_work_item on findings", () => {
    expect(indexNames(db, "findings")).toContain("idx_findings_work_item");
  });

  it("creates idx_domain_policies_domain on domain_policies", () => {
    expect(indexNames(db, "domain_policies")).toContain("idx_domain_policies_domain");
  });

  it("creates idx_domain_questions_domain on domain_questions", () => {
    expect(indexNames(db, "domain_questions")).toContain("idx_domain_questions_domain");
  });
});

// ---------------------------------------------------------------------------
// findings table columns
// ---------------------------------------------------------------------------

describe("createSchema — findings table columns", () => {
  it("has all 11 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "findings");
    for (const col of [
      "id", "severity", "work_item", "file_refs", "verdict",
      "cycle", "reviewer", "description", "suggestion", "addressed_by", "title",
    ]) {
      expect(cols, `expected findings to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: severity, work_item, verdict, cycle, reviewer are required; file_refs, description, suggestion, addressed_by, title are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('findings')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));
    for (const col of ["severity", "work_item", "verdict", "cycle", "reviewer"]) {
      expect(byName[col], `${col} should be NOT NULL`).toBe(1);
    }
    for (const col of ["file_refs", "description", "suggestion", "addressed_by", "title"]) {
      expect(byName[col], `${col} should be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// domain_policies table columns
// ---------------------------------------------------------------------------

describe("createSchema — domain_policies table columns", () => {
  it("has all 7 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "domain_policies");
    for (const col of [
      "id", "domain", "derived_from", "established", "amended", "amended_by", "description",
    ]) {
      expect(cols, `expected domain_policies to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: domain is required; derived_from, established, amended, amended_by, description are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('domain_policies')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));
    for (const col of ["domain"]) {
      expect(byName[col], `${col} should be NOT NULL`).toBe(1);
    }
    for (const col of ["derived_from", "established", "amended", "amended_by", "description"]) {
      expect(byName[col], `${col} should be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// domain_questions table columns
// ---------------------------------------------------------------------------

describe("createSchema — domain_questions table columns", () => {
  it("has all 8 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "domain_questions");
    for (const col of [
      "id", "domain", "impact", "source", "resolution", "resolved_in", "description", "addressed_by",
    ]) {
      expect(cols, `expected domain_questions to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: domain is required; impact, source, resolution, resolved_in, description, addressed_by are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('domain_questions')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));
    for (const col of ["domain"]) {
      expect(byName[col], `${col} should be NOT NULL`).toBe(1);
    }
    for (const col of ["impact", "source", "resolution", "resolved_in", "description", "addressed_by"]) {
      expect(byName[col], `${col} should be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// document_artifacts table columns
// ---------------------------------------------------------------------------

describe("createSchema — document_artifacts table columns", () => {
  it("has all 4 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "document_artifacts");
    for (const col of ["id", "title", "cycle", "content"]) {
      expect(cols, `expected document_artifacts to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: title, cycle, and content are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('document_artifacts')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));
    for (const col of ["title", "cycle", "content"]) {
      expect(byName[col], `${col} should be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// work_items table
// ---------------------------------------------------------------------------

describe("createSchema — work_items table", () => {
  it("has all 13 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "work_items");
    for (const col of [
      "id", "title", "complexity", "scope", "depends", "blocks",
      "criteria", "module", "domain", "phase", "notes", "work_item_type", "resolution",
    ]) {
      expect(cols, `expected work_items to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: title is required; complexity, scope, depends, blocks, criteria, module, domain, phase, notes, work_item_type, resolution are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('work_items')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));

    // Required (NOT NULL)
    for (const col of ["title"]) {
      expect(byName[col], `expected '${col}' to be NOT NULL`).toBe(1);
    }

    // Nullable
    for (const col of ["complexity", "scope", "depends", "blocks", "criteria", "module", "domain", "phase", "notes", "work_item_type", "resolution"]) {
      expect(byName[col], `expected '${col}' to be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// domain_decisions table
// ---------------------------------------------------------------------------

describe("createSchema — domain_decisions table", () => {
  it("has all 9 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "domain_decisions");
    for (const col of ["id", "domain", "cycle", "supersedes", "description", "rationale", "title", "source", "derived_from"]) {
      expect(cols, `expected domain_decisions to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: domain is required; cycle, supersedes, description, rationale, title, source, derived_from are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('domain_decisions')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));

    // Required (NOT NULL)
    for (const col of ["domain"]) {
      expect(byName[col], `expected '${col}' to be NOT NULL`).toBe(1);
    }

    // Nullable
    for (const col of ["cycle", "supersedes", "description", "rationale", "title", "source", "derived_from"]) {
      expect(byName[col], `expected '${col}' to be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// guiding_principles table
// ---------------------------------------------------------------------------

describe("createSchema — guiding_principles table", () => {
  it("has all 4 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "guiding_principles");
    for (const col of ["id", "name", "description", "amendment_history"]) {
      expect(cols, `expected guiding_principles to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: name is required; description and amendment_history are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('guiding_principles')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));

    // Required (NOT NULL)
    for (const col of ["name"]) {
      expect(byName[col], `expected '${col}' to be NOT NULL`).toBe(1);
    }

    // Nullable
    for (const col of ["description", "amendment_history"]) {
      expect(byName[col], `expected '${col}' to be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// constraints table
// ---------------------------------------------------------------------------

describe("createSchema — constraints table", () => {
  it("has all 3 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "constraints");
    for (const col of ["id", "category", "description"]) {
      expect(cols, `expected constraints to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: category is required; description is nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('constraints')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));

    // Required (NOT NULL)
    for (const col of ["category"]) {
      expect(byName[col], `expected '${col}' to be NOT NULL`).toBe(1);
    }

    // Nullable
    for (const col of ["description"]) {
      expect(byName[col], `expected '${col}' to be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// module_specs table
// ---------------------------------------------------------------------------

describe("createSchema — module_specs table", () => {
  it("has all 6 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "module_specs");
    for (const col of ["id", "name", "scope", "provides", "requires", "boundary_rules"]) {
      expect(cols, `expected module_specs to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: name is required; scope, provides, requires, boundary_rules are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('module_specs')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));

    // Required (NOT NULL)
    for (const col of ["name"]) {
      expect(byName[col], `expected '${col}' to be NOT NULL`).toBe(1);
    }

    // Nullable
    for (const col of ["scope", "provides", "requires", "boundary_rules"]) {
      expect(byName[col], `expected '${col}' to be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// research_findings table
// ---------------------------------------------------------------------------

describe("createSchema — research_findings table", () => {
  it("has all 5 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "research_findings");
    for (const col of ["id", "topic", "date", "content", "sources"]) {
      expect(cols, `expected research_findings to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: topic is required; date, content, sources are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('research_findings')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));

    // Required (NOT NULL)
    for (const col of ["topic"]) {
      expect(byName[col], `expected '${col}' to be NOT NULL`).toBe(1);
    }

    // Nullable
    for (const col of ["date", "content", "sources"]) {
      expect(byName[col], `expected '${col}' to be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// journal_entries table
// ---------------------------------------------------------------------------

describe("createSchema — journal_entries table", () => {
  it("has all 6 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "journal_entries");
    for (const col of ["id", "phase", "date", "title", "work_item", "content"]) {
      expect(cols, `expected journal_entries to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: phase, date, title, work_item, content are all nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('journal_entries')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));

    // Nullable
    for (const col of ["phase", "date", "title", "work_item", "content"]) {
      expect(byName[col], `expected '${col}' to be nullable`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// interview_questions table
// ---------------------------------------------------------------------------

describe("createSchema — interview_questions table", () => {
  it("interview_questions table exists", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).toContain("interview_questions");
  });

  it("has expected columns: id, interview_id, question, answer, domain, seq", () => {
    const db = freshDb();
    const cols = columnNames(db, "interview_questions");
    for (const col of ["id", "interview_id", "question", "answer", "domain", "seq"]) {
      expect(cols, `expected interview_questions to have column '${col}'`).toContain(col);
    }
  });

  it("domain column is nullable", () => {
    const db = freshDb();
    const rows = db
      .prepare(`PRAGMA table_info(interview_questions)`)
      .all() as Array<{ name: string; notnull: number }>;
    const col = rows.find((r) => r.name === "domain");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it("creates idx_interview_questions_interview index", () => {
    const db = freshDb();
    const indexes = indexNames(db, "interview_questions");
    expect(indexes).toContain("idx_interview_questions_interview");
  });

  it("ON DELETE CASCADE: deleting a node cascades to interview_questions row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('INT-001', 'interview', 'hash-int', '/tmp/int-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('IQ-001-001', 'interview_question', 'hash-iq', '/tmp/int-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO interview_questions (id, interview_id, question, answer, seq) VALUES ('IQ-001-001', 'INT-001', 'What?', 'This.', 1)`
    ).run();

    const before = db.prepare(`SELECT id FROM interview_questions WHERE id = 'IQ-001-001'`).get();
    expect(before).toBeDefined();

    db.prepare(`DELETE FROM nodes WHERE id = 'IQ-001-001'`).run();

    const after = db.prepare(`SELECT id FROM interview_questions WHERE id = 'IQ-001-001'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("createSchema — idempotency", () => {
  it("can be called twice on the same DB without error", () => {
    const db = new Database(":memory:");
    expect(() => {
      createSchema(db);
      createSchema(db);
    }).not.toThrow();
  });

  it("same tables present after second call", () => {
    const db = new Database(":memory:");
    createSchema(db);
    createSchema(db);
    const tables = tableNames(db);
    expect(tables).toContain("nodes");
    expect(tables).toContain("work_items");
    expect(tables).toContain("edges");
    expect(tables).toContain("node_file_refs");
  });
});

// ---------------------------------------------------------------------------
// checkSchemaVersion
// ---------------------------------------------------------------------------

describe("checkSchemaVersion", () => {
  it("returns true for a fresh database with user_version = 0", () => {
    const db = new Database(":memory:");
    // SQLite sets user_version = 0 by default on a new file — treated as "fresh DB, compatible"
    const result = checkSchemaVersion(db, "/nonexistent/path/that/does/not/exist.db");
    expect(result).toBe(true);
    db.close();
  });

  it("returns false and deletes the database file when user_version is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "ideate-schema-test-"));
    const dbPath = join(dir, "test.db");

    try {
      {
        const db = new Database(dbPath);
        db.pragma("user_version = 99"); // stale — current is 9
        db.close();
      }

      // Open the handle; track whether the test still owns it so the finally
      // block can close it safely if checkSchemaVersion does not (e.g. if the
      // implementation is later changed to not close internally on this path).
      const db = new Database(dbPath);
      let handleClosed = false;
      try {
        const result = checkSchemaVersion(db, dbPath);
        expect(result).toBe(false);
        expect(existsSync(dbPath)).toBe(false);
      } finally {
        if (!handleClosed) {
          try { db.close(); } catch { /* already closed by checkSchemaVersion */ }
          handleClosed = true;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when user_version matches CURRENT_SCHEMA_VERSION (9)", () => {
    const db = new Database(":memory:");
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`); // 9
    const result = checkSchemaVersion(db, "/nonexistent/path/not/used.db");
    expect(result).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPES — governed_by and informed_by
// ---------------------------------------------------------------------------

describe("EDGE_TYPES — governed_by and informed_by", () => {
  it("EDGE_TYPES includes governed_by", () => {
    expect(EDGE_TYPES).toContain("governed_by");
  });

  it("EDGE_TYPES includes informed_by", () => {
    expect(EDGE_TYPES).toContain("informed_by");
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPE_REGISTRY — governed_by and informed_by entries
// ---------------------------------------------------------------------------

describe("EDGE_TYPE_REGISTRY — governed_by entry", () => {
  it("governed_by entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("governed_by");
  });

  it("governed_by has correct source_types", () => {
    expect(EDGE_TYPE_REGISTRY.governed_by.source_types).toEqual(["work_item", "module_spec", "constraint"]);
  });

  it("governed_by has correct target_types", () => {
    expect(EDGE_TYPE_REGISTRY.governed_by.target_types).toEqual(["guiding_principle", "domain_policy", "constraint"]);
  });

  it("governed_by has yaml_field set", () => {
    expect(EDGE_TYPE_REGISTRY.governed_by.yaml_field).toBe("governed_by");
  });
});

describe("EDGE_TYPE_REGISTRY — informed_by entry", () => {
  it("informed_by entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("informed_by");
  });

  it("informed_by has correct source_types", () => {
    expect(EDGE_TYPE_REGISTRY.informed_by.source_types).toEqual(["work_item", "module_spec", "guiding_principle"]);
  });

  it("informed_by has correct target_types", () => {
    expect(EDGE_TYPE_REGISTRY.informed_by.target_types).toEqual(["research_finding", "domain_decision", "domain_question"]);
  });

  it("informed_by has yaml_field set", () => {
    expect(EDGE_TYPE_REGISTRY.informed_by.yaml_field).toBe("informed_by");
  });
});

// ---------------------------------------------------------------------------
// projects table
// ---------------------------------------------------------------------------

describe("createSchema — projects table", () => {
  it("projects table exists", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).toContain("projects");
  });

  it("has expected columns: id, name, description, intent, scope_boundary, success_criteria, appetite, steering, horizon, status, current_phase_id", () => {
    const db = freshDb();
    const cols = columnNames(db, "projects");
    for (const col of ["id", "name", "description", "intent", "scope_boundary", "success_criteria", "appetite", "steering", "horizon", "status", "current_phase_id"]) {
      expect(cols, `expected projects to have column '${col}'`).toContain(col);
    }
  });

  it("ON DELETE CASCADE: deleting a node cascades to projects row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('PRJ-001', 'project', 'hash-prj', '/tmp/prj-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO projects (id, intent, status) VALUES ('PRJ-001', 'Build something', 'active')`
    ).run();
    const before = db.prepare(`SELECT id FROM projects WHERE id = 'PRJ-001'`).get();
    expect(before).toBeDefined();
    db.prepare(`DELETE FROM nodes WHERE id = 'PRJ-001'`).run();
    const after = db.prepare(`SELECT id FROM projects WHERE id = 'PRJ-001'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// phases table
// ---------------------------------------------------------------------------

describe("createSchema — phases table", () => {
  it("phases table exists", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).toContain("phases");
  });

  it("has expected columns: id, name, description, project, phase_type, intent, steering, status, work_items, completed_date", () => {
    const db = freshDb();
    const cols = columnNames(db, "phases");
    for (const col of ["id", "name", "description", "project", "phase_type", "intent", "steering", "status", "work_items", "completed_date"]) {
      expect(cols, `expected phases to have column '${col}'`).toContain(col);
    }
  });

  it("creates idx_phases_project index on phases", () => {
    const db = freshDb();
    const indexes = indexNames(db, "phases");
    expect(indexes).toContain("idx_phases_project");
  });

  it("ON DELETE CASCADE: deleting a node cascades to phases row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('PH-001', 'phase', 'hash-ph', '/tmp/ph-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO phases (id, project, phase_type, intent, status) VALUES ('PH-001', 'PRJ-001', 'execute', 'Build it', 'active')`
    ).run();
    const before = db.prepare(`SELECT id FROM phases WHERE id = 'PH-001'`).get();
    expect(before).toBeDefined();
    db.prepare(`DELETE FROM nodes WHERE id = 'PH-001'`).run();
    const after = db.prepare(`SELECT id FROM phases WHERE id = 'PH-001'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// proxy_human_decisions table
// ---------------------------------------------------------------------------

describe("createSchema — proxy_human_decisions table", () => {
  it("has all 8 expected columns", () => {
    const db = freshDb();
    const cols = columnNames(db, "proxy_human_decisions");
    for (const col of ["id", "cycle", "trigger", "triggered_by", "decision", "rationale", "timestamp", "status"]) {
      expect(cols, `expected proxy_human_decisions to have column '${col}'`).toContain(col);
    }
  });

  it("NOT NULL constraints: cycle, trigger, decision, timestamp, status are required; triggered_by and rationale are nullable", () => {
    const db = freshDb();
    type ColInfo = { name: string; notnull: number };
    const colInfo = db.prepare("PRAGMA table_info('proxy_human_decisions')").all() as ColInfo[];
    const byName = Object.fromEntries(colInfo.map((c) => [c.name, c.notnull]));

    // Required (NOT NULL)
    for (const col of ["cycle", "trigger", "decision", "timestamp", "status"]) {
      expect(byName[col], `expected '${col}' to be NOT NULL`).toBe(1);
    }

    // Nullable
    for (const col of ["triggered_by", "rationale"]) {
      expect(byName[col], `expected '${col}' to be nullable`).toBe(0);
    }
  });

  it("has idx_proxy_human_decisions_cycle index", () => {
    const db = freshDb();
    expect(indexNames(db, "proxy_human_decisions")).toContain("idx_proxy_human_decisions_cycle");
  });

  it("ON DELETE CASCADE: deleting a node cascades to proxy_human_decisions row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('PHD-001', 'proxy_human_decision', 'hash-phd', '/tmp/phd-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO proxy_human_decisions (id, cycle, "trigger", decision, timestamp, status) VALUES ('PHD-001', 1, 'test-trigger', 'test-decision', '2026-04-12', 'deferred')`
    ).run();
    const before = db.prepare(`SELECT id FROM proxy_human_decisions WHERE id = 'PHD-001'`).get();
    expect(before).toBeDefined();
    db.prepare(`DELETE FROM nodes WHERE id = 'PHD-001'`).run();
    const after = db.prepare(`SELECT id FROM proxy_human_decisions WHERE id = 'PHD-001'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPES — belongs_to_project and belongs_to_phase
// ---------------------------------------------------------------------------

describe("EDGE_TYPES — belongs_to_project and belongs_to_phase", () => {
  it("EDGE_TYPES includes belongs_to_project", () => {
    expect(EDGE_TYPES).toContain("belongs_to_project");
  });

  it("EDGE_TYPES includes belongs_to_phase", () => {
    expect(EDGE_TYPES).toContain("belongs_to_phase");
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPE_REGISTRY — belongs_to_project and belongs_to_phase entries
// ---------------------------------------------------------------------------

describe("EDGE_TYPE_REGISTRY — belongs_to_project entry", () => {
  it("belongs_to_project entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("belongs_to_project");
  });

  it("belongs_to_project has correct source_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_project.source_types).toEqual(["phase"]);
  });

  it("belongs_to_project has correct target_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_project.target_types).toEqual(["project"]);
  });

  it("belongs_to_project has yaml_field = 'project'", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_project.yaml_field).toBe("project");
  });
});

describe("EDGE_TYPE_REGISTRY — belongs_to_phase entry", () => {
  it("belongs_to_phase entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("belongs_to_phase");
  });

  it("belongs_to_phase has correct source_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_phase.source_types).toEqual(["work_item"]);
  });

  it("belongs_to_phase has correct target_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_phase.target_types).toEqual(["phase"]);
  });

  it("belongs_to_phase has yaml_field = 'phase'", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_phase.yaml_field).toBe("phase");
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPES — belongs_to_cycle
// ---------------------------------------------------------------------------

describe("EDGE_TYPES — belongs_to_cycle", () => {
  it("EDGE_TYPES includes belongs_to_cycle", () => {
    expect(EDGE_TYPES).toContain("belongs_to_cycle");
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPE_REGISTRY — belongs_to_cycle entry
// ---------------------------------------------------------------------------

describe("EDGE_TYPE_REGISTRY — belongs_to_cycle entry", () => {
  it("belongs_to_cycle entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("belongs_to_cycle");
  });

  it("belongs_to_cycle has correct source_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_cycle.source_types).toEqual(["journal_entry"]);
  });

  it("belongs_to_cycle has correct target_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_cycle.target_types).toEqual(["cycle_summary"]);
  });

  it("belongs_to_cycle has yaml_field null", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_cycle.yaml_field).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPE_REGISTRY — relates_to derivationPath documents regex-mining (WI-901)
// ---------------------------------------------------------------------------

describe("EDGE_TYPE_REGISTRY — relates_to derivationPath", () => {
  it("relates_to entry has derivationPath set to 'regex_mine_journal_titles'", () => {
    // The relates_to edge has two derivation paths for journal_entry sources:
    // 1. yaml_field 'work_item' — the standard YAML field path
    // 2. regex mining of the journal entry title — implemented in deriveJournalEntryEdges
    // The derivationPath field documents the second path so a developer reading
    // EDGE_TYPE_REGISTRY alone understands the full derivation behaviour.
    expect(EDGE_TYPE_REGISTRY.relates_to.derivationPath).toBe("regex_mine_journal_titles");
  });

  it("relates_to yaml_field remains 'work_item' (no behavioural change)", () => {
    expect(EDGE_TYPE_REGISTRY.relates_to.yaml_field).toBe("work_item");
  });
});

// ---------------------------------------------------------------------------
// CONTAINMENT_EDGE_TYPES — all members must be registered in EDGE_TYPES
// ---------------------------------------------------------------------------

describe("CONTAINMENT_EDGE_TYPES — registry membership", () => {
  it("every member of CONTAINMENT_EDGE_TYPES is present in EDGE_TYPES", () => {
    for (const t of Array.from(CONTAINMENT_EDGE_TYPES)) {
      expect(
        (EDGE_TYPES as readonly string[]).includes(t),
        `CONTAINMENT_EDGE_TYPES member '${t}' is not in EDGE_TYPES`
      ).toBe(true);
    }
  });

  it("CONTAINMENT_EDGE_TYPES is non-empty", () => {
    expect(CONTAINMENT_EDGE_TYPES.size).toBeGreaterThan(0);
  });

  it("CONTAINMENT_EDGE_TYPES contains belongs_to_module", () => {
    expect(CONTAINMENT_EDGE_TYPES.has("belongs_to_module")).toBe(true);
  });

  it("CONTAINMENT_EDGE_TYPES does NOT contain belongs_to_domain (domain edges flow through getEdges)", () => {
    // belongs_to_domain is excluded from the containment set because domain edges
    // are used by getEdges() for cross-type domain relationship queries and must
    // not be filtered out during traversal.
    expect(CONTAINMENT_EDGE_TYPES.has("belongs_to_domain")).toBe(false);
  });

  it("CONTAINMENT_EDGE_TYPES contains belongs_to_project", () => {
    expect(CONTAINMENT_EDGE_TYPES.has("belongs_to_project")).toBe(true);
  });

  it("CONTAINMENT_EDGE_TYPES contains belongs_to_phase", () => {
    expect(CONTAINMENT_EDGE_TYPES.has("belongs_to_phase")).toBe(true);
  });

  it("CONTAINMENT_EDGE_TYPES contains belongs_to_cycle", () => {
    expect(CONTAINMENT_EDGE_TYPES.has("belongs_to_cycle")).toBe(true);
  });

  it("CONTAINMENT_EDGE_TYPES does not contain phantom types from the old inline sets", () => {
    const phantomTypes = [
      "owns_codebase",
      "owns_project",
      "has_phase",
      "has_work_item",
      "owns_knowledge",
      "references_codebase",
    ];
    for (const phantom of phantomTypes) {
      expect(
        CONTAINMENT_EDGE_TYPES.has(phantom as never),
        `phantom type '${phantom}' should NOT be in CONTAINMENT_EDGE_TYPES`
      ).toBe(false);
    }
  });

  it("semantic/derivation edge types are NOT in CONTAINMENT_EDGE_TYPES", () => {
    // Includes belongs_to_domain because domain edges are used for getEdges() queries
    const semanticTypes = ["derived_from", "relates_to", "addressed_by", "references", "depends_on", "blocks", "belongs_to_domain"];
    for (const t of semanticTypes) {
      expect(
        CONTAINMENT_EDGE_TYPES.has(t as never),
        `semantic type '${t}' should NOT be in CONTAINMENT_EDGE_TYPES`
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPE_REGISTRY — supersedes entry (WI-905: extended to work_item)
// ---------------------------------------------------------------------------

describe("EDGE_TYPE_REGISTRY — supersedes entry", () => {
  it("supersedes entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("supersedes");
  });

  it("supersedes source_types is exactly ['domain_decision'] (work_item extracted via hand-wired indexer block)", () => {
    expect(EDGE_TYPE_REGISTRY.supersedes.source_types).toEqual(["domain_decision"]);
  });

  it("supersedes source_types does NOT include work_item (work_item uses superseded_by field, hand-wired in indexer)", () => {
    expect(EDGE_TYPE_REGISTRY.supersedes.source_types).not.toContain("work_item");
  });

  it("supersedes target_types includes domain_decision", () => {
    expect(EDGE_TYPE_REGISTRY.supersedes.target_types).toContain("domain_decision");
  });

  it("supersedes target_types includes work_item (supersedes CAN target a work_item)", () => {
    expect(EDGE_TYPE_REGISTRY.supersedes.target_types).toContain("work_item");
  });

  it("supersedes yaml_field remains 'supersedes'", () => {
    expect(EDGE_TYPE_REGISTRY.supersedes.yaml_field).toBe("supersedes");
  });

  it("supersedes derivationPath is 'work_item_superseded_by_field'", () => {
    expect(EDGE_TYPE_REGISTRY.supersedes.derivationPath).toBe("work_item_superseded_by_field");
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPE_REGISTRY — derived_from entry (WI-905: extended source/target types)
// ---------------------------------------------------------------------------

describe("EDGE_TYPE_REGISTRY — derived_from entry", () => {
  it("derived_from entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("derived_from");
  });

  it("derived_from source_types includes domain_policy (existing)", () => {
    expect(EDGE_TYPE_REGISTRY.derived_from.source_types).toContain("domain_policy");
  });

  it("derived_from source_types includes domain_decision (existing)", () => {
    expect(EDGE_TYPE_REGISTRY.derived_from.source_types).toContain("domain_decision");
  });

  it("derived_from source_types includes guiding_principle (WI-908)", () => {
    // Regression guard: guiding_principle must remain in source_types so that
    // principles with a derived_from field emit edges correctly.
    expect(EDGE_TYPE_REGISTRY.derived_from.source_types).toContain("guiding_principle");
  });

  it("derived_from target_types includes guiding_principle (existing)", () => {
    expect(EDGE_TYPE_REGISTRY.derived_from.target_types).toContain("guiding_principle");
  });

  it("derived_from target_types includes finding", () => {
    expect(EDGE_TYPE_REGISTRY.derived_from.target_types).toContain("finding");
  });

  it("derived_from target_types includes domain_policy", () => {
    expect(EDGE_TYPE_REGISTRY.derived_from.target_types).toContain("domain_policy");
  });

  it("derived_from yaml_field remains 'derived_from'", () => {
    expect(EDGE_TYPE_REGISTRY.derived_from.yaml_field).toBe("derived_from");
  });
});

// ---------------------------------------------------------------------------
// document_artifacts.cycle populated by indexer for cycle_summary YAML
// ---------------------------------------------------------------------------

describe("indexer — document_artifacts.cycle populated from YAML", () => {
  it("indexing a cycle_summary YAML with top-level cycle:3 sets document_artifacts.cycle = 3", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ideate-da-cycle-test-"));
    try {
      // Set up a minimal .ideate/ directory with a cycles/003/ subdir
      const cycleDir = join(tmpDir, "cycles", "003");
      mkdirSync(cycleDir, { recursive: true });

      // Write a cycle_summary YAML with a top-level cycle field
      const yamlPath = join(cycleDir, "SA-TEST-001.yaml");
      writeFileSync(
        yamlPath,
        [
          "id: SA-TEST-001",
          "type: cycle_summary",
          "cycle: 3",
          "title: Test Spec Adherence",
          "reviewer: spec-reviewer",
          "verdict: Pass",
          "content: |",
          "  ## Verdict: Pass",
        ].join("\n") + "\n",
        "utf8"
      );

      // Set up in-memory DB + drizzle
      const db = new Database(":memory:");
      createSchema(db);
      const drizzleDb = drizzle(db, { schema: dbSchema });

      // Run incremental indexer on the single file
      indexFiles(db, drizzleDb, [yamlPath]);

      // Query document_artifacts for SA-TEST-001
      const row = db
        .prepare("SELECT cycle FROM document_artifacts WHERE id = 'SA-TEST-001'")
        .get() as { cycle: number | null } | undefined;

      expect(row, "SA-TEST-001 should be present in document_artifacts").toBeDefined();
      expect(row!.cycle, "document_artifacts.cycle should equal 3").toBe(3);

      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
