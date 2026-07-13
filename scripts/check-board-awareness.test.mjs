// scripts/check-board-awareness.test.mjs — falsification tests for
// check-board-awareness.mjs (WI-320, policy P-41: "guards must be guarded").
//
// Uses node:test (node built-in, no deps) — there is no root package.json /
// vitest setup in this repo (scripts/tests/ uses a plain bash harness;
// vitest exists only inside mcp/artifact-server's own workspace). Run with:
//   node --test scripts/check-board-awareness.test.mjs
//
// Every fixture test builds a throwaway tree under a fresh os.tmpdir()
// mkdtemp and calls run(fixtureRoot) directly — the real repo on disk is
// NEVER mutated by these tests. The one exception is the final "real repo"
// tests, which only READ the real tree via run(), exactly as
// `node scripts/check-board-awareness.mjs` does.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from './check-board-awareness.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const tmpRoots = [];
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'check-board-awareness-'));
  tmpRoots.push(root);
  return root;
}

function writeFile(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('check-board-awareness: run(rootDir) — falsification fixtures', () => {
  it('is NOT vacuous: a known-unbranched call site is flagged as a violation naming the file', () => {
    const root = fixtureRoot();
    writeFile(
      root,
      'skills/x.md',
      [
        '---',
        'name: x',
        '---',
        '',
        '# Phase 1: Load Work Item',
        '',
        "Call `ideate_get_artifact_context({artifact_id})` to load the work item spec.",
        '',
      ].join('\n'),
    );

    const { ok, violations } = run(root);

    assert.equal(ok, false);
    assert.ok(violations.length > 0);
    assert.ok(violations.some((v) => v.file === 'skills/x.md' && v.tool === 'ideate_get_artifact_context'));
  });

  it('the SAME unbranched line, with a board branch added in-window, clears the check', () => {
    const root = fixtureRoot();
    writeFile(
      root,
      'skills/x.md',
      [
        '---',
        'name: x',
        '---',
        '',
        '# Phase 1: Load Work Item',
        '',
        '**Board-aware (v3)**: for a board item (in `{board_items}`), the spec payload IS the work item spec.',
        "For a v2 item, call `ideate_get_artifact_context({artifact_id})` to load the work item spec.",
        '',
      ].join('\n'),
    );

    const { ok, violations } = run(root);

    assert.equal(ok, true);
    assert.deepEqual(violations, []);
  });

  it('a board token far outside the window does NOT clear an unbranched call (window is bounded)', () => {
    const root = fixtureRoot();
    const filler = Array.from({ length: 30 }, (_, i) => `Filler line ${i} with no signal.`).join('\n');
    writeFile(
      root,
      'skills/x.md',
      [
        '# Phase 1',
        '',
        'Board-aware note lives way up here.',
        '',
        filler,
        '',
        "Call `ideate_get_artifact_context({artifact_id})` to load the work item spec.",
        '',
      ].join('\n'),
    );

    const { ok, violations } = run(root);

    assert.equal(ok, false);
    assert.ok(violations.some((v) => v.file === 'skills/x.md'));
  });

  it('ideate_artifact_query is only in scope when {type: "work_item"} — other types are ignored', () => {
    const root = fixtureRoot();
    writeFile(
      root,
      'skills/x.md',
      ['# Phase 1', '', 'Call `ideate_artifact_query({type: "overview"})` — returns the overview.', ''].join('\n'),
    );

    const { ok, violations } = run(root);

    assert.equal(ok, true);
    assert.deepEqual(violations, []);
  });

  it('ideate_artifact_query({type: "work_item"}) unbranched IS flagged, and clears with a board token', () => {
    const unbranchedRoot = fixtureRoot();
    writeFile(
      unbranchedRoot,
      'skills/x.md',
      ['# Phase 1', '', 'Call `ideate_artifact_query({type: "work_item"})` — returns all work items.', ''].join('\n'),
    );
    const unbranched = run(unbranchedRoot);
    assert.equal(unbranched.ok, false);
    assert.ok(unbranched.violations.some((v) => v.tool === 'ideate_artifact_query(work_item)'));

    const branchedRoot = fixtureRoot();
    writeFile(
      branchedRoot,
      'skills/x.md',
      [
        '# Phase 1',
        '',
        'Call `ideate_artifact_query({type: "work_item"})` — returns all v2 work items. **Board-aware read (v3)**: also call `work_list` for board items.',
        '',
      ].join('\n'),
    );
    const branched = run(branchedRoot);
    assert.equal(branched.ok, true);
    assert.deepEqual(branched.violations, []);
  });

  it('ideate_get_artifact_context loading a PROJECT or PHASE (not a work item) is out of scope, unbranched', () => {
    const root = fixtureRoot();
    writeFile(
      root,
      'skills/project.md',
      [
        '# Project Commands',
        '',
        'Call `ideate_get_artifact_context({artifact_id: id})`. Display the project.',
        '',
      ].join('\n'),
    );

    const { ok, violations } = run(root);

    assert.equal(ok, true);
    assert.deepEqual(violations, []);
  });

  it('a "do NOT call" negative instruction is compliant even without a nearby board token', () => {
    const root = fixtureRoot();
    writeFile(
      root,
      'skills/x.md',
      [
        '# Phase 1',
        '',
        'Do NOT call `ideate_update_work_items(` for a board item — the board owns its own transitions.',
        '',
      ].join('\n'),
    );

    const { ok, violations } = run(root);

    assert.equal(ok, true);
    assert.deepEqual(violations, []);
  });

  it('a call site inside a fenced code block is not scanned (prose-only check)', () => {
    const root = fixtureRoot();
    writeFile(
      root,
      'skills/x.md',
      [
        '# Phase 1',
        '',
        '```json',
        '{"example": "ideate_get_artifact_context({artifact_id}) to load the work item spec"}',
        '```',
        '',
      ].join('\n'),
    );

    const { ok, violations } = run(root);

    assert.equal(ok, true);
    assert.deepEqual(violations, []);
  });

  it('agents/*.md is scanned, but only direct children — not recursively', () => {
    const root = fixtureRoot();
    writeFile(
      root,
      'agents/worker.md',
      ["Call `ideate_update_work_items({id})` to change the work item's status.", ''].join('\n'),
    );
    writeFile(
      root,
      'agents/nested/should-not-be-scanned.md',
      ["Call `ideate_update_work_items({id})` to change the work item's status.", ''].join('\n'),
    );

    const { ok, violations } = run(root);

    assert.equal(ok, false);
    assert.ok(violations.some((v) => v.file === 'agents/worker.md'));
    assert.ok(!violations.some((v) => v.file.includes('nested')));
  });

  it('a missing skills/ and agents/ directory reports a structured failure, never a throw', () => {
    const root = fixtureRoot(); // empty tmp dir, no skills/ or agents/
    assert.doesNotThrow(() => run(root));
    const { ok, failures } = run(root);
    assert.equal(ok, false);
    assert.ok(failures.length > 0);
  });
});

describe('check-board-awareness: real repo', () => {
  it('run(REPO_ROOT) does not throw and returns a well-formed result', () => {
    assert.doesNotThrow(() => run(REPO_ROOT));
    const { ok, violations, summary } = run(REPO_ROOT);
    assert.equal(typeof ok, 'boolean');
    assert.ok(Array.isArray(violations));
    assert.equal(typeof summary, 'string');
  });

  // NOTE (WI-320 self-check finding, reported to the coordinator rather than
  // fixed here — project/SKILL.md, autopilot/SKILL.md, and triage/SKILL.md
  // are outside this work item's file scope): as of this writing, run() on
  // the real repo is RED. It surfaces four genuine, pre-existing
  // board-awareness gaps that WI-316/317/318 did not sweep (they touched
  // execute/refine/review + the autopilot phase docs, not the top-level
  // autopilot/project/triage skills):
  //   - skills/autopilot/SKILL.md:75  — ideate_artifact_query({type:"work_item"})
  //     in the Phase 3 pre-flight load has no board branch anywhere in the
  //     file; on a v3-board-only project this returns empty and Phase 3's
  //     "if no work items are found, stop" check would abort autopilot
  //     entirely despite pending board work.
  //   - skills/project/SKILL.md:113 and :154 — same call, used for phase-name
  //     auto-suggestion and the Phase Transition Protocol's incomplete-work
  //     listing; the file has zero board-awareness tokens anywhere, so a
  //     phase transition would silently omit board items from the
  //     carry-forward/cancel prompt.
  //   - skills/triage/SKILL.md:59 — the dedup-check query only sees v2 items,
  //     so triage cannot detect a duplicate of a board-resident item (the
  //     file's write-side IS board-aware, at line 164, but this read-side
  //     call is 100+ lines away, well outside any reasonable window).
  // The four sites the check found at WI-320 build time (autopilot/SKILL.md:75,
  // project/SKILL.md:113 and :154, triage/SKILL.md:59 — the top-level
  // controllers the WI-316/317/318 sweep missed) were fixed in the same cycle-13
  // pass once the check surfaced them. The gate below now asserts a CLEAN tree.
  it('passes GREEN on the real repo — no unbranched work-item call sites (P-46 gate)', () => {
    const { ok, violations } = run(REPO_ROOT);
    const sites = violations.map((v) => `${v.file}:${v.line}`).sort();
    // If this grows, a NEW unbranched site was introduced (or a fix regressed) —
    // investigate before touching this assertion; that is the whole point of the gate.
    assert.deepEqual(sites, [], `unexpected unbranched call sites: ${sites.join(', ')}`);
    assert.equal(ok, true);
  });
});
