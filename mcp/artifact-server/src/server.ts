/**
 * server.ts — Extracted server initialization and dormant-mode logic.
 *
 * This module owns the ServerState lifecycle:
 *   - openDatabase(dir) creates + configures a SQLite DB
 *   - initServer(dir) opens DB, rebuilds index, starts watcher, returns ServerState
 *   - handleBootstrapDormant(state, args) creates .ideate/, triggers lazy init
 *   - routeToolCall(state, name, args, handleTool) routes MCP calls with dormant guards
 *
 * index.ts imports from here and wires to MCP transport.
 * Tests import from here without triggering MCP side effects.
 */

import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import type { ToolContext } from "./types.js";
import type { StorageAdapter } from "./adapter.js";
import { LocalAdapter } from "./adapters/local/index.js";
import { RemoteAdapter } from "./adapters/remote/index.js";
import { ValidatingAdapter } from "./validating.js";
import { signalIndexReady } from "./tools/index.js";
import { artifactWatcher, BatchChangeEvent } from "./watcher.js";
import { createIdeateProject, DEFAULT_ARTIFACT_DIRECTORY, IDEATE_SUBDIRS, IdeateConfigJson, resolveArtifactDir, findIdeateJson, readRawConfig } from "./config.js";
import { createSchema, checkSchemaVersion } from "./schema.js";
import { rebuildIndex, RebuildStats } from "./indexer.js";
import { runPendingMigrations } from "./migrations.js";
import { runV4Migration } from "./adapters/local/migrations/v4-add-codebase-id.js";
import { resolveDefaultScope } from "./default-scope-resolver.js";
import * as dbSchema from "./db.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// Startup build-stamp — emitted once when this module is first loaded.
// Helps diagnose stale-require.cache incidents: the timestamp shows whether
// the running process picked up the latest dist/ build.
// See docs/deployment-notes.md for details on the 2026-04-16 incident.
// ---------------------------------------------------------------------------

(function logBuildStamp() {
  try {
    const serverPath = fileURLToPath(import.meta.url);
    const mtime = fs.statSync(serverPath).mtime.toISOString();
    log.info("ideate-mcp", `build timestamp=${mtime} source=${serverPath}`);
  } catch {
    // Non-fatal: if stat fails (e.g., in-memory test environments), skip.
    log.info("ideate-mcp", "build timestamp=unknown source=unknown");
  }
})();

// ---------------------------------------------------------------------------
// ServerState — testable value object instead of module-level mutable vars
// ---------------------------------------------------------------------------

export interface ServerState {
  ctx: ToolContext | null;
  ideateDir: string | null;
  db: InstanceType<typeof Database> | null;
}

/**
 * Create a fresh dormant ServerState (all null).
 */
export function createDormantState(): ServerState {
  return { ctx: null, ideateDir: null, db: null };
}

// ---------------------------------------------------------------------------
// selectAdapter — choose backend based on config.backend
// ---------------------------------------------------------------------------

/**
 * Select and construct the appropriate StorageAdapter based on config.backend.
 *
 * - "local" (default): constructs a LocalAdapter backed by SQLite. Requires
 *   `db` and `drizzleDb` to be provided.
 * - "remote": constructs a RemoteAdapter using config.remote. Does not use
 *   `db` or `drizzleDb`.
 *
 * @param dir - Path to the .ideate/ directory (used to read config)
 * @param db - Open SQLite database instance (required for local backend)
 * @param drizzleDb - Drizzle ORM wrapper (required for local backend)
 * @throws {Error} when remote config is missing required fields, or backend is unknown
 */
export function selectAdapter(
  dir: string,
  db?: InstanceType<typeof Database>,
  drizzleDb?: BetterSQLite3Database<typeof dbSchema>
): StorageAdapter {
  const config = readRawConfig(dir);
  const backend = config.backend ?? "local";

  if (backend === "local" || backend === undefined) {
    if (!db || !drizzleDb) throw new Error("Local backend requires db and drizzleDb");
    // Resolve default scope (org_id, codebase_id) from config or cwd heuristic.
    // This runs once at startup and the result is cached on the adapter instance.
    const default_scope = resolveDefaultScope(config);
    log.info("server", `resolved default scope: org_id=${default_scope.org_id} codebase_id=${default_scope.codebase_id}`);
    return new LocalAdapter({ db, drizzleDb, ideateDir: dir, default_scope });
  }

  if (backend === "remote") {
    const remoteConfig = config.remote;
    if (!remoteConfig || !remoteConfig.endpoint) {
      throw new Error("Remote backend requires 'remote.endpoint' in .ideate.json");
    }
    return new RemoteAdapter(remoteConfig);
  }

  throw new Error(
    `Unknown backend "${backend}". Valid values are "local" or "remote".`
  );
}

