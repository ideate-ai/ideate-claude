import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readIdeateConfig,
  readIdeateJson,
  findIdeateJson,
  readRawConfig,
  findIdeateConfig,
  resolveArtifactDir,
  createIdeateProject,
  writeConfig,
  getConfigWithDefaults,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_AGENT_BUDGETS,
  DEFAULT_PPR_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_APPETITE,
  DEFAULT_ARTIFACT_DIRECTORY,
  IDEATE_SUBDIRS,
} from "../config.js";
import type { IdeateConfigJson } from "../config.js";
import { handleUpdateConfig } from "../tools/config.js";
import type { ToolContext } from "../types.js";
import { CURRENT_SCHEMA_VERSION } from "../schema.js";

let tmpDir: string;

function write(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// CONFIG_SCHEMA_VERSION sync check
// -----------------------------------------------------------------------

it("CONFIG_SCHEMA_VERSION equals CURRENT_SCHEMA_VERSION", () => {
  expect(CONFIG_SCHEMA_VERSION).toBe(CURRENT_SCHEMA_VERSION);
});

// -----------------------------------------------------------------------
// readIdeateConfig (deprecated stub — always returns null)
// -----------------------------------------------------------------------

describe("readIdeateConfig", () => {
  it("returns null regardless of directory contents (legacy stub)", () => {
    // Write a legacy artifact directory config file (historical location, no longer read).
    const legacyDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "config.json"),
      JSON.stringify({ schema_version: 2, project_name: "test" })
    );
    // readIdeateConfig is a no-op stub; the legacy artifact-directory config path is
    // no longer supported. callers must use readIdeateJson() instead.
    expect(readIdeateConfig(tmpDir)).toBeNull();
  });

  it("returns null when .ideate directory does not exist", () => {
    expect(readIdeateConfig(tmpDir)).toBeNull();
  });
});

// -----------------------------------------------------------------------
// findIdeateConfig (deprecated wrapper around findIdeateJson)
// -----------------------------------------------------------------------

describe("findIdeateConfig", () => {
  it("finds .ideate.json in the start directory and returns artifactDir", () => {
    write(
      ".ideate.json",
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, artifact_directory: ".ideate" })
    );
    const result = findIdeateConfig(tmpDir);
    expect(result).toBe(path.join(tmpDir, ".ideate"));
  });

  it("finds .ideate.json in a parent directory", () => {
    write(
      ".ideate.json",
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION })
    );
    const subDir = path.join(tmpDir, "src", "components");
    fs.mkdirSync(subDir, { recursive: true });
    const result = findIdeateConfig(subDir);
    expect(result).toBe(path.join(tmpDir, ".ideate"));
  });

  it("returns null when no .ideate.json exists in any ancestor", () => {
    const result = findIdeateConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when only the legacy artifact-directory config file exists (no .ideate.json)", () => {
    // @deprecated Legacy path: the artifact-directory config file is no longer used.
    // findIdeateConfig delegates to findIdeateJson which only looks for .ideate.json.
    const legacyDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "config.json"), JSON.stringify({ schema_version: 2 }));
    const result = findIdeateConfig(tmpDir);
    expect(result).toBeNull();
  });
});

// -----------------------------------------------------------------------
// readIdeateJson
// -----------------------------------------------------------------------

