// scripts/check-all.test.mjs — tests for the check-all composition runner
// (WI-334 / F-334-001 M1). Verifies it aggregates ALL failures across the three
// board-awareness layers without short-circuiting, and is green on the real repo.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from './check-all.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const tmpRoots = [];
function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), 'check-all-'));
  tmpRoots.push(root);
  return root;
}
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

describe('check-all: composition runner', () => {
  it('is green on the real repo (all three layers pass)', () => {
    const { ok, problems } = run(REPO_ROOT);
    assert.equal(ok, true, `unexpected problems: ${problems.join('; ')}`);
    assert.deepEqual(problems, []);
  });

  it('aggregates ALL three layers when everything fails — no short-circuit', () => {
    // An empty root: no skills/agents (prose scan fails), no index.ts (registry
    // grounding fails), no engine files (engine-guard census fails). All three
    // classes must appear in one problems array.
    const { ok, problems } = run(emptyRoot());
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.startsWith('board-awareness:')), 'expected a board-awareness problem');
    assert.ok(problems.some((p) => p.startsWith('registry grounding:')), 'expected a registry-grounding problem');
    assert.ok(problems.some((p) => p.startsWith('engine guard:')), 'expected an engine-guard problem');
  });

  it('run() returns a structured result without throwing (never prints/exits)', () => {
    assert.doesNotThrow(() => run(emptyRoot()));
    const { ok, problems } = run(emptyRoot());
    assert.equal(typeof ok, 'boolean');
    assert.ok(Array.isArray(problems));
  });
});
