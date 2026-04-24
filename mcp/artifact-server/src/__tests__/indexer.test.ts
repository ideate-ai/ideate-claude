import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { stringify } from "yaml";
import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import { rebuildIndex, detectCycles, indexFiles, removeFiles, deriveJournalEntryCycleEdges, MAX_DEPENDENCY_NODES, MAX_DEPENDENCY_EDGES, readAndPrepare, upsertPrepared } from "../indexer.js";
import { computeArtifactHash, upsertNode, upsertJournalEntry, upsertDocumentArtifact } from "../db-helpers.js";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-indexer-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a fresh in-memory DB with schema applied */
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  createSchema(db);
  return db;
}

/**
 * Set up a minimal .ideate/ directory structure under baseDir.
 * Returns the path to the .ideate/ directory.
 */
function makeIdeateDir(baseDir: string): string {
  const ideateDir = path.join(baseDir, ".ideate");
  const subdirs = [
    "work-items",
    "principles",
    "constraints",
    "policies",
    "decisions",
    "questions",
    "modules",
    "research",
    "interviews",
    "cycles",
    "projects",
    "phases",
  ];
  for (const sub of subdirs) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }
  return ideateDir;
}

/** Write a YAML file under the given directory */
function writeYaml(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

/** Minimal work item YAML */
function minimalWorkItem(overrides: Record<string, unknown> = {}): string {
  const defaults: Record<string, unknown> = {
    id: "WI-001",
    type: "work_item",
    title: "Test work item",
    status: "pending",
    complexity: "small",
    cycle_created: 1,
    cycle_modified: null,
    depends: [],
    blocks: [],
    criteria: [],
    scope: [],
    content_hash: "",
    token_count: 0,
    file_path: "",
  };
  const merged = { ...defaults, ...overrides };
  // Hand-roll YAML for predictable output (avoids circular dep on yaml lib in tests)
  const lines: string[] = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v === null) {
      lines.push(`${k}: null`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) {
          if (typeof item === "object" && item !== null) {
            // Use block mapping syntax for objects in arrays:
            //   - key1: val1
            //     key2: val2
            const entries = Object.entries(item as Record<string, unknown>);
            const [firstKey, firstVal] = entries[0];
            lines.push(`  - ${firstKey}: ${firstVal}`);
            for (const [ik, iv] of entries.slice(1)) {
              lines.push(`    ${ik}: ${iv}`);
            }
          } else {
            lines.push(`  - ${item}`);
          }
        }
      }
    } else if (typeof v === "string") {
      lines.push(`${k}: "${v}"`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// rebuildIndex tests
// ---------------------------------------------------------------------------

describe("rebuildIndex — empty directory", () => {
  it("returns zero stats for empty .ideate/ dir", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const stats = rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);
    expect(stats.files_scanned).toBe(0);
    expect(stats.files_updated).toBe(0);
    expect(stats.files_deleted).toBe(0);
    expect(stats.edges_created).toBe(0);
    expect(stats.cycles_detected).toEqual([]);
  });
});

describe("rebuildIndex — work item YAML → table populated", () => {
  it("inserts a work item row with correct title", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem({ id: "WI-001", title: "Test work item" })
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const row = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-001'")
      .get() as { id: string; title: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.title).toBe("Test work item");
  });
});

describe("rebuildIndex — depends edge extracted", () => {
  it("creates a depends_on edge from WI-002 to WI-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    writeYaml(wiDir, "WI-001.yaml", minimalWorkItem({ id: "WI-001" }));
    writeYaml(
      wiDir,
      "WI-002.yaml",
      minimalWorkItem({ id: "WI-002", title: "Second item", depends: ["WI-001"] })
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-002' AND target_id = 'WI-001' AND edge_type = 'depends_on'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.source_id).toBe("WI-002");
    expect(edge!.target_id).toBe("WI-001");
    expect(edge!.edge_type).toBe("depends_on");
  });
});

describe("rebuildIndex — incremental skip for unchanged file", () => {
  it("returns files_updated: 0 on second call with same content", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem()
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);
    const stats2 = rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    expect(stats2.files_updated).toBe(0);
  });
});

describe("rebuildIndex — incremental update for changed file", () => {
  it("updates the row and returns files_updated: 1 after content change", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiPath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem({ title: "Original title" })
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    // Overwrite with new content
    fs.writeFileSync(wiPath, minimalWorkItem({ title: "Updated title" }), "utf8");

    const stats2 = rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    expect(stats2.files_updated).toBe(1);

    const row = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-001'")
      .get() as { title: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.title).toBe("Updated title");
  });
});

describe("rebuildIndex — stale row deletion", () => {
  it("removes the row when the YAML file is deleted", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiPath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem()
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    // Confirm it was inserted
    const before = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-001'")
      .get();
    expect(before).toBeDefined();

    // Delete the file and rebuild
    fs.unlinkSync(wiPath);
    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const after = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-001'")
      .get();
    expect(after).toBeUndefined();
  });
});