describe("readIdeateJson", () => {
  it("parses a valid .ideate.json with artifact_directory set", () => {
    const configPath = path.join(tmpDir, ".ideate.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, artifact_directory: "my-artifacts" }),
      "utf8"
    );
    const result = readIdeateJson(configPath);
    expect(result.configPath).toBe(configPath);
    expect(result.artifactDir).toBe(path.join(tmpDir, "my-artifacts"));
    expect(result.config.schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it("defaults artifact_directory to .ideate when field is absent", () => {
    const configPath = path.join(tmpDir, ".ideate.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION }),
      "utf8"
    );
    const result = readIdeateJson(configPath);
    expect(result.artifactDir).toBe(path.join(tmpDir, ".ideate"));
  });

  it("resolves a relative artifact_directory relative to the config file directory", () => {
    const configPath = path.join(tmpDir, ".ideate.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, artifact_directory: "./custom/artifacts" }),
      "utf8"
    );
    const result = readIdeateJson(configPath);
    expect(result.artifactDir).toBe(path.join(tmpDir, "custom", "artifacts"));
  });

  it("passes through an absolute artifact_directory unchanged", () => {
    const configPath = path.join(tmpDir, ".ideate.json");
    const absoluteArtifactDir = "/absolute/path/to/artifacts";
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, artifact_directory: absoluteArtifactDir }),
      "utf8"
    );
    const result = readIdeateJson(configPath);
    expect(result.artifactDir).toBe(absoluteArtifactDir);
  });

  it("throws when JSON is malformed", () => {
    const configPath = path.join(tmpDir, ".ideate.json");
    fs.writeFileSync(configPath, "{ not valid json }", "utf8");
    expect(() => readIdeateJson(configPath)).toThrow();
  });

  it("throws when schema_version does not equal 9", () => {
    const configPath = path.join(tmpDir, ".ideate.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schema_version: 5 }),
      "utf8"
    );
    expect(() => readIdeateJson(configPath)).toThrow(/schema_version mismatch/);
  });

  it("throws when schema_version is absent (undefined !== 9)", () => {
    const configPath = path.join(tmpDir, ".ideate.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ project_name: "test" }),
      "utf8"
    );
    expect(() => readIdeateJson(configPath)).toThrow(/schema_version mismatch/);
  });
});

// -----------------------------------------------------------------------
// findIdeateJson
// -----------------------------------------------------------------------

describe("findIdeateJson", () => {
  it("finds .ideate.json in cwd and returns configPath and artifactDir", () => {
    write(
      ".ideate.json",
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, artifact_directory: "specs" })
    );
    const result = findIdeateJson(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.configPath).toBe(path.join(tmpDir, ".ideate.json"));
    expect(result!.artifactDir).toBe(path.join(tmpDir, "specs"));
  });

  it("finds .ideate.json two levels above cwd (ancestor walk)", () => {
    write(
      ".ideate.json",
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION })
    );
    const deepDir = path.join(tmpDir, "a", "b");
    fs.mkdirSync(deepDir, { recursive: true });
    const result = findIdeateJson(deepDir);
    expect(result).not.toBeNull();
    expect(result!.configPath).toBe(path.join(tmpDir, ".ideate.json"));
    expect(result!.artifactDir).toBe(path.join(tmpDir, ".ideate"));
  });

  it("returns null when no .ideate.json exists in any ancestor", () => {
    const result = findIdeateJson(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when only the legacy artifact-directory config file exists (no .ideate.json)", () => {
    // @deprecated Legacy path: the artifact-directory config file is no longer used.
    const legacyDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "config.json"), JSON.stringify({ schema_version: 2 }));
    const result = findIdeateJson(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when .ideate.json exists but is malformed (does not walk further up)", () => {
    write(".ideate.json", "{ not valid json");
    const result = findIdeateJson(tmpDir);
    expect(result).toBeNull();
  });
});

// -----------------------------------------------------------------------
// resolveArtifactDir
// -----------------------------------------------------------------------

describe("resolveArtifactDir", () => {
  it("returns artifact_dir from args when provided", () => {
    const result = resolveArtifactDir(
      { artifact_dir: "/absolute/path/to/specs" },
      tmpDir
    );
    expect(result).toBe("/absolute/path/to/specs");
  });

  it("falls back to .ideate.json when artifact_dir is absent", () => {
    write(
      ".ideate.json",
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION })
    );
    const result = resolveArtifactDir({}, tmpDir);
    expect(result).toBe(path.join(tmpDir, ".ideate"));
  });

  it("prefers explicit artifact_dir over .ideate.json", () => {
    write(
      ".ideate.json",
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION })
    );
    const result = resolveArtifactDir(
      { artifact_dir: "/explicit/path" },
      tmpDir
    );
    expect(result).toBe("/explicit/path");
  });

  it("throws when no artifact_dir and no .ideate.json — message mentions .ideate.json", () => {
    expect(() => resolveArtifactDir({}, tmpDir)).toThrow(".ideate.json");
  });

  it("throws when artifact_dir is an empty string and no .ideate.json", () => {
    expect(() => resolveArtifactDir({ artifact_dir: "  " }, tmpDir)).toThrow(
      "artifact_dir"
    );
  });
});

