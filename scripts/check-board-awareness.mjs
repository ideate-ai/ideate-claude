#!/usr/bin/env node
// scripts/check-board-awareness.mjs — committed board-awareness completeness
// check (WI-320; enacts domain policy P-46).
//
// P-46's problem statement: for three straight cycles, a fix scoped to named
// skill/agent sections missed a SIBLING section that still assumed every
// work item resolves via the v2 `ideate_get_artifact_context` path — i.e.
// the fix never accounted for v3 board-resident work items. A committed,
// mechanical grep-check makes "swept complete" verifiable forever instead of
// re-relying on a human re-reading every prose surface each cycle.
//
// What this checks: every skill/agent markdown file for BRANCH-SENSITIVE
// work-item tool call sites — the five call shapes that behave differently
// depending on whether a work item lives in the v2 artifact store or on the
// v3 board:
//
//   1. `ideate_get_artifact_context(` — loads an item-scoped spec
//   2. `ideate_assemble_context(`      — seeds PPR with a work item
//   3. `ideate_update_work_items(`     — v2 status/field update
//   4. `ideate_write_work_items(`      — v2 item creation
//   5. `ideate_artifact_query({type: "work_item"` — per-item v2 metadata read
//
// A call site is COMPLIANT if a board-awareness token (`board_items`,
// `board item`, `board-aware`, `work_list`, `work_get`, `work_claim`,
// `work_complete`, `spec_format`, `CANONICAL`, "Sourcing a work item", a v2
// fallback marker, etc.) appears within a bounded line window around it —
// prose written to route board-resident items differently reliably mentions
// one of these nearby (verified against the current, already-swept surfaces
// in skills/execute, skills/refine, skills/review, and the autopilot phase
// docs). A call site with NO such marker in-window is a VIOLATION: prose
// that still silently assumes the v2-only path.
//
// This is a heuristic static check over prose, not a semantic verifier — it
// cannot confirm the branch is *correct*, only that the surface is not
// completely oblivious to v3's existence. Tuned for zero false positives on
// the sections already swept board-aware (WI-316/317/318); see the test
// file's real-repo assertion and this file's inline notes on tuning
// decisions (paren-required call-site detection, frontmatter exclusion).
//
// Testable: run(rootDir) runs the full scan against ANY root directory (the
// real repo, or a fixture tree built in a temp dir) and returns
// {ok, violations, summary} without printing or exiting. The CLI entry point
// at the bottom of this file calls run() against the real repo root and is
// the only place that prints to console / calls process.exit (P-41 pattern:
// guards must be guarded — see check-shared-pins.mjs for the sibling check
// this file's structure is modeled on).
//
// Run from anywhere: paths resolve from this script's own location.

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// How many lines before/after a call site count as "nearby" for a
// board-awareness marker. Tuned against the current tree: every already-swept
// call site carries its marker on the same line or within a couple of lines;
// 12 gives headroom for markers stated once per subsection (e.g. a heading's
// "Board-aware (v3)" callout governing a short paragraph of call sites)
// without growing so wide it would clear a call site in an unrelated section.
const WINDOW = 12;

// Board-awareness / v2-fallback tokens. Matched case-insensitively — the
// three casing variants named in the policy (`board-aware`, `Board-aware`,
// `Board-Aware`) are one case-insensitive pattern here, and "CANONICAL" is
// folded in the same way since prose casing of the "(CANONICAL)" heading
// marker is not load-bearing for this check.
const BOARD_TOKEN_RE =
  /board_items|board item|board-aware|work_list|work_get|work_claim|work_complete|spec_format|canonical|sourcing a work item|v2 fallback|v2 item|v2-phase|legacy item/i;

// A call site inside a sentence that explicitly instructs NOT to call the
// tool (e.g. "Do NOT call `ideate_get_artifact_context` for a board item...")
// is itself the board-aware branch, not a miss. In the current tree these
// negative instructions never carry a literal `(` after the tool name (they
// reference the tool name, not an invocation), so the paren-required call
// detection below already excludes them naturally. This regex is kept as a
// defensive backstop in case a future edit phrases the same negative
// instruction with example call syntax.
const NEGATIVE_INSTRUCTION_RE = /\b(?:do\s+not|never)\s+call\b/i;