describe("rebuildIndex — node_file_refs from scope", () => {
  it("inserts a node_file_refs row for each scope entry path", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem({
        scope: [{ path: "src/foo.ts", op: "modify" }],
      })
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const ref = db
      .prepare(
        `SELECT * FROM node_file_refs WHERE node_id = 'WI-001' AND file_path = 'src/foo.ts'`
      )
      .get() as { node_id: string; file_path: string } | undefined;
    expect(ref).toBeDefined();
    expect(ref!.node_id).toBe("WI-001");
    expect(ref!.file_path).toBe("src/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — files_failed for malformed YAML
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rebuildIndex — edge extraction tests per auto-extracted edge type
// ---------------------------------------------------------------------------

describe("rebuildIndex — blocks edge extracted", () => {
  it("creates a blocks edge from WI-002 to WI-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    writeYaml(wiDir, "WI-001.yaml", minimalWorkItem({ id: "WI-001" }));
    writeYaml(
      wiDir,
      "WI-002.yaml",
      minimalWorkItem({ id: "WI-002", title: "Blocker item", blocks: ["WI-001"] })
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-002' AND target_id = 'WI-001' AND edge_type = 'blocks'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("blocks");
  });
});

describe("rebuildIndex — belongs_to_module edge extracted", () => {
  it("creates a belongs_to_module edge from WI-001 to MOD-core", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    writeYaml(
      wiDir,
      "WI-001.yaml",
      minimalWorkItem({ id: "WI-001", module: "MOD-core" })
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-001' AND target_id = 'MOD-core' AND edge_type = 'belongs_to_module'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("belongs_to_module");
  });
});

describe("rebuildIndex — belongs_to_domain edge extracted", () => {
  it("creates a belongs_to_domain edge from WI-001 to workflow", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    writeYaml(
      wiDir,
      "WI-001.yaml",
      minimalWorkItem({ id: "WI-001", domain: "workflow" })
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-001' AND target_id = 'workflow' AND edge_type = 'belongs_to_domain'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("belongs_to_domain");
  });
});

describe("rebuildIndex — derived_from edge extracted", () => {
  it("creates a derived_from edge from DP-001 to GP-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const policiesDir = path.join(ideateDir, "policies");

    const yaml = [
      `id: "DP-001"`,
      `type: "domain_policy"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `derived_from:`,
      `  - "GP-001"`,
      `established: "2026-01-01"`,
      `amended: null`,
      `amended_by: null`,
      `description: "Test policy"`,
    ].join("\n") + "\n";

    writeYaml(policiesDir, "DP-001.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'DP-001' AND target_id = 'GP-001' AND edge_type = 'derived_from'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("derived_from");
  });

  it("splits comma-separated derived_from string into individual edges", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const policiesDir = path.join(ideateDir, "policies");

    const yaml = [
      `id: "DP-002"`,
      `type: "domain_policy"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `derived_from: "D-142, GP-08"`,
      `established: "2026-01-01"`,
      `amended: null`,
      `amended_by: null`,
      `description: "Legacy policy with comma-string derived_from"`,
    ].join("\n") + "\n";

    writeYaml(policiesDir, "DP-002.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    // Should create two separate edges, not one edge to the whole string
    const edge1 = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'DP-002' AND target_id = 'D-142' AND edge_type = 'derived_from'`
      )
      .get() as { edge_type: string } | undefined;
    expect(edge1).toBeDefined();

    const edge2 = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'DP-002' AND target_id = 'GP-08' AND edge_type = 'derived_from'`
      )
      .get() as { edge_type: string } | undefined;
    expect(edge2).toBeDefined();

    // No edge to the raw comma-string
    const badEdge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'DP-002' AND target_id = 'D-142, GP-08'`
      )
      .get() as { edge_type: string } | undefined;
    expect(badEdge).toBeUndefined();
  });
});

describe("rebuildIndex — comma-split restricted to derived_from", () => {
  it("does not split a comma-containing supersedes value into multiple edges", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const decisionsDir = path.join(ideateDir, "decisions");

    // A decision whose supersedes field contains a comma — must NOT be split.
    const yaml = [
      `id: "D-099"`,
      `type: "domain_decision"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `supersedes: "D-001,D-002"`,
      `title: "Test decision"`,
      `description: "Tests comma-split guard"`,
    ].join("\n") + "\n";

    writeYaml(decisionsDir, "D-099.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    // Should produce exactly one supersedes edge targeting the literal "D-001,D-002"
    const edges = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'D-099' AND edge_type = 'supersedes'`)
      .all() as { source_id: string; target_id: string; edge_type: string }[];
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe("D-001,D-002");
  });
});

describe("rebuildIndex — relates_to edge extracted", () => {
  it("creates a relates_to edge from FIND-001 to WI-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const archiveDir = path.join(ideateDir, "cycles");

    const yaml = [
      `id: "FIND-001"`,
      `type: "finding"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "open"`,
      `severity: "minor"`,
      `work_item: "WI-001"`,
      `file_refs: []`,
      `verdict: "fail"`,
      `cycle: 1`,
      `reviewer: "test-reviewer"`,
      `addressed_by: null`,
    ].join("\n") + "\n";

    writeYaml(archiveDir, "FIND-001.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'FIND-001' AND target_id = 'WI-001' AND edge_type = 'relates_to'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("relates_to");
  });
});

describe("rebuildIndex — supersedes edge extracted", () => {
  it("creates a supersedes edge from DD-002 to DD-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const decisionsDir = path.join(ideateDir, "decisions");

    const yaml = [
      `id: "DD-002"`,
      `type: "domain_decision"`,
      `cycle_created: 2`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `cycle: 2`,
      `supersedes: "DD-001"`,
      `description: "Updated decision"`,
      `rationale: "Because reasons"`,
    ].join("\n") + "\n";

    writeYaml(decisionsDir, "DD-002.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'DD-002' AND target_id = 'DD-001' AND edge_type = 'supersedes'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("supersedes");
  });
});

describe("rebuildIndex — addressed_by edge extracted", () => {
  it("creates an addressed_by edge from FIND-002 to WI-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const archiveDir = path.join(ideateDir, "cycles");

    const yaml = [
      `id: "FIND-002"`,
      `type: "finding"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "resolved"`,
      `severity: "significant"`,
      `work_item: "WI-001"`,
      `file_refs: []`,
      `verdict: "fail"`,
      `cycle: 1`,
      `reviewer: "test-reviewer"`,
      `addressed_by: "WI-001"`,
    ].join("\n") + "\n";

    writeYaml(archiveDir, "FIND-002.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'FIND-002' AND target_id = 'WI-001' AND edge_type = 'addressed_by'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("addressed_by");
  });

  it("derives addressed_by edge from passing verdict + work_item (no explicit addressed_by field)", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const archiveDir = path.join(ideateDir, "cycles");

    const yaml = [
      `id: "FIND-010"`,
      `type: "finding"`,
      `cycle_created: 5`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "resolved"`,
      `severity: "minor"`,
      `work_item: "WI-042"`,
      `file_refs: []`,
      `verdict: "pass"`,
      `cycle: 5`,
      `reviewer: "test-reviewer"`,
      `addressed_by: null`,
    ].join("\n") + "\n";

    writeYaml(archiveDir, "FIND-010.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'FIND-010' AND target_id = 'WI-042' AND edge_type = 'addressed_by'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("addressed_by");
  });

  it("does NOT derive addressed_by edge when verdict is fail", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const archiveDir = path.join(ideateDir, "cycles");

    const yaml = [
      `id: "FIND-011"`,
      `type: "finding"`,
      `cycle_created: 5`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "open"`,
      `severity: "significant"`,
      `work_item: "WI-043"`,
      `file_refs: []`,
      `verdict: "fail"`,
      `cycle: 5`,
      `reviewer: "test-reviewer"`,
      `addressed_by: null`,
    ].join("\n") + "\n";

    writeYaml(archiveDir, "FIND-011.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'FIND-011' AND target_id = 'WI-043' AND edge_type = 'addressed_by'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeUndefined();
  });

  it("does NOT derive addressed_by edge when work_item is free-text (not WI-NNN pattern)", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const archiveDir = path.join(ideateDir, "cycles");

    const yaml = [
      `id: "FIND-012"`,
      `type: "finding"`,
      `cycle_created: 5`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "resolved"`,
      `severity: "minor"`,
      `work_item: "some free-text value"`,
      `file_refs: []`,
      `verdict: "pass"`,
      `cycle: 5`,
      `reviewer: "test-reviewer"`,
      `addressed_by: null`,
    ].join("\n") + "\n";

    writeYaml(archiveDir, "FIND-012.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'FIND-012' AND edge_type = 'addressed_by'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeUndefined();
  });

  it("accepts pass_with_notes verdict (case-insensitive /^pass/i match)", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const archiveDir = path.join(ideateDir, "cycles");

    const yaml = [
      `id: "FIND-013"`,
      `type: "finding"`,
      `cycle_created: 6`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "resolved"`,
      `severity: "minor"`,
      `work_item: "WI-099"`,
      `file_refs: []`,
      `verdict: "pass_with_notes"`,
      `cycle: 6`,
      `reviewer: "test-reviewer"`,
      `addressed_by: null`,
    ].join("\n") + "\n";

    writeYaml(archiveDir, "FIND-013.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'FIND-013' AND target_id = 'WI-099' AND edge_type = 'addressed_by'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("addressed_by");
  });

  it("emits exactly one addressed_by edge when yaml_field and derivation both point to the same work item", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const archiveDir = path.join(ideateDir, "cycles");

    // Both addressed_by (yaml_field path) and work_item+verdict (derivation path) point to WI-001
    const yaml = [
      `id: "FIND-014"`,
      `type: "finding"`,
      `cycle_created: 6`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "resolved"`,
      `severity: "minor"`,
      `work_item: "WI-001"`,
      `file_refs: []`,
      `verdict: "pass"`,
      `cycle: 6`,
      `reviewer: "test-reviewer"`,
      `addressed_by: "WI-001"`,
    ].join("\n") + "\n";

    writeYaml(archiveDir, "FIND-014.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edges = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'FIND-014' AND target_id = 'WI-001' AND edge_type = 'addressed_by'`
      )
      .all() as { source_id: string; target_id: string; edge_type: string }[];
    expect(edges).toHaveLength(1);
  });
});

describe("rebuildIndex — amended_by edge extracted", () => {
  it("creates an amended_by edge from DP-001 to DP-002", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const policiesDir = path.join(ideateDir, "policies");

    const yaml = [
      `id: "DP-001"`,
      `type: "domain_policy"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "amended"`,
      `domain: "workflow"`,
      `derived_from: []`,
      `established: "2026-01-01"`,
      `amended: "2026-02-01"`,
      `amended_by: "DP-002"`,
      `description: "Original policy"`,
    ].join("\n") + "\n";

    writeYaml(policiesDir, "DP-001.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'DP-001' AND target_id = 'DP-002' AND edge_type = 'amended_by'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("amended_by");
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — interview entries create interview_question nodes
// ---------------------------------------------------------------------------

describe("rebuildIndex — interview entries create interview_question nodes", () => {
  it("creates one interview_question node per entry and references edges", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const interviewsDir = path.join(ideateDir, "interviews");
    fs.mkdirSync(interviewsDir, { recursive: true });

    const yaml = [
      `id: "INT-022"`,
      `type: "interview"`,
      `cycle_created: 22`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `title: "Refine 022"`,
      `cycle: 22`,
      `content: null`,
      `entries:`,
      `  - id: IQ-022-001`,
      `    question: "What is the scope?"`,
      `    answer: "Tackle all phases."`,
      `    domain: null`,
      `    seq: 1`,
      `  - id: IQ-022-002`,
      `    question: "Schema approach?"`,
      `    answer: "Class table inheritance."`,
      `    domain: artifact-structure`,
      `    seq: 2`,
    ].join("\n") + "\n";

    writeYaml(interviewsDir, "INT-022.yaml", yaml);

    const stats = rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    // Parent interview node should be indexed
    const interviewNode = db
      .prepare(`SELECT * FROM nodes WHERE id = 'INT-022' AND type = 'interview'`)
      .get() as { id: string; type: string } | undefined;
    expect(interviewNode).toBeDefined();

    // Both interview_question nodes should exist
    const q1 = db
      .prepare(`SELECT * FROM interview_questions WHERE id = 'IQ-022-001'`)
      .get() as { id: string; interview_id: string; question: string; seq: number } | undefined;
    expect(q1).toBeDefined();
    expect(q1!.interview_id).toBe("INT-022");
    expect(q1!.question).toBe("What is the scope?");
    expect(q1!.seq).toBe(1);

    const q2 = db
      .prepare(`SELECT * FROM interview_questions WHERE id = 'IQ-022-002'`)
      .get() as { id: string; interview_id: string; domain: string | null; seq: number } | undefined;
    expect(q2).toBeDefined();
    expect(q2!.interview_id).toBe("INT-022");
    expect(q2!.domain).toBe("artifact-structure");
    expect(q2!.seq).toBe(2);

    // Both question nodes should have references edges pointing to parent interview
    const edge1 = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'IQ-022-001' AND target_id = 'INT-022' AND edge_type = 'references'`)
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge1).toBeDefined();

    const edge2 = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'IQ-022-002' AND target_id = 'INT-022' AND edge_type = 'references'`)
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge2).toBeDefined();

    // No parse errors
    expect(stats.parse_errors.filter((e) => e.includes("INT-022"))).toHaveLength(0);
  });

  it("interview without entries array still indexes as interview with no question nodes", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const interviewsDir = path.join(ideateDir, "interviews");
    fs.mkdirSync(interviewsDir, { recursive: true });

    const yaml = [
      `id: "INT-001"`,
      `type: "interview"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `title: "Legacy interview"`,
      `cycle: 1`,
      `content: "Some raw content"`,
    ].join("\n") + "\n";

    writeYaml(interviewsDir, "INT-001.yaml", yaml);

    const stats = rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const interviewNode = db
      .prepare(`SELECT * FROM nodes WHERE id = 'INT-001'`)
      .get() as { id: string } | undefined;
    expect(interviewNode).toBeDefined();

    const questionCount = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM interview_questions WHERE interview_id = 'INT-001'`)
        .get() as { cnt: number }
    ).cnt;
    expect(questionCount).toBe(0);

    expect(stats.parse_errors.filter((e) => e.includes("INT-001"))).toHaveLength(0);
  });

  it("creates belongs_to_domain edge for interview_question with domain field", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const interviewsDir = path.join(ideateDir, "interviews");
    fs.mkdirSync(interviewsDir, { recursive: true });

    const yaml = [
      `id: "INT-030"`,
      `type: "interview"`,
      `cycle_created: 30`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `title: "Refine 030"`,
      `cycle: 30`,
      `content: null`,
      `entries:`,
      `  - id: IQ-030-001`,
      `    question: "Domain question?"`,
      `    answer: "Yes."`,
      `    domain: workflow`,
      `    seq: 1`,
      `  - id: IQ-030-002`,
      `    question: "No domain question?"`,
      `    answer: "Correct."`,
      `    domain: null`,
      `    seq: 2`,
    ].join("\n") + "\n";

    writeYaml(interviewsDir, "INT-030.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    // IQ-030-001 with domain=workflow should have a belongs_to_domain edge
    const domainEdge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'IQ-030-001' AND target_id = 'workflow' AND edge_type = 'belongs_to_domain'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(domainEdge).toBeDefined();
    expect(domainEdge!.edge_type).toBe("belongs_to_domain");

    // IQ-030-002 with domain=null should have no belongs_to_domain edge
    const noDomainEdge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'IQ-030-002' AND edge_type = 'belongs_to_domain'`
      )
      .get() as { source_id: string } | undefined;
    expect(noDomainEdge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — triggered_by object-array items produce triggered_by edges
// ---------------------------------------------------------------------------

describe("rebuildIndex — triggered_by object-array items produce edges", () => {
  it("creates triggered_by edge for proxy_human_decision with object-array triggered_by", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const proxyDir = path.join(ideateDir, "cycles", "005", "proxy-human");
    fs.mkdirSync(proxyDir, { recursive: true });

    const yaml = [
      `id: "PHD-005-001"`,
      `type: "proxy_human_decision"`,
      `cycle: 5`,
      `trigger: "andon"`,
      `triggered_by:`,
      `  - type: work_item`,
      `    id: "WI-100"`,
      `decision: "approved"`,
      `rationale: "Looks good."`,
      `timestamp: "2026-04-08T00:00:00Z"`,
      `status: "resolved"`,
    ].join("\n") + "\n";

    writeYaml(proxyDir, "PHD-005-001.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'PHD-005-001' AND target_id = 'WI-100' AND edge_type = 'triggered_by'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("triggered_by");
  });

  it("does not create triggered_by edges for string-array yaml_fields when items are objects", () => {
    // Verify generic fix doesn't break plain string arrays (depends_on etc.)
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");
    fs.mkdirSync(wiDir, { recursive: true });

    const yaml = [
      `id: "WI-200"`,
      `type: "work_item"`,
      `title: "Parent"`,
      `status: "pending"`,
      `depends: []`,
      `blocks: []`,
      `scope: []`,
      `criteria: []`,
    ].join("\n") + "\n";

    const yaml2 = [
      `id: "WI-201"`,
      `type: "work_item"`,
      `title: "Child"`,
      `status: "pending"`,
      `depends:`,
      `  - "WI-200"`,
      `blocks: []`,
      `scope: []`,
      `criteria: []`,
    ].join("\n") + "\n";

    writeYaml(wiDir, "WI-200.yaml", yaml);
    writeYaml(wiDir, "WI-201.yaml", yaml2);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-201' AND target_id = 'WI-200' AND edge_type = 'depends_on'`
      )
      .get() as { edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("depends_on");
  });
});

describe("rebuildIndex — malformed YAML file", () => {
  it("reports files_failed and parse_errors for invalid YAML", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    writeYaml(ideateDir, "bad.yaml", "{ invalid yaml: [unclosed");

    const stats = rebuildIndex(db, drizzle(db, { schema: dbSchema }),ideateDir);

    expect(stats.files_failed).toBeGreaterThanOrEqual(1);
    expect(stats.parse_errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// detectCycles tests
// ---------------------------------------------------------------------------

describe("detectCycles — no cycles", () => {
  it("returns [] on empty DB", () => {
    const db = freshDb();
    expect(detectCycles(drizzle(db, { schema: dbSchema }))).toEqual([]);
  });

  it("returns [] for a simple A→B→C DAG", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    insert.run("A", "B");
    insert.run("B", "C");
    db.pragma("foreign_keys = ON");
    expect(detectCycles(drizzle(db, { schema: dbSchema }))).toEqual([]);
  });
});

describe("detectCycles — simple 2-node cycle", () => {
  it("detects A→B, B→A cycle and returns both nodes", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    insert.run("A", "B");
    insert.run("B", "A");
    db.pragma("foreign_keys = ON");

    const cycles = detectCycles(drizzle(db, { schema: dbSchema }));
    expect(cycles.length).toBeGreaterThan(0);

    const allNodes = cycles.flat();
    expect(allNodes).toContain("A");
    expect(allNodes).toContain("B");
  });
});

describe("detectCycles — 3-node cycle", () => {
  it("detects A→B, B→C, C→A cycle and returns all three nodes", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    insert.run("A", "B");
    insert.run("B", "C");
    insert.run("C", "A");
    db.pragma("foreign_keys = ON");

    const cycles = detectCycles(drizzle(db, { schema: dbSchema }));
    expect(cycles.length).toBeGreaterThan(0);

    const allNodes = cycles.flat();
    expect(allNodes).toContain("A");
    expect(allNodes).toContain("B");
    expect(allNodes).toContain("C");
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — document_artifacts type registration
// ---------------------------------------------------------------------------

describe("rebuildIndex — document artifact types map to document_artifacts table", () => {
  const documentTypes = [
    "decision_log",
    "cycle_summary",
    "review_manifest",
    "architecture",
    "overview",
    "execution_strategy",
    "guiding_principles",
    "constraints",
    "research",
    "interview",
  ];

  for (const docType of documentTypes) {
    it(`indexes type '${docType}' into document_artifacts without parse error`, () => {
      const db = freshDb();
      const ideateDir = makeIdeateDir(tmpDir);

      const yaml = [
        `id: "DOC-${docType}"`,
        `type: "${docType}"`,
        `cycle_created: 1`,
        `cycle_modified: null`,
        `content_hash: ""`,
        `token_count: 0`,
        `file_path: ""`,
        `status: "active"`,
        `title: "Test ${docType}"`,
        `cycle: 1`,
        `content: "Some content"`,
      ].join("\n") + "\n";

      writeYaml(ideateDir, `${docType}.yaml`, yaml);

      const stats = rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

      expect(stats.parse_errors.filter((e) => e.includes(`unknown type '${docType}'`))).toHaveLength(0);

      const row = db
        .prepare(`SELECT * FROM document_artifacts WHERE id = 'DOC-${docType}'`)
        .get() as { id: string; title: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.title).toBe(`Test ${docType}`);
    });
  }
});

describe("detectCycles — traversal limits", () => {
  it("throws when edge count exceeds MAX_DEPENDENCY_EDGES", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    for (let i = 0; i <= MAX_DEPENDENCY_EDGES; i++) {
      insert.run(`A${i}`, `B${i}`);
    }
    db.pragma("foreign_keys = ON");
    expect(() => detectCycles(drizzle(db, { schema: dbSchema }))).toThrow(/edge count .* exceeds limit/);
  });

  it("throws when node count exceeds MAX_DEPENDENCY_NODES", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    // Each pair gives 2 unique nodes; floor(MAX/2)+1 pairs → MAX+2 unique nodes
    const edgeCount = Math.floor(MAX_DEPENDENCY_NODES / 2) + 1;
    for (let i = 0; i < edgeCount; i++) {
      insert.run(`SRC${i}`, `TGT${i}`);
    }
    db.pragma("foreign_keys = ON");
    expect(() => detectCycles(drizzle(db, { schema: dbSchema }))).toThrow(/node count .* exceeds limit/);
  });
});

// ---------------------------------------------------------------------------
// indexFiles tests
// ---------------------------------------------------------------------------

describe("indexFiles — single file add", () => {
  it("indexes a valid work_item YAML into the DB", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const filePath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-100.yaml",
      minimalWorkItem({ id: "WI-100", title: "Indexed via indexFiles" })
    );

    const result = indexFiles(db, drizzle(db, { schema: dbSchema }), [filePath]);

    expect(result.updated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    const row = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-100'")
      .get() as { id: string; title: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.title).toBe("Indexed via indexFiles");

    const node = db
      .prepare("SELECT * FROM nodes WHERE id = 'WI-100'")
      .get() as { id: string; type: string } | undefined;
    expect(node).toBeDefined();
    expect(node!.type).toBe("work_item");
  });
});

describe("indexFiles — unchanged file skipped", () => {
  it("returns updated: 0 when the same file is indexed twice", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const filePath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-101.yaml",
      minimalWorkItem({ id: "WI-101", title: "Unchanged test" })
    );

    // First index
    const first = indexFiles(db, drizzle(db, { schema: dbSchema }), [filePath]);
    expect(first.updated).toBe(1);

    // Second index with same content
    const second = indexFiles(db, drizzle(db, { schema: dbSchema }), [filePath]);
    expect(second.updated).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.errors).toHaveLength(0);
  });
});