// -----------------------------------------------------------------------
// createIdeateProject (WI-980: new project layout)
// -----------------------------------------------------------------------

describe("createIdeateProject", () => {
  it("creates <projectRoot>/.ideate.json with schema_version and artifact_directory", () => {
    createIdeateProject(tmpDir);
    const ideateJsonPath = path.join(tmpDir, ".ideate.json");
    expect(fs.existsSync(ideateJsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(ideateJsonPath, "utf8"));
    expect(parsed.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(parsed.artifact_directory).toBe(DEFAULT_ARTIFACT_DIRECTORY);
  });

  it("creates <projectRoot>/<artifact_directory>/ directory", () => {
    createIdeateProject(tmpDir);
    const artifactDir = path.join(tmpDir, DEFAULT_ARTIFACT_DIRECTORY);
    expect(fs.existsSync(artifactDir)).toBe(true);
    expect(fs.statSync(artifactDir).isDirectory()).toBe(true);
  });

  it("creates all IDEATE_SUBDIRS inside the artifact directory", () => {
    const artifactDir = createIdeateProject(tmpDir);
    for (const sub of IDEATE_SUBDIRS) {
      expect(fs.existsSync(path.join(artifactDir, sub))).toBe(true);
    }
  });

  it("does NOT create config.json inside the artifact directory", () => {
    const artifactDir = createIdeateProject(tmpDir);
    const legacyConfigPath = path.join(artifactDir, "config.json");
    expect(fs.existsSync(legacyConfigPath)).toBe(false);
  });

  it("returns the absolute path to the artifact directory", () => {
    const result = createIdeateProject(tmpDir);
    expect(result).toBe(path.join(tmpDir, DEFAULT_ARTIFACT_DIRECTORY));
  });

  it("includes project_name in .ideate.json when provided", () => {
    createIdeateProject(tmpDir, { project_name: "my-project" });
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ".ideate.json"), "utf8"));
    expect(parsed.project_name).toBe("my-project");
    expect(parsed.schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it("is idempotent — second call does not overwrite .ideate.json", () => {
    createIdeateProject(tmpDir);
    // Manually modify .ideate.json to detect overwrite
    const ideateJsonPath = path.join(tmpDir, ".ideate.json");
    const originalContent = fs.readFileSync(ideateJsonPath, "utf8");
    const modified = JSON.parse(originalContent);
    modified.user_modified = true;
    fs.writeFileSync(ideateJsonPath, JSON.stringify(modified, null, 2), "utf8");

    // Second call should not throw and should NOT overwrite the modified file
    createIdeateProject(tmpDir);
    const afterContent = JSON.parse(fs.readFileSync(ideateJsonPath, "utf8"));
    expect(afterContent.user_modified).toBe(true);
  });

  it("is idempotent — second call does not error and all subdirs still exist", () => {
    const artifactDir = createIdeateProject(tmpDir);
    // Should not throw when called again
    expect(() => createIdeateProject(tmpDir)).not.toThrow();
    for (const sub of IDEATE_SUBDIRS) {
      expect(fs.existsSync(path.join(artifactDir, sub))).toBe(true);
    }
  });

  it("custom artifact_directory_name creates artifact tree at that path", () => {
    const customName = ".ideate-experiment";
    const artifactDir = createIdeateProject(tmpDir, {}, customName);
    expect(artifactDir).toBe(path.join(tmpDir, customName));
    expect(fs.existsSync(artifactDir)).toBe(true);
    for (const sub of IDEATE_SUBDIRS) {
      expect(fs.existsSync(path.join(artifactDir, sub))).toBe(true);
    }
  });

  it("custom artifact_directory_name is recorded in .ideate.json", () => {
    const customName = "graph";
    createIdeateProject(tmpDir, {}, customName);
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ".ideate.json"), "utf8"));
    expect(parsed.artifact_directory).toBe(customName);
  });

  it(".ideate.json created by createIdeateProject is discoverable by findIdeateConfig", () => {
    createIdeateProject(tmpDir);
    const result = findIdeateConfig(tmpDir);
    expect(result).toBe(path.join(tmpDir, DEFAULT_ARTIFACT_DIRECTORY));
  });
});