// How many lines before/after a call site are searched for a WORK-ITEM SCOPE
// signal (see `scopeRe` below) — distinct from, and much tighter than,
// WINDOW (the board-token compliance search). `ideate_get_artifact_context`
// is a generic by-ID artifact loader: it loads projects and phases just as
// often as work items, and only the work-item case has a v3 board
// equivalent to be aware of. Every already-swept, genuinely work-item-scoped
// call site in the current tree states "work item" / "work_item_type" on
// the SAME line as the call, so 0 (same line only) is deliberately exact —
// a wider window bleeds into unrelated neighboring bullets (e.g.
// skills/project/SKILL.md's phase-create bullet writes a `work_items: []`
// array field two lines from an unrelated *project*-scoped
// ideate_get_artifact_context call; a >0 window would wrongly pull that
// field name in as a work-item-scope signal for the project read).
const SCOPE_WINDOW = 0;
const WORK_ITEM_SCOPE_RE = /work[ _]item/i;

const CALL_PATTERNS = [
  // Only in scope when the call is actually loading a WORK ITEM's spec (see
  // SCOPE_WINDOW doc above) — loading a project or phase artifact by ID via
  // this same generic tool is never board-sensitive (projects/phases have no
  // v3 board equivalent).
  {
    name: 'ideate_get_artifact_context',
    re: /ideate_get_artifact_context\s*\(/g,
    scopeRe: WORK_ITEM_SCOPE_RE,
    scopeWindow: SCOPE_WINDOW,
  },
  { name: 'ideate_assemble_context', re: /ideate_assemble_context\s*\(/g },
  { name: 'ideate_update_work_items', re: /ideate_update_work_items\s*\(/g },
  { name: 'ideate_write_work_items', re: /ideate_write_work_items\s*\(/g },
  // ideate_artifact_query is only branch-sensitive when scoped to
  // {type: "work_item"} — other types (project, phase, finding,
  // journal_entry, ...) are not per-item work-item reads and are not in
  // scope for this check. Checked on the call's own line only (every call in
  // the current tree is single-line); a cross-line lookahead would risk
  // bleeding a `type: "work_item"` from an unrelated adjacent call into this
  // one's scope check.
  {
    name: 'ideate_artifact_query(work_item)',
    re: /ideate_artifact_query\s*\(\s*\{[^}]*type:\s*"work_item"/g,
  },
];

function read(absPath, relPath, failures) {
  try {
    return readFileSync(absPath, 'utf8');
  } catch (err) {
    const why =
      err.code === 'ENOENT' ? 'not found'
      : err.code === 'EACCES' || err.code === 'EPERM' ? 'permission denied'
      : (err.code ?? err.message);
    failures.push(`${relPath}: could not read — ${why}`);
    return null;
  }
}

// Recursively collect .md files under `dir` (absolute path), skipping hidden
// directories and node_modules. Returns absolute paths, sorted for
// deterministic output.
function walkMarkdown(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // missing directory — caller decides whether that's fatal
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out.sort();
}

// Strips content that must not be scanned for call sites or board tokens:
// fenced code blocks (```...```) and HTML comments (<!-- ... -->), whether
// single-line or spanning multiple lines. Blanks matched lines in place so
// line numbers reported in violations stay aligned with the original file.
function stripNonProse(rawLines) {
  const out = rawLines.slice();
  let inFence = false;
  let inComment = false;
  for (let i = 0; i < out.length; i++) {
    const line = out[i];

    if (inComment) {
      out[i] = '';
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (inFence) {
      out[i] = '';
      if (/^\s*```/.test(line)) inFence = false;
      continue;
    }
    if (/^\s*```/.test(line)) {
      inFence = true;
      out[i] = '';
      continue;
    }
    // Single-line HTML comment.
    if (/<!--.*-->/.test(line)) {
      out[i] = line.replace(/<!--.*?-->/g, '');
      continue;
    }
    // Multi-line HTML comment start.
    if (/<!--/.test(line)) {
      inComment = true;
      out[i] = line.slice(0, line.indexOf('<!--'));
      continue;
    }
  }
  return out;
}

// Returns [frontmatterStartLine, frontmatterEndLine] (1-indexed, inclusive)
// for a leading YAML frontmatter block delimited by `---` lines, or null if
// the file has none. Frontmatter `tools:` lists name MCP tools without call
// syntax (no parens) so the paren-required detection below already excludes
// them, but this is kept as a defensive second layer.
function frontmatterRange(lines) {
  if (lines.length === 0 || !/^---\s*$/.test(lines[0])) return null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) return [1, i + 1];
  }
  return null;
}

export function run(rootDir) {
  const failures = [];
  const violations = [];

  const skillsDir = join(rootDir, 'skills');
  const agentsDir = join(rootDir, 'agents');

  const files = [];
  for (const abs of walkMarkdown(skillsDir)) files.push(abs);
  // agents/*.md — direct children only, not recursive.
  let agentEntries = [];
  try {
    agentEntries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    agentEntries = [];
  }
  for (const entry of agentEntries) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(agentsDir, entry.name));
  }
  files.sort();

  if (files.length === 0) {
    failures.push('no skill/agent markdown files found under skills/ or agents/ — check rootDir');
  }

  for (const absPath of files) {
    const relPath = relative(rootDir, absPath);
    const content = read(absPath, relPath, failures);
    if (content === null) continue; // read() already reported the miss

    const rawLines = content.split('\n');
    const lines = stripNonProse(rawLines);
    const fm = frontmatterRange(lines);

    for (const pattern of CALL_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        if (fm && lineNum >= fm[0] && lineNum <= fm[1]) continue; // frontmatter tool list, not a call site

        const line = lines[i];
        pattern.re.lastIndex = 0;
        let m;
        while ((m = pattern.re.exec(line)) !== null) {
          // Defensive backstop: an explicit negative instruction on the same
          // line is itself the board-aware branch (see NEGATIVE_INSTRUCTION_RE
          // doc comment above).
          if (NEGATIVE_INSTRUCTION_RE.test(line)) continue;

          if (pattern.scopeRe) {
            const scopeStart = Math.max(0, i - pattern.scopeWindow);
            const scopeEnd = Math.min(lines.length, i + pattern.scopeWindow + 1);
            const scopeText = lines.slice(scopeStart, scopeEnd).join('\n');
            if (!pattern.scopeRe.test(scopeText)) continue; // not work-item-scoped — out of scope for this check
          }

          const windowStart = Math.max(0, i - WINDOW);
          const windowEnd = Math.min(lines.length, i + WINDOW + 1);
          const windowText = lines.slice(windowStart, windowEnd).join('\n');

          if (BOARD_TOKEN_RE.test(windowText)) continue; // compliant — board-aware marker in window

          violations.push({
            file: relPath,
            line: lineNum,
            tool: pattern.name,
            text: rawLines[i].trim(),
          });
        }
      }
    }
  }

  const summary =
    violations.length === 0 && failures.length === 0
      ? `check-board-awareness: OK — ${files.length} skill/agent file(s) scanned, no unbranched work-item call sites`
      : `check-board-awareness: ${violations.length} violation(s), ${failures.length} read failure(s)`;

  return { ok: violations.length === 0 && failures.length === 0, violations, failures, summary };
}

// --- CLI entry point --------------------------------------------------------
// Only runs (and only ever prints / calls process.exit) when this file is
// executed directly, e.g. `node scripts/check-board-awareness.mjs` — never
// on import, so tests can `import { run }` without side effects.
// Realpath-normalized on BOTH sides (P-41 pattern, per check-shared-pins.mjs
// F-298-001 C1): invoked through a symlink, argv[1] stays the symlink path
// while import.meta.url resolves to the target — a naive string compare
// would silently never match and the CLI would become a print-nothing exit-0
// no-op.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  const { ok, violations, failures, summary } = run(ROOT);
  if (!ok) {
    console.error('check-board-awareness: FAILED');
    for (const f of failures) console.error(`  - ${f}`);
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}: [${v.tool}] ${v.text}`);
    }
    process.exit(1);
  }
  console.log(summary);
}
