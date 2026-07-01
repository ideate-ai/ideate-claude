// node-type-registry.test.ts — regression tests for NODE_TYPE_REGISTRY
//
// Acceptance criteria (WI-898):
//   1. Registry keys equal ALL_NODE_TYPES set exactly (no missing, no extra)
//   2. Every entry with idPrefix non-null also has idPadWidth non-null
//   3. autopilot_state is registered with extensionTable: null and isQueryable: false
//   4. Every entry with extensionTable non-null also has extensionTableName non-null
//   5. QUERYABLE_NODE_TYPES is consistent with per-entry isQueryable flags
//   6. NODE_TYPE_ID_PREFIXES is consistent with per-entry idPrefix/idPadWidth

import { describe, it, expect } from "vitest";
import { ALL_NODE_TYPES } from "../adapter.js";
import {
  NODE_TYPE_REGISTRY,
  QUERYABLE_NODE_TYPES,
  NODE_TYPE_ID_PREFIXES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_STATUS_SYNONYMS,
  TERMINAL_WORK_ITEM_STATUSES,
  normalizeWorkItemStatus,
  isTerminalWorkItemStatus,
} from "../node-type-registry.js";
import type { NodeType } from "../adapter.js";

// ---------------------------------------------------------------------------
// 1. Registry key completeness — keys must exactly match ALL_NODE_TYPES
// ---------------------------------------------------------------------------

describe("NODE_TYPE_REGISTRY key completeness", () => {
  it("has an entry for every NodeType in ALL_NODE_TYPES", () => {
    const allNodeTypesSet = new Set<string>(ALL_NODE_TYPES);
    const registryKeys = new Set(Object.keys(NODE_TYPE_REGISTRY));

    for (const nodeType of allNodeTypesSet) {
      expect(
        registryKeys.has(nodeType),
        `Missing registry entry for NodeType: "${nodeType}"`
      ).toBe(true);
    }
  });

  it("has no extra keys beyond ALL_NODE_TYPES", () => {
    const allNodeTypesSet = new Set<string>(ALL_NODE_TYPES);
    const registryKeys = Object.keys(NODE_TYPE_REGISTRY);

    for (const key of registryKeys) {
      expect(
        allNodeTypesSet.has(key),
        `Registry has unexpected key: "${key}" not in ALL_NODE_TYPES`
      ).toBe(true);
    }
  });

  it("registry key count matches ALL_NODE_TYPES length", () => {
    expect(Object.keys(NODE_TYPE_REGISTRY).length).toBe(ALL_NODE_TYPES.length);
  });
});

// ---------------------------------------------------------------------------
// 2. idPrefix / idPadWidth co-presence invariant
// ---------------------------------------------------------------------------

