import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { log } from "./logger.js";

export const CONFIG_SCHEMA_VERSION = 9;

/**
 * Schema for .ideate.json (the config pointer file at the project root).
 * Historical note: earlier schemas stored config in .ideate/config.json (legacy).
 */
export type SpawnMode = "subagent" | "teammate";

export type BackendType = "local" | "remote";

export interface IdeateConfigJson {
  schema_version: number;
  project_name?: string;
  agent_budgets?: Record<string, number>;
  model_overrides?: Record<string, string>;
  circuit_breaker_threshold?: number;
  default_appetite?: number;
  spawn_mode?: SpawnMode;
  ppr?: {
    alpha?: number;
    max_iterations?: number;
    convergence_threshold?: number;
    edge_type_weights?: Record<string, number>;
    default_token_budget?: number;
    max_hops?: number;
  };
  /** Storage backend selection. Default: "local". */
  backend?: BackendType;
  /**
   * Organization ID for multi-tenant isolation.
   * Used by both local and remote adapters for artifact scoping.
   * When absent, the default-scope resolver derives org_id from cwd.
   */
  org_id?: string;
  /**
   * Codebase ID within the organization.
   * Used by both local and remote adapters for artifact scoping.
   * When absent, the default-scope resolver derives codebase_id from cwd.
   */
  codebase_id?: string;
  /**
   * Relative path from the .ideate.json file's directory to the artifact tree.
   * When absent, defaults to ".ideate".
   */
  artifact_directory?: string;
  /** Remote backend configuration. Required when backend is "remote". */
  remote?: {
    /** GraphQL endpoint URL for the ideate-server. */
    endpoint: string;
    /** Organization ID for multi-tenant isolation. */
    org_id: string;
    /** Codebase ID within the organization. */
    codebase_id: string;
    /** Auth fields reserved for future use. */
    auth_token?: string | null;
  };
  /**
   * v3 delegation-board state configuration (WI-321).
   * When the board is active (its database file exists on disk), the v2
   * artifact server refuses work-item writes — see resolveBoardDbPath() and
   * BoardActiveError in tools/write.ts.
   */
  work_state?: {
    /**
     * Relative (or absolute) path from the project root (the .ideate.json
     * file's directory) to the v3 work-state directory. When absent,
     * defaults to DEFAULT_WORK_STATE_PATH (".ideate-work").
     */
    path?: string;
  };
}

/**
 * Default circuit_breaker_threshold used when the field is absent from config.json.
 */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;

/**
 * Default default_appetite used when the field is absent from config.json.
 */
export const DEFAULT_APPETITE = 6;

/**
 * Default spawn_mode used when the field is absent from config.json.
 * "subagent" = standard Agent tool spawning; "teammate" = agent teams mode.
 */
export const DEFAULT_SPAWN_MODE: SpawnMode = "subagent";

/**
 * Default backend used when the field is absent from config.json.
 */
export const DEFAULT_BACKEND: BackendType = "local";

/**
 * Default artifact_directory used when the field is absent from config.json.
 * Relative path from the .ideate.json file's directory to the artifact tree.
 */
export const DEFAULT_ARTIFACT_DIRECTORY = ".ideate";

/**
 * Default work_state.path used when the field is absent from .ideate.json.
 * Relative path from the project root (the .ideate.json file's directory)
 * to the v3 delegation-board's work-state directory. See WI-321.
 */
export const DEFAULT_WORK_STATE_PATH = ".ideate-work";

/**
 * Default agent_budgets used when the field is absent from config.json.
 */
export const DEFAULT_AGENT_BUDGETS: Record<string, number> = {
  "code-reviewer": 80,
  "spec-reviewer": 100,
  "gap-analyst": 100,
  "journal-keeper": 60,
  "domain-curator": 100,
  decomposer: 100,
  architect: 160,
  researcher: 80,
  "proxy-human": 160,
};

/**
 * Default PPR configuration used when the field is absent from config.json.
 */
export const DEFAULT_PPR_CONFIG = {
  alpha: 0.15,
  max_iterations: 50,
  convergence_threshold: 1e-6,
  edge_type_weights: {
    depends_on: 1.0,
    governed_by: 0.8,
    informed_by: 0.6,
    references: 0.4,
    blocks: 0.3,
  },
  default_token_budget: 50000,
  max_hops: 4,
};

/**
 * Resolved config used internally.
 */
export interface IdeateConfig {
  artifactDir: string;
}

/**
 * Result type returned by findIdeateJson and readIdeateJson.
 */