// -----------------------------------------------------------------------
// writeConfig
// -----------------------------------------------------------------------

describe("writeConfig", () => {
  it("writes .ideate.json to the project root (parent of artifact directory)", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 2 });
    // writeConfig writes to <parent>/.ideate.json, not inside the artifact dir
    const configPath = path.join(tmpDir, ".ideate.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed).toEqual({ schema_version: 2 });
  });

  it("overwrites existing .ideate.json at project root", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 1 });
    writeConfig(ideateDir, {
      schema_version: 2,
      project_name: "updated",
    });
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".ideate.json"), "utf8")
    );
    expect(parsed).toEqual({
      schema_version: 2,
      project_name: "updated",
    });
  });

  it("writes to .ideate.json located via findIdeateJson for nested artifact_directory (not just path.dirname)", () => {
    // Set up: .ideate.json at tmpDir with artifact_directory pointing into a nested path.
    const configPath = path.join(tmpDir, ".ideate.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION, artifact_directory: "./custom/nested/artifacts" }),
      "utf8"
    );
    const nestedIdeateDir = path.join(tmpDir, "custom", "nested", "artifacts");
    fs.mkdirSync(nestedIdeateDir, { recursive: true });

    // writeConfig with the nested artifact directory must locate the .ideate.json at tmpDir, not at tmpDir/custom/nested/.
    writeConfig(nestedIdeateDir, { schema_version: CONFIG_SCHEMA_VERSION, project_name: "nested-proj" });

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed.project_name).toBe("nested-proj");
    // Confirm no config was misplaced to the nested intermediate level.
    expect(fs.existsSync(path.join(tmpDir, "custom", "nested", ".ideate.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "custom", ".ideate.json"))).toBe(false);
  });
});

// -----------------------------------------------------------------------
// getConfigWithDefaults
// -----------------------------------------------------------------------

describe("getConfigWithDefaults", () => {
  it("returns all fields with defaults when config has only schema_version", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 2 });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.schema_version).toBe(2);
    // agent_budgets should be the full defaults
    expect(result.agent_budgets).toEqual(DEFAULT_AGENT_BUDGETS);
    // ppr should be fully populated with defaults
    expect(result.ppr.alpha).toBe(DEFAULT_PPR_CONFIG.alpha);
    expect(result.ppr.max_iterations).toBe(DEFAULT_PPR_CONFIG.max_iterations);
    expect(result.ppr.convergence_threshold).toBe(
      DEFAULT_PPR_CONFIG.convergence_threshold
    );
    expect(result.ppr.edge_type_weights).toEqual(
      DEFAULT_PPR_CONFIG.edge_type_weights
    );
    expect(result.ppr.default_token_budget).toBe(
      DEFAULT_PPR_CONFIG.default_token_budget
    );
  });

  it("returns merged config when all optional fields are explicitly set", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const customConfig: IdeateConfigJson = {
      schema_version: 2,
      project_name: "my-project",
      agent_budgets: {
        "code-reviewer": 200,
        "custom-agent": 50,
      },
      ppr: {
        alpha: 0.25,
        max_iterations: 100,
        convergence_threshold: 1e-8,
        edge_type_weights: { depends_on: 2.0 },
        default_token_budget: 100000,
      },
    };
    writeConfig(ideateDir, customConfig);

    const result = getConfigWithDefaults(ideateDir);

    expect(result.schema_version).toBe(2);
    expect(result.project_name).toBe("my-project");
    // custom agent budget overrides default, and extra agent is present
    expect(result.agent_budgets["code-reviewer"]).toBe(200);
    expect(result.agent_budgets["custom-agent"]).toBe(50);
    // default agent budgets not overridden remain
    expect(result.agent_budgets["architect"]).toBe(160);
    // ppr scalars from config
    expect(result.ppr.alpha).toBe(0.25);
    expect(result.ppr.max_iterations).toBe(100);
    expect(result.ppr.convergence_threshold).toBe(1e-8);
    expect(result.ppr.default_token_budget).toBe(100000);
    // edge_type_weights: custom overrides default, others from default remain
    expect(result.ppr.edge_type_weights!["depends_on"]).toBe(2.0);
    expect(result.ppr.edge_type_weights!["governed_by"]).toBe(0.8);
  });

  it("applies defaults for missing ppr sub-fields when ppr is partially specified", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 2, ppr: { alpha: 0.5 } });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.ppr.alpha).toBe(0.5);
    expect(result.ppr.max_iterations).toBe(DEFAULT_PPR_CONFIG.max_iterations);
    expect(result.ppr.convergence_threshold).toBe(
      DEFAULT_PPR_CONFIG.convergence_threshold
    );
  });

  it("returns defaults when config.json does not exist", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    // No config.json written

    const result = getConfigWithDefaults(ideateDir);

    expect(result.agent_budgets).toEqual(DEFAULT_AGENT_BUDGETS);
    expect(result.ppr.alpha).toBe(DEFAULT_PPR_CONFIG.alpha);
  });

  it("returns model_overrides as empty object when field is absent from config.json", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 2 });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.model_overrides).toEqual({});
  });

  it("returns populated model_overrides when field is present in config.json", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, {
      schema_version: 2,
      model_overrides: {
        "domain-curator": "claude-opus-4-5",
        architect: "claude-opus-4-5",
      },
    });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.model_overrides).toEqual({
      "domain-curator": "claude-opus-4-5",
      architect: "claude-opus-4-5",
    });
  });

  it("applies defaults for circuit_breaker_threshold and default_appetite when absent", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 3 });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.circuit_breaker_threshold).toBe(DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
    expect(result.default_appetite).toBe(DEFAULT_APPETITE);
  });

  it("respects circuit_breaker_threshold and default_appetite overrides from config.json", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, {
      schema_version: 3,
      circuit_breaker_threshold: 10,
      default_appetite: 3,
    });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.circuit_breaker_threshold).toBe(10);
    expect(result.default_appetite).toBe(3);
  });
});

