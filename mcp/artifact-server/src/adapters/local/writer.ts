/**
 * writer.ts — LocalAdapter write operations.
 *
 * Extracted storage logic from tools/write.ts. Implements the write-side of
 * the StorageAdapter interface: putNode, patchNode, deleteNode, putEdge,
 * removeEdges, batchMutate, archiveCycle, nextId, appendJournalEntry.
 *
 *   appendJournalEntry — three-phase journal write (reserve → YAML → finalize) preserving P-44 compliance
 *
 * P-44 two-phase write pattern (YAML first, SQLite second) is preserved for all
 * write operations and is invisible to tool handlers. Tool handlers call adapter
 * methods; storage details (YAML I/O, SQLite upserts, rollback) are encapsulated
 * in this module. appendJournalEntry uses a three-phase pattern (exclusive tx to
 * reserve a sequence-number slot, YAML write outside any transaction, exclusive tx
 * to finalize) to satisfy P-44 while preventing sequence-number collisions.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type Database from "better-sqlite3";
import { eq, and } from "drizzle-orm";
import { detectCycles } from "../../indexer.js";
import { estimateTokens } from "../../token-utils.js";
import * as dbSchema from "../../db.js";
import {
  type DrizzleDb,
  type NodeRow,
  type JournalEntryRow,
  type WorkItemRow,
  upsertNode,
  upsertWorkItem,
  upsertJournalEntry,
  upsertExtensionRow,
  insertEdge,
  computeArtifactHash,
} from "../../db-helpers.js";
import type {
  MutateNodeInput,
  MutateNodeResult,
  UpdateNodeInput,
  UpdateNodeResult,
  DeleteNodeResult,
  Edge,
  EdgeType,
  BatchMutateInput,
  BatchMutateResult,
  NodeType,
  ArtifactScope,
} from "../../adapter.js";
import { ValidationError, StorageAdapterError } from "../../adapter.js";
import { CYCLE_SCOPED_TYPES } from "../../validating.js";
import { log } from "../../logger.js";
import { NODE_TYPE_REGISTRY } from "../../node-type-registry.js";
import { hasV4ScopingColumns } from "../../schema.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// resolveArtifactPath — determine output path for an artifact
// ---------------------------------------------------------------------------

export function resolveArtifactPath(ideateDir: string, type: string, id: string, cycle?: number): string {
  if (CYCLE_SCOPED_TYPES.has(type as NodeType)) {
    if (cycle === undefined || cycle === null) {
      throw new Error(`Type '${type}' requires a cycle parameter`);
    }
    const paddedCycle = String(cycle).padStart(3, "0");
    if (type === "finding") {
      return path.join(ideateDir, "cycles", paddedCycle, "findings", `${id}.yaml`);
    }
    if (type === "proxy_human_decision") {
      return path.join(ideateDir, "cycles", paddedCycle, "proxy-human", `${id}.yaml`);
    }
    return path.join(ideateDir, "cycles", paddedCycle, `${id}.yaml`);
  }

  switch (type) {
    case "overview":
    case "execution_strategy":
    case "architecture":
      return path.join(ideateDir, "plan", `${id}.yaml`);
    case "guiding_principles":
    case "constraints":
      return path.join(ideateDir, "steering", `${id}.yaml`);
    case "guiding_principle":
      return path.join(ideateDir, "principles", `${id}.yaml`);
    case "constraint":
      return path.join(ideateDir, "constraints", `${id}.yaml`);
    case "domain_policy":
      return path.join(ideateDir, "policies", `${id}.yaml`);
    case "domain_decision":
      return path.join(ideateDir, "decisions", `${id}.yaml`);
    case "domain_question":
      return path.join(ideateDir, "questions", `${id}.yaml`);
    case "domain_index":
      return path.join(ideateDir, "domains", "index.yaml");
    case "module_spec":
      return path.join(ideateDir, "modules", `${id}.yaml`);
    case "research_finding":
      return path.join(ideateDir, "research", `${id}.yaml`);
    case "interview_question":
      return path.join(ideateDir, "interviews", `${id}.yaml`);
    case "interview":
      return path.join(ideateDir, "interviews", `${id}.yaml`);
    case "research":
      return path.join(ideateDir, "steering", "research", `${id}.yaml`);
    case "project":
      return path.join(ideateDir, "projects", `${id}.yaml`);
    case "phase":
      return path.join(ideateDir, "phases", `${id}.yaml`);
    case "work_item":
      return path.join(ideateDir, "work-items", `${id}.yaml`);
    default:
      return path.join(ideateDir, type, `${id}.yaml`);
  }
}

// ---------------------------------------------------------------------------
// Type-specific SQLite upsert dispatch — registry-driven
//
// Replaces the former 390-line if/else chain.  Each node type's buildRow
// function lives in NODE_TYPE_REGISTRY (node-type-registry.ts); this function
// is purely dispatch + edge side-effects.
// ---------------------------------------------------------------------------

function upsertExtensionTableRow(
  drizzleDb: DrizzleDb,
  type: string,
  id: string,
  content: Record<string, unknown>,
  cycleForNode: number | null
): void {
  const spec = NODE_TYPE_REGISTRY[type as keyof typeof NODE_TYPE_REGISTRY];
  if (!spec || !spec.extensionTableName) {
    // Types without an extension table (e.g. autopilot_state) — no upsert needed.
    return;
  }

  const row = spec.buildRow(content, cycleForNode);
  if (row === null) return;

  upsertExtensionRow(drizzleDb, spec.extensionTableName, id, row);

  // Edge side-effects for types that embed relationship arrays in YAML.
  // These mirror the edge-insertion logic the old if/else chain performed inline.
  if (type === "work_item") {
    if (content.depends && Array.isArray(content.depends)) {
      for (const dep of content.depends as string[]) {
        insertEdge(drizzleDb, { source_id: id, target_id: dep, edge_type: "depends_on", props: null });
      }
    }
    if (content.blocks && Array.isArray(content.blocks)) {
      for (const blocked of content.blocks as string[]) {
        insertEdge(drizzleDb, { source_id: id, target_id: blocked, edge_type: "blocks", props: null });
      }
    }
  } else if (type === "proxy_human_decision") {
    if (content.triggered_by && Array.isArray(content.triggered_by)) {
      for (const ref of content.triggered_by as Array<{ type: string; id: string }>) {
        if (ref && ref.id) {
          insertEdge(drizzleDb, { source_id: id, target_id: ref.id, edge_type: "triggered_by", props: null });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LocalWriterAdapter — implements write-side StorageAdapter methods
// ---------------------------------------------------------------------------

export interface LocalWriterConfig {
  db: Database.Database;
  drizzleDb: DrizzleDb;
  ideateDir: string;
  /**
   * Default scope (org_id, codebase_id) resolved at startup via
   * resolveDefaultScope(). When present, write operations use this scope
   * to populate org_id/codebase_id columns if the schema has been migrated
   * to v4 (columns exist). When absent, writes proceed without scoping
   * (backward compatibility for pre-v4 schemas).
   */
  default_scope?: ArtifactScope;
}