export interface IdeateJsonResult {
  /** Absolute path to the .ideate.json file. */
  configPath: string;
  /** Absolute path to the resolved artifact directory. */
  artifactDir: string;
}

/**
 * Subdirectories created inside the artifact directory by createIdeateProject().
 */
export const IDEATE_SUBDIRS = [
  "plan",
  "steering",
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
  "domains",
  "projects",
  "phases",
] as const;

/**
 * Parse the .ideate.json file at the given absolute path.
 * Validates schema_version === 9; throws if mismatched or malformed.
 * Resolves artifact_directory relative to the config file's directory.
 * If artifact_directory is absent, defaults to ".ideate".
 *
 * @param configPath - Absolute path to the .ideate.json file
 * @returns Parsed config and resolved artifactDir
 * @throws If the file cannot be read, JSON is malformed, or schema_version !== 9
 */
export function readIdeateJson(configPath: string): IdeateJsonResult & { config: IdeateConfigJson } {
  let raw: IdeateConfigJson;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as IdeateConfigJson;
  } catch (err) {
    throw new Error(
      `.ideate.json at ${configPath} failed to parse: ${(err as Error).message}`
    );
  }
  if (raw.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `.ideate.json schema_version mismatch: expected ${CONFIG_SCHEMA_VERSION}, got ${raw.schema_version} (path: ${configPath})`
    );
  }
  const configDir = path.dirname(configPath);
  const relOrAbsArtifactDir = raw.artifact_directory ?? DEFAULT_ARTIFACT_DIRECTORY;
  const artifactDir = path.isAbsolute(relOrAbsArtifactDir)
    ? relOrAbsArtifactDir
    : path.resolve(configDir, relOrAbsArtifactDir);
  return { configPath, artifactDir, config: raw };
}

/**
 * Walk up the directory tree from startDir looking for .ideate.json.
 * Returns {configPath, artifactDir} where configPath is the absolute path to
 * the .ideate.json file and artifactDir is the resolved artifact directory.
 * Returns null if no .ideate.json is found before reaching the filesystem root.
 *
 * @param startDir - Directory to begin searching from
 */
