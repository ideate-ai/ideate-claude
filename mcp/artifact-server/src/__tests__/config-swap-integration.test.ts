/**
 * config-swap-integration.test.ts — End-to-end regression guard for the
 * artifact_directory swap scenario (PH-076 success criterion #3).
 *
 * Scenario: a user changes the `artifact_directory` field in `.ideate.json`
 * to point at a different directory and restarts the MCP server.  After the
 * restart the index must reflect the NEW directory's artifacts and must NOT
 * contain any artifact that was only present in the OLD directory.
 *
 * The "restart" is simulated by:
 *   1. Creating a fresh ServerState with createDormantState().
 *   2. Calling initServer(newArtifactDir, state) — exactly what server startup
 *      does in production.
 *
 * Pool: inherited from vitest.config.ts (pool: 'forks', singleFork: true).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  createDormantState,
  initServer,
} from "../server.js";
import { CONFIG_SCHEMA_VERSION, resolveArtifactDir } from "../config.js";
import { artifactWatcher } from "../watcher.js";

// ---------------------------------------------------------------------------
// Minimal YAML helpers — no dep on yaml lib, hand-rolled for predictability
// ---------------------------------------------------------------------------

function minimalWorkItemYaml(id: string, title: string): string {
  return [
    `id: "${id}"`,
    `type: "work_item"`,
    `title: "${title}"`,
    `status: "pending"`,
    `complexity: "small"`,
    `cycle_created: 1`,
    `cycle_modified: null`,
    `depends: []`,
    `blocks: []`,
    `criteria: []`,
    `scope: []`,
    `content_hash: ""`,
    `token_count: 0`,
    `file_path: ""`,
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let parentDir: string;   // parent temp directory
let dirA: string;        // first artifact tree
let dirB: string;        // second artifact tree

beforeEach(() => {
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-swap-test-"));
});

afterEach(async () => {
  await artifactWatcher.close();
  fs.rmSync(parentDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper — build a minimal artifact tree rooted at artifactDir
// ---------------------------------------------------------------------------

function buildArtifactTree(artifactDir: string): void {
  // createIdeateProject creates the full sub-directory tree
  // but we need the artifact dir itself, not a project root.
  // So we just create it manually.
  const subdirs = [
    "work-items",
    "plan",
    "steering",
    "principles",
    "constraints",
    "policies",
    "decisions",
    "questions",
    "modules",
    "research",
    "interviews",
    "cycles",
    "domains",
    "projects",
    "phases",
  ];
  for (const sub of subdirs) {
    fs.mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("artifact_directory swap — end-to-end integration", () => {
  it("AC1: resolveArtifactDir reads .ideate.json and initServer indexes the resolved tree", () => {
    // Arrange — build dirA artifact tree with one work item
    dirA = path.join(parentDir, "artifactsA");
    buildArtifactTree(dirA);
    fs.writeFileSync(
      path.join(dirA, "work-items", "WI-A01.yaml"),
      minimalWorkItemYaml("WI-A01", "Work item from dirA"),
      "utf8"
    );

    // Write .ideate.json pointing at dirA
    const ideateJsonPath = path.join(parentDir, ".ideate.json");
    fs.writeFileSync(
      ideateJsonPath,
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, artifact_directory: "./artifactsA" }, null, 2) + "\n",
      "utf8"
    );

    // Act — exercise the production resolution path explicitly.
    // This catches findIdeateJson regressions (e.g., a module-level cache that
    // would return the wrong path on swap).
    const resolvedDir = resolveArtifactDir({}, parentDir);
    expect(resolvedDir).toBe(dirA);

    const state = createDormantState();
    initServer(resolvedDir, state);

    try {
      // Assert — index contains WI-A01
      expect(state.ctx).not.toBeNull();
      const rows = state.ctx!.db!
        .prepare("SELECT id FROM nodes WHERE id = ?")
        .all("WI-A01") as { id: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("WI-A01");
    } finally {
      state.db?.close();
    }
  });

  it("AC2: after swap to dirB, fresh initServer indexes dirB and NOT dirA artifacts", () => {
    // --- Phase 1: build and initialize with dirA ---
    dirA = path.join(parentDir, "artifactsA");
    buildArtifactTree(dirA);
    fs.writeFileSync(
      path.join(dirA, "work-items", "WI-A01.yaml"),
      minimalWorkItemYaml("WI-A01", "Work item from dirA"),
      "utf8"
    );

    const ideateJsonPath = path.join(parentDir, ".ideate.json");
    fs.writeFileSync(
      ideateJsonPath,
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, artifact_directory: "./artifactsA" }, null, 2) + "\n",
      "utf8"
    );

    // Phase 1 resolution — must return dirA
    const resolvedA = resolveArtifactDir({}, parentDir);
    expect(resolvedA).toBe(dirA);

    const state1 = createDormantState();
    initServer(resolvedA, state1);

    try {
      const rowsA = state1.ctx!.db!
        .prepare("SELECT id FROM nodes WHERE id = ?")
        .all("WI-A01") as { id: string }[];
      expect(rowsA).toHaveLength(1);
    } finally {
      // Close first server state (simulating process shutdown)
      state1.db?.close();
    }

    // --- Phase 2: swap .ideate.json to point at dirB, restart ---
    dirB = path.join(parentDir, "artifactsB");
    buildArtifactTree(dirB);
    fs.writeFileSync(
      path.join(dirB, "work-items", "WI-B01.yaml"),
      minimalWorkItemYaml("WI-B01", "Work item from dirB"),
      "utf8"
    );

    // Modify .ideate.json to point at dirB
    fs.writeFileSync(
      ideateJsonPath,
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, artifact_directory: "./artifactsB" }, null, 2) + "\n",
      "utf8"
    );

    // Simulate server restart: fresh ServerState, re-resolve via .ideate.json
    // (this is the production path — catches findIdeateJson caching regressions).
    const resolvedB = resolveArtifactDir({}, parentDir);
    expect(resolvedB).toBe(dirB);
    expect(resolvedB).not.toBe(dirA);

    const state2 = createDormantState();
    initServer(resolvedB, state2);

    try {
      expect(state2.ctx).not.toBeNull();

      // dirB artifact should be present
      const rowsB = state2.ctx!.db!
        .prepare("SELECT id FROM nodes WHERE id = ?")
        .all("WI-B01") as { id: string }[];
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].id).toBe("WI-B01");

      // dirA artifact must NOT be present in the fresh index
      const rowsAInB = state2.ctx!.db!
        .prepare("SELECT id FROM nodes WHERE id = ?")
        .all("WI-A01") as { id: string }[];
      expect(rowsAInB).toHaveLength(0);
    } finally {
      state2.db?.close();
    }
  });
});
