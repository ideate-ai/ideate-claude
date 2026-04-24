/**
 * bootstrap.test.ts — Unit tests for handleBootstrapWorkspace (tools/bootstrap.ts).
 *
 * These tests exercise the MCP tool handler directly without the MCP transport
 * layer. Each test uses a fresh temporary directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { handleBootstrapWorkspace } from "../tools/bootstrap.js";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_ARTIFACT_DIRECTORY,
  IDEATE_SUBDIRS,
} from "../config.js";
import type { ToolContext } from "../types.js";

let tmpDir: string;

// Helper to build a minimal ToolContext pointing ideateDir at <tmpDir>/.ideate
function makeCtx(artifactDirName = DEFAULT_ARTIFACT_DIRECTORY): ToolContext {
  return {
    ideateDir: path.join(tmpDir, artifactDirName),
  } as unknown as ToolContext;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-bootstrap-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic initialization
// ---------------------------------------------------------------------------

describe("handleBootstrapWorkspace — basic initialization", () => {
  it("creates .ideate.json at the project root with schema_version 9", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, {});
    const ideateJsonPath = path.join(tmpDir, ".ideate.json");
    expect(fs.existsSync(ideateJsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(ideateJsonPath, "utf8"));
    expect(parsed.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(parsed.schema_version).toBe(9);
  });

  it("records artifact_directory in .ideate.json", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, {});
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".ideate.json"), "utf8")
    );
    expect(parsed.artifact_directory).toBe(DEFAULT_ARTIFACT_DIRECTORY);
  });

  it("creates the artifact directory", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, {});
    expect(fs.existsSync(path.join(tmpDir, DEFAULT_ARTIFACT_DIRECTORY))).toBe(true);
  });

  it("creates all IDEATE_SUBDIRS inside the artifact directory — iterates IDEATE_SUBDIRS", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, {});
    const artifactDir = path.join(tmpDir, DEFAULT_ARTIFACT_DIRECTORY);
    for (const sub of IDEATE_SUBDIRS) {
      expect(
        fs.existsSync(path.join(artifactDir, sub)),
        `expected subdir '${sub}' to exist`
      ).toBe(true);
    }
  });

  it("does NOT write config.json inside the artifact directory", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, {});
    const legacyPath = path.join(tmpDir, DEFAULT_ARTIFACT_DIRECTORY, "config.json");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("returns JSON with status=initialized and subdirectories list", async () => {
    const ctx = makeCtx();
    const result = await handleBootstrapWorkspace(ctx, {});
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("initialized");
    expect(Array.isArray(parsed.subdirectories)).toBe(true);
    expect(parsed.subdirectories).toEqual([...IDEATE_SUBDIRS]);
  });

  it("includes project_name in .ideate.json when provided", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, { project_name: "my-project" });
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".ideate.json"), "utf8")
    );
    expect(parsed.project_name).toBe("my-project");
  });

  it("omits project_name from .ideate.json when not provided", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, {});
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".ideate.json"), "utf8")
    );
    expect(parsed.project_name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// custom artifact_directory_name
// ---------------------------------------------------------------------------

describe("handleBootstrapWorkspace — artifact_directory_name parameter", () => {
  it("creates artifact tree at custom directory", async () => {
    const customName = ".ideate-experiment";
    const ctx = makeCtx(customName);
    await handleBootstrapWorkspace(ctx, { artifact_directory_name: customName });
    const customDir = path.join(tmpDir, customName);
    expect(fs.existsSync(customDir)).toBe(true);
    for (const sub of IDEATE_SUBDIRS) {
      expect(fs.existsSync(path.join(customDir, sub))).toBe(true);
    }
  });

  it("records custom artifact_directory_name in .ideate.json", async () => {
    const customName = "graph";
    const ctx = makeCtx(customName);
    await handleBootstrapWorkspace(ctx, { artifact_directory_name: customName });
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".ideate.json"), "utf8")
    );
    expect(parsed.artifact_directory).toBe(customName);
  });

  it("does NOT write config.json inside a custom artifact directory", async () => {
    const customName = ".ideate-experiment";
    const ctx = makeCtx(customName);
    await handleBootstrapWorkspace(ctx, { artifact_directory_name: customName });
    const legacyPath = path.join(tmpDir, customName, "config.json");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("falls back to DEFAULT_ARTIFACT_DIRECTORY when artifact_directory_name is empty string", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, { artifact_directory_name: "  " });
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".ideate.json"), "utf8")
    );
    expect(parsed.artifact_directory).toBe(DEFAULT_ARTIFACT_DIRECTORY);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("handleBootstrapWorkspace — idempotency", () => {
  it("second call does NOT overwrite existing .ideate.json", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, { project_name: "original" });

    // Manually edit .ideate.json to detect overwrite
    const ideateJsonPath = path.join(tmpDir, ".ideate.json");
    const original = JSON.parse(fs.readFileSync(ideateJsonPath, "utf8"));
    original.user_modified = true;
    fs.writeFileSync(ideateJsonPath, JSON.stringify(original, null, 2), "utf8");

    // Second call
    await handleBootstrapWorkspace(ctx, { project_name: "overwritten" });

    const after = JSON.parse(fs.readFileSync(ideateJsonPath, "utf8"));
    expect(after.user_modified).toBe(true);
    expect(after.project_name).toBe("original");
  });

  it("second call does not throw and still returns status=initialized", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, {});
    const result = JSON.parse(await handleBootstrapWorkspace(ctx, {}));
    expect(result.status).toBe("initialized");
  });

  it("second call ensures all subdirs still exist (fills in missing ones)", async () => {
    const ctx = makeCtx();
    await handleBootstrapWorkspace(ctx, {});

    // Remove a subdir to simulate partial deletion
    const artifactDir = path.join(tmpDir, DEFAULT_ARTIFACT_DIRECTORY);
    fs.rmSync(path.join(artifactDir, "work-items"), { recursive: true });

    // Second call should recreate it
    await handleBootstrapWorkspace(ctx, {});
    expect(fs.existsSync(path.join(artifactDir, "work-items"))).toBe(true);
  });
});