// ---------------------------------------------------------------------------
// readTelemetryContext — source session_id, cycle, phase from best-available
// authority at server startup.
//
// - session_id: a UUID generated fresh for each server process startup. Stable
//   for the lifetime of this MCP server process.
// - cycle: read from autopilot-state.yaml (last_cycle), or null if absent.
// - phase: read from autopilot-state.yaml (last_phase), or null if absent.
// ---------------------------------------------------------------------------

export interface TelemetryContext {
  session_id: string;
  cycle: number | null;
  phase: string | null;
}

export function readTelemetryContext(dir: string): TelemetryContext {
  const session_id = crypto.randomUUID();

  const statePath = path.join(dir, "autopilot-state.yaml");
  let cycle: number | null = null;
  let phase: string | null = null;

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") {
      if (typeof parsed["last_cycle"] === "number") {
        cycle = parsed["last_cycle"] as number;
      }
      if (typeof parsed["last_phase"] === "string") {
        phase = parsed["last_phase"] as string;
      }
    }
  } catch {
    // autopilot-state.yaml absent or unreadable — leave cycle/phase null
  }

  return { session_id, cycle, phase };
}

// ---------------------------------------------------------------------------
// openDatabase — create + configure a SQLite DB in the given directory
// ---------------------------------------------------------------------------

function configurePragmas(db: InstanceType<typeof Database>): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
}

export function openDatabase(dir: string): InstanceType<typeof Database> {
  const dbPath = path.join(dir, "index.db");
  let newDb = new Database(dbPath);
  configurePragmas(newDb);
  if (!checkSchemaVersion(newDb, dbPath)) {
    // DB was stale — reopen fresh
    newDb = new Database(dbPath);
    configurePragmas(newDb);
  }
  try {
    createSchema(newDb);
    // Run the v4 local adapter migration (adds org_id + codebase_id scoping columns).
    // Idempotent: no-op if columns already exist (fresh DB born v4 via createSchema).
    // This covers the upgrade path: existing v3 DBs get the columns + backfill on
    // first server startup after this version is deployed.
    runV4Migration(newDb);
  } catch (err) {
    newDb.close();
    throw err;
  }
  return newDb;
}

// ---------------------------------------------------------------------------
// initServer — open DB, create schema, rebuild index, start watcher
// ---------------------------------------------------------------------------

const watchedDirs = new Set<string>();

