// scripts/check-phase-close-gate.test.mjs — falsification tests for
// check-phase-close-gate.mjs (WI-329, policy P-41: "guards must be guarded").
//
// node:test (built-in, no deps). Run with:
//   node --test scripts/check-phase-close-gate.test.mjs
//
// Every fixture builds a throwaway project tree under a fresh mkdtemp and calls
// run()/readers directly — no real .ideate/.ideate-work is ever touched. The
// board.db fixtures are built with the same built-in node:sqlite driver the
// gate reads with.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  phaseCloseGaps,
  readPhaseWorkItems,
  readCoveredWorkItems,
  readBoardItems,
  run,
} from './check-phase-close-gate.mjs';

const tmpRoots = [];
function projectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'check-phase-close-gate-'));
  tmpRoots.push(root);
  return root;
}
function writeFile(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}
function writePhase(root, phaseId, workItems) {
  writeFile(
    root,
    join('.ideate', 'phases', `${phaseId}.yaml`),
    ['id: ' + phaseId, 'status: active', 'work_items:', ...workItems.map((w) => `  - ${w}`), 'name: fixture', ''].join('\n'),
  );
}
function writeFinding(root, cycle, wi, extra = '') {
  const num = wi.replace('WI-', '');
  writeFile(
    root,
    join('.ideate', 'cycles', cycle, 'findings', `F-${num}-001.yaml`),
    [`id: F-${num}-001`, `work_item: ${wi}`, 'verdict: pass', extra, ''].join('\n'),
  );
}
function writeBoard(root, items /* [{wi, status}] */) {
  const dbPath = join(root, '.ideate-work', 'board.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE items (title TEXT, status TEXT)');
  const stmt = db.prepare('INSERT INTO items (title, status) VALUES (?, ?)');
  for (const it of items) stmt.run(`${it.wi}: fixture title`, it.status);
  db.close();
}

afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

describe('check-phase-close-gate: phaseCloseGaps (pure core)', () => {
  it('is NOT vacuous: an ungated phase item is flagged', () => {
    const { ok, uncovered } = phaseCloseGaps(['WI-001', 'WI-002'], ['WI-001']);
    assert.equal(ok, false);
    assert.deepEqual(uncovered, ['WI-002']);
  });

  it('a fully-covered phase passes', () => {
    const { ok, uncovered } = phaseCloseGaps(['WI-001', 'WI-002'], ['WI-001', 'WI-002', 'WI-999']);
    assert.equal(ok, true);
    assert.deepEqual(uncovered, []);
  });

  it('an empty phase has no gaps (caller decides whether empty is itself a failure)', () => {
    const { ok, uncovered } = phaseCloseGaps([], ['WI-001']);
    assert.equal(ok, true);
    assert.deepEqual(uncovered, []);
  });

  it('deduplicates repeated phase items', () => {
    const { uncovered } = phaseCloseGaps(['WI-001', 'WI-001', 'WI-002'], []);
    assert.deepEqual(uncovered, ['WI-001', 'WI-002']);
  });
});