describe("indexFiles — parse error", () => {
  it("reports failed: 1 and populates errors for invalid YAML", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const filePath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-BAD.yaml",
      "{ invalid yaml: [unclosed"
    );

    const result = indexFiles(db, drizzle(db, { schema: dbSchema }), [filePath]);

    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain("WI-BAD.yaml");
  });
});

describe("indexFiles — non-YAML file path", () => {
  it("returns updated: 0 and no errors for a non-existent .json path", () => {
    const db = freshDb();
    // Pass a path to a .json file that does not exist on disk.
    // indexSingleFile catches the read error and returns a silent no-op.
    const fakePath = path.join(tmpDir, ".ideate.json");

    const result = indexFiles(db, drizzle(db, { schema: dbSchema }), [fakePath]);

    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// removeFiles tests
// ---------------------------------------------------------------------------

describe("removeFiles — cascade removal", () => {
  it("removes the node and its extension row when the file is deleted", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const filePath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-200.yaml",
      minimalWorkItem({ id: "WI-200", title: "To be removed" })
    );

    // Index the file first
    const indexResult = indexFiles(db, drizzle(db, { schema: dbSchema }), [filePath]);
    expect(indexResult.updated).toBe(1);

    // Confirm both node and extension row exist
    const nodeBefore = db
      .prepare("SELECT * FROM nodes WHERE id = 'WI-200'")
      .get();
    expect(nodeBefore).toBeDefined();

    const extBefore = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-200'")
      .get();
    expect(extBefore).toBeDefined();

    // Remove via removeFiles
    const removeResult = removeFiles(db, drizzle(db, { schema: dbSchema }), [filePath]);
    expect(removeResult.removed).toBe(1);

    // Verify the node is gone
    const nodeAfter = db
      .prepare("SELECT * FROM nodes WHERE id = 'WI-200'")
      .get();
    expect(nodeAfter).toBeUndefined();

    // Verify the extension row is gone (CASCADE)
    const extAfter = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-200'")
      .get();
    expect(extAfter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — project and phase type support
// ---------------------------------------------------------------------------

describe("rebuildIndex — project YAML creates node and extension row", () => {
  it("indexes a project file into the projects table", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);

    const yaml = [
      `id: "PROJ-001"`,
      `type: "project"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `intent: "Build a great product"`,
      `scope_boundary:`,
      `  in:`,
      `    - "backend"`,
      `    - "frontend"`,
      `  out: []`,
      `success_criteria:`,
      `  - "All tests pass"`,
      `appetite: 6`,
      `steering: null`,
      `horizon:`,
      `  current: "phase-1"`,
      `  next: []`,
      `  later: []`,
    ].join("\n") + "\n";

    writeYaml(path.join(ideateDir, "projects"), "PROJ-001.yaml", yaml);

    const stats = rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    expect(stats.parse_errors.filter((e) => e.includes("PROJ-001"))).toHaveLength(0);

    const node = db
      .prepare(`SELECT * FROM nodes WHERE id = 'PROJ-001' AND type = 'project'`)
      .get() as { id: string; type: string } | undefined;
    expect(node).toBeDefined();
    expect(node!.type).toBe("project");

    const row = db
      .prepare(`SELECT * FROM projects WHERE id = 'PROJ-001'`)
      .get() as { id: string; intent: string; status: string; appetite: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.intent).toBe("Build a great product");
    expect(row!.status).toBe("active");
    expect(row!.appetite).toBe(6);
  });
});

describe("rebuildIndex — phase YAML creates node and extension row", () => {
  it("indexes a phase file into the phases table", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);

    const yaml = [
      `id: "PHASE-001"`,
      `type: "phase"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `project: "PROJ-001"`,
      `phase_type: "execution"`,
      `intent: "Deliver core features"`,
      `steering: null`,
      `work_items:`,
      `  - "WI-001"`,
      `  - "WI-002"`,
    ].join("\n") + "\n";

    writeYaml(path.join(ideateDir, "phases"), "PHASE-001.yaml", yaml);

    const stats = rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    expect(stats.parse_errors.filter((e) => e.includes("PHASE-001"))).toHaveLength(0);

    const node = db
      .prepare(`SELECT * FROM nodes WHERE id = 'PHASE-001' AND type = 'phase'`)
      .get() as { id: string; type: string } | undefined;
    expect(node).toBeDefined();
    expect(node!.type).toBe("phase");

    const row = db
      .prepare(`SELECT * FROM phases WHERE id = 'PHASE-001'`)
      .get() as { id: string; project: string; phase_type: string; intent: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.project).toBe("PROJ-001");
    expect(row!.phase_type).toBe("execution");
    expect(row!.intent).toBe("Deliver core features");
  });
});

describe("rebuildIndex — phase with project field creates belongs_to_project edge", () => {
  it("creates a belongs_to_project edge from PHASE-001 to PROJ-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);

    const yaml = [
      `id: "PHASE-002"`,
      `type: "phase"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `project: "PROJ-001"`,
      `phase_type: "planning"`,
      `intent: "Plan the work"`,
      `steering: null`,
      `work_items: []`,
    ].join("\n") + "\n";

    writeYaml(path.join(ideateDir, "phases"), "PHASE-002.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'PHASE-002' AND target_id = 'PROJ-001' AND edge_type = 'belongs_to_project'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("belongs_to_project");
  });
});

describe("rebuildIndex — work item with phase field creates belongs_to_phase edge", () => {
  it("creates a belongs_to_phase edge from WI-001 to PHASE-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);

    writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-003.yaml",
      minimalWorkItem({ id: "WI-003", title: "Phase-scoped work item", phase: "PHASE-001" })
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-003' AND target_id = 'PHASE-001' AND edge_type = 'belongs_to_phase'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("belongs_to_phase");
  });

  it("journal_entry with phase field does NOT produce a belongs_to_phase edge", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);

    const yaml = [
      `id: "JE-001"`,
      `type: "journal_entry"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `phase: "PHASE-001"`,
      `date: "2026-01-01"`,
      `title: "Day one"`,
      `work_item: null`,
      `content: "Some content"`,
    ].join("\n") + "\n";

    writeYaml(path.join(ideateDir, "cycles"), "JE-001.yaml", yaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'JE-001' AND edge_type = 'belongs_to_phase'`
      )
      .get() as { source_id: string } | undefined;
    expect(edge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — content_hash excludes metadata fields (WI-490)
// ---------------------------------------------------------------------------

describe("rebuildIndex — content_hash excludes metadata fields", () => {
  it("stores the same content_hash as computeArtifactHash regardless of embedded metadata", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);

    // The content object that a write handler would produce (before adding metadata fields)
    const contentObj: Record<string, unknown> = {
      id: "WI-999",
      type: "work_item",
      title: "Hash consistency test",
      status: "pending",
      complexity: "small",
      scope: [],
      depends: [],
      blocks: [],
      criteria: [],
      domain: null,
      phase: null,
      notes: "# WI-999",
      resolution: null,
      cycle_created: 1,
      cycle_modified: null,
    };

    // Compute expected hash the same way write handlers do: over content fields only
    const expectedHash = computeArtifactHash(contentObj);

    // Write a YAML file that includes embedded metadata fields (as written by a write handler)
    const yamlLines = [
      `id: "WI-999"`,
      `type: "work_item"`,
      `title: "Hash consistency test"`,
      `status: "pending"`,
      `complexity: "small"`,
      `scope: []`,
      `depends: []`,
      `blocks: []`,
      `criteria: []`,
      `domain: null`,
      `phase: null`,
      `notes: "# WI-999"`,
      `resolution: null`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      // These metadata fields should be excluded from hash computation
      `content_hash: "stale-or-placeholder-hash"`,
      `token_count: 9999`,
      `file_path: "/some/old/path.yaml"`,
    ];

    writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-999.yaml",
      yamlLines.join("\n") + "\n"
    );

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    // The stored content_hash must match the hash computed from content fields only
    const node = db
      .prepare("SELECT content_hash FROM nodes WHERE id = 'WI-999'")
      .get() as { content_hash: string } | undefined;

    expect(node).toBeDefined();
    expect(node!.content_hash).toBe(expectedHash);
  });

  it("content_hash is stable across rebuildIndex calls when content fields are unchanged", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);

    writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-998.yaml",
      minimalWorkItem({ id: "WI-998", title: "Stable hash test" })
    );

    // First index
    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const nodeAfterFirst = db
      .prepare("SELECT content_hash FROM nodes WHERE id = 'WI-998'")
      .get() as { content_hash: string } | undefined;
    expect(nodeAfterFirst).toBeDefined();
    const hashAfterFirst = nodeAfterFirst!.content_hash;

    // Second rebuild with same file on disk — hash must not change
    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const nodeAfterSecond = db
      .prepare("SELECT content_hash FROM nodes WHERE id = 'WI-998'")
      .get() as { content_hash: string } | undefined;
    expect(nodeAfterSecond).toBeDefined();
    expect(nodeAfterSecond!.content_hash).toBe(hashAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// computeArtifactHash — direct unit test (WI-501)
// ---------------------------------------------------------------------------

describe("computeArtifactHash — direct unit test", () => {
  it("excludes content_hash, token_count, and file_path from hash computation", () => {
    const obj = { id: "WI-001", title: "Test", content_hash: "stale", token_count: 99, file_path: "/fake/path" };
    const clean = { id: "WI-001", title: "Test" };
    const expected = createHash("sha256").update(stringify(clean, { lineWidth: 0 })).digest("hex");
    expect(computeArtifactHash(obj)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// deriveJournalEntryCycleEdges — idempotency and stale-edge removal (WI-726)
// rebuildIndex — journal entry title extraction for relates_to edges (WI-719)
// ---------------------------------------------------------------------------

/** Minimal journal_entry YAML */
function journalEntryYaml(
  id: string,
  title: string = `Journal entry ${id}`,
  workItem: string | null = null
): string {
  return [
    `id: "${id}"`,
    `type: "journal_entry"`,
    `cycle_created: 1`,
    `cycle_modified: null`,
    `content_hash: ""`,
    `token_count: 0`,
    `file_path: ""`,
    `status: "active"`,
    `phase: null`,
    `date: "2026-01-01"`,
    `title: "${title}"`,
    `work_item: ${workItem ? `"${workItem}"` : "null"}`,
    `content: "Some content"`,
  ].join("\n") + "\n";
}

describe("rebuildIndex — journal entry relates_to edges from title (WI-719)", () => {
  it("emits relates_to edge for 'Work item NNN:' format when target WI exists", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");
    const cyclesDir = path.join(ideateDir, "cycles");

    writeYaml(wiDir, "WI-117.yaml", minimalWorkItem({ id: "WI-117", title: "Some work item" }));
    writeYaml(cyclesDir, "J-001.yaml", journalEntryYaml("J-001", "Work item 117: Implement feature"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'J-001' AND target_id = 'WI-117' AND edge_type = 'relates_to'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("relates_to");
  });

  it("emits relates_to edge for 'WI-NNN' format when target WI exists", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");
    const cyclesDir = path.join(ideateDir, "cycles");

    writeYaml(wiDir, "WI-683.yaml", minimalWorkItem({ id: "WI-683", title: "Another work item" }));
    writeYaml(cyclesDir, "J-002.yaml", journalEntryYaml("J-002", "WI-683: Fix the bug"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'J-002' AND target_id = 'WI-683' AND edge_type = 'relates_to'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("relates_to");
  });

  it("does NOT emit relates_to edge when target WI-NNN does not exist (existence check)", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const cyclesDir = path.join(ideateDir, "cycles");

    // No WI-999 in the index
    writeYaml(cyclesDir, "J-003.yaml", journalEntryYaml("J-003", "Work item 999: Non-existent WI"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'J-003' AND edge_type = 'relates_to'`
      )
      .get() as { source_id: string } | undefined;
    expect(edge).toBeUndefined();
  });

  it("emits multiple relates_to edges when title references multiple work items", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");
    const cyclesDir = path.join(ideateDir, "cycles");

    writeYaml(wiDir, "WI-010.yaml", minimalWorkItem({ id: "WI-010", title: "First WI" }));
    writeYaml(wiDir, "WI-020.yaml", minimalWorkItem({ id: "WI-020", title: "Second WI" }));
    writeYaml(cyclesDir, "J-004.yaml", journalEntryYaml("J-004", "Work item 10 and WI-020 both updated"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edges = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'J-004' AND edge_type = 'relates_to' ORDER BY target_id`
      )
      .all() as { source_id: string; target_id: string; edge_type: string }[];
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.target_id).sort()).toEqual(["WI-010", "WI-020"]);
  });

  it("zero-pads single-digit work item numbers to 3 digits", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");
    const cyclesDir = path.join(ideateDir, "cycles");

    writeYaml(wiDir, "WI-005.yaml", minimalWorkItem({ id: "WI-005", title: "Padded WI" }));
    writeYaml(cyclesDir, "J-005.yaml", journalEntryYaml("J-005", "Work item 5: Short number"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'J-005' AND target_id = 'WI-005' AND edge_type = 'relates_to'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.target_id).toBe("WI-005");
  });

  it("preserves yaml_field relates_to edge (work_item field) when title has no WI reference", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");
    const cyclesDir = path.join(ideateDir, "cycles");

    writeYaml(wiDir, "WI-200.yaml", minimalWorkItem({ id: "WI-200", title: "A work item" }));
    // Journal entry with work_item set but title has no WI pattern
    writeYaml(cyclesDir, "J-006.yaml", journalEntryYaml("J-006", "Daily standup notes", "WI-200"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'J-006' AND target_id = 'WI-200' AND edge_type = 'relates_to'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.target_id).toBe("WI-200");
  });

  it("emits exactly one relates_to edge when work_item field and title both reference the same WI", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");
    const cyclesDir = path.join(ideateDir, "cycles");

    writeYaml(wiDir, "WI-300.yaml", minimalWorkItem({ id: "WI-300", title: "A work item" }));
    writeYaml(cyclesDir, "J-007.yaml", journalEntryYaml("J-007", "WI-300: Implemented feature", "WI-300"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edges = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'J-007' AND target_id = 'WI-300' AND edge_type = 'relates_to'`
      )
      .all() as { source_id: string; target_id: string; edge_type: string }[];
    expect(edges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// WI-720: Journal entry → belongs_to_cycle derivation
// ---------------------------------------------------------------------------

/** Minimal cycle_summary YAML */
function cycleSummaryYaml(id: string, cycle: number): string {
  return [
    `id: "${id}"`,
    `type: "cycle_summary"`,
    `cycle_created: ${cycle}`,
    `cycle_modified: null`,
    `content_hash: ""`,
    `token_count: 0`,
    `file_path: ""`,
    `status: "active"`,
    `title: "Cycle ${cycle} summary"`,
    `cycle: ${cycle}`,
    `content: "Summary content"`,
  ].join("\n") + "\n";
}

describe("deriveJournalEntryCycleEdges — idempotency (WI-726)", () => {
  it("calling deriveJournalEntryCycleEdges directly twice does not duplicate belongs_to_cycle edges", () => {
    const db = freshDb();
    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Directly seed a journal_entry node (J-024-001 → cycle 24) without rebuildIndex.
    // rebuildIndex's Phase 1 wipes all edges via deleteEdgesBySourceId before Phase 3 runs,
    // which means calling rebuildIndex twice cannot test whether deriveJournalEntryCycleEdges
    // itself contains a targeted delete. This test bypasses rebuildIndex entirely.
    upsertNode(drizzleDb, {
      id: "J-024-001",
      type: "journal_entry",
      cycle_created: 24,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: "",
      status: "active",
    });
    upsertJournalEntry(drizzleDb, {
      id: "J-024-001",
      phase: null,
      date: "2026-01-01",
      title: "Journal entry J-024-001",
      work_item: null,
      content: "Some content",
    });

    // Directly seed a cycle_summary node for cycle 24.
    upsertNode(drizzleDb, {
      id: "summary-024",
      type: "cycle_summary",
      cycle_created: 24,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: "",
      status: "active",
    });
    upsertDocumentArtifact(drizzleDb, {
      id: "summary-024",
      title: "Cycle 24 summary",
      cycle: 24,
      content: "Summary content",
    });

    // First call — should produce exactly 1 belongs_to_cycle edge.
    deriveJournalEntryCycleEdges(drizzleDb);

    const countAfterFirst = (db.prepare(
      `SELECT COUNT(*) as cnt FROM edges WHERE source_id = 'J-024-001' AND edge_type = 'belongs_to_cycle'`
    ).get() as { cnt: number }).cnt;

    // Second call — the targeted delete inside deriveJournalEntryCycleEdges must prevent
    // duplication. Without the targeted delete, this would return 2 instead of 1.
    deriveJournalEntryCycleEdges(drizzleDb);

    const countAfterSecond = (db.prepare(
      `SELECT COUNT(*) as cnt FROM edges WHERE source_id = 'J-024-001' AND edge_type = 'belongs_to_cycle'`
    ).get() as { cnt: number }).cnt;

    expect(countAfterFirst).toBe(1);
    expect(countAfterSecond).toBe(1);
  });
});

describe("deriveJournalEntryCycleEdges — stale edge removal (WI-726)", () => {
  it("removes the edge to the old cycle_summary when it is no longer indexed", () => {
    const db = freshDb();
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const ideateDir = makeIdeateDir(tmpDir);
    const cycleDir = path.join(ideateDir, "cycles");

    // Step 1: index a journal entry alone (no cycle_summary) → 0 belongs_to_cycle edges
    writeYaml(cycleDir, "J-024-001.yaml", journalEntryYaml("J-024-001"));
    rebuildIndex(db, drizzleDb, ideateDir);

    const countNoSummary = (db.prepare(
      `SELECT COUNT(*) as cnt FROM edges WHERE source_id = 'J-024-001' AND edge_type = 'belongs_to_cycle'`
    ).get() as { cnt: number }).cnt;
    expect(countNoSummary).toBe(0);

    // Step 2: add a cycle_summary for cycle 24, rebuild → 1 edge
    const summaryPath = writeYaml(cycleDir, "summary-024.yaml", cycleSummaryYaml("summary-024", 24));
    rebuildIndex(db, drizzleDb, ideateDir);

    const countWithSummary = (db.prepare(
      `SELECT COUNT(*) as cnt FROM edges WHERE source_id = 'J-024-001' AND edge_type = 'belongs_to_cycle'`
    ).get() as { cnt: number }).cnt;
    expect(countWithSummary).toBe(1);

    // Step 3: remove the cycle_summary file, rebuild → 0 edges (stale edge removed)
    fs.unlinkSync(summaryPath);
    rebuildIndex(db, drizzleDb, ideateDir);

    const countAfterRemoval = (db.prepare(
      `SELECT COUNT(*) as cnt FROM edges WHERE source_id = 'J-024-001' AND edge_type = 'belongs_to_cycle'`
    ).get() as { cnt: number }).cnt;
    expect(countAfterRemoval).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// indexFiles — derivation trigger tests (WI-727)
// ---------------------------------------------------------------------------

describe("indexFiles — derivation triggered by work_item change (WI-727)", () => {
  it("derives relates_to edge when new work_item file is indexed via indexFiles", () => {
    const db = freshDb();
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const ideateDir = makeIdeateDir(tmpDir);

    // Step 1: seed a journal entry referencing WI-500 directly in the DB (no edge created).
    // Bypassing indexFiles/rebuildIndex ensures no edge exists yet.
    upsertNode(drizzleDb, {
      id: "J-001-001",
      type: "journal_entry",
      cycle_created: 1,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: "",
      status: "active",
    });
    upsertJournalEntry(drizzleDb, {
      id: "J-001-001",
      phase: null,
      date: "2026-01-01",
      title: "Journal entry J-001-001",
      work_item: "WI-500",
      content: "Some content",
    });

    // Step 2: verify 0 relates_to edges — WI-500 is not in the graph yet
    const countBefore = (db.prepare(
      `SELECT COUNT(*) as cnt FROM edges WHERE source_id = 'J-001-001' AND edge_type = 'relates_to'`
    ).get() as { cnt: number }).cnt;
    expect(countBefore).toBe(0);

    // Step 3: write WI-500.yaml to disk and index it via indexFiles
    const wiPath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-500.yaml",
      minimalWorkItem({ id: "WI-500", title: "New work item" })
    );
    indexFiles(db, drizzleDb, [wiPath]);

    // Step 4: relates_to edge should now exist from J-001-001 to WI-500
    const countAfter = (db.prepare(
      `SELECT COUNT(*) as cnt FROM edges WHERE source_id = 'J-001-001' AND target_id = 'WI-500' AND edge_type = 'relates_to'`
    ).get() as { cnt: number }).cnt;
    expect(countAfter).toBe(1);
  });
});

describe("indexFiles — derivation triggered by cycle_summary change (WI-727)", () => {
  it("derives belongs_to_cycle edge when new cycle_summary file is indexed via indexFiles", () => {
    const db = freshDb();
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const ideateDir = makeIdeateDir(tmpDir);

    // Step 1: seed a journal entry J-001-001 for cycle 1 directly in the DB (no edges).
    upsertNode(drizzleDb, {
      id: "J-001-001",
      type: "journal_entry",
      cycle_created: 1,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: "",
      status: "active",
    });
    upsertJournalEntry(drizzleDb, {
      id: "J-001-001",
      phase: null,
      date: "2026-01-01",
      title: "Journal entry J-001-001",
      work_item: null,
      content: "Some content",
    });

    // Step 2: verify 0 belongs_to_cycle edges — no cycle_summary exists yet
    const countBefore = (db.prepare(
      `SELECT COUNT(*) as cnt FROM edges WHERE source_id = 'J-001-001' AND edge_type = 'belongs_to_cycle'`
    ).get() as { cnt: number }).cnt;
    expect(countBefore).toBe(0);

    // Step 3: write a cycle_summary YAML for cycle 1 into the cycles/001/ directory
    // and index it via indexFiles.
    const cycleDir = path.join(ideateDir, "cycles", "001");
    fs.mkdirSync(cycleDir, { recursive: true });
    const summaryPath = writeYaml(cycleDir, "summary-001.yaml", cycleSummaryYaml("summary-001", 1));
    indexFiles(db, drizzleDb, [summaryPath]);

    // Step 4: belongs_to_cycle edge should now exist from J-001-001 to summary-001
    const countAfter = (db.prepare(
      `SELECT COUNT(*) as cnt FROM edges WHERE source_id = 'J-001-001' AND target_id = 'summary-001' AND edge_type = 'belongs_to_cycle'`
    ).get() as { cnt: number }).cnt;
    expect(countAfter).toBe(1);
  });
});

describe("rebuildIndex — journal entry belongs_to_cycle edges (WI-720)", () => {
  it("emits belongs_to_cycle edge when matching cycle_summary exists", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const cyclesDir = path.join(ideateDir, "cycles");

    writeYaml(cyclesDir, "CS-019.yaml", cycleSummaryYaml("CS-019", 19));
    writeYaml(cyclesDir, "J-019-001.yaml", journalEntryYaml("J-019-001", "Some entry"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'J-019-001' AND target_id = 'CS-019' AND edge_type = 'belongs_to_cycle'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("belongs_to_cycle");
  });

  it("does not emit belongs_to_cycle edge when no cycle_summary exists for the cycle", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const cyclesDir = path.join(ideateDir, "cycles");

    writeYaml(cyclesDir, "J-042-001.yaml", journalEntryYaml("J-042-001", "Orphan entry"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'J-042-001' AND edge_type = 'belongs_to_cycle'`)
      .get();
    expect(edge).toBeUndefined();
  });

  it("emits belongs_to_cycle edges to multiple cycle_summaries sharing the same cycle number", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const cyclesDir = path.join(ideateDir, "cycles");

    writeYaml(cyclesDir, "CS-005a.yaml", cycleSummaryYaml("CS-005", 5));
    writeYaml(cyclesDir, "CQ-005a.yaml", cycleSummaryYaml("CQ-005", 5));
    writeYaml(cyclesDir, "J-005-001.yaml", journalEntryYaml("J-005-001", "Cycle 5 entry"));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edges = db
      .prepare(
        `SELECT target_id FROM edges WHERE source_id = 'J-005-001' AND edge_type = 'belongs_to_cycle' ORDER BY target_id`
      )
      .all() as { target_id: string }[];
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.target_id)).toEqual(["CQ-005", "CS-005"]);
  });
});

describe("rebuildIndex — stats.edges_created accuracy (Q-138, WI-731)", () => {
  it("counts derived edges exactly once — not double-counted — regression test for Q-138", () => {
    // Regression test for Q-138 — verifies stats.edges_created is not double-counted after WI-729 fix.
    // Pre-fix: bare calls alongside transactional wrappers ran each derivation function twice,
    // inflating stats.edges_created to 2x the actual derived edge count.
    // Post-fix: each function runs exactly once via the transactional wrappers only.
    const db = freshDb();
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const ideateDir = makeIdeateDir(tmpDir);
    const cyclesDir = path.join(ideateDir, "cycles");

    // Fixture: one cycle_summary + one journal entry matching that cycle.
    // deriveJournalEntryCycleEdges produces 1 belongs_to_cycle edge (J-055-001 → CS-055).
    // deriveJournalEntryEdges produces 0 relates_to edges (title has no WI-NNN reference).
    // Neither file has YAML-field inter-artifact edges, so r.edgesCreated from the upsert phase is 0.
    // Expected stats.edges_created = 1.
    writeYaml(cyclesDir, "CS-055.yaml", cycleSummaryYaml("CS-055", 55));
    writeYaml(cyclesDir, "J-055-001.yaml", journalEntryYaml("J-055-001", "No work item reference here"));

    const stats = rebuildIndex(db, drizzleDb, ideateDir);

    // Count actual derived edges in the DB (only belongs_to_cycle and title-derived relates_to)
    const derivedEdgeCount = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM edges WHERE edge_type IN ('belongs_to_cycle', 'relates_to')`)
        .get() as { cnt: number }
    ).cnt;

    // stats.edges_created must equal the actual derived edge count, not 2x.
    // If the double-count bug were re-introduced, stats would be 2 while the DB has 1 edge.
    expect(stats.edges_created).toBe(derivedEdgeCount);
    // Assert the exact expected count so re-introduction of the bug fails loudly.
    expect(stats.edges_created).toBe(1);
  });
});

describe("indexFiles — journal entry belongs_to_cycle derivation (WI-720 incremental)", () => {
  it("emits belongs_to_cycle edge when a journal entry is added via indexFiles", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const cyclesDir = path.join(ideateDir, "cycles");

    // Seed: index the cycle_summary first via rebuildIndex
    writeYaml(cyclesDir, "CS-007.yaml", cycleSummaryYaml("CS-007", 7));
    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    // Now add a journal entry incrementally using the canonical path structure
    // (cycles/{NNN}/journal/) so the hasJournalUpdate condition fires in indexFiles
    const journalDir = path.join(cyclesDir, "007", "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    const journalPath = path.join(journalDir, "J-007-001.yaml");
    fs.writeFileSync(journalPath, journalEntryYaml("J-007-001", "Incremental entry"), "utf8");
    indexFiles(db, drizzle(db, { schema: dbSchema }), [journalPath]);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'J-007-001' AND target_id = 'CS-007' AND edge_type = 'belongs_to_cycle'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("belongs_to_cycle");
  });
});

// ---------------------------------------------------------------------------
// WI-905: supersedes edge — work_item → work_item via superseded_by field
// ---------------------------------------------------------------------------

describe("rebuildIndex — work_item superseded_by field produces supersedes edge (WI-905)", () => {
  it("creates a supersedes edge from WI-X (newer) to WI-Y (older) via superseded_by field", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    // WI-Y: the older item being superseded
    writeYaml(wiDir, "WI-Y.yaml", minimalWorkItem({ id: "WI-Y", title: "Older work item" }));

    // WI-X: the newer item — uses superseded_by to point to WI-Y
    const yamlNew = [
      `id: "WI-X"`,
      `type: "work_item"`,
      `title: "Newer work item"`,
      `status: "pending"`,
      `complexity: "small"`,
      `cycle_created: 5`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `superseded_by: "WI-Y"`,
      `depends: []`,
      `blocks: []`,
      `criteria: []`,
      `scope: []`,
    ].join("\n") + "\n";

    writeYaml(wiDir, "WI-X.yaml", yamlNew);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-X' AND target_id = 'WI-Y' AND edge_type = 'supersedes'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.source_id).toBe("WI-X");
    expect(edge!.target_id).toBe("WI-Y");
    expect(edge!.edge_type).toBe("supersedes");
  });

  it("does not create a supersedes edge for a work_item without superseded_by field", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    writeYaml(wiDir, "WI-001.yaml", minimalWorkItem({ id: "WI-001", title: "Plain work item" }));

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-001' AND edge_type = 'supersedes'`
      )
      .get() as { source_id: string } | undefined;
    expect(edge).toBeUndefined();
  });

  it("existing domain_decision supersedes edge still works (regression)", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const decisionsDir = path.join(ideateDir, "decisions");

    const yamlOld = [
      `id: "D-001"`,
      `type: "domain_decision"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `cycle: 1`,
      `supersedes: null`,
      `description: "Original decision"`,
      `rationale: "First"`,
    ].join("\n") + "\n";

    const yamlNew = [
      `id: "D-002"`,
      `type: "domain_decision"`,
      `cycle_created: 2`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `cycle: 2`,
      `supersedes: "D-001"`,
      `description: "Newer decision"`,
      `rationale: "Second"`,
    ].join("\n") + "\n";

    writeYaml(decisionsDir, "D-001.yaml", yamlOld);
    writeYaml(decisionsDir, "D-002.yaml", yamlNew);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'D-002' AND target_id = 'D-001' AND edge_type = 'supersedes'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("supersedes");
  });
});

// ---------------------------------------------------------------------------
// WI-905: derived_from edge — domain_policy → finding, domain_decision → finding
// ---------------------------------------------------------------------------

describe("rebuildIndex — domain_policy derived_from finding produces derived_from edge (WI-905)", () => {
  it("creates a derived_from edge from domain_policy to a finding", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const policiesDir = path.join(ideateDir, "policies");
    const cyclesDir = path.join(ideateDir, "cycles");

    // Index a finding node so the edge target exists
    const findingYaml = [
      `id: "F-CYCLE-071-S1"`,
      `type: "finding"`,
      `cycle_created: 71`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "resolved"`,
      `severity: "significant"`,
      `work_item: "WI-900"`,
      `file_refs: []`,
      `verdict: "fail"`,
      `cycle: 71`,
      `reviewer: "spec-reviewer"`,
    ].join("\n") + "\n";

    writeYaml(cyclesDir, "F-CYCLE-071-S1.yaml", findingYaml);

    // A domain_policy derived from a finding (new combination)
    const policyYaml = [
      `id: "P-099"`,
      `type: "domain_policy"`,
      `cycle_created: 71`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `derived_from:`,
      `  - "F-CYCLE-071-S1"`,
      `established: "2026-04-17"`,
      `amended: null`,
      `amended_by: null`,
      `description: "Policy derived from a finding"`,
    ].join("\n") + "\n";

    writeYaml(policiesDir, "P-099.yaml", policyYaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'P-099' AND target_id = 'F-CYCLE-071-S1' AND edge_type = 'derived_from'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.source_id).toBe("P-099");
    expect(edge!.target_id).toBe("F-CYCLE-071-S1");
    expect(edge!.edge_type).toBe("derived_from");
  });
});

describe("rebuildIndex — domain_decision derived_from finding produces derived_from edge (WI-905)", () => {
  it("creates a derived_from edge from domain_decision to a finding", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const decisionsDir = path.join(ideateDir, "decisions");
    const cyclesDir = path.join(ideateDir, "cycles");

    // Index a finding node
    const findingYaml = [
      `id: "F-CYCLE-028-S3"`,
      `type: "finding"`,
      `cycle_created: 28`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "resolved"`,
      `severity: "critical"`,
      `work_item: "WI-876"`,
      `file_refs: []`,
      `verdict: "fail"`,
      `cycle: 28`,
      `reviewer: "spec-reviewer"`,
    ].join("\n") + "\n";

    writeYaml(cyclesDir, "F-CYCLE-028-S3.yaml", findingYaml);

    // A domain_decision derived from a finding (new source_type)
    const decisionYaml = [
      `id: "D-200"`,
      `type: "domain_decision"`,
      `cycle_created: 28`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "artifact-structure"`,
      `cycle: 28`,
      `supersedes: null`,
      `derived_from:`,
      `  - "F-CYCLE-028-S3"`,
      `description: "Decision derived from a finding"`,
      `rationale: "The finding revealed the need for this decision"`,
    ].join("\n") + "\n";

    writeYaml(decisionsDir, "D-200.yaml", decisionYaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'D-200' AND target_id = 'F-CYCLE-028-S3' AND edge_type = 'derived_from'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.source_id).toBe("D-200");
    expect(edge!.target_id).toBe("F-CYCLE-028-S3");
    expect(edge!.edge_type).toBe("derived_from");
  });

  it("creates a derived_from edge from domain_decision to a domain_policy (new target_type)", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const decisionsDir = path.join(ideateDir, "decisions");
    const policiesDir = path.join(ideateDir, "policies");

    // Index a domain_policy node as target
    const policyYaml = [
      `id: "P-001"`,
      `type: "domain_policy"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `derived_from: []`,
      `established: "2026-01-01"`,
      `amended: null`,
      `amended_by: null`,
      `description: "An existing policy"`,
    ].join("\n") + "\n";

    writeYaml(policiesDir, "P-001.yaml", policyYaml);

    // A domain_decision derived from a domain_policy (new target_type)
    const decisionYaml = [
      `id: "D-201"`,
      `type: "domain_decision"`,
      `cycle_created: 30`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `cycle: 30`,
      `supersedes: null`,
      `derived_from:`,
      `  - "P-001"`,
      `description: "Decision derived from a policy"`,
      `rationale: "Extends the policy scope"`,
    ].join("\n") + "\n";

    writeYaml(decisionsDir, "D-201.yaml", decisionYaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'D-201' AND target_id = 'P-001' AND edge_type = 'derived_from'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.source_id).toBe("D-201");
    expect(edge!.target_id).toBe("P-001");
    expect(edge!.edge_type).toBe("derived_from");
  });
});

// ---------------------------------------------------------------------------
// guiding_principle derived_from roundtrip (WI-908 Fix 3)
// ---------------------------------------------------------------------------

describe("rebuildIndex — guiding_principle derived_from produces derived_from edge (WI-908)", () => {
  it("creates a derived_from edge from a guiding_principle to another guiding_principle", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const principlesDir = path.join(ideateDir, "principles");

    // Target guiding_principle
    const targetYaml = [
      `id: "GP-01"`,
      `type: "guiding_principle"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `name: "Foundational Principle"`,
      `description: "A foundational principle"`,
      `amendment_history: []`,
    ].join("\n") + "\n";

    writeYaml(principlesDir, "GP-01.yaml", targetYaml);

    // Source guiding_principle with derived_from pointing to GP-01
    const sourceYaml = [
      `id: "GP-02"`,
      `type: "guiding_principle"`,
      `cycle_created: 5`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `name: "Derived Principle"`,
      `description: "A principle derived from GP-01"`,
      `amendment_history: []`,
      `derived_from:`,
      `  - "GP-01"`,
    ].join("\n") + "\n";

    writeYaml(principlesDir, "GP-02.yaml", sourceYaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'GP-02' AND target_id = 'GP-01' AND edge_type = 'derived_from'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.source_id).toBe("GP-02");
    expect(edge!.target_id).toBe("GP-01");
    expect(edge!.edge_type).toBe("derived_from");
  });

  it("creates a derived_from edge from a guiding_principle to a research_finding", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const principlesDir = path.join(ideateDir, "principles");
    const researchDir = path.join(ideateDir, "research");

    // Target research_finding
    const rfYaml = [
      `id: "RF-q164-stale-reads"`,
      `type: "research_finding"`,
      `cycle_created: 71`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `topic: "Stale reads"`,
      `date: "2026-04-17"`,
      `content: "Research on stale read patterns"`,
      `sources: []`,
    ].join("\n") + "\n";

    writeYaml(researchDir, "RF-q164-stale-reads.yaml", rfYaml);

    // Guiding principle derived from the research finding
    const gpYaml = [
      `id: "GP-14"`,
      `type: "guiding_principle"`,
      `cycle_created: 71`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `name: "No .ideate/ writes from code"`,
      `description: "Code must never write .ideate/ files directly"`,
      `amendment_history: []`,
      `derived_from:`,
      `  - "RF-q164-stale-reads"`,
    ].join("\n") + "\n";

    writeYaml(principlesDir, "GP-14.yaml", gpYaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'GP-14' AND target_id = 'RF-q164-stale-reads' AND edge_type = 'derived_from'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    // Note: research_finding is not in target_types for derived_from, so the edge
    // is only inserted if the target node exists — which it does. The source type
    // guiding_principle IS now in source_types (WI-908), so the edge is emitted.
    expect(edge).toBeDefined();
    expect(edge!.source_id).toBe("GP-14");
    expect(edge!.target_id).toBe("RF-q164-stale-reads");
    expect(edge!.edge_type).toBe("derived_from");
  });
});

// ---------------------------------------------------------------------------
// Registry source_types enforcement negative tests (WI-908 Fix 4)
// ---------------------------------------------------------------------------

describe("registry source_types enforcement — supersedes", () => {
  it("does NOT emit a supersedes edge when source type is 'finding' (not in source_types)", () => {
    // finding is not in EDGE_TYPE_REGISTRY.supersedes.source_types,
    // so a finding YAML with supersedes: "X" must not produce a supersedes edge.
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const cyclesDir = path.join(ideateDir, "cycles");

    // Target domain_decision
    const targetDecisionYaml = [
      `id: "D-OLD-001"`,
      `type: "domain_decision"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "superseded"`,
      `domain: "workflow"`,
      `cycle: 1`,
      `supersedes: null`,
      `description: "Old decision"`,
      `rationale: "Original rationale"`,
    ].join("\n") + "\n";

    const decisionsDir = path.join(ideateDir, "decisions");
    writeYaml(decisionsDir, "D-OLD-001.yaml", targetDecisionYaml);

    // A finding with a supersedes field — this type is NOT in supersedes.source_types
    const findingYaml = [
      `id: "F-ROGUE-001"`,
      `type: "finding"`,
      `cycle_created: 5`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "resolved"`,
      `severity: "minor"`,
      `work_item: "WI-001"`,
      `file_refs: []`,
      `verdict: "pass"`,
      `cycle: 5`,
      `reviewer: "spec-reviewer"`,
      `supersedes: "D-OLD-001"`,
    ].join("\n") + "\n";

    writeYaml(cyclesDir, "F-ROGUE-001.yaml", findingYaml);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'F-ROGUE-001' AND edge_type = 'supersedes'`
      )
      .get();
    expect(edge).toBeUndefined();
  });
});

describe("registry source_types enforcement — derived_from", () => {
  it("does NOT emit a derived_from edge when source type is 'work_item' (not in source_types)", () => {
    // work_item is not in EDGE_TYPE_REGISTRY.derived_from.source_types,
    // so a work_item YAML with derived_from: ["GP-01"] must not produce a derived_from edge.
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const principlesDir = path.join(ideateDir, "principles");
    const wiDir = path.join(ideateDir, "work-items");

    // Target guiding_principle
    const gpYaml = [
      `id: "GP-01"`,
      `type: "guiding_principle"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `name: "Target Principle"`,
      `description: "A principle"`,
      `amendment_history: []`,
    ].join("\n") + "\n";

    writeYaml(principlesDir, "GP-01.yaml", gpYaml);

    // A work_item with derived_from — this type is NOT in derived_from.source_types.
    // Build manually since minimalWorkItem doesn't support arbitrary extra fields:
    const wiYamlFull = [
      `id: "WI-ROGUE-001"`,
      `type: "work_item"`,
      `cycle_created: 5`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "pending"`,
      `title: "Rogue work item"`,
      `complexity: "small"`,
      `depends: []`,
      `blocks: []`,
      `criteria: []`,
      `scope: []`,
      `derived_from:`,
      `  - "GP-01"`,
    ].join("\n") + "\n";

    writeYaml(wiDir, "WI-ROGUE-001.yaml", wiYamlFull);

    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-ROGUE-001' AND edge_type = 'derived_from'`
      )
      .get();
    expect(edge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fs-out-of-transaction pattern regression tests (WI-896)
// ---------------------------------------------------------------------------

describe("fs-out-of-transaction — readAndPrepare returns PreparedNode without touching DB", () => {
  it("readAndPrepare returns prepared node with correct fields for a valid work_item YAML", () => {
    const db = freshDb();
    const yamlContent = minimalWorkItem({ id: "WI-TEST-896", title: "WI-896 regression" });
    const filePath = path.join(tmpDir, "WI-TEST-896.yaml");
    fs.writeFileSync(filePath, yamlContent, "utf8");

    // The hash-check statement is a pure read on the nodes table.
    // For a fresh DB with no rows, it returns undefined (file not in index yet).
    const hashCheckStmt = db.prepare(`SELECT id, content_hash FROM nodes WHERE file_path = ?`);

    const result = readAndPrepare(filePath, hashCheckStmt);

    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") return; // narrow type for TS
    expect(result.node.nodeId).toBe("WI-TEST-896");
    expect(result.node.typeField).toBe("work_item");
    expect(result.node.filePath).toBe(filePath);
    // No SQL has been performed — nodes table is still empty
    const row = db.prepare("SELECT id FROM nodes WHERE id = 'WI-TEST-896'").get();
    expect(row).toBeUndefined();
  });

  it("readAndPrepare returns skip for a file already indexed with the same content", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");
    writeYaml(wiDir, "WI-001.yaml", minimalWorkItem({ id: "WI-001" }));

    // First rebuild populates the DB
    rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    const hashCheckStmt = db.prepare(`SELECT id, content_hash FROM nodes WHERE file_path = ?`);
    const filePath = path.join(wiDir, "WI-001.yaml");
    const result = readAndPrepare(filePath, hashCheckStmt);

    expect(result.kind).toBe("skip");
  });

  it("readAndPrepare returns error for invalid YAML without performing any SQL", () => {
    const db = freshDb();
    const filePath = path.join(tmpDir, "bad.yaml");
    fs.writeFileSync(filePath, "{ invalid yaml: [unclosed", "utf8");

    const hashCheckStmt = db.prepare(`SELECT id, content_hash FROM nodes WHERE file_path = ?`);
    const result = readAndPrepare(filePath, hashCheckStmt);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error).toContain("bad.yaml");
    // DB remains untouched
    const count = (db.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("upsertPrepared writes the node row only after readAndPrepare produces a PreparedNode", () => {
    const db = freshDb();
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const yamlContent = minimalWorkItem({ id: "WI-UP-001", title: "upsertPrepared test" });
    const filePath = path.join(tmpDir, "WI-UP-001.yaml");
    fs.writeFileSync(filePath, yamlContent, "utf8");

    const hashCheckStmt = db.prepare(`SELECT id, content_hash FROM nodes WHERE file_path = ?`);
    const result = readAndPrepare(filePath, hashCheckStmt);
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") return;

    // Confirm node is absent before SQL phase
    expect(db.prepare("SELECT id FROM nodes WHERE id = 'WI-UP-001'").get()).toBeUndefined();

    // Run the SQL phase inside a transaction (as the callers do)
    db.transaction(() => { upsertPrepared(drizzleDb, result.node); })();

    // Confirm node is present after SQL phase
    const row = db.prepare("SELECT id FROM nodes WHERE id = 'WI-UP-001'").get() as { id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe("WI-UP-001");
  });

  it("rebuildIndex over N files: all nodes indexed, two-phase correctness", () => {
    // Seed a workspace with N work-item files and verify that rebuildIndex
    // correctly indexes all of them with the two-phase pattern.
    // Correctness guarantee: stats.files_updated equals the number of files
    // written — meaning readAndPrepare ran for all files before the SQL
    // transaction opened, and upsertPrepared ran for all of them inside it.
    const N = 5;
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    for (let i = 1; i <= N; i++) {
      const id = `WI-${String(i).padStart(3, "0")}`;
      writeYaml(wiDir, `${id}.yaml`, minimalWorkItem({ id, title: `Item ${i}` }));
    }

    const stats = rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);

    expect(stats.files_scanned).toBe(N);
    expect(stats.files_updated).toBe(N);
    expect(stats.files_failed).toBe(0);

    // Verify all nodes landed in the DB
    const rows = db.prepare("SELECT id FROM nodes WHERE type = 'work_item' ORDER BY id").all() as Array<{ id: string }>;
    expect(rows).toHaveLength(N);
    for (let i = 1; i <= N; i++) {
      expect(rows[i - 1].id).toBe(`WI-${String(i).padStart(3, "0")}`);
    }

    // Second call: no changes — files_updated must be 0, proving the hash-check
    // (which runs in readAndPrepare, outside the transaction) short-circuits correctly.
    const stats2 = rebuildIndex(db, drizzle(db, { schema: dbSchema }), ideateDir);
    expect(stats2.files_updated).toBe(0);
  });
});
