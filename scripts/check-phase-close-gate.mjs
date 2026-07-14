#!/usr/bin/env node
// scripts/check-phase-close-gate.mjs — committed P-47 mechanical phase-close
// gate (WI-329).
//
// P-47's problem statement: for THREE straight cycles a coordinator-executed,
// MCP-only work item shipped with no incremental review of its own deliverable
// (WI-313 → WI-319 → WI-325), each time while the "every item gets a review or
// a recorded exemption" norm was in active view and being claimed satisfied. A
// stated norm that is not mechanically gated self-non-enforces indefinitely —
// the same failure P-41 (guards must be guarded) and P-48 (green is
// coverage-scoped) address. This gate makes "every phase item is reviewed or
// exempted" a MECHANICAL phase-close check, not a stated norm.
//
// What it checks: for a given phase, every work item the phase claims (the
// phase artifact's `work_items` list) must have >= 1 finding-store record —
// either a filed incremental finding OR a recorded exemption. Both are finding
// artifacts (`F-<WI>-<seq>.yaml`); an exemption is a finding carrying
// `verdict: exempted` / `exemption: true`, so "finding OR exemption" collapses
// to "at least one finding-store record references the item." A phase item with
// neither is an ungated item — a hard phase-close failure.
//
// REGISTRY GROUNDING (P-48): the item set and the coverage set are read from
// the AUTHORITATIVE stores directly — the phase artifact's work_items, the v3
// board (`.ideate-work/board.db`, via the built-in node:sqlite driver), and the
// finding artifacts on disk — NOT a hand-maintained list. A newly-added phase
// item with no finding cannot silently pass; it surfaces as uncovered. This is
// the check-board-awareness.mjs pattern (read the source of truth directly)
// applied to the governance axis.
//
// PROJECT ROOT: unlike check-board-awareness (which scans this repo's own
// skills/), this gate reads the ACTIVE PROJECT's artifact stores, which live at
// the project root being worked on (e.g. the monorepo root), NOT inside this
// plugin repo. So run(projectRoot, phaseId) takes the project root explicitly;
// the CLI defaults it to process.cwd().
//
// Testable: run() and the reader functions take a root directory and return
// structured results without printing or exiting. The CLI entry point at the
// bottom is the only place that prints / calls process.exit (P-41 pattern).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// --- Pure core -------------------------------------------------------------
// Given the phase's work-item IDs and the set of covered IDs (those with a
// filed finding or recorded exemption), return the uncovered items. Pure so a
// fixture can prove non-vacuity without touching disk.
export function phaseCloseGaps(phaseWorkItems, coveredWorkItems) {
  const covered = new Set(coveredWorkItems);
  const uncovered = [...new Set(phaseWorkItems)].filter((wi) => !covered.has(wi)).sort();
  return { ok: uncovered.length === 0, uncovered };
}

// --- Authoritative-store readers -------------------------------------------

// Parse a phase artifact's `work_items` list from
// <projectRoot>/.ideate/phases/<phaseId>.yaml. The list is a YAML sequence of
// `- WI-NNN` entries terminated by the next top-level key.
export function readPhaseWorkItems(projectRoot, phaseId) {
  const p = join(projectRoot, '.ideate', 'phases', `${phaseId}.yaml`);
  const src = readFileSync(p, 'utf8');
  const items = [];
  let inList = false;
  for (const line of src.split('\n')) {
    // Flow style: `work_items: [WI-001, WI-002]` (or `[]`). Self-contained on
    // one line (F-329-001 M1: block-only parsing silently returned [] for a
    // flow list WITH content, masking real ungated items).
    const flow = line.match(/^work_items:\s*\[([^\]]*)\]/);
    if (flow) {
      for (const m of flow[1].matchAll(/WI-\d+/g)) items.push(m[0]);
      return items;
    }
    // Block style: `work_items:` then `  - WI-NNN` entries.
    if (/^work_items:\s*$/.test(line)) { inList = true; continue; }
    if (!inList) continue;
    const m = line.match(/^\s*-\s*(WI-\d+)\s*$/);
    if (m) { items.push(m[1]); continue; }
    // A non-list, non-blank line ends the sequence (next key or dedent).
    if (line.trim() !== '') break;
  }
  return items;
}

