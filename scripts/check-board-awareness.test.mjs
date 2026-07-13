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
import { run, COVERAGE_MANIFEST } from './check-board-awareness.mjs';

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

// P-48 (WI-324): registers a fixture test AND records its exact title so the
// "coverage manifest completeness" tests below can assert every
// COVERAGE_MANIFEST.fixtureName corresponds to a REAL, REGISTERED test — not
// just a manifest entry claiming a fixture exists. This is how the manifest
// stays honest: a fixtureName that doesn't match any `fixture(...)` call
// here fails the binding test, not just a human's read-through.
const REGISTERED_FIXTURE_NAMES = new Set();
function fixture(name, fn) {
  REGISTERED_FIXTURE_NAMES.add(name);
  it(name, fn);
}

describe('check-board-awareness: run(rootDir) — falsification fixtures', () => {
  fixture('is NOT vacuous: a known-unbranched call site is flagged as a violation naming the file', () => {
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

  fixture('ideate_artifact_query({type: "work_item"}) unbranched IS flagged, and clears with a board token', () => {
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

describe('check-board-awareness: WI-324 / P-48 hardening — new monitored shapes', () => {
  fixture(
    'ideate_get_execution_status: unbranched call is flagged; a board-awareness token within the read window clears',
    () => {
      const unbranchedRoot = fixtureRoot();
      writeFile(
        unbranchedRoot,
        'skills/x.md',
        [
          '# Phase: Completed Items Scan',
          '',
          'Call `ideate_get_execution_status()` — returns completed, pending, and blocked work item sets.',
          '',
        ].join('\n'),
      );
      const unbranched = run(unbranchedRoot);
      assert.equal(unbranched.ok, false);
      assert.ok(unbranched.violations.some((v) => v.tool === 'ideate_get_execution_status'));

      const branchedRoot = fixtureRoot();
      writeFile(
        branchedRoot,
        'skills/x.md',
        [
          '# Phase: Completed Items Scan',
          '',
          'Call `ideate_get_execution_status()` — returns completed, pending, and blocked work item sets. **Board-aware merge (v3)**: also call `work_list` and merge board status for board items.',
          '',
        ].join('\n'),
      );
      const branched = run(branchedRoot);
      assert.equal(branched.ok, true);
      assert.deepEqual(branched.violations, []);
    },
  );

  fixture(
    'ideate_get_workspace_status: unbranched progress read is flagged; a board token clears; a project-root-resolution call is out of scope',
    () => {
      // Unbranched work-item-PROGRESS read (in scope via the {view:...} form
      // OR same-line progress vocabulary) with no board token → flagged.
      const unbranchedRoot = fixtureRoot();
      writeFile(
        unbranchedRoot,
        'skills/x.md',
        [
          '# Phase: Status Report',
          '',
          'Call `ideate_get_workspace_status({view: "project"})` — returns completed, in-progress, and remaining item counts. Display the result.',
          '',
        ].join('\n'),
      );
      const unbranched = run(unbranchedRoot);
      assert.equal(unbranched.ok, false);
      assert.ok(unbranched.violations.some((v) => v.tool === 'ideate_get_workspace_status'));

      // Same progress read, board branch added in-window → clears.
      const branchedRoot = fixtureRoot();
      writeFile(
        branchedRoot,
        'skills/x.md',
        [
          '# Phase: Status Report',
          '',
          'Call `ideate_get_workspace_status({view: "project"})` — returns completed, in-progress, and remaining item counts. **Board-aware (v3)**: also call `work_list` and merge board-item counts.',
          '',
        ].join('\n'),
      );
      const branched = run(branchedRoot);
      assert.equal(branched.ok, true);
      assert.deepEqual(branched.violations, []);

      // WI-324 rework: the VERIFICATION use is also board-sensitive (WI-322
      // moved init work-item creation onto the board). An unbranched
      // "verify all work items are present via workspace status" → flagged.
      const verifyUnbranchedRoot = fixtureRoot();
      writeFile(
        verifyUnbranchedRoot,
        'skills/x.md',
        [
          '# Phase: Verify',
          '',
          'All work items should already be written. Verify they are all present via `ideate_get_workspace_status()`.',
          '',
        ].join('\n'),
      );
      const verifyUnbranched = run(verifyUnbranchedRoot);
      assert.equal(verifyUnbranched.ok, false);
      assert.ok(verifyUnbranched.violations.some((v) => v.tool === 'ideate_get_workspace_status'));

      // Same verification read with a work_list board branch in-window → clears.
      const verifyBranchedRoot = fixtureRoot();
      writeFile(
        verifyBranchedRoot,
        'skills/x.md',
        [
          '# Phase: Verify',
          '',
          'All work items should already be written. Verify them via `work_list` if created on the board (board-resident, INVISIBLE to `ideate_get_workspace_status()`); otherwise confirm via `ideate_get_workspace_status()`.',
          '',
        ].join('\n'),
      );
      const verifyBranched = run(verifyBranchedRoot);
      assert.equal(verifyBranched.ok, true);
      assert.deepEqual(verifyBranched.violations, []);

      // A project-root-RESOLUTION call (no progress vocab, no view arg, no
      // work-item verification vocab) is OUT of scope — resolving a project
      // path is not board-sensitive, so an unbranched resolution call must NOT
      // be flagged (mirrors get_artifact_context excluding project/phase loads).
      const resolutionRoot = fixtureRoot();
      writeFile(
        resolutionRoot,
        'skills/x.md',
        [
          '# Phase: Setup',
          '',
          'Call `ideate_get_workspace_status()` to identify the project root. The MCP server walks up the directory tree to find the artifact directory.',
          '',
        ].join('\n'),
      );
      const resolution = run(resolutionRoot);
      assert.equal(resolution.ok, true);
      assert.deepEqual(resolution.violations, []);
    },
  );

  fixture(
    'ideate_write_artifact({type: "work_item"}): unbranched write is flagged; a same-line board-create token clears',
    () => {
      const unbranchedRoot = fixtureRoot();
      writeFile(
        unbranchedRoot,
        'skills/x.md',
        [
          '# Phase: Write Steering Artifacts',
          '',
          'Write each work item via `ideate_write_artifact({type: "work_item", id: "WI-001", content: {}})`.',
          '',
        ].join('\n'),
      );
      const unbranched = run(unbranchedRoot);
      assert.equal(unbranched.ok, false);
      assert.ok(unbranched.violations.some((v) => v.tool === 'ideate_write_artifact(work_item)'));

      const branchedRoot = fixtureRoot();
      writeFile(
        branchedRoot,
        'skills/x.md',
        [
          '# Phase: Write Steering Artifacts',
          '',
          '**v2 fallback (pre-v3 projects only)**: write each work item via `ideate_write_artifact({type: "work_item", id: "WI-001", content: {}})`.',
          '',
        ].join('\n'),
      );
      const branched = run(branchedRoot);
      assert.equal(branched.ok, true);
      assert.deepEqual(branched.violations, []);
    },
  );

  fixture('work_create: an unbranched call is NEVER flagged, even with zero board tokens anywhere in the file', () => {
    const root = fixtureRoot();
    writeFile(
      root,
      'skills/x.md',
      ['# Phase: Create', '', 'Create the item via `work_create({title: "x", spec: {}})`.', ''].join('\n'),
    );

    const { ok, violations } = run(root);

    assert.equal(ok, true);
    assert.deepEqual(violations, []);
    assert.ok(!violations.some((v) => v.tool === 'work_create')); // never emitted for this shape, by design
  });

  fixture(
    'ideate_write_work_items: a board token in a SEPARATE paragraph 2 lines away does NOT clear (reproduces the cycle-13 triage false-negative; WRITE_WINDOW catches it)',
    () => {
      // Reproduces the exact cycle-13 gap-C2 shape: a board-aware numbering
      // paragraph sits ~2 lines above an UNBRANCHED write call in its own
      // separate paragraph. Under the old WINDOW=12 read-window, this board
      // token falsely cleared the write. WRITE_WINDOW=0 (same
      // line/paragraph only) must catch it.
      const root = fixtureRoot();
      writeFile(
        root,
        'skills/x.md',
        [
          '# Phase: Write Work Item',
          '',
          '**Board-aware numbering (v3)**: also call `work_list` and take the maximum WI number across the artifact index and any board items.',
          '',
          'Call `ideate_write_work_items({items: [{id: "WI-001"}]})` to create the work item.',
          '',
        ].join('\n'),
      );

      const { ok, violations } = run(root);

      assert.equal(ok, false);
      assert.ok(violations.some((v) => v.file === 'skills/x.md' && v.tool === 'ideate_write_work_items'));
    },
  );

  fixture(
    'ideate_write_work_items: a board token on the SAME line/paragraph as the write clears (tightened window still passes the real-tree pattern)',
    () => {
      const root = fixtureRoot();
      writeFile(
        root,
        'skills/x.md',
        [
          '# Phase: Write Work Item',
          '',
          '**v2 fallback (pre-v3 projects only)**: call `ideate_write_work_items({items: [{id: "WI-001"}]})` to create the work item.',
          '',
        ].join('\n'),
      );

      const { ok, violations } = run(root);

      assert.equal(ok, true);
      assert.deepEqual(violations, []);
    },
  );

  fixture(
    'ideate_assemble_context: unbranched call is flagged; a board token within the read window clears',
    () => {
      const unbranchedRoot = fixtureRoot();
      writeFile(
        unbranchedRoot,
        'skills/x.md',
        ['# Phase: Seed PPR', '', 'Call `ideate_assemble_context({artifact_id})` to seed PPR with the work item.', ''].join(
          '\n',
        ),
      );
      const unbranched = run(unbranchedRoot);
      assert.equal(unbranched.ok, false);
      assert.ok(unbranched.violations.some((v) => v.tool === 'ideate_assemble_context'));

      const branchedRoot = fixtureRoot();
      writeFile(
        branchedRoot,
        'skills/x.md',
        [
          '# Phase: Seed PPR',
          '',
          '**Board-aware (v3)**: call `ideate_assemble_context({artifact_id})` to seed PPR with the work item.',
          '',
        ].join('\n'),
      );
      const branched = run(branchedRoot);
      assert.equal(branched.ok, true);
      assert.deepEqual(branched.violations, []);
    },
  );

  fixture(
    'ideate_update_work_items: unbranched call is flagged; a board token within the read window clears',
    () => {
      const unbranchedRoot = fixtureRoot();
      writeFile(
        unbranchedRoot,
        'skills/x.md',
        ["Call `ideate_update_work_items({id})` to change the work item's status.", ''].join('\n'),
      );
      const unbranched = run(unbranchedRoot);
      assert.equal(unbranched.ok, false);
      assert.ok(unbranched.violations.some((v) => v.tool === 'ideate_update_work_items'));

      const branchedRoot = fixtureRoot();
      writeFile(
        branchedRoot,
        'skills/x.md',
        [
          '**Board-aware (v3)**: for board items, the board owns its own transitions.',
          "For a v2 item, call `ideate_update_work_items({id})` to change the work item's status.",
          '',
        ].join('\n'),
      );
      const branched = run(branchedRoot);
      assert.equal(branched.ok, true);
      assert.deepEqual(branched.violations, []);
    },
  );
});

describe('check-board-awareness: P-48 coverage manifest completeness', () => {
  const callPatternNames = () => {
    // CALL_PATTERNS itself is not exported (it's an internal implementation
    // detail of run()) — but every violation this file's fixtures produce
    // carries `tool`, which is exactly CALL_PATTERNS[i].name. We derive the
    // full name set from a small synthetic tree that trips every pattern at
    // once (including work_create, which never violates but must still be
    // recognized as a call site — checked separately below since it can
    // never appear in a `violations` list by design).
    const root = fixtureRoot();
    writeFile(
      root,
      'skills/all-shapes.md',
      [
        'Call `ideate_get_artifact_context({artifact_id})` for the work item.',
        'Call `ideate_assemble_context({artifact_id})`.',
        "Call `ideate_update_work_items({id})` for the work item's status.",
        'Call `ideate_write_work_items({items: []})`.',
        'Call `ideate_write_artifact({type: "work_item", id: "WI-001"})`.',
        'Call `ideate_get_execution_status()`.',
        'Call `ideate_get_workspace_status({view: "project"})` — completed, in-progress, remaining item counts.',
        'Call `ideate_artifact_query({type: "work_item"})`.',
        '',
      ].join('\n'),
    );
    const { violations } = run(root);
    const names = new Set(violations.map((v) => v.tool));
    names.add('work_create'); // neverViolation — never appears in `violations`, added manually
    return names;
  };

  it('every CALL_PATTERNS shape is enumerated in COVERAGE_MANIFEST — no pattern unmanifested', () => {
    const patternNames = callPatternNames();
    const manifestNames = new Set(COVERAGE_MANIFEST.map((e) => e.name));

    for (const name of patternNames) {
      assert.ok(manifestNames.has(name), `CALL_PATTERNS shape "${name}" has no COVERAGE_MANIFEST entry`);
    }
  });

  it('every COVERAGE_MANIFEST entry names a real CALL_PATTERNS shape — no manifest entry describes a nonexistent pattern', () => {
    const patternNames = callPatternNames();

    for (const entry of COVERAGE_MANIFEST) {
      assert.ok(patternNames.has(entry.name), `COVERAGE_MANIFEST entry "${entry.name}" does not match any CALL_PATTERNS shape`);
    }
  });

  it('every COVERAGE_MANIFEST entry has a corresponding REGISTERED fixture — no claimed-but-untested shape', () => {
    for (const entry of COVERAGE_MANIFEST) {
      assert.ok(
        REGISTERED_FIXTURE_NAMES.has(entry.fixtureName),
        `COVERAGE_MANIFEST entry "${entry.name}" claims fixtureName "${entry.fixtureName}" but no fixture(...) test with that title is registered`,
      );
    }
  });

  it('every COVERAGE_MANIFEST entry declares a verb (CREATE / COMPLETE / READ / UPDATE)', () => {
    for (const entry of COVERAGE_MANIFEST) {
      assert.ok(['CREATE', 'COMPLETE', 'READ', 'UPDATE'].includes(entry.verb), `entry "${entry.name}" has invalid verb "${entry.verb}"`);
    }
  });

  it('every COVERAGE_MANIFEST entry documents its window bound with a rationale string', () => {
    for (const entry of COVERAGE_MANIFEST) {
      assert.equal(typeof entry.window, 'string');
      assert.ok(entry.window.length > 0, `entry "${entry.name}" has an empty window rationale`);
    }
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