export class LocalWriterAdapter {
  protected db: Database.Database;
  protected drizzleDb: DrizzleDb;
  protected ideateDir: string;
  /** Default scope resolved at startup. Null = no scoping (pre-v4 schema). */
  protected defaultScope: ArtifactScope | null;

  /** Cached current cycle number from domains/index.yaml */
  private _cachedCycleNumber: number | null = null;
  /** mtime (ms) of domains/index.yaml at last cache fill */
  private _cycleCacheMtime: number = 0;

  /** Set to true after shutdown(); mutating methods check this guard. */
  protected _isShutDown = false;

  constructor(config: LocalWriterConfig) {
    this.db = config.db;
    this.drizzleDb = config.drizzleDb;
    this.ideateDir = config.ideateDir;
    this.defaultScope = config.default_scope ?? null;
  }

  // -------------------------------------------------------------------------
  // Shutdown guard helpers
  // -------------------------------------------------------------------------

  private assertNotShutDown(): void {
    if (this._isShutDown) {
      throw new StorageAdapterError("adapter shut down", "ADAPTER_SHUT_DOWN");
    }
  }

  // -------------------------------------------------------------------------
  // Scope helpers (v4 migration)
  // -------------------------------------------------------------------------

  /**
   * Validate that a write can proceed given the current scope configuration.
   * Throws a descriptive error when the DB has v4 scoping columns but no
   * default scope has been configured (no silent fallback for writes).
   */
  protected assertScopeForWrite(): void {
    if (this.defaultScope !== null) return; // Scope configured — OK
    if (hasV4ScopingColumns(this.db)) {
      throw new StorageAdapterError(
        "LocalAdapter write requires org_id + codebase_id scope but none is configured. " +
        "Set default_scope when constructing LocalAdapter after running the v4 migration, " +
        "or run resolveDefaultScope() and pass the result as default_scope.",
        "MISSING_SCOPE"
      );
    }
    // Pre-v4 schema — no scoping columns, proceed as before
  }

  /**
   * Stamp a written node row with org_id and codebase_id.
   * Called inside the existing SQLite transaction after upsertNode.
   * No-op when v4 columns are not present or defaultScope is null.
   */
  protected stampScope(id: string): void {
    if (this.defaultScope === null) return;
    if (!hasV4ScopingColumns(this.db)) return;
    this.db
      .prepare(`UPDATE nodes SET org_id = ?, codebase_id = ? WHERE id = ?`)
      .run(this.defaultScope.org_id, this.defaultScope.codebase_id, id);
  }

  /** Called by LocalAdapter.shutdown() to flip the writer's shutdown flag. */
  _markShutDown(): void {
    this._isShutDown = true;
  }

  // -------------------------------------------------------------------------
  // nextId — generate the next available ID for a given node type
  // -------------------------------------------------------------------------

  async nextId(type: NodeType, cycle?: number): Promise<string> {
    // Validate cycle parameter: must be non-negative integer if provided
    if (cycle !== undefined) {
      if (!Number.isInteger(cycle)) {
        throw new ValidationError(
          `Cycle must be an integer, received ${typeof cycle}`,
          "INVALID_CYCLE",
          { value: cycle }
        );
      }
      if (cycle < 0) {
        throw new ValidationError(
          `Cycle must be a non-negative integer, received ${cycle}`,
          "INVALID_CYCLE",
          { value: cycle }
        );
      }
    }

    if (type === "journal_entry") {
      // Journal entries: J-{cycleStr}-{seqStr}
      const cycleNum = cycle ?? 0;
      const cycleStr = String(cycleNum).padStart(3, "0");
      // Use MAX+1 strategy (not COUNT) to handle gaps from deleted entries
      const maxRow = this.db.prepare(
        `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num FROM nodes WHERE id LIKE ?`
      ).get(`J-${cycleStr}-`.length + 1, `J-${cycleStr}-%`) as { max_num: number | null };
      const seq = (maxRow?.max_num ?? 0) + 1;
      return `J-${cycleStr}-${String(seq).padStart(3, "0")}`;
    }

    if (type === "work_item") {
      const maxIdRow = this.db.prepare(
        `SELECT MAX(CAST(REPLACE(n.id, 'WI-', '') AS INTEGER)) as max_id FROM nodes n WHERE n.type = 'work_item'`
      ).get() as { max_id: number | null };
      const next = (maxIdRow?.max_id ?? 0) + 1;
      return `WI-${String(next).padStart(3, "0")}`;
    }

    if (type === "finding") {
      const cycleNum = cycle ?? 0;
      const cycleStr = String(cycleNum).padStart(3, "0");
      // Use MAX+1 strategy (not COUNT) to handle gaps from deleted entries
      const maxRow = this.db.prepare(
        `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num FROM nodes WHERE id LIKE ?`
      ).get(`F-${cycleStr}-`.length + 1, `F-${cycleStr}-%`) as { max_num: number | null };
      const seq = (maxRow?.max_num ?? 0) + 1;
      return `F-${cycleStr}-${String(seq).padStart(3, "0")}`;
    }

    // For all other types, raise an error — ID generation is type-specific
    throw new ValidationError(
      `nextId: no ID format defined for type '${type}'`,
      "INVALID_NODE_TYPE",
      { value: type }
    );
  }

  // -------------------------------------------------------------------------
  // putNode — create or replace a node (two-phase write)
  // -------------------------------------------------------------------------