describe("idPrefix / idPadWidth co-presence", () => {
  it("every entry with non-null idPrefix also has non-null idPadWidth", () => {
    for (const [type, spec] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (spec.idPrefix !== null) {
        expect(
          spec.idPadWidth,
          `NodeType "${type}" has idPrefix "${spec.idPrefix}" but idPadWidth is null`
        ).not.toBeNull();
      }
    }
  });

  it("every entry with null idPrefix also has null idPadWidth", () => {
    for (const [type, spec] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (spec.idPrefix === null) {
        expect(
          spec.idPadWidth,
          `NodeType "${type}" has null idPrefix but idPadWidth is ${spec.idPadWidth}`
        ).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. extensionTable / extensionTableName co-presence invariant
// ---------------------------------------------------------------------------

describe("extensionTable / extensionTableName co-presence", () => {
  it("every entry with non-null extensionTable also has non-null extensionTableName", () => {
    for (const [type, spec] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (spec.extensionTable !== null) {
        expect(
          spec.extensionTableName,
          `NodeType "${type}" has extensionTable set but extensionTableName is null`
        ).not.toBeNull();
      }
    }
  });

  it("every entry with null extensionTable also has null extensionTableName", () => {
    for (const [type, spec] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (spec.extensionTable === null) {
        expect(
          spec.extensionTableName,
          `NodeType "${type}" has null extensionTable but extensionTableName is "${spec.extensionTableName}"`
        ).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. autopilot_state asymmetry resolution
// ---------------------------------------------------------------------------

describe("autopilot_state", () => {
  it("has extensionTable: null", () => {
    expect(NODE_TYPE_REGISTRY.autopilot_state.extensionTable).toBeNull();
  });

  it("has extensionTableName: null", () => {
    expect(NODE_TYPE_REGISTRY.autopilot_state.extensionTableName).toBeNull();
  });

  it("has isQueryable: false", () => {
    expect(NODE_TYPE_REGISTRY.autopilot_state.isQueryable).toBe(false);
  });

  it("has idPrefix: null", () => {
    expect(NODE_TYPE_REGISTRY.autopilot_state.idPrefix).toBeNull();
  });

  it("is not included in QUERYABLE_NODE_TYPES", () => {
    expect(QUERYABLE_NODE_TYPES.has("autopilot_state")).toBe(false);
  });

  it("is not included in NODE_TYPE_ID_PREFIXES", () => {
    expect(NODE_TYPE_ID_PREFIXES.has("autopilot_state")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. QUERYABLE_NODE_TYPES consistency
// ---------------------------------------------------------------------------

describe("QUERYABLE_NODE_TYPES derived set", () => {
  it("contains exactly the NodeTypes with isQueryable: true", () => {
    for (const [type, spec] of Object.entries(NODE_TYPE_REGISTRY) as Array<[NodeType, typeof NODE_TYPE_REGISTRY[NodeType]]>) {
      if (spec.isQueryable) {
        expect(
          QUERYABLE_NODE_TYPES.has(type),
          `NodeType "${type}" has isQueryable: true but is absent from QUERYABLE_NODE_TYPES`
        ).toBe(true);
      } else {
        expect(
          QUERYABLE_NODE_TYPES.has(type),
          `NodeType "${type}" has isQueryable: false but appears in QUERYABLE_NODE_TYPES`
        ).toBe(false);
      }
    }
  });

  it("is a proper subset of ALL_NODE_TYPES", () => {
    const allSet = new Set<string>(ALL_NODE_TYPES);
    for (const type of QUERYABLE_NODE_TYPES) {
      expect(allSet.has(type), `QUERYABLE_NODE_TYPES contains unknown type: "${type}"`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. NODE_TYPE_ID_PREFIXES consistency
// ---------------------------------------------------------------------------

describe("NODE_TYPE_ID_PREFIXES derived map", () => {
  it("contains exactly the NodeTypes with non-null idPrefix", () => {
    for (const [type, spec] of Object.entries(NODE_TYPE_REGISTRY) as Array<[NodeType, typeof NODE_TYPE_REGISTRY[NodeType]]>) {
      if (spec.idPrefix !== null) {
        expect(
          NODE_TYPE_ID_PREFIXES.has(type),
          `NodeType "${type}" has idPrefix "${spec.idPrefix}" but is absent from NODE_TYPE_ID_PREFIXES`
        ).toBe(true);
        const entry = NODE_TYPE_ID_PREFIXES.get(type);
        expect(entry?.prefix).toBe(spec.idPrefix);
        expect(entry?.padWidth).toBe(spec.idPadWidth);
      } else {
        expect(
          NODE_TYPE_ID_PREFIXES.has(type),
          `NodeType "${type}" has null idPrefix but appears in NODE_TYPE_ID_PREFIXES`
        ).toBe(false);
      }
    }
  });

  it("work_item maps to WI- with padWidth 3", () => {
    const entry = NODE_TYPE_ID_PREFIXES.get("work_item");
    expect(entry?.prefix).toBe("WI-");
    expect(entry?.padWidth).toBe(3);
  });

  it("domain_policy maps to P- with padWidth 2", () => {
    const entry = NODE_TYPE_ID_PREFIXES.get("domain_policy");
    expect(entry?.prefix).toBe("P-");
    expect(entry?.padWidth).toBe(2);
  });

  it("project maps to PR- with padWidth 3", () => {
    const entry = NODE_TYPE_ID_PREFIXES.get("project");
    expect(entry?.prefix).toBe("PR-");
    expect(entry?.padWidth).toBe(3);
  });

  it("phase maps to PH- with padWidth 3", () => {
    const entry = NODE_TYPE_ID_PREFIXES.get("phase");
    expect(entry?.prefix).toBe("PH-");
    expect(entry?.padWidth).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 7. Known extension table names (spot checks)
// ---------------------------------------------------------------------------

describe("extension table names spot checks", () => {
  it("work_item uses work_items table", () => {
    expect(NODE_TYPE_REGISTRY.work_item.extensionTableName).toBe("work_items");
  });

  it("finding uses findings table", () => {
    expect(NODE_TYPE_REGISTRY.finding.extensionTableName).toBe("findings");
  });

  it("document subtypes all use document_artifacts table", () => {
    const documentSubtypes: NodeType[] = [
      "decision_log",
      "cycle_summary",
      "review_manifest",
      "review_output",
      "architecture",
      "overview",
      "execution_strategy",
      "guiding_principles",
      "constraints",
      "research",
      "interview",
      "domain_index",
    ];
    for (const type of documentSubtypes) {
      expect(
        NODE_TYPE_REGISTRY[type].extensionTableName,
        `Document subtype "${type}" should use document_artifacts table`
      ).toBe("document_artifacts");
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Summary selectors are strings (not empty) when extensionTable is set
// ---------------------------------------------------------------------------

describe("summarySelector presence", () => {
  it("every entry with a non-null extensionTable has a non-null, non-empty summarySelector", () => {
    for (const [type, spec] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (spec.extensionTable !== null) {
        expect(
          spec.summarySelector,
          `NodeType "${type}" has an extension table but summarySelector is null`
        ).not.toBeNull();
        expect(
          (spec.summarySelector as string).length,
          `NodeType "${type}" has an extension table but summarySelector is empty`
        ).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 9. WI-220 — canonical work_item status vocabulary
// ---------------------------------------------------------------------------

describe("WORK_ITEM_STATUSES canonical enum", () => {
  it("is exactly the five canonical values", () => {
    expect([...WORK_ITEM_STATUSES].sort()).toEqual(
      ["blocked", "done", "in_progress", "obsolete", "pending"].sort()
    );
  });

  it("TERMINAL_WORK_ITEM_STATUSES contains exactly done and obsolete", () => {
    expect([...TERMINAL_WORK_ITEM_STATUSES].sort()).toEqual(["done", "obsolete"]);
    expect(TERMINAL_WORK_ITEM_STATUSES.has("pending")).toBe(false);
    expect(TERMINAL_WORK_ITEM_STATUSES.has("in_progress")).toBe(false);
    expect(TERMINAL_WORK_ITEM_STATUSES.has("blocked")).toBe(false);
  });

  it("WORK_ITEM_STATUS_SYNONYMS maps legacy values to canonical values only", () => {
    for (const canonical of Object.values(WORK_ITEM_STATUS_SYNONYMS)) {
      expect(WORK_ITEM_STATUSES as readonly string[]).toContain(canonical);
    }
    expect(WORK_ITEM_STATUS_SYNONYMS.complete).toBe("done");
    expect(WORK_ITEM_STATUS_SYNONYMS.completed).toBe("done");
    expect(WORK_ITEM_STATUS_SYNONYMS.unknown).toBe("pending");
  });
});

describe("normalizeWorkItemStatus — canonical values pass through", () => {
  it.each(WORK_ITEM_STATUSES)("preserves canonical value '%s'", (status) => {
    expect(normalizeWorkItemStatus(status)).toBe(status);
  });

  it("is case-insensitive and trims whitespace for canonical values", () => {
    expect(normalizeWorkItemStatus("DONE")).toBe("done");
    expect(normalizeWorkItemStatus("  pending  ")).toBe("pending");
    expect(normalizeWorkItemStatus("Obsolete")).toBe("obsolete");
  });
});

describe("normalizeWorkItemStatus — legacy synonym mapping", () => {
  it("maps 'complete' -> 'done'", () => {
    expect(normalizeWorkItemStatus("complete")).toBe("done");
  });

  it("maps 'completed' -> 'done'", () => {
    expect(normalizeWorkItemStatus("completed")).toBe("done");
  });

  it("maps 'unknown' -> 'pending'", () => {
    expect(normalizeWorkItemStatus("unknown")).toBe("pending");
  });

  it("is case-insensitive for legacy synonyms", () => {
    expect(normalizeWorkItemStatus("Completed")).toBe("done");
    expect(normalizeWorkItemStatus("COMPLETE")).toBe("done");
    expect(normalizeWorkItemStatus("Unknown")).toBe("pending");
  });
});

describe("normalizeWorkItemStatus — null/empty/unanticipated values default to 'pending'", () => {
  it("maps null -> 'pending'", () => {
    expect(normalizeWorkItemStatus(null)).toBe("pending");
  });

  it("maps undefined -> 'pending'", () => {
    expect(normalizeWorkItemStatus(undefined)).toBe("pending");
  });

  it("maps empty string -> 'pending'", () => {
    expect(normalizeWorkItemStatus("")).toBe("pending");
    expect(normalizeWorkItemStatus("   ")).toBe("pending");
  });

  it("maps an unanticipated/typo'd value to 'pending' rather than passing it through", () => {
    const result = normalizeWorkItemStatus("not_a_real_status");
    expect(result).toBe("pending");
    expect(result).not.toBe("not_a_real_status");
  });

  it("maps a non-string value (number) to 'pending'", () => {
    expect(normalizeWorkItemStatus(42)).toBe("pending");
  });
});

describe("normalizeWorkItemStatus — idempotency", () => {
  const sampleRawValues = [
    "pending",
    "in_progress",
    "done",
    "obsolete",
    "blocked",
    "complete",
    "completed",
    "unknown",
    null,
    undefined,
    "",
    "typo_status",
    "DONE",
    " Completed ",
  ];

  it.each(sampleRawValues)("normalizing twice equals normalizing once for %j", (raw) => {
    const once = normalizeWorkItemStatus(raw);
    const twice = normalizeWorkItemStatus(once);
    expect(twice).toBe(once);
  });
});

describe("isTerminalWorkItemStatus", () => {
  it("returns true for done and obsolete (canonical)", () => {
    expect(isTerminalWorkItemStatus("done")).toBe(true);
    expect(isTerminalWorkItemStatus("obsolete")).toBe(true);
  });

  it("returns true for legacy synonyms that normalize to done", () => {
    expect(isTerminalWorkItemStatus("complete")).toBe(true);
    expect(isTerminalWorkItemStatus("completed")).toBe(true);
  });

  it("returns false for pending, in_progress, blocked", () => {
    expect(isTerminalWorkItemStatus("pending")).toBe(false);
    expect(isTerminalWorkItemStatus("in_progress")).toBe(false);
    expect(isTerminalWorkItemStatus("blocked")).toBe(false);
  });

  it("returns false for null/unknown (normalizes to pending, non-terminal)", () => {
    expect(isTerminalWorkItemStatus(null)).toBe(false);
    expect(isTerminalWorkItemStatus("unknown")).toBe(false);
  });
});