export function findIdeateJson(startDir: string): IdeateJsonResult | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, ".ideate.json");
    if (existsSync(candidate)) {
      try {
        const result = readIdeateJson(candidate);
        return { configPath: result.configPath, artifactDir: result.artifactDir };
      } catch (err) {
        log.warn("config", `Found .ideate.json at ${candidate} but could not read it: ${(err as Error).message}`);
        // Do not fall through to parent — a broken .ideate.json at this level is an error,
        // not a signal to keep walking up.
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Read and parse .ideate/config.json from a given directory.
 *
 * @deprecated Historical function that read from the legacy .ideate/config.json path.
 * Use readIdeateJson() instead. All production callers were migrated in WI-981;
 * this stub is retained only to avoid import errors in external/test code.
 *
 * Returns null always — the legacy .ideate/config.json path is no longer supported.
 */
export function readIdeateConfig(_dir: string): IdeateConfig | null {
  return null;
}

/**
 * Walk up the directory tree from startDir looking for a config file.
 *
 * @deprecated Historical function that walked up looking for .ideate/config.json (legacy path).
 * Internally now delegates to findIdeateJson(). Retained for caller compatibility (WI-981).
 *
 * Returns the resolved absolute path to the artifact directory, or null if not found.
 */
export function findIdeateConfig(startDir: string): string | null {
  const result = findIdeateJson(startDir);
  return result ? result.artifactDir : null;
}

/**
 * Resolve artifact_dir from tool arguments, falling back to .ideate.json discovery.
 * Throws if neither is available.
 *
 * Prefers args.artifact_dir when non-empty. Otherwise calls findIdeateJson(cwd).
 * If neither source provides a path, throws with a message directing the user
 * to create a .ideate.json file at their project root.
 */
export function resolveArtifactDir(
  args: Record<string, unknown>,
  cwd: string = process.cwd()
): string {
  if (typeof args.artifact_dir === "string" && args.artifact_dir.trim() !== "") {
    return path.resolve(args.artifact_dir.trim());
  }
  const found = findIdeateJson(cwd);
  if (found) return found.artifactDir;
  throw new Error(
    'Required argument "artifact_dir" must be provided, or place a .ideate.json file at your project root (e.g. <project-root>/.ideate.json).'
  );
}

/**
 * Create the new-style project layout under a project root directory.
 *
 * Writes `<projectRoot>/.ideate.json` with schema_version 9 and the given
 * artifact_directory field, then creates the artifact directory tree and all
 * IDEATE_SUBDIRS inside it.
 *
 * Idempotent: if `.ideate.json` already exists at projectRoot it is left
 * untouched (preserving any user modifications). The artifact directory and
 * subdirectories are still created with { recursive: true } so missing dirs
 * are filled in without error.
 *
 * Does NOT write `config.json` inside the artifact directory.
 *
 * @param projectRoot          - Directory where `.ideate.json` will be written.
 * @param config               - Optional config fields to merge into `.ideate.json`
 *                               (schema_version and artifact_directory are always
 *                               written from the function's own values; caller
 *                               supplied fields are spread on top).
 * @param artifactDirectoryName - Relative (or absolute) path for the artifact tree.
 *                               Defaults to DEFAULT_ARTIFACT_DIRECTORY (".ideate").
 *                               A leading "./" is preserved verbatim; path.resolve
 *                               is used only for creating the directory on disk.
 * @returns The absolute path to the artifact directory.
 */
export function createIdeateProject(
  projectRoot: string,
  config: Omit<IdeateConfigJson, "schema_version" | "artifact_directory"> = {},
  artifactDirectoryName: string = DEFAULT_ARTIFACT_DIRECTORY
): string {
  const resolvedRoot = path.resolve(projectRoot);
  const ideateJsonPath = path.join(resolvedRoot, ".ideate.json");

  // Idempotency: only write .ideate.json if it does not already exist.
  if (!existsSync(ideateJsonPath)) {
    const configToWrite: IdeateConfigJson = {
      schema_version: CONFIG_SCHEMA_VERSION,
      artifact_directory: artifactDirectoryName,
      ...config,
    };
    writeFileSync(ideateJsonPath, JSON.stringify(configToWrite, null, 2) + "\n", "utf8");
  }

  // Resolve the artifact directory path relative to the project root.
  const artifactDir = path.isAbsolute(artifactDirectoryName)
    ? artifactDirectoryName
    : path.resolve(resolvedRoot, artifactDirectoryName);

  mkdirSync(artifactDir, { recursive: true });

  for (const sub of IDEATE_SUBDIRS) {
    mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }

  return artifactDir;
}

/**
 * Create the .ideate/ directory structure at the given path.
 *
 * @deprecated Replaced by createIdeateProject() (WI-980/WI-981). Delegates to
 * createIdeateProject() and writes <dirPath>/.ideate.json (new canonical location).
 * Retained for test backward compatibility. New callers must use
 * createIdeateProject() directly.
 *
 * @param dirPath - Project root directory where .ideate.json will be written
 *                  and .ideate/ artifact directory will be created.
 * @param config  - Config fields to merge into .ideate.json (schema_version
 *                  and artifact_directory are always written from canonical values).
 * @returns The absolute path to the created artifact directory
 */
export function createIdeateDir(
  dirPath: string,
  config: Omit<IdeateConfigJson, "schema_version" | "artifact_directory"> & { schema_version?: number } = {}
): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { schema_version: _sv, artifact_directory: _ad, ...rest } = config as Record<string, unknown>;
  return createIdeateProject(dirPath, rest as Omit<IdeateConfigJson, "schema_version" | "artifact_directory">);
}

/**
 * Write config to <projectRoot>/.ideate.json.
 *
 * Accepts an artifact directory path (ideateDir) and writes the config to
 * the .ideate.json file one level up (at the project root). This is the
 * canonical write path for schema_version 9.
 *
 * @deprecated Legacy call-site name retained for compatibility with migrations.ts
 * and test code (WI-981). The parameter semantics changed: ideateDir is the
 * artifact directory; the actual write target is path.dirname(ideateDir)/.ideate.json.
 * Historical note: earlier versions wrote to .ideate/config.json (legacy).
 *
 * @param ideateDir - Path to the artifact directory (e.g. <project>/.ideate)
 * @param config    - Config object to write
 */
export function writeConfig(
  ideateDir: string,
  config: IdeateConfigJson
): void {
  // Prefer walking up from ideateDir to locate the existing .ideate.json. This
  // handles nested or absolute artifact_directory values (e.g., "./custom/artifacts").
  // Fall back to the default <parent>/.ideate.json when no pointer exists yet —
  // this path is only reached during first-time bootstrap before .ideate.json is written.
  const existing = findIdeateJson(ideateDir);
  const configPath = existing?.configPath ?? path.join(path.dirname(ideateDir), ".ideate.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Read the raw config from <projectRoot>/.ideate.json without applying defaults.
 * Returns only the fields actually stored in the file.
 *
 * Accepts an artifact directory path (ideateDir) and reads from the .ideate.json
 * file one level up (at the project root). Does NOT validate schema_version
 * so it is safe to call during migration when the file may be at an older version.
 *
 * @deprecated Legacy call-site name retained for compatibility with migrations.ts
 * and test code (WI-981). The parameter semantics changed: ideateDir is the
 * artifact directory; the actual read source is path.dirname(ideateDir)/.ideate.json.
 * Historical note: earlier versions read from .ideate/config.json (legacy).
 *
 * @param ideateDir - Path to the artifact directory (e.g. <project>/.ideate)
 * @returns Raw stored config, or minimal default if file is missing/invalid
 */
export function readRawConfig(ideateDir: string): IdeateConfigJson {
  // Prefer walking up from ideateDir to locate the .ideate.json pointer. This
  // handles nested or absolute artifact_directory values (e.g., "./custom/artifacts").
  // Fall back to the default <parent>/.ideate.json when findIdeateJson returns null.
  const existing = findIdeateJson(ideateDir);
  const configPath = existing?.configPath ?? path.join(path.dirname(ideateDir), ".ideate.json");
  if (!existsSync(configPath)) {
    return { schema_version: CONFIG_SCHEMA_VERSION };
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as IdeateConfigJson;
  } catch (err) {
    log.warn("config", `.ideate.json exists at ${configPath} but failed to parse: ${(err as Error).message}`);
    return { schema_version: CONFIG_SCHEMA_VERSION };
  }
}

/**
 * Read config from <projectRoot>/.ideate.json and deep-merge with defaults for
 * any missing optional fields (agent_budgets, ppr, backend).
 *
 * Accepts an artifact directory path (ideateDir) and reads from the .ideate.json
 * file one level up (at the project root). Does NOT validate schema_version.
 *
 * @deprecated Legacy call-site name retained for compatibility with tools/context.ts,
 * tools/index.ts, and test code (WI-981). The parameter semantics changed: ideateDir
 * is the artifact directory; the actual read source is path.dirname(ideateDir)/.ideate.json.
 * Historical note: earlier versions read from .ideate/config.json (legacy).
 *
 * @param ideateDir - Path to the artifact directory (e.g. <project>/.ideate)
 * @returns Config object with defaults applied for missing fields
 */
export function getConfigWithDefaults(ideateDir: string): Required<
  Pick<IdeateConfigJson, "schema_version" | "agent_budgets" | "model_overrides" | "ppr" | "circuit_breaker_threshold" | "default_appetite" | "spawn_mode" | "backend" | "artifact_directory">
> &
  Omit<IdeateConfigJson, "agent_budgets" | "model_overrides" | "ppr" | "circuit_breaker_threshold" | "default_appetite" | "spawn_mode" | "backend" | "artifact_directory"> {
  const raw: IdeateConfigJson = readRawConfig(ideateDir);

  const agent_budgets: Record<string, number> = {
    ...DEFAULT_AGENT_BUDGETS,
    ...(raw.agent_budgets ?? {}),
  };

  const rawPpr = raw.ppr ?? {};
  const ppr = {
    alpha: rawPpr.alpha ?? DEFAULT_PPR_CONFIG.alpha,
    max_iterations: rawPpr.max_iterations ?? DEFAULT_PPR_CONFIG.max_iterations,
    convergence_threshold:
      rawPpr.convergence_threshold ?? DEFAULT_PPR_CONFIG.convergence_threshold,
    edge_type_weights: {
      ...DEFAULT_PPR_CONFIG.edge_type_weights,
      ...(rawPpr.edge_type_weights ?? {}),
    },
    default_token_budget:
      rawPpr.default_token_budget ?? DEFAULT_PPR_CONFIG.default_token_budget,
    max_hops: rawPpr.max_hops ?? DEFAULT_PPR_CONFIG.max_hops,
  };

  const model_overrides: Record<string, string> = {
    ...(raw.model_overrides ?? {}),
  };

  const circuit_breaker_threshold =
    raw.circuit_breaker_threshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;

  const default_appetite = raw.default_appetite ?? DEFAULT_APPETITE;
  const spawn_mode = raw.spawn_mode ?? DEFAULT_SPAWN_MODE;
  const backend = raw.backend ?? DEFAULT_BACKEND;
  const artifact_directory = raw.artifact_directory ?? DEFAULT_ARTIFACT_DIRECTORY;

  return {
    ...raw,
    agent_budgets,
    model_overrides,
    ppr,
    circuit_breaker_threshold,
    default_appetite,
    spawn_mode,
    backend,
    artifact_directory,
  };
}