  async putNode(input: MutateNodeInput): Promise<MutateNodeResult> {
    this.assertNotShutDown();
    this.assertScopeForWrite();
    const { id, type, properties: content, cycle } = input;

    // Determine output path
    const absoluteFilePath = resolveArtifactPath(this.ideateDir, type, id, cycle);
    ensureDir(path.dirname(absoluteFilePath));

    // Build YAML object: merge content with id and type
    const yamlObj: Record<string, unknown> = {
      id,
      type,
      ...content,
    };
    if (cycle !== undefined && !("cycle" in yamlObj)) {
      yamlObj.cycle = cycle;
    }

    // Apply defaults for work_item type (match server behavior)
    if (type === "work_item") {
      if (!yamlObj.work_item_type) {
        yamlObj.work_item_type = "feature";
      }
    }

    // Determine current cycle for cycle_modified (same logic as patchNode)
    let cycleNumber: number | null = null;
    try {
      const indexYamlPath = path.join(this.ideateDir, "domains", "index.yaml");
      const indexMdPath = path.join(this.ideateDir, "domains", "index.md");
      let indexPath: string | null = null;
      if (fs.existsSync(indexYamlPath)) {
        indexPath = indexYamlPath;
      } else if (fs.existsSync(indexMdPath)) {
        indexPath = indexMdPath;
      }
      if (indexPath) {
        const indexContent = fs.readFileSync(indexPath, "utf8");
        const match = indexContent.match(/^current_cycle:\s*(\d+)/m);
        cycleNumber = match ? parseInt(match[1], 10) : null;
      }
    } catch {
      // cycle_modified remains null if index cannot be read
    }
    yamlObj.cycle_modified = cycleNumber;

    // Compute hash over content fields only
    const contentHash = computeArtifactHash(yamlObj);
    const yamlForTokens = stringifyYaml(yamlObj, { lineWidth: 0 });
    const tokens = estimateTokens(yamlForTokens);

    // Add computed fields (no file_path in YAML)
    yamlObj.content_hash = contentHash;
    yamlObj.token_count = tokens;

    // Determine if this is a create or update
    const existingRow = this.db.prepare(
      `SELECT id, file_path FROM nodes WHERE id = ?`
    ).get(id) as { id: string; file_path: string } | undefined;
    const isUpdate = existingRow !== undefined;

    // For updates: read existing YAML and merge with new properties
    let finalYamlObj = yamlObj;
    let originalContent: string | null = null;
    if (isUpdate && fs.existsSync(existingRow.file_path)) {
      try {
        const existingContent = fs.readFileSync(existingRow.file_path, "utf8");
        originalContent = existingContent;
        const existingObj = parseYaml(existingContent) as Record<string, unknown>;
        // Merge: existing values + new values (new wins for provided fields)
        finalYamlObj = { ...existingObj, ...yamlObj };
        // Recompute hash and tokens for merged content
        const mergedContentHash = computeArtifactHash(finalYamlObj);
        const mergedYamlForTokens = stringifyYaml(finalYamlObj, { lineWidth: 0 });
        const mergedTokens = estimateTokens(mergedYamlForTokens);
        finalYamlObj.content_hash = mergedContentHash;
        finalYamlObj.token_count = mergedTokens;
      } catch {
        // If read/parse fails, use the new yamlObj as-is
      }
    }

    const finalYaml = stringifyYaml(finalYamlObj, { lineWidth: 0 });

    // Phase 1 — Write the YAML file (source of truth)
    fs.writeFileSync(absoluteFilePath, finalYaml, "utf8");

    // Phase 2 — SQLite upserts in a single exclusive transaction
    const cycleForNode = CYCLE_SCOPED_TYPES.has(type as NodeType) && cycle !== undefined
      ? cycle
      : (finalYamlObj.cycle_created as number | null) ?? null;
    const finalCycleModified = finalYamlObj.cycle_modified as number | null;
    const finalContentHash = finalYamlObj.content_hash as string;
    const finalTokenCount = finalYamlObj.token_count as number;

    // Build extension content from finalYamlObj (for work_item extension table)
    const extensionContent: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(finalYamlObj)) {
      // Skip metadata fields, keep user-visible properties
      if (!["id", "type", "content_hash", "token_count", "file_path"].includes(k)) {
        extensionContent[k] = v;
      }
    }

