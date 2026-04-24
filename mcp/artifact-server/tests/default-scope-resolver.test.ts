/**
 * default-scope-resolver.test.ts — Tests for resolveDefaultScope() (WI-001)
 *
 * Covers AC-10:
 *   - explicit config wins
 *   - cwd heuristic per submodule (plugins/claude, services/server, infra)
 *   - fallback to "product" when no heuristic matches
 *   - behavior when all paths fail (documented: currently falls back to product)
 */

import { describe, it, expect } from "vitest";
import { resolveDefaultScope } from "../src/default-scope-resolver.js";
import type { IdeateConfigJson } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal config object
// ---------------------------------------------------------------------------

function config(overrides: Partial<IdeateConfigJson> = {}): Partial<IdeateConfigJson> {
  return { schema_version: 8, ...overrides };
}

// ---------------------------------------------------------------------------
// Suite: explicit config wins
// ---------------------------------------------------------------------------

describe("resolveDefaultScope — explicit config wins", () => {
  it("returns config.org_id and config.codebase_id when both are set", () => {
    const result = resolveDefaultScope(
      config({ org_id: "acme", codebase_id: "my-service" }),
      "/some/irrelevant/path"
    );
    expect(result).toEqual({ org_id: "acme", codebase_id: "my-service" });
  });

  it("trims whitespace from org_id and codebase_id", () => {
    const result = resolveDefaultScope(
      config({ org_id: "  acme  ", codebase_id: "  my-service  " }),
      "/some/path"
    );
    expect(result).toEqual({ org_id: "acme", codebase_id: "my-service" });
  });

  it("falls through to heuristic when org_id is missing", () => {
    const result = resolveDefaultScope(
      config({ codebase_id: "my-service" }), // no org_id
      "/Users/dan/code/ideate/plugins/claude/mcp/server"
    );
    // Should use cwd heuristic, not config.codebase_id (since org_id is missing)
    expect(result.org_id).toBe("ideate");
    expect(result.codebase_id).toBe("plugin-claude");
  });

  it("falls through to heuristic when codebase_id is missing", () => {
    const result = resolveDefaultScope(
      config({ org_id: "acme" }), // no codebase_id
      "/Users/dan/code/ideate/plugins/claude/mcp/server"
    );
    // Should use cwd heuristic, not config.org_id (since codebase_id is missing)
    expect(result.org_id).toBe("ideate");
    expect(result.codebase_id).toBe("plugin-claude");
  });

  it("falls through to heuristic when org_id is empty string", () => {
    const result = resolveDefaultScope(
      config({ org_id: "", codebase_id: "my-service" }),
      "/Users/dan/code/ideate/plugins/claude"
    );
    expect(result.codebase_id).toBe("plugin-claude");
  });

  it("falls through to heuristic when codebase_id is empty string", () => {
    const result = resolveDefaultScope(
      config({ org_id: "acme", codebase_id: "" }),
      "/Users/dan/code/ideate/plugins/claude"
    );
    expect(result.codebase_id).toBe("plugin-claude");
  });
});

// ---------------------------------------------------------------------------
// Suite: cwd heuristic per submodule
// ---------------------------------------------------------------------------

describe("resolveDefaultScope — cwd heuristic", () => {
  it("maps plugins/claude/** to codebase_id='plugin-claude'", () => {
    const result = resolveDefaultScope(
      config(),
      "/Users/dan/code/ideate/plugins/claude/mcp/artifact-server/src"
    );
    expect(result).toEqual({ org_id: "ideate", codebase_id: "plugin-claude" });
  });

  it("maps plugins/claude (root) to codebase_id='plugin-claude'", () => {
    const result = resolveDefaultScope(
      config(),
      "/workspace/ideate/plugins/claude"
    );
    expect(result).toEqual({ org_id: "ideate", codebase_id: "plugin-claude" });
  });

  it("maps services/server/** to codebase_id='artifact-server'", () => {
    const result = resolveDefaultScope(
      config(),
      "/home/user/projects/ideate/services/server/src"
    );
    expect(result).toEqual({ org_id: "ideate", codebase_id: "artifact-server" });
  });

  it("maps infra/** to codebase_id='infra'", () => {
    const result = resolveDefaultScope(
      config(),
      "/workspace/ideate/infra/docker"
    );
    expect(result).toEqual({ org_id: "ideate", codebase_id: "infra" });
  });

  it("uses first matching prefix (plugins/claude wins over services/server if both appear in path)", () => {
    // This is an edge case — unlikely in practice but tests ordering
    const result = resolveDefaultScope(
      config(),
      "/home/plugins/claude/services/server/nested"
    );
    expect(result.codebase_id).toBe("plugin-claude");
  });
});

// ---------------------------------------------------------------------------
// Suite: fallback to "product"
// ---------------------------------------------------------------------------

describe("resolveDefaultScope — fallback to product", () => {
  it("returns codebase_id='product' for an unrecognised path", () => {
    const result = resolveDefaultScope(
      config(),
      "/Users/dan/unrelated/project/src"
    );
    expect(result).toEqual({ org_id: "ideate", codebase_id: "product" });
  });

  it("returns codebase_id='product' for an empty cwd string", () => {
    const result = resolveDefaultScope(config(), "");
    expect(result).toEqual({ org_id: "ideate", codebase_id: "product" });
  });

  it("returns codebase_id='product' for a root path", () => {
    const result = resolveDefaultScope(config(), "/");
    expect(result).toEqual({ org_id: "ideate", codebase_id: "product" });
  });

  it("returns a valid scope even with an empty config object", () => {
    const result = resolveDefaultScope({}, "/unknown/path");
    expect(result.org_id).toBeDefined();
    expect(result.codebase_id).toBeDefined();
    expect(typeof result.org_id).toBe("string");
    expect(typeof result.codebase_id).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Suite: process.cwd() default when cwd is omitted
// ---------------------------------------------------------------------------

describe("resolveDefaultScope — defaults to process.cwd()", () => {
  it("resolves without cwd argument (uses process.cwd())", () => {
    const result = resolveDefaultScope(config());
    // Just verify it returns a valid scope — actual value depends on the test runner cwd
    expect(result.org_id).toBeDefined();
    expect(result.codebase_id).toBeDefined();
    expect(typeof result.org_id).toBe("string");
    expect(typeof result.codebase_id).toBe("string");
    expect(result.org_id.length).toBeGreaterThan(0);
    expect(result.codebase_id.length).toBeGreaterThan(0);
  });
});