describe('check-phase-close-gate: authoritative-store readers', () => {
  it('readPhaseWorkItems parses the work_items sequence and stops at the next key', () => {
    const root = projectRoot();
    writePhase(root, 'PH-100', ['WI-001', 'WI-002', 'WI-003']);
    assert.deepEqual(readPhaseWorkItems(root, 'PH-100'), ['WI-001', 'WI-002', 'WI-003']);
  });

  it('readCoveredWorkItems collects WIs from finding files across cycles (via work_item field)', () => {
    const root = projectRoot();
    writeFinding(root, '014', 'WI-001');
    writeFinding(root, '015', 'WI-002');
    const covered = readCoveredWorkItems(root);
    assert.ok(covered.has('WI-001'));
    assert.ok(covered.has('WI-002'));
    assert.ok(!covered.has('WI-003'));
  });

  it('readCoveredWorkItems counts a recorded exemption (a finding with verdict: exempted) as coverage', () => {
    const root = projectRoot();
    writeFinding(root, '015', 'WI-050', 'verdict: exempted\nexemption: true');
    assert.ok(readCoveredWorkItems(root).has('WI-050'));
  });

  it('readCoveredWorkItems falls back to the F-<num>- filename when work_item is absent', () => {
    const root = projectRoot();
    writeFile(root, join('.ideate', 'cycles', '015', 'findings', 'F-077-001.yaml'), 'id: F-077-001\nverdict: pass\n');
    assert.ok(readCoveredWorkItems(root).has('WI-077'));
  });

  it('readCoveredWorkItems returns empty (no throw) when there are no cycles', () => {
    const root = projectRoot();
    assert.deepEqual([...readCoveredWorkItems(root)], []);
  });

  it('readBoardItems reads titles/status from board.db via node:sqlite', () => {
    const root = projectRoot();
    writeBoard(root, [{ wi: 'WI-001', status: 'done' }, { wi: 'WI-002', status: 'open' }]);
    const { items: board, error } = readBoardItems(root);
    assert.equal(error, null);
    assert.equal(board.get('WI-001'), 'done');
    assert.equal(board.get('WI-002'), 'open');
  });

  it('readBoardItems returns an empty map + null error (no throw) when board.db is absent', () => {
    const root = projectRoot();
    const { items, error } = readBoardItems(root);
    assert.equal(items.size, 0);
    assert.equal(error, null);
  });

  it('readBoardItems returns a structured error (never throws) for a malformed board.db (F-329-001 S1)', () => {
    const root = projectRoot();
    // A board.db present but WITHOUT the expected `items` table.
    const dbPath = join(root, '.ideate-work', 'board.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE wrong_table (x TEXT)');
    db.close();

    assert.doesNotThrow(() => readBoardItems(root));
    const { items, error } = readBoardItems(root);
    assert.equal(items.size, 0);
    assert.ok(error && /board\.db/.test(error));
  });

  it('readPhaseWorkItems parses FLOW-style work_items with content (F-329-001 M1)', () => {
    const root = projectRoot();
    writeFile(root, join('.ideate', 'phases', 'PH-300.yaml'), 'id: PH-300\nwork_items: [WI-001, WI-002, WI-003]\nname: fixture\n');
    assert.deepEqual(readPhaseWorkItems(root, 'PH-300'), ['WI-001', 'WI-002', 'WI-003']);
  });

  it('readPhaseWorkItems returns [] for an empty flow-style list', () => {
    const root = projectRoot();
    writeFile(root, join('.ideate', 'phases', 'PH-301.yaml'), 'id: PH-301\nwork_items: []\nname: fixture\n');
    assert.deepEqual(readPhaseWorkItems(root, 'PH-301'), []);
  });
});

describe('check-phase-close-gate: run() integration', () => {
  it('FAILS and names the ungated item, enriched with board status', () => {
    const root = projectRoot();
    writePhase(root, 'PH-200', ['WI-001', 'WI-002']);
    writeFinding(root, '015', 'WI-001'); // WI-002 left ungated
    writeBoard(root, [{ wi: 'WI-001', status: 'done' }, { wi: 'WI-002', status: 'done' }]);

    const { ok, uncovered, summary } = run(root, 'PH-200');
    assert.equal(ok, false);
    assert.deepEqual(uncovered.map((u) => u.wi), ['WI-002']);
    assert.equal(uncovered[0].boardStatus, 'done');
    assert.match(summary, /1 ungated item/);
  });

  it('passes GREEN when every phase item has a finding or exemption', () => {
    const root = projectRoot();
    writePhase(root, 'PH-201', ['WI-001', 'WI-002']);
    writeFinding(root, '015', 'WI-001');
    writeFinding(root, '015', 'WI-002', 'verdict: exempted'); // exemption satisfies
    writeBoard(root, [{ wi: 'WI-001', status: 'done' }, { wi: 'WI-002', status: 'done' }]);

    const { ok, uncovered } = run(root, 'PH-201');
    assert.equal(ok, true);
    assert.deepEqual(uncovered, []);
  });

  it('reports a read failure (never throws) for a missing phase artifact', () => {
    const root = projectRoot();
    assert.doesNotThrow(() => run(root, 'PH-404'));
    const { ok, failures } = run(root, 'PH-404');
    assert.equal(ok, false);
    assert.ok(failures.length > 0);
  });

  it('reports a structured failure (never throws) when board.db is malformed (F-329-001 S1)', () => {
    const root = projectRoot();
    writePhase(root, 'PH-203', ['WI-001']);
    writeFinding(root, '015', 'WI-001'); // coverage is fine; the board is the problem
    const dbPath = join(root, '.ideate-work', 'board.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE wrong_table (x TEXT)');
    db.close();

    assert.doesNotThrow(() => run(root, 'PH-203'));
    const { ok, failures } = run(root, 'PH-203');
    assert.equal(ok, false);
    assert.ok(failures.some((f) => /board\.db/.test(f)));
  });

  it('an uncovered item not on the board is annotated as legacy/absent', () => {
    const root = projectRoot();
    writePhase(root, 'PH-202', ['WI-900']);
    // no finding, no board entry
    const { ok, uncovered } = run(root, 'PH-202');
    assert.equal(ok, false);
    assert.equal(uncovered[0].wi, 'WI-900');
    assert.match(uncovered[0].boardStatus, /not on board|legacy/);
  });
});