export function initServer(dir: string, state: ServerState): void {
  // P-120: Warn when the resolved artifact_directory path does not exist on disk.
  // The server continues with an empty index — this is informational only.
  if (!fs.existsSync(dir)) {
    log.warn("server", `artifact_directory '${dir}' does not exist — starting with empty index`);
    // Create the directory so subsequent startup steps (openDatabase, rebuildIndex)
    // proceed normally without crashing.
    fs.mkdirSync(dir, { recursive: true });
  }

  // Run pending migrations before opening the database.
  // Migrations may transform YAML files, .ideate.json, or directory structure.
  // They run against the artifact directory (dir), not the SQLite index.
  const migrationResult = runPendingMigrations(dir);
  if (migrationResult.migrationsRun > 0) {
    log.info("server", `${migrationResult.migrationsRun} migration(s) applied (v${migrationResult.fromVersion} → v${migrationResult.toVersion})`);
  }
  if (migrationResult.errors.length > 0) {
    log.error("server", `Migration errors: ${migrationResult.errors.join("; ")}`);
  }

  // Read backend before opening DB so we can skip SQLite entirely for remote.
  const rawConfig = readRawConfig(dir);
  const backend = rawConfig.backend ?? "local";

  if (backend === "remote") {
    // Remote path: skip openDatabase, drizzle, rebuildIndex, and file watcher.
    // The RemoteAdapter communicates with a remote server; no local SQLite needed.
    const rawAdapter = selectAdapter(dir);
    const adapter = new ValidatingAdapter(rawAdapter);

    const telemetry = readTelemetryContext(dir);

    state.ideateDir = dir;
    state.db = null;
    // db and drizzleDb are intentionally absent for remote backend.
    // Production tool code routes through adapter only and does not access ctx.db.
    state.ctx = {
      ideateDir: dir,
      adapter,
      session_id: telemetry.session_id,
      cycle: telemetry.cycle,
      phase: telemetry.phase,
    };

    signalIndexReady();
    log.info("server", "initialized (remote backend, no local index)");
    return;
  }

  // Local path: use locals so server state is only committed after full success.
  const newDb = openDatabase(dir);
  let newDrizzle;
  let stats: RebuildStats;
  try {
    newDrizzle = drizzle(newDb, { schema: dbSchema });
    stats = rebuildIndex(newDb, newDrizzle, dir);
  } catch (err) {
    newDb.close();
    throw err;
  }

  // Select adapter based on config.backend, then wrap in validation layer.
  const rawAdapter = selectAdapter(dir, newDb, newDrizzle);
  const adapter = new ValidatingAdapter(rawAdapter);

  const telemetry = readTelemetryContext(dir);

  // Commit state
  state.ideateDir = dir;
  state.db = newDb;
  state.ctx = {
    db: newDb,
    drizzleDb: newDrizzle,
    ideateDir: dir,
    adapter,
    session_id: telemetry.session_id,
    cycle: telemetry.cycle,
    phase: telemetry.phase,
  };

  signalIndexReady();
  log.info("server", `initialized, ${stats.files_scanned} files indexed`);

  // File watcher: incrementally index changed files (guard against duplicate listeners)
  artifactWatcher.watch(dir);
  if (!watchedDirs.has(dir)) {
    watchedDirs.add(dir);
    artifactWatcher.on("change", (event: BatchChangeEvent) => {
      try {
        if (!state.ctx || !state.ctx.adapter) return;
        if (event.artifactDir !== dir) return;
        const yamlChanged = event.changed.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        const yamlDeleted = event.deleted.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        if (yamlChanged.length > 0) {
          state.ctx.adapter.indexFiles(yamlChanged).catch(err => log.error("watcher", "indexFiles failed", err));
        }
        if (yamlDeleted.length > 0) {
          state.ctx.adapter.removeFiles(yamlDeleted).catch(err => log.error("watcher", "removeFiles failed", err));
        }
      } catch (err) {
        log.error("watcher", "incremental index failed", err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// handleBootstrapDormant — create .ideate/ and lazily initialize
// ---------------------------------------------------------------------------

function buildBootstrapResponse(warning?: string): string {
  const result: Record<string, unknown> = { status: "initialized", subdirectories: [...IDEATE_SUBDIRS] };
  if (warning) result.warning = warning;
  return JSON.stringify(result, null, 2);
}

function tryInitServer(dir: string, state: ServerState): string | null {
  if (state.ctx) return null;
  try {
    initServer(dir, state);
    return null;
  } catch (err) {
    const msg = (err as Error).message;
    log.error("server", `Late initialization failed: ${msg}`);
    return `DB initialization failed: ${msg}. Server is still dormant.`;
  }
}

export function handleBootstrapDormant(
  state: ServerState,
  args: Record<string, unknown>,
  cwd?: string
): string {
  const projectRoot = cwd ?? process.cwd();
  const existingResult = findIdeateJson(projectRoot);

  if (existingResult) {
    const warning = tryInitServer(existingResult.artifactDir, state);
    return buildBootstrapResponse(warning ?? undefined);
  }

  // No existing .ideate.json — create fresh
  const projectName = args.project_name as string | undefined;
  const artifactDirectoryName =
    typeof args.artifact_directory_name === "string" && args.artifact_directory_name.trim() !== ""
      ? args.artifact_directory_name.trim()
      : DEFAULT_ARTIFACT_DIRECTORY;
  const config: Partial<IdeateConfigJson> = {};
  if (projectName) config.project_name = projectName;

  const ideateDir = createIdeateProject(projectRoot, config, artifactDirectoryName);
  const warning = tryInitServer(ideateDir, state);
  return buildBootstrapResponse(warning ?? undefined);
}

// ---------------------------------------------------------------------------
// routeToolCall — dormant-aware routing extracted from index.ts
// ---------------------------------------------------------------------------

export type ToolCallResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

export type HandleToolFn = (
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
) => Promise<string>;

/**
 * Route an MCP tool call with dormant-mode guards.
 * This is the production routing logic, testable without MCP transport.
 */
export async function routeToolCall(
  state: ServerState,
  name: string,
  args: Record<string, unknown>,
  handleToolFn: HandleToolFn
): Promise<ToolCallResult> {
  // --- Dormant-safe tools: handle before requiring full ctx ---

  if (name === "ideate_bootstrap_workspace") {
    if (state.ctx) {
      const result = await handleToolFn(state.ctx, name, args);
      return { content: [{ type: "text", text: result }] };
    }
    try {
      const result = handleBootstrapDormant(state, args);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: Bootstrap failed: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === "ideate_get_workspace_status" && !state.ctx) {
    // Lazy recovery: retry artifact dir resolution before reporting dormant
    try {
      const dir = resolveArtifactDir({});
      initServer(dir, state);
      log.info("server", `Lazy initialization succeeded: ${dir}`);
      // Fall through to normal handling now that ctx is set
    } catch {
      const result = JSON.stringify({
        status: "not_initialized",
        message: "No .ideate/ directory found. Run /ideate:init to initialize the project.",
      }, null, 2);
      return { content: [{ type: "text", text: result }] };
    }
  }

  // --- All other tools require full initialization ---

  if (!state.ctx) {
    // Lazy recovery: retry artifact dir resolution before giving up
    try {
      const dir = resolveArtifactDir({});
      initServer(dir, state);
      log.info("server", `Lazy initialization succeeded: ${dir}`);
    } catch {
      return {
        content: [{ type: "text", text: "Error: Project not initialized. Run /ideate:init to set up the .ideate/ directory." }],
        isError: true,
      };
    }
  }

  const result = await handleToolFn(state.ctx!, name, args);
  return { content: [{ type: "text", text: result }] };
}