// -----------------------------------------------------------------------
// IdeateConfigJson — artifact_directory field (WI-978)
// -----------------------------------------------------------------------

describe("IdeateConfigJson artifact_directory field", () => {
  it("parses inline JSON with artifact_directory set to ./.ideate", () => {
    const raw: IdeateConfigJson = JSON.parse(
      JSON.stringify({ schema_version: 9, artifact_directory: "./.ideate" })
    );
    expect(raw.artifact_directory).toBe("./.ideate");
    expect(raw.schema_version).toBe(9);
  });

  it("parses inline JSON without artifact_directory and defaults to .ideate via getConfigWithDefaults", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    // Write a config without artifact_directory to the project-root .ideate.json
    const raw: IdeateConfigJson = { schema_version: 9 };
    fs.writeFileSync(
      path.join(tmpDir, ".ideate.json"),
      JSON.stringify(raw, null, 2),
      "utf8"
    );

    const result = getConfigWithDefaults(ideateDir);
    expect(result.artifact_directory).toBe(DEFAULT_ARTIFACT_DIRECTORY);
    expect(result.artifact_directory).toBe(".ideate");
  });

  it("parses inline JSON with artifact_directory set to a custom path and preserves it", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    const raw: IdeateConfigJson = { schema_version: 9, artifact_directory: "./custom-artifacts" };
    // Write to the project-root .ideate.json (parent of artifact dir)
    fs.writeFileSync(
      path.join(tmpDir, ".ideate.json"),
      JSON.stringify(raw, null, 2),
      "utf8"
    );

    const result = getConfigWithDefaults(ideateDir);
    expect(result.artifact_directory).toBe("./custom-artifacts");
  });
});

// -----------------------------------------------------------------------
// handleUpdateConfig
// -----------------------------------------------------------------------

