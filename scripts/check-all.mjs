#!/usr/bin/env node
// scripts/check-all.mjs — single committed entrypoint for the repo-scoped
// board-awareness validation (WI-334 / cycle-15 D1).
//
// The board-awareness check (check-board-awareness.mjs) is mechanical WHEN RUN
// but had no single trigger. This runner gives it one entrypoint
// (`node scripts/check-all.mjs`) so it can be wired to a git hook / CI without
// callers needing to know the check's internals. It runs all three layers the
// check-board-awareness CLI runs — the prose scan, the registry-grounded
// coverage (P-48), and the registry-grounded engine-marker census (WI-333) —
// and exits non-zero if any fails.
//
// NOTE: check-phase-close-gate.mjs is deliberately NOT run here. It is
// PROJECT-scoped — it takes a phaseId + a projectRoot whose .ideate/
// .ideate-work stores it reads — so it is invoked by the review/execute skills
// at phase-close against the ACTIVE PROJECT, not from this plugin-repo-scoped
// runner. A full CI / git-hook wiring is a separate, larger concern (there is
// no root package.json / CI in this repo yet).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  run as runBoardAwareness,
  readRegisteredTools,
  registryCoverageGaps,
  engineGuardsPresent,
} from './check-board-awareness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Run the full repo-scoped board-awareness validation and collect every
// failure. Returns {ok, problems} without printing or exiting (testable).
export function run(rootDir) {
  const problems = [];

  // (1) Prose scan — no unbranched work-item call sites in skills/agents.
  const board = runBoardAwareness(rootDir);
  if (!board.ok) {
    for (const f of board.failures) problems.push(`board-awareness: ${f}`);
    for (const v of board.violations) problems.push(`board-awareness: ${v.file}:${v.line} [${v.tool}] ${v.text}`);
  }

  // (2) Registry-grounded coverage (P-48, WI-327): every registered tool is
  // monitored or excluded-with-rationale.
  try {
    const reg = registryCoverageGaps(readRegisteredTools(rootDir));
    for (const n of reg.unclassified) problems.push(`registry grounding: "${n}" is registered but neither monitored nor excluded-with-rationale`);
    for (const n of reg.stale) problems.push(`registry grounding: "${n}" is monitored/excluded but no longer registered`);
  } catch (err) {
    problems.push(`registry grounding: ${err.message ?? String(err)}`);
  }

  // (3) Registry-grounded engine-marker census (WI-333): every marker-required
  // read handler carries the engine marker; write sinks are guarded.
  const guards = engineGuardsPresent(rootDir);
  for (const m of guards.missing) problems.push(`engine guard: ${m}`);

  return { ok: problems.length === 0, problems };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  const { ok, problems } = run(ROOT);
  if (!ok) {
    console.error('check-all: FAILED');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('check-all: OK — board-awareness (prose + registry-grounded coverage + engine-marker census) green. (Phase-close gate is skill-invoked per active project.)');
}
