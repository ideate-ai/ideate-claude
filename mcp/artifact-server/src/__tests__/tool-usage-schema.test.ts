import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as dbSchema from "../db.js";
import { createSchema, CURRENT_SCHEMA_VERSION } from "../schema.js";
import { insertToolUsage, toolUsage } from "../db-helpers.js";
import { TYPE_TO_EXTENSION_TABLE } from "../node-type-registry.js";
import type { ToolUsageInsert } from "../adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const sqlite = new Database(":memory:");
  createSchema(sqlite);
  return sqlite;
}

function columnInfo(db: Database.Database, table: string): Array<{ name: string; type: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number }>;
}

function indexList(db: Database.Database, table: string): Array<{ name: string }> {
  return db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// PRAGMA user_version
// ---------------------------------------------------------------------------

describe("tool_usage schema — user_version", () => {
  it("sets PRAGMA user_version to 9 after createSchema", () => {
    const db = freshDb();
    const version = db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(9);
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Table existence and column shape
// ---------------------------------------------------------------------------

describe("tool_usage schema — table and columns", () => {
  it("tool_usage table exists", () => {
    const db = freshDb();
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name);
    expect(tables).toContain("tool_usage");
  });

  it("has all expected columns with correct types", () => {
    const db = freshDb();
    const cols = columnInfo(db, "tool_usage");
    const colMap = new Map(cols.map(c => [c.name, c]));

    // id — integer, primary key (not null is implied by PK)
    expect(colMap.has("id")).toBe(true);
    expect(colMap.get("id")!.type.toUpperCase()).toContain("INTEGER");

    // tool_name — text, not null
    expect(colMap.has("tool_name")).toBe(true);
    expect(colMap.get("tool_name")!.type.toUpperCase()).toContain("TEXT");
    expect(colMap.get("tool_name")!.notnull).toBe(1);

    // request_tokens — integer, nullable
    expect(colMap.has("request_tokens")).toBe(true);
    expect(colMap.get("request_tokens")!.type.toUpperCase()).toContain("INTEGER");
    expect(colMap.get("request_tokens")!.notnull).toBe(0);

    // response_tokens — integer, nullable
    expect(colMap.has("response_tokens")).toBe(true);
    expect(colMap.get("response_tokens")!.type.toUpperCase()).toContain("INTEGER");
    expect(colMap.get("response_tokens")!.notnull).toBe(0);

    // request_bytes — integer, not null
    expect(colMap.has("request_bytes")).toBe(true);
    expect(colMap.get("request_bytes")!.type.toUpperCase()).toContain("INTEGER");
    expect(colMap.get("request_bytes")!.notnull).toBe(1);

    // response_bytes — integer, not null
    expect(colMap.has("response_bytes")).toBe(true);
    expect(colMap.get("response_bytes")!.type.toUpperCase()).toContain("INTEGER");
    expect(colMap.get("response_bytes")!.notnull).toBe(1);

    // session_id — text, nullable
    expect(colMap.has("session_id")).toBe(true);
    expect(colMap.get("session_id")!.type.toUpperCase()).toContain("TEXT");
    expect(colMap.get("session_id")!.notnull).toBe(0);

    // cycle — integer, nullable
    expect(colMap.has("cycle")).toBe(true);
    expect(colMap.get("cycle")!.type.toUpperCase()).toContain("INTEGER");
    expect(colMap.get("cycle")!.notnull).toBe(0);

    // phase — text, nullable
    expect(colMap.has("phase")).toBe(true);
    expect(colMap.get("phase")!.type.toUpperCase()).toContain("TEXT");
    expect(colMap.get("phase")!.notnull).toBe(0);

    // timestamp — text, not null
    expect(colMap.has("timestamp")).toBe(true);
    expect(colMap.get("timestamp")!.type.toUpperCase()).toContain("TEXT");
    expect(colMap.get("timestamp")!.notnull).toBe(1);
  });

  it("has exactly 10 columns", () => {
    const db = freshDb();
    const cols = columnInfo(db, "tool_usage");
    expect(cols.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

describe("tool_usage schema — indexes", () => {
  const expectedIndexes = [
    "idx_tool_usage_tool_name",
    "idx_tool_usage_timestamp",
    "idx_tool_usage_session",
    "idx_tool_usage_cycle",
    "idx_tool_usage_phase",
  ];

  it("all 5 expected indexes exist on tool_usage", () => {
    const db = freshDb();
    const idxs = indexList(db, "tool_usage").map(r => r.name);
    for (const idx of expectedIndexes) {
      expect(idxs, `expected index '${idx}' to exist`).toContain(idx);
    }
  });

  it("idx_tool_usage_tool_name covers tool_name column", () => {
    const db = freshDb();
    const info = db.prepare(`PRAGMA index_info(idx_tool_usage_tool_name)`).all() as Array<{ name: string }>;
    expect(info.map(r => r.name)).toContain("tool_name");
  });

  it("idx_tool_usage_timestamp covers timestamp column", () => {
    const db = freshDb();
    const info = db.prepare(`PRAGMA index_info(idx_tool_usage_timestamp)`).all() as Array<{ name: string }>;
    expect(info.map(r => r.name)).toContain("timestamp");
  });

  it("idx_tool_usage_session covers session_id column", () => {
    const db = freshDb();
    const info = db.prepare(`PRAGMA index_info(idx_tool_usage_session)`).all() as Array<{ name: string }>;
    expect(info.map(r => r.name)).toContain("session_id");
  });

  it("idx_tool_usage_cycle covers cycle column", () => {
    const db = freshDb();
    const info = db.prepare(`PRAGMA index_info(idx_tool_usage_cycle)`).all() as Array<{ name: string }>;
    expect(info.map(r => r.name)).toContain("cycle");
  });

  it("idx_tool_usage_phase covers phase column", () => {
    const db = freshDb();
    const info = db.prepare(`PRAGMA index_info(idx_tool_usage_phase)`).all() as Array<{ name: string }>;
    expect(info.map(r => r.name)).toContain("phase");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: insertToolUsage + SELECT
// ---------------------------------------------------------------------------

describe("tool_usage schema — insertToolUsage round-trip", () => {
  it("inserts a full row and reads it back with all columns matching", () => {
    const sqlite = freshDb();
    const db = drizzle(sqlite, { schema: dbSchema });

    const row: ToolUsageInsert = {
      tool_name: "ideate_query",
      request_tokens: 512,
      response_tokens: 1024,
      request_bytes: 2048,
      response_bytes: 4096,
      session_id: "sess-abc-123",
      cycle: 5,
      phase: "PH-001",
      timestamp: "2026-04-16T00:00:00.000Z",
    };

    insertToolUsage(db, row);

    const results = sqlite.prepare(`SELECT * FROM tool_usage`).all() as Array<Record<string, unknown>>;
    expect(results.length).toBe(1);

    const r = results[0];
    expect(typeof r["id"]).toBe("number");
    expect(r["tool_name"]).toBe("ideate_query");
    expect(r["request_tokens"]).toBe(512);
    expect(r["response_tokens"]).toBe(1024);
    expect(r["request_bytes"]).toBe(2048);
    expect(r["response_bytes"]).toBe(4096);
    expect(r["session_id"]).toBe("sess-abc-123");
    expect(r["cycle"]).toBe(5);
    expect(r["phase"]).toBe("PH-001");
    expect(r["timestamp"]).toBe("2026-04-16T00:00:00.000Z");
  });

  it("inserts a row with all nullable fields null", () => {
    const sqlite = freshDb();
    const db = drizzle(sqlite, { schema: dbSchema });

    const row: ToolUsageInsert = {
      tool_name: "ideate_emit_metric",
      request_tokens: null,
      response_tokens: null,
      request_bytes: 128,
      response_bytes: 64,
      session_id: null,
      cycle: null,
      phase: null,
      timestamp: "2026-04-16T01:00:00.000Z",
    };

    insertToolUsage(db, row);

    const results = sqlite.prepare(`SELECT * FROM tool_usage`).all() as Array<Record<string, unknown>>;
    expect(results.length).toBe(1);

    const r = results[0];
    expect(r["request_tokens"]).toBeNull();
    expect(r["response_tokens"]).toBeNull();
    expect(r["session_id"]).toBeNull();
    expect(r["cycle"]).toBeNull();
    expect(r["phase"]).toBeNull();
  });

  it("autoincrement assigns sequential ids for multiple inserts", () => {
    const sqlite = freshDb();
    const db = drizzle(sqlite, { schema: dbSchema });

    const base: ToolUsageInsert = {
      tool_name: "ideate_query",
      request_tokens: null,
      response_tokens: null,
      request_bytes: 100,
      response_bytes: 200,
      session_id: null,
      cycle: null,
      phase: null,
      timestamp: "2026-04-16T02:00:00.000Z",
    };

    insertToolUsage(db, base);
    insertToolUsage(db, base);
    insertToolUsage(db, base);

    const results = sqlite.prepare(`SELECT id FROM tool_usage ORDER BY id`).all() as Array<{ id: number }>;
    expect(results.length).toBe(3);
    expect(results[0].id).toBe(1);
    expect(results[1].id).toBe(2);
    expect(results[2].id).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// toolUsage is NOT in TYPE_TO_EXTENSION_TABLE
// ---------------------------------------------------------------------------

describe("tool_usage schema — not a node-extension table", () => {
  it("toolUsage table is NOT present as a value in TYPE_TO_EXTENSION_TABLE", () => {
    const tableValues = Object.values(TYPE_TO_EXTENSION_TABLE);
    // toolUsage Drizzle table should not appear in the extension table map
    expect(tableValues).not.toContain(toolUsage);
  });

  it("tool_usage key is NOT present in TYPE_TO_EXTENSION_TABLE", () => {
    expect(Object.keys(TYPE_TO_EXTENSION_TABLE)).not.toContain("tool_usage");
  });
});