    try {
      const upsertPhase = this.db.transaction(() => {
        const nodeRow: NodeRow = {
          id,
          type,
          cycle_created: cycleForNode,
          cycle_modified: finalCycleModified,
          content_hash: finalContentHash,
          token_count: finalTokenCount,
          file_path: absoluteFilePath,
          status: (finalYamlObj.status as string | null) ?? null,
        };

        upsertNode(this.drizzleDb, nodeRow);
        upsertExtensionTableRow(this.drizzleDb, type, id, extensionContent, cycleForNode);
        this.stampScope(id);
      });
      upsertPhase.exclusive();
    } catch (dbErr) {
      // SQLite transaction failed — roll back the YAML file
      try {
        if (isUpdate && originalContent !== null) {
          // Restore the original content for updates
          fs.writeFileSync(absoluteFilePath, originalContent, "utf8");
        } else {
          // New insert, or update where original read failed — remove newly written file
          if (fs.existsSync(absoluteFilePath)) fs.unlinkSync(absoluteFilePath);
        }
      } catch (cleanupErr) {
        throw new ValidationError(
          `operation failed: ${(dbErr as Error).message}; cleanup also failed: ${(cleanupErr as Error).message}`,
          "TRANSACTION_FAILED",
          { operation: "putNode", id, filePath: absoluteFilePath }
        );
      }
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "putNode", id, filePath: absoluteFilePath }
      );
    }

    return { id, status: isUpdate ? "updated" : "created" };
  }

  // -------------------------------------------------------------------------
  // patchNode — partially update an existing node's properties
  // -------------------------------------------------------------------------

  async patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult> {
    this.assertNotShutDown();
    this.assertScopeForWrite();
    const { id, properties } = input;

    // Determine file path for work items (only work_item type supports patchNode for now)
    // Find the node's file_path from the index
    const nodeRow = this.db.prepare(
      `SELECT file_path, type, cycle_created, status FROM nodes WHERE id = ?`
    ).get(id) as { file_path: string; type: string; cycle_created: number | null; status: string | null } | undefined;

    if (!nodeRow) {
      return { id, status: "not_found" };
    }

    const filePath = nodeRow.file_path;

    // Read and parse existing YAML.
    // Filesystem errors (ENOENT, EACCES, etc.) during the read phase are treated
    // as "not_found" — they are a pre-condition failure, not a DB/transaction
    // failure.  This ensures callers (handleUpdateWorkItems) can add the item to
    // the per-item failures list without re-throwing, preserving the original
    // behavior where filesystem errors are surfaced as item-level failures.
    if (!fs.existsSync(filePath)) {
      return { id, status: "not_found" };
    }

    let existingContent: string;
    try {
      existingContent = fs.readFileSync(filePath, "utf8");
    } catch {
      return { id, status: "not_found" };
    }
    const existingObj = parseYaml(existingContent) as Record<string, unknown>;

    // Determine current cycle for cycle_modified (cached to avoid re-reading on every call)
    let cycleNumber: number | null = null;
    try {
      const indexYamlPath = path.join(this.ideateDir, "domains", "index.yaml");
      const indexMdPath = path.join(this.ideateDir, "domains", "index.md");
      // Check mtime of the preferred index file to decide whether the cache is stale
      let indexPath: string | null = null;
      if (fs.existsSync(indexYamlPath)) {
        indexPath = indexYamlPath;
      } else if (fs.existsSync(indexMdPath)) {
        indexPath = indexMdPath;
      }
      if (indexPath) {
        const mtime = fs.statSync(indexPath).mtimeMs;
        if (mtime !== this._cycleCacheMtime || this._cachedCycleNumber === null) {
          // Cache is stale or empty — re-read
          const indexContent = fs.readFileSync(indexPath, "utf8");
          const match = indexContent.match(/^current_cycle:\s*(\d+)/m);
          this._cachedCycleNumber = match ? parseInt(match[1], 10) : null;
          this._cycleCacheMtime = mtime;
        }
        cycleNumber = this._cachedCycleNumber;
      }
    } catch {
      // cycle_modified remains null if index cannot be read
    }

    // Merge provided fields (skip immutable fields)
    const merged: Record<string, unknown> = { ...existingObj };
    const IMMUTABLE_SET = new Set(["id", "type", "cycle_created", "file_path"]);
    for (const [field, value] of Object.entries(properties)) {
      if (!IMMUTABLE_SET.has(field)) {
        merged[field] = value;
      }
    }

    // Update cycle_modified
    merged.cycle_modified = cycleNumber;

    // Apply work_item_type default for work_item type (match server behavior)
    if (nodeRow.type === "work_item" && !merged.work_item_type) {
      merged.work_item_type = "feature";
    }

    // Recompute hash and token count
    const contentHash = computeArtifactHash(merged);
    const yamlForTokens = stringifyYaml(merged, { lineWidth: 0 });
    const tokens = estimateTokens(yamlForTokens);

    merged.content_hash = contentHash;
    merged.token_count = tokens;
    delete merged.file_path;

    // Write updated YAML back to same path (save original for rollback)
    const finalYaml = stringifyYaml(merged, { lineWidth: 0 });

    fs.writeFileSync(filePath, finalYaml, "utf8");

    // Phase 2 — SQLite upserts in exclusive transaction
    const fkWasOn = this.db.pragma("foreign_keys", { simple: true }) as number;
    if (fkWasOn) this.db.pragma("foreign_keys = OFF");

    // Precompute all values needed for the transaction from the in-memory `merged`
    // object — no filesystem reads inside the transaction callback.
    const txType = nodeRow.type;
    const txHash = contentHash;
    const txTokenCount = tokens;
    const txCycleModified = (merged.cycle_modified as number | null) ?? null;
    const txStatus = (merged.status as string | null) ?? null;
    const txMerged = merged; // reference to the already-computed object

    try {
      const upsertPhase = this.db.transaction(() => {
        const updatedNodeRow: NodeRow = {
          id,
          type: txType,
          cycle_created: nodeRow.cycle_created,
          cycle_modified: txCycleModified,
          content_hash: txHash,
          token_count: txTokenCount,
          file_path: filePath,
          status: txStatus,
        };

        upsertNode(this.drizzleDb, updatedNodeRow);

        // For work_item type, also upsert extension table and replace edges
        if (txType === "work_item") {
          // Apply defaults to match server behavior
          const workItemType = (txMerged.work_item_type as string | null) ?? "feature";

          const wiRow: WorkItemRow = {
            id,
            title: (txMerged.title as string) ?? "",
            complexity: (txMerged.complexity as string | null) ?? null,
            scope: txMerged.scope ? JSON.stringify(txMerged.scope) : null,
            depends: txMerged.depends ? JSON.stringify(txMerged.depends) : null,
            blocks: txMerged.blocks ? JSON.stringify(txMerged.blocks) : null,
            criteria: txMerged.criteria ? JSON.stringify(txMerged.criteria) : null,
            module: null,
            domain: (txMerged.domain as string | null) ?? null,
            phase: (txMerged.phase as string | null) ?? null,
            notes: (txMerged.notes as string | null) ?? null,
            work_item_type: workItemType,
            resolution: (txMerged.resolution as string | null) ?? null,
          };
          upsertWorkItem(this.drizzleDb, wiRow);

          // Delete old dependency edges for this item
          this.db.prepare(`DELETE FROM edges WHERE source_id = ? AND edge_type IN ('depends_on', 'blocks')`).run(id);

          // Insert new depends_on edges
          for (const dep of (txMerged.depends as string[] | undefined) || []) {
            this.db.prepare(`INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'depends_on')`).run(id, dep);
          }

          // Insert new blocks edges
          for (const blk of (txMerged.blocks as string[] | undefined) || []) {
            this.db.prepare(`INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'blocks')`).run(id, blk);
          }
        }
      });

      upsertPhase.exclusive();
    } catch (dbErr) {
      // SQLite transaction failed — restore original YAML content
      try {
        fs.writeFileSync(filePath, existingContent, "utf8");
      } catch (cleanupErr) {
        throw new ValidationError(
          `operation failed: ${(dbErr as Error).message}; cleanup also failed: ${(cleanupErr as Error).message}`,
          "TRANSACTION_FAILED",
          { operation: "patchNode", id, filePath }
        );
      }
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "patchNode", id, filePath }
      );
    } finally {
      if (fkWasOn) this.db.pragma("foreign_keys = ON");
    }

    return { id, status: "updated" };
  }

  // -------------------------------------------------------------------------
  // deleteNode — delete a node and its associated edges
  // -------------------------------------------------------------------------

  async deleteNode(id: string): Promise<DeleteNodeResult> {
    this.assertNotShutDown();
    this.assertScopeForWrite();
    const nodeRow = this.db.prepare(
      `SELECT file_path FROM nodes WHERE id = ?`
    ).get(id) as { file_path: string } | undefined;

    if (!nodeRow) {
      return { id, status: "not_found" };
    }

    const absoluteFilePath = nodeRow.file_path;

    // Phase 0 — Save file content so we can restore on rollback
    let originalContent: string | null = null;
    try {
      originalContent = fs.readFileSync(absoluteFilePath, 'utf-8');
    } catch {
      // File may already be missing; proceed, but rollback won't be able to restore
    }

    // Phase 1 — Remove YAML file first (YAML-first per P-44)
    try {
      fs.unlinkSync(absoluteFilePath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // File already absent — nothing to unlink, proceed
      } else {
        throw new ValidationError(
          `deleteNode failed: artifact removal failed: ${(e as Error).message}`,
          "FILESYSTEM_ERROR",
          { operation: "deleteNode", id }
        );
      }
    }

    // Phase 2 — Delete from SQLite (edges cascade or are deleted separately)
    try {
      const deleteTransaction = this.db.transaction(() => {
        this.db.prepare(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`).run(id, id);
        this.db.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
      });
      deleteTransaction.exclusive();
    } catch (err: unknown) {
      // Restore the YAML file that was already unlinked
      if (originalContent !== null) {
        try {
          fs.writeFileSync(absoluteFilePath, originalContent, 'utf-8');
        } catch (restoreErr: unknown) {
          throw new ValidationError(
            `operation failed: ${(err as Error).message}; cleanup also failed: ${(restoreErr as Error).message}`,
            "TRANSACTION_FAILED",
            { operation: "deleteNode", id }
          );
        }
      }
      throw new ValidationError(
        `operation failed: ${(err as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "deleteNode", id }
      );
    }

    return { id, status: "deleted" };
  }

  // -------------------------------------------------------------------------
  // putEdge — create an edge (idempotent)
  // -------------------------------------------------------------------------

  async putEdge(edge: Edge): Promise<void> {
    this.assertNotShutDown();
    try {
      insertEdge(this.drizzleDb, {
        source_id: edge.source_id,
        target_id: edge.target_id,
        edge_type: edge.edge_type,
        props: edge.properties && Object.keys(edge.properties).length > 0
          ? JSON.stringify(edge.properties)
          : null,
      });
    } catch (dbErr) {
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "putEdge" }
      );
    }
  }

  // -------------------------------------------------------------------------
  // removeEdges — remove all edges from a source node with specified types
  // -------------------------------------------------------------------------

  async removeEdges(source_id: string, edge_types: EdgeType[]): Promise<void> {
    this.assertNotShutDown();
    if (edge_types.length === 0) return;
    const placeholders = edge_types.map(() => "?").join(", ");
    try {
      this.db.prepare(
        `DELETE FROM edges WHERE source_id = ? AND edge_type IN (${placeholders})`
      ).run(source_id, ...edge_types);
    } catch (dbErr) {
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "removeEdges" }
      );
    }
  }

  // -------------------------------------------------------------------------
  // batchMutate — atomically create/update multiple nodes and edges
  // -------------------------------------------------------------------------

  async batchMutate(input: BatchMutateInput): Promise<BatchMutateResult> {
    this.assertNotShutDown();
    this.assertScopeForWrite();
    const { nodes, edges: extraEdges = [] } = input;
    const results: MutateNodeResult[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    // ---------- Assign IDs to nodes that don't have one ----------
    // For work_item nodes, query current max ID
    const workItemNodes = nodes.filter(n => n.type === "work_item");
    let nextWiId = 0;
    if (workItemNodes.some(n => !n.id)) {
      const maxIdRow = this.db.prepare(
        `SELECT MAX(CAST(REPLACE(n.id, 'WI-', '') AS INTEGER)) as max_id FROM nodes n WHERE n.type = 'work_item'`
      ).get() as { max_id: number | null };
      nextWiId = (maxIdRow?.max_id ?? 0) + 1;
    }

    const resolvedNodes = nodes.map((node) => {
      if (node.id) return { ...node, resolvedId: node.id };
      if (node.type === "work_item") {
        const assignedId = `WI-${String(nextWiId).padStart(3, "0")}`;
        nextWiId++;
        return { ...node, resolvedId: assignedId };
      }
      // For other types without IDs, generate one
      return { ...node, resolvedId: node.id ?? `${node.type}-${Date.now()}` };
    });

    // ---------- DAG cycle detection (for work_item nodes with depends) ----------
    const tempEdgesInserted: Array<{ source: string; target: string }> = [];
    for (const node of resolvedNodes) {
      if (node.type === "work_item" && node.properties.depends && Array.isArray(node.properties.depends)) {
        for (const dep of node.properties.depends as string[]) {
          tempEdgesInserted.push({ source: node.resolvedId, target: dep });
        }
      }
    }

    let cycles: string[][] = [];
    if (tempEdgesInserted.length > 0) {
      const fkWasOn = this.db.pragma("foreign_keys", { simple: true }) as number;
      if (fkWasOn) this.db.pragma("foreign_keys = OFF");
      try {
        this.db.exec("SAVEPOINT dag_check");
        const insertEdgeStmt = this.db.prepare(
          `INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'depends_on')`
        );
        for (const { source, target } of tempEdgesInserted) {
          insertEdgeStmt.run(source, target);
        }
        try {
          cycles = detectCycles(this.drizzleDb);
        } catch (err) {
          this.db.exec("ROLLBACK TO dag_check");
          this.db.exec("RELEASE dag_check");
          if (fkWasOn) this.db.pragma("foreign_keys = ON");
          throw new Error(`DAG validation failed: ${(err as Error).message}`);
        }
        this.db.exec("ROLLBACK TO dag_check");
        this.db.exec("RELEASE dag_check");
      } finally {
        if (fkWasOn) this.db.pragma("foreign_keys = ON");
      }
    }

    if (cycles.length > 0) {
      const cycleDesc = cycles.map((c) => c.join(" -> ")).join("; ");
      return {
        results: [],
        errors: [{ id: "*", error: `DAG cycle detected: ${cycleDesc}` }],
      };
    }

    // ---------- Scope collision detection ----------
    const workItemNodesResolved = resolvedNodes.filter(n => n.type === "work_item");
    const itemScopeMap = new Map<string, Set<string>>();
    for (const node of workItemNodesResolved) {
      const filePaths = new Set<string>();
      if (node.properties.scope && Array.isArray(node.properties.scope)) {
        for (const entry of node.properties.scope as Array<{ path: string; op: string }>) {
          if (entry.path) filePaths.add(entry.path);
        }
      }
      itemScopeMap.set(node.resolvedId, filePaths);
    }

    const dependsGraph = new Map<string, Set<string>>();
    for (const node of workItemNodesResolved) {
      const deps = new Set<string>((node.properties.depends as string[] | undefined) ?? []);
      dependsGraph.set(node.resolvedId, deps);
    }

    // Seed dependsGraph from existing SQLite depends_on edges so that items
    // linked via a pre-existing node (not in the current batch) are not
    // false-flagged as scope collisions.
    if (workItemNodesResolved.length > 0) {
      const itemIds = workItemNodesResolved.map(n => n.resolvedId);
      const edgePlaceholders = itemIds.map(() => "?").join(", ");
      const existingEdges = this.db.prepare(
        `SELECT source_id, target_id FROM edges WHERE edge_type = 'depends_on' AND (source_id IN (${edgePlaceholders}) OR target_id IN (${edgePlaceholders}))`
      ).all(...itemIds, ...itemIds) as Array<{ source_id: string; target_id: string }>;
      for (const edge of existingEdges) {
        if (!dependsGraph.has(edge.source_id)) dependsGraph.set(edge.source_id, new Set());
        dependsGraph.get(edge.source_id)!.add(edge.target_id);
      }
    }

    function isLinkedByDepends(a: string, b: string): boolean {
      function reachable(from: string, to: string): boolean {
        const visited = new Set<string>();
        const queue = [from];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current === to) return true;
          if (visited.has(current)) continue;
          visited.add(current);
          for (const dep of dependsGraph.get(current) ?? []) queue.push(dep);
        }
        return false;
      }
      return reachable(a, b) || reachable(b, a);
    }

    const collisionErrors: string[] = [];
    const itemIds = workItemNodesResolved.map(n => n.resolvedId);
    for (let i = 0; i < itemIds.length; i++) {
      for (let j = i + 1; j < itemIds.length; j++) {
        const idA = itemIds[i];
        const idB = itemIds[j];
        if (isLinkedByDepends(idA, idB)) continue;
        const scopeA = itemScopeMap.get(idA) ?? new Set();
        const scopeB = itemScopeMap.get(idB) ?? new Set();
        const shared = [...scopeA].filter(p => scopeB.has(p));
        if (shared.length > 0) {
          collisionErrors.push(`Scope collision between items ${idA} and ${idB}: ${shared.join(", ")}`);
        }
      }
    }

    if (collisionErrors.length > 0) {
      return {
        results: [],
        errors: collisionErrors.map(e => ({ id: "*", error: e })),
      };
    }

    // ---------- Phase 1: Write all YAML files and precompute index data ----------
    const writtenFilePaths: string[] = [];

    // Precomputed node row data keyed by resolvedId — populated during YAML writes
    // so the transaction callback contains only SQL upserts (no filesystem reads).
    type PrecomputedNodeData = {
      absoluteFilePath: string;
      contentHash: string;
      tokenCountVal: number;
      cycleForNode: number | null;
      yamlObj: Record<string, unknown>;
    };
    const precomputedData = new Map<string, PrecomputedNodeData>();

    for (const node of resolvedNodes) {
      const id = node.resolvedId;
      const type = node.type;
      const properties = node.properties;
      const cycle = node.cycle;

      try {
        const absoluteFilePath = resolveArtifactPath(this.ideateDir, type, id, cycle);
        ensureDir(path.dirname(absoluteFilePath));

        const yamlObj: Record<string, unknown> = {
          id,
          type,
          ...properties,
        };
        if (cycle !== undefined && !("cycle" in yamlObj)) {
          yamlObj.cycle = cycle;
        }

        const contentHash = computeArtifactHash(yamlObj);
        const yamlForTokens = stringifyYaml(yamlObj, { lineWidth: 0 });
        const tokens = estimateTokens(yamlForTokens);
        yamlObj.content_hash = contentHash;
        yamlObj.token_count = tokens;

        const cycleForNode = CYCLE_SCOPED_TYPES.has(type as NodeType) && cycle !== undefined
          ? cycle
          : (properties.cycle_created as number | null) ?? null;

        // Store precomputed data before writing to disk
        precomputedData.set(id, {
          absoluteFilePath,
          contentHash,
          tokenCountVal: tokens,
          cycleForNode,
          yamlObj,
        });

        const finalYaml = stringifyYaml(yamlObj, { lineWidth: 0 });
        fs.writeFileSync(absoluteFilePath, finalYaml, "utf8");
        writtenFilePaths.push(absoluteFilePath);
      } catch (err) {
        errors.push({ id, error: (err as Error).message });
      }
    }

    if (errors.length > 0) {
      // Clean up any YAML files written before the error
      for (const fp of writtenFilePaths) {
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
      }
      return { results: [], errors };
    }

    // ---------- Check node existence before transaction (for created/updated status) ----------
    const existingNodes = new Set<string>();
    for (const node of resolvedNodes) {
      const existingRow = this.db.prepare(
        `SELECT id FROM nodes WHERE id = ?`
      ).get(node.resolvedId) as { id: string } | undefined;
      if (existingRow) {
        existingNodes.add(node.resolvedId);
      }
    }

    // ---------- Phase 2: SQLite upserts in a single exclusive transaction ----------
    // All hash/token_count values were precomputed from the in-memory yamlObj above.
    // The transaction callback performs only SQL upserts — no filesystem reads.
    const fkWasOn = this.db.pragma("foreign_keys", { simple: true }) as number;
    if (fkWasOn) this.db.pragma("foreign_keys = OFF");

    try {
      const upsertPhase = this.db.transaction(() => {
        for (const node of resolvedNodes) {
          const id = node.resolvedId;
          const type = node.type;
          const properties = node.properties;
          const precomp = precomputedData.get(id)!;

          const nodeRow: NodeRow = {
            id,
            type,
            cycle_created: precomp.cycleForNode,
            cycle_modified: null,
            content_hash: precomp.contentHash,
            token_count: precomp.tokenCountVal,
            file_path: precomp.absoluteFilePath,
            status: (properties.status as string | null) ?? null,
          };

          upsertNode(this.drizzleDb, nodeRow);
          upsertExtensionTableRow(this.drizzleDb, type, id, properties, precomp.cycleForNode);
          this.stampScope(id);
        }

        // Insert extra edges
        for (const edge of extraEdges) {
          insertEdge(this.drizzleDb, {
            source_id: edge.source_id,
            target_id: edge.target_id,
            edge_type: edge.edge_type,
            props: edge.properties && Object.keys(edge.properties).length > 0
              ? JSON.stringify(edge.properties)
              : null,
          });
        }
      });

      upsertPhase.exclusive();
    } catch (dbErr) {
      // SQLite transaction failed — clean up written YAML files
      for (const fp of writtenFilePaths) {
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
      }
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "batchMutate", filePaths: writtenFilePaths }
      );
    } finally {
      if (fkWasOn) this.db.pragma("foreign_keys = ON");
    }

    // Build results with correct created/updated status
    for (const node of resolvedNodes) {
      const status = existingNodes.has(node.resolvedId) ? "updated" : "created";
      results.push({ id: node.resolvedId, status });
    }

    return { results, errors };
  }

  // -------------------------------------------------------------------------
  // archiveCycleLocal — atomic cycle archival (copy, verify, delete)
  //
  // Returns a formatted result string. This method is LocalAdapter-specific;
  // the StorageAdapter interface's archiveCycle() delegates here and returns
  // the result string to callers.
  // -------------------------------------------------------------------------

  async archiveCycleLocal(cycle: number): Promise<string> {
    const cycleStr = String(cycle).padStart(3, "0");
    const cycleDir = path.join(this.ideateDir, "archive", "cycles", cycleStr);
    const cycleWorkItemsDir = path.join(cycleDir, "work-items");
    const cycleIncrementalDir = path.join(cycleDir, "incremental");

    // Query SQLite for active work items with cycle_created = cycle
    // This matches the server-side behavior in lifecycle.ts archiveCycle mutation
    const activeWorkItems = this.drizzleDb
      .select({
        id: dbSchema.nodes.id,
        file_path: dbSchema.nodes.file_path,
      })
      .from(dbSchema.nodes)
      .where(
        and(
          eq(dbSchema.nodes.cycle_created, cycle),
          eq(dbSchema.nodes.type, "work_item"),
          eq(dbSchema.nodes.status, "active")
        )
      )
      .all();

    // Query SQLite for active findings with cycle = cycle
    // Findings use the 'cycle' field in the findings table, not cycle_created
    const activeFindings = this.drizzleDb
      .select({
        id: dbSchema.nodes.id,
        file_path: dbSchema.nodes.file_path,
      })
      .from(dbSchema.nodes)
      .innerJoin(dbSchema.findings, eq(dbSchema.nodes.id, dbSchema.findings.id))
      .where(
        and(
          eq(dbSchema.findings.cycle, cycle),
          eq(dbSchema.nodes.type, "finding"),
          eq(dbSchema.nodes.status, "active")
        )
      )
      .all();

    // Build file lists from database queries (no filesystem fallback)
    // This ensures parity with the RemoteAdapter/server behavior
    const incrementalFiles: string[] = [];
    for (const finding of activeFindings) {
      if (finding.file_path && fs.existsSync(finding.file_path)) {
        incrementalFiles.push(finding.file_path);
      }
    }

    const workItemFiles: { src: string; name: string }[] = [];
    for (const wi of activeWorkItems) {
      if (wi.file_path && fs.existsSync(wi.file_path)) {
        workItemFiles.push({ src: wi.file_path, name: path.basename(wi.file_path) });
      }
    }

    // If no files to archive, return early with zero counts
    if (incrementalFiles.length === 0 && workItemFiles.length === 0) {
      return `Archived cycle ${cycle}: 0 work items, 0 incremental reviews moved.`;
    }

    // Phase 1: Copy
    ensureDir(cycleWorkItemsDir);
    ensureDir(cycleIncrementalDir);

    interface CopyRecord { src: string; dst: string; }
    const copied: CopyRecord[] = [];
    const copyErrors: string[] = [];

    for (const srcPath of incrementalFiles) {
      const name = path.basename(srcPath);
      const dstPath = path.join(cycleIncrementalDir, name);
      try {
        fs.copyFileSync(srcPath, dstPath);
        copied.push({ src: srcPath, dst: dstPath });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "ERR_UNKNOWN";
        copyErrors.push(`Failed to copy ${path.basename(srcPath)}: ${code}`);
      }
    }

    for (const { src: srcPath, name } of workItemFiles) {
      const dstPath = path.join(cycleWorkItemsDir, name);
      try {
        fs.copyFileSync(srcPath, dstPath);
        copied.push({ src: srcPath, dst: dstPath });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "ERR_UNKNOWN";
        copyErrors.push(`Failed to copy ${path.basename(srcPath)}: ${code}`);
      }
    }

    if (copyErrors.length > 0) {
      return `Error during cycle archival — no originals deleted:\n${copyErrors.join("\n")}`;
    }

    // Phase 2: Verify
    const verifyErrors: string[] = [];
    for (const { src, dst } of copied) {
      if (!fs.existsSync(dst)) {
        verifyErrors.push(`Verification failed — file missing after copy: ${path.basename(dst)}`);
        continue;
      }
      const srcHash = sha256(fs.readFileSync(src, "utf8"));
      const dstHash = sha256(fs.readFileSync(dst, "utf8"));
      if (srcHash !== dstHash) {
        verifyErrors.push(`Verification failed — content hash mismatch for ${path.basename(dst)}`);
      }
    }

    if (verifyErrors.length > 0) {
      return `Error during cycle archival verification — no originals deleted:\n${verifyErrors.join("\n")}`;
    }

    // Phase 3: Atomic commit — update SQLite index in transaction (no fs I/O inside).
    // fs.unlinkSync calls happen AFTER the transaction commits to avoid a situation
    // where the transaction rolls back but filesystem deletes are already committed.
    // If the transaction throws, the rollback handler cleans up archive copies and no
    // originals are deleted. If post-commit unlinks fail, the error is logged and
    // surfaced to the caller — the archive copies remain valid.
    const deleteStmt = this.db.prepare(`DELETE FROM nodes WHERE file_path = ?`);
    const updatePathStmt = this.db.prepare(`UPDATE nodes SET file_path = ? WHERE file_path = ?`);

    try {
      this.db.transaction(() => {
        // Update SQLite index to reflect new paths (no filesystem I/O here)
        for (const srcPath of incrementalFiles) {
          deleteStmt.run(srcPath);
        }
        for (const { src: srcPath, name } of workItemFiles) {
          const archivePath = path.join(cycleWorkItemsDir, name);
          updatePathStmt.run(archivePath, srcPath);
        }
      }).exclusive();
    } catch (err) {
      // Transaction failed — rollback: remove copied archive files.
      // No originals were deleted (fs.unlinkSync not called inside transaction).
      for (const { dst } of copied) {
        try {
          if (fs.existsSync(dst)) fs.unlinkSync(dst);
        } catch {
          // Best-effort cleanup
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      return `Error during cycle archival — transaction rolled back: ${message}`;
    }

    // Phase 4: Delete originals post-commit. Transaction has already succeeded;
    // the index now points to archive copies. Any unlink failure is non-fatal
    // (archive copy is still valid) but must be logged and surfaced to caller.
    const unlinkErrors: string[] = [];
    for (const srcPath of incrementalFiles) {
      try {
        fs.unlinkSync(srcPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "ERR_UNKNOWN";
        const msg = `Failed to delete original after commit: ${path.basename(srcPath)} (${code})`;
        log.error("archiveCycleLocal", msg);
        unlinkErrors.push(msg);
      }
    }
    for (const { src: srcPath } of workItemFiles) {
      try {
        if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "ERR_UNKNOWN";
        const msg = `Failed to delete original after commit: ${path.basename(srcPath)} (${code})`;
        log.error("archiveCycleLocal", msg);
        unlinkErrors.push(msg);
      }
    }

    if (unlinkErrors.length > 0) {
      return `Cycle ${cycle} archived (SQLite committed) but ${unlinkErrors.length} original(s) could not be deleted:\n${unlinkErrors.join("\n")}`;
    }

    const workItemCount = workItemFiles.length;
    const incrementalCount = incrementalFiles.length;

    return `Archived cycle ${cycle}: ${workItemCount} work items, ${incrementalCount} incremental reviews moved.`;
  }

  // -------------------------------------------------------------------------
  // archiveCycle — StorageAdapter interface method
  // Delegates to archiveCycleLocal and returns the result string (including
  // error strings) so callers can surface the message to the user.
  // -------------------------------------------------------------------------

  async archiveCycle(cycle: number): Promise<string> {
    this.assertNotShutDown();
    return this.archiveCycleLocal(cycle);
  }

  // -------------------------------------------------------------------------
  // appendJournalEntry — StorageAdapter interface method
  // Delegates to putNodeForJournal with the cycle-number parameter renamed.
  // -------------------------------------------------------------------------

  async appendJournalEntry(args: {
    skill: string;
    date: string;
    entryType: string;
    body: string;
    cycle: number;
  }): Promise<string> {
    this.assertNotShutDown();
    this.assertScopeForWrite();
    return this.putNodeForJournal({
      skill: args.skill,
      date: args.date,
      entryType: args.entryType,
      body: args.body,
      cycleNumber: args.cycle,
    });
  }

  // -------------------------------------------------------------------------
  // putNodeForJournal — specialized journal entry writer
  // Three-phase P-44-compliant write: reserve seq (tx1) → YAML (no tx) → finalize (tx2).
  // -------------------------------------------------------------------------

  protected async putNodeForJournal(args: {
    skill: string;
    date: string;
    entryType: string;
    body: string;
    cycleNumber: number;
  }): Promise<string> {
    this.assertScopeForWrite();
    const { skill, date, entryType, body, cycleNumber } = args;
    const cycleStr = String(cycleNumber).padStart(3, "0");

    const journalDir = path.join(this.ideateDir, "cycles", cycleStr, "journal");
    ensureDir(journalDir);

    // -----------------------------------------------------------------------
    // Phase 1 — Allocate and reserve sequence slot (exclusive SQLite tx, raw SQL)
    // Releases the exclusive lock before YAML I/O begins (P-44 requirement).
    // -----------------------------------------------------------------------
    let id: string;
    let filePath: string;
    try {
      const phase1Result = this.db.transaction(() => {
        // MAX+1 strategy prevents sequence-number gaps from deleted entries.
        const maxRow = this.db.prepare(
          `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num FROM nodes WHERE id LIKE ?`
        ).get(`J-${cycleStr}-`.length + 1, `J-${cycleStr}-%`) as { max_num: number | null };
        const seq = (maxRow?.max_num ?? 0) + 1;
        const seqStr = String(seq).padStart(3, "0");
        const allocatedId = `J-${cycleStr}-${seqStr}`;
        const allocatedFilePath = path.join(journalDir, `${allocatedId}.yaml`);

        // Insert placeholder row to reserve the slot; prevents concurrent callers
        // from allocating the same sequence number.
        this.db.prepare(
          `INSERT INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
           VALUES (?, ?, ?, NULL, '', 0, ?, NULL)`
        ).run(allocatedId, "journal_entry", cycleNumber, allocatedFilePath);

        return { id: allocatedId, filePath: allocatedFilePath };
      }).exclusive();
      id = phase1Result.id;
      filePath = phase1Result.filePath;
    } catch (tx1Err) {
      throw new ValidationError(
        `operation failed: ${(tx1Err as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "appendJournalEntry" }
      );
    }

    // -----------------------------------------------------------------------
    // Phase 2 — Write YAML file (outside any transaction, per P-44)
    // On failure: delete placeholder and rethrow.
    // -----------------------------------------------------------------------
    const entryObj = {
      id,
      type: "journal_entry",
      phase: skill,
      date,
      cycle_created: cycleNumber,
      title: entryType,
      content: body,
    };
    const yamlContent = stringifyYaml(entryObj);
    const contentHash = computeArtifactHash(entryObj as Record<string, unknown>);
    const tokens = estimateTokens(yamlContent);

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, yamlContent, "utf8");
    } catch (writeErr) {
      // Rollback Phase 1 placeholder (best-effort).
      try {
        this.db.transaction(() => {
          this.db.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
        }).exclusive();
      } catch {
        // best-effort; ignore cleanup errors
      }
      throw writeErr;
    }

    // -----------------------------------------------------------------------
    // Phase 3 — Finalize (exclusive SQLite tx)
    // On failure: unlink YAML, delete placeholder, throw ValidationError.
    // -----------------------------------------------------------------------
    try {
      this.db.transaction(() => {
        const nodeRow: NodeRow = {
          id,
          type: "journal_entry",
          cycle_created: cycleNumber,
          cycle_modified: null,
          content_hash: contentHash,
          token_count: tokens,
          file_path: filePath,
          status: null,
        };
        upsertNode(this.drizzleDb, nodeRow);

        const journalRow: JournalEntryRow = {
          id,
          phase: skill,
          date,
          title: entryType,
          work_item: null,
          content: body,
        };
        upsertJournalEntry(this.drizzleDb, journalRow);
        this.stampScope(id);
      }).exclusive();
    } catch (txErr) {
      // Rollback: remove YAML and delete placeholder (both best-effort).
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // best-effort; ignore unlink errors
      }
      try {
        this.db.transaction(() => {
          this.db.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
        }).exclusive();
      } catch {
        // best-effort; ignore cleanup errors
      }
      throw new ValidationError(
        `operation failed: ${(txErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "appendJournalEntry", id, filePath }
      );
    }

    return id;
  }
}