describe("handleUpdateConfig", () => {
  let ideateDir: string;
  let ctx: ToolContext;

  // Minimal ToolContext — handleUpdateConfig only uses ideateDir
  function makeCtx(dir: string): ToolContext {
    return {
      ideateDir: dir,
    } as unknown as ToolContext;
  }

  beforeEach(() => {
    // Create a fresh .ideate/ dir with a known baseline config
    ideateDir = path.join(tmpDir, "handle-update-config-ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    const baseline: IdeateConfigJson = {
      schema_version: 2,
      project_name: "test-project",
      agent_budgets: {
        "code-reviewer": 80,
        architect: 160,
      },
      model_overrides: {
        "domain-curator": "claude-opus-4-5",
      },
      ppr: {
        alpha: 0.15,
        max_iterations: 50,
        convergence_threshold: 1e-6,
        edge_type_weights: { depends_on: 1.0, governed_by: 0.8 },
        default_token_budget: 50000,
      },
    };
    writeConfig(ideateDir, baseline);
    ctx = makeCtx(ideateDir);
  });

  it("updates a single agent_budget key — other agents are preserved", async () => {
    const result = JSON.parse(
      await handleUpdateConfig(ctx, { patch: { agent_budgets: { "code-reviewer": 120 } } })
    );
    expect(result.status).toBe("updated");
    expect(result.updated_keys).toContain("agent_budgets");

    const saved = getConfigWithDefaults(ideateDir);
    expect(saved.agent_budgets["code-reviewer"]).toBe(120);
    expect(saved.agent_budgets["architect"]).toBe(160);
  });

  it("adds a new model_overrides key while preserving existing keys", async () => {
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { model_overrides: { architect: "claude-opus-4-5" } },
      })
    );
    expect(result.status).toBe("updated");
    expect(result.updated_keys).toContain("model_overrides");

    const saved = getConfigWithDefaults(ideateDir);
    expect(saved.model_overrides["architect"]).toBe("claude-opus-4-5");
    expect(saved.model_overrides["domain-curator"]).toBe("claude-opus-4-5");
  });

  it("updates ppr.alpha — other PPR fields are preserved", async () => {
    const result = JSON.parse(
      await handleUpdateConfig(ctx, { patch: { ppr: { alpha: 0.25 } } })
    );
    expect(result.status).toBe("updated");
    expect(result.updated_keys).toContain("ppr");

    const saved = getConfigWithDefaults(ideateDir);
    expect(saved.ppr.alpha).toBe(0.25);
    expect(saved.ppr.max_iterations).toBe(50);
    expect(saved.ppr.convergence_threshold).toBe(1e-6);
    expect(saved.ppr.default_token_budget).toBe(50000);
  });

  it("updates a single edge_type_weight — other weights are preserved", async () => {
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { ppr: { edge_type_weights: { depends_on: 2.0 } } },
      })
    );
    expect(result.status).toBe("updated");

    const saved = getConfigWithDefaults(ideateDir);
    expect(saved.ppr.edge_type_weights!["depends_on"]).toBe(2.0);
    expect(saved.ppr.edge_type_weights!["governed_by"]).toBe(0.8);
  });

  it("returns error when agent_budget value is 0 — config is not written", async () => {
    // Config is now at <parent>/.ideate.json, not inside the artifact directory
    const configFilePath = path.join(path.dirname(ideateDir), ".ideate.json");
    const before = fs.readFileSync(configFilePath, "utf8");
    const result = JSON.parse(
      await handleUpdateConfig(ctx, { patch: { agent_budgets: { "code-reviewer": 0 } } })
    );
    expect(result.status).toBe("error");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.some((e: string) => e.includes("code-reviewer"))).toBe(true);

    // Config must not have changed
    const after = fs.readFileSync(configFilePath, "utf8");
    expect(after).toBe(before);
  });

  it("returns error when model_overrides value is empty string — config is not written", async () => {
    const configFilePath = path.join(path.dirname(ideateDir), ".ideate.json");
    const before = fs.readFileSync(configFilePath, "utf8");
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { model_overrides: { "domain-curator": "" } },
      })
    );
    expect(result.status).toBe("error");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.some((e: string) => e.includes("domain-curator"))).toBe(true);

    const after = fs.readFileSync(configFilePath, "utf8");
    expect(after).toBe(before);
  });

  it("returns error when ppr.alpha is 1.5 — config is not written", async () => {
    const configFilePath = path.join(path.dirname(ideateDir), ".ideate.json");
    const before = fs.readFileSync(configFilePath, "utf8");
    const result = JSON.parse(
      await handleUpdateConfig(ctx, { patch: { ppr: { alpha: 1.5 } } })
    );
    expect(result.status).toBe("error");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.some((e: string) => e.includes("ppr.alpha"))).toBe(true);

    const after = fs.readFileSync(configFilePath, "utf8");
    expect(after).toBe(before);
  });

  it("updated_keys reflects actual top-level keys that changed", async () => {
    // Patch only model_overrides — updated_keys should contain only that key
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { model_overrides: { researcher: "claude-opus-4-5" } },
      })
    );
    expect(result.status).toBe("updated");
    expect(result.updated_keys).toContain("model_overrides");
    // agent_budgets did not change
    expect(result.updated_keys).not.toContain("agent_budgets");
  });

  it("written .ideate.json is sparse — only patched keys are present", async () => {
    // Start from a minimal config with no optional keys.
    // Use a dedicated project root so it doesn't collide with the outer beforeEach.
    const sparseProjectRoot = path.join(tmpDir, "sparse-project");
    const sparseDir = path.join(sparseProjectRoot, ".ideate");
    fs.mkdirSync(sparseDir, { recursive: true });
    writeConfig(sparseDir, { schema_version: 2 });
    const sparseCtx = makeCtx(sparseDir);

    // Patch only agent_budgets
    const result = JSON.parse(
      await handleUpdateConfig(sparseCtx, {
        patch: { agent_budgets: { "code-reviewer": 100 } },
      })
    );
    expect(result.status).toBe("updated");

    // Read .ideate.json as raw JSON — ppr and model_overrides must NOT be present
    const raw = readRawConfig(sparseDir);
    expect(raw.agent_budgets).toEqual({ "code-reviewer": 100 });
    expect(raw.ppr).toBeUndefined();
    expect(raw.model_overrides).toBeUndefined();
  });

  it("null-signal removes a stored model_overrides key", async () => {
    // setup: store an override
    await handleUpdateConfig(ctx, { patch: { model_overrides: { architect: "opus" } } });
    // act: clear it
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { model_overrides: { architect: null } as Record<string, string | null> },
      })
    );
    expect(result.status).toBe("updated");
    const raw = readRawConfig(ideateDir);
    expect(raw.model_overrides).not.toHaveProperty("architect");
  });

  it("null-signal on last key produces absent model_overrides (sparse invariant)", async () => {
    // Start from a config with only one model_override key.
    // Use a dedicated project root so it doesn't collide with the outer beforeEach.
    const nullSignalProjectRoot = path.join(tmpDir, "null-signal-project");
    const sparseDir = path.join(nullSignalProjectRoot, ".ideate");
    fs.mkdirSync(sparseDir, { recursive: true });
    writeConfig(sparseDir, { schema_version: 2 });
    const sparseCtx = makeCtx(sparseDir);

    await handleUpdateConfig(sparseCtx, {
      patch: { model_overrides: { researcher: "opus" } },
    });
    await handleUpdateConfig(sparseCtx, {
      patch: { model_overrides: { researcher: null } as Record<string, string | null> },
    });
    const raw = readRawConfig(sparseDir);
    expect(raw.model_overrides).toBeUndefined();
  });

  it("null-signal on non-existent key is a no-op", async () => {
    // Start from a minimal config with no model_overrides.
    // Use a dedicated project root so it doesn't collide with the outer beforeEach.
    const noopProjectRoot = path.join(tmpDir, "noop-project");
    const sparseDir = path.join(noopProjectRoot, ".ideate");
    fs.mkdirSync(sparseDir, { recursive: true });
    writeConfig(sparseDir, { schema_version: 2 });
    const sparseCtx = makeCtx(sparseDir);

    const result = JSON.parse(
      await handleUpdateConfig(sparseCtx, {
        patch: { model_overrides: { nonexistent: null } as Record<string, string | null> },
      })
    );
    expect(result.status).toBe("updated");
    const raw = readRawConfig(sparseDir);
    expect(raw.model_overrides).toBeUndefined();
  });

  it("mixed patch: sets one key and nulls another in same call", async () => {
    // setup: two keys stored
    await handleUpdateConfig(ctx, {
      patch: { model_overrides: { architect: "opus", researcher: "haiku" } },
    });
    // act: set architect to sonnet, clear researcher
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: {
          model_overrides: { architect: "sonnet", researcher: null } as Record<string, string | null>,
        },
      })
    );
    expect(result.status).toBe("updated");
    const raw = readRawConfig(ideateDir);
    expect(raw.model_overrides).toEqual({ architect: "sonnet", "domain-curator": "claude-opus-4-5" });
  });
});