// Covered = every work item with >= 1 finding-store record. Reads the finding
// yaml files DIRECTLY across all cycle dirs (registry-grounded). A recorded
// exemption is itself a finding artifact, so it counts here with no special
// case. Prefers each file's `work_item:` field; falls back to the `F-<WI>-<seq>`
// filename.
export function readCoveredWorkItems(projectRoot) {
  const covered = new Set();
  const cyclesDir = join(projectRoot, '.ideate', 'cycles');
  let cycleEntries = [];
  try { cycleEntries = readdirSync(cyclesDir, { withFileTypes: true }); } catch { return covered; }
  for (const c of cycleEntries) {
    if (!c.isDirectory()) continue;
    const findingsDir = join(cyclesDir, c.name, 'findings');
    let files = [];
    try { files = readdirSync(findingsDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.yaml')) continue;
      let wi = null;
      try {
        const m = readFileSync(join(findingsDir, f), 'utf8').match(/^work_item:\s*(WI-\d+)/m);
        if (m) wi = m[1];
      } catch { /* fall through to filename */ }
      if (!wi) {
        // Finding files are named F-<num>-<seq> (e.g. F-326-001); some legacy
        // ones use F-WI-<num>-<seq>. Normalize either to WI-<num>.
        const fm = f.match(/^F-(?:WI-)?(\d+)-/);
        if (fm) wi = `WI-${fm[1]}`;
      }
      if (wi) covered.add(wi);
    }
  }
  return covered;
}

// Read board items from <projectRoot>/.ideate-work/board.db (built-in
// node:sqlite, read-only, depless). Returns { items, error }: `items` is a Map
// of WI designation -> status; `error` is null on success or a message string
// when the db is present but unreadable (wrong/legacy schema, corruption, lock
// contention). NEVER throws (F-329-001 S1) — the gate is CI infrastructure and
// a raw stack trace is a worse failure mode than a structured report. board.db
// is enrichment-only (coverage comes from findings), but an unreadable board is
// surfaced as a run() failure rather than silently ignored.
export function readBoardItems(projectRoot) {
  const dbPath = join(projectRoot, '.ideate-work', 'board.db');
  const items = new Map();
  if (!existsSync(dbPath)) return { items, error: null };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    for (const r of db.prepare('SELECT title, status FROM items').all()) {
      const m = String(r.title).match(/(WI-\d+)/);
      if (m) items.set(m[1], String(r.status));
    }
    return { items, error: null };
  } catch (err) {
    return { items, error: `cannot read board.db: ${err.message ?? err.code ?? String(err)}` };
  } finally {
    try { db?.close(); } catch { /* already failed / not opened */ }
  }
}

// run(projectRoot, phaseId): enumerate the phase's authoritative item set and
// gate on finding/exemption coverage. Returns {ok, phaseId, phaseWorkItems,
// uncovered, failures, summary} without printing or exiting.
export function run(projectRoot, phaseId) {
  const failures = [];
  let phaseWorkItems = [];
  try {
    phaseWorkItems = readPhaseWorkItems(projectRoot, phaseId);
  } catch (err) {
    failures.push(`cannot read phase ${phaseId}: ${err.code === 'ENOENT' ? 'not found' : (err.code ?? err.message)}`);
  }
  if (phaseWorkItems.length === 0 && failures.length === 0) {
    failures.push(`phase ${phaseId} has an empty work_items list — nothing to gate (check the phase id)`);
  }

  const covered = readCoveredWorkItems(projectRoot);
  const { items: board, error: boardError } = readBoardItems(projectRoot);
  if (boardError) failures.push(boardError);

  const { ok: gateOk, uncovered } = phaseCloseGaps(phaseWorkItems, covered);
  const report = uncovered.map((wi) => ({ wi, boardStatus: board.get(wi) ?? '(not on board / legacy v2)' }));

  const ok = gateOk && failures.length === 0;
  const summary = ok
    ? `check-phase-close-gate: OK — ${phaseId}: all ${phaseWorkItems.length} work items have a filed finding or recorded exemption`
    : `check-phase-close-gate: ${uncovered.length} ungated item(s) in ${phaseId}, ${failures.length} read failure(s)`;
  return { ok, phaseId, phaseWorkItems, uncovered: report, failures, summary };
}

// --- CLI entry point --------------------------------------------------------
// node scripts/check-phase-close-gate.mjs <phaseId> [projectRoot]
// projectRoot defaults to process.cwd() (run from the active project root).
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  const phaseId = process.argv[2];
  const projectRoot = process.argv[3] ?? process.cwd();
  if (!phaseId) {
    console.error('usage: check-phase-close-gate.mjs <phaseId> [projectRoot]');
    process.exit(2);
  }
  const { ok, uncovered, failures, summary } = run(projectRoot, phaseId);
  if (!ok) {
    console.error('check-phase-close-gate: FAILED');
    for (const f of failures) console.error(`  - ${f}`);
    for (const u of uncovered) {
      console.error(`  - ${u.wi}: no filed finding or recorded exemption (board status: ${u.boardStatus}) — file F-${u.wi.replace('WI-', '')}-NNN or record an exemption before phase close (P-47)`);
    }
    process.exit(1);
  }
  console.log(summary);
}
