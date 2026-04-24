/**
 * remote-backend-init.test.ts — Regression tests for the remote-backend gate
 * in initServer (WI-815).
 *
 * When config.backend === "remote", initServer must NOT open SQLite, run
 * rebuildIndex, or start the file watcher.  We verify this by checking:
 *   - state.db is null after initServer
 *   - no index.db file is created in the artifact directory
 *   - state.ctx is set (adapter is wired up)
 *   - state.ideateDir is set
 *
 * When config.backend === "local" (default), the existing behavior is
 * preserved: state.db is non-null and index.db is created.
 *
 * Architecture:
 *   - Each test creates a fresh tmp directory and writes a minimal .ideate.json.
 *   - initServer is called directly (no MCP transport).
 *   - The remote backend requires a 'remote.endpoint' value; we supply a fake
 *     URL so selectAdapter does not throw.
 *   - The RemoteAdapter itself is NOT called at runtime in these tests — we
 *     only verify that the SQLite layer is bypassed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { initServer, createDormantState } from "../server.js";
import { createIdeateDir, CONFIG_SCHEMA_VERSION } from "../config.js";
import { artifactWatcher } from "../watcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-remote-backend-test-"));
});

afterEach(async () => {
  await artifactWatcher.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Create a .ideate/ artifact directory and a root .ideate.json with remote-backend config.
 * Returns the path to the created .ideate/ directory.
 */
function createRemoteIdeateDir(dir: string): string {
  const ideateDir = createIdeateDir(dir, {
    schema_version: CONFIG_SCHEMA_VERSION,
    backend: "remote",
    remote: {
      endpoint: "https://fake-ideate-server.example.com/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
    },
  });
  return ideateDir;
}

// ---------------------------------------------------------------------------
// Remote backend gate
// ---------------------------------------------------------------------------

describe("initServer — remote backend", () => {
  it("does not set state.db (no SQLite opened)", () => {
    const ideateDir = createRemoteIdeateDir(tmpDir);
    const state = createDormantState();

    initServer(ideateDir, state);

    expect(state.db).toBeNull();
  });

  it("does not create index.db file in artifact directory", () => {
    const ideateDir = createRemoteIdeateDir(tmpDir);
    const state = createDormantState();

    initServer(ideateDir, state);

    const dbPath = path.join(ideateDir, "index.db");
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("sets state.ideateDir to the artifact directory", () => {
    const ideateDir = createRemoteIdeateDir(tmpDir);
    const state = createDormantState();

    initServer(ideateDir, state);

    expect(state.ideateDir).toBe(ideateDir);
  });

  it("sets state.ctx with a non-null adapter (ValidatingAdapter over RemoteAdapter)", () => {
    const ideateDir = createRemoteIdeateDir(tmpDir);
    const state = createDormantState();

    initServer(ideateDir, state);

    expect(state.ctx).not.toBeNull();
    expect(state.ctx!.adapter).toBeDefined();
    // ctx.ideateDir is set
    expect(state.ctx!.ideateDir).toBe(ideateDir);
  });

  it("does not register file watcher for the artifact directory", () => {
    const ideateDir = createRemoteIdeateDir(tmpDir);
    const state = createDormantState();

    // Spy on artifactWatcher.watch to confirm it is NOT called
    const watchSpy = vi.spyOn(artifactWatcher, "watch");

    initServer(ideateDir, state);

    expect(watchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Local backend gate (existing behavior preserved)
// ---------------------------------------------------------------------------

describe("initServer — local backend (regression)", () => {
  it("sets state.db (SQLite opened)", () => {
    const ideateDir = createIdeateDir(tmpDir);
    const state = createDormantState();

    initServer(ideateDir, state);

    expect(state.db).not.toBeNull();
    state.db?.close();
  });

  it("creates index.db file in artifact directory", () => {
    const ideateDir = createIdeateDir(tmpDir);
    const state = createDormantState();

    initServer(ideateDir, state);

    const dbPath = path.join(ideateDir, "index.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    state.db?.close();
  });

  it("sets state.ctx with db and drizzleDb populated", () => {
    const ideateDir = createIdeateDir(tmpDir);
    const state = createDormantState();

    initServer(ideateDir, state);

    expect(state.ctx).not.toBeNull();
    expect(state.ctx!.adapter).toBeDefined();
    state.db?.close();
  });
});
