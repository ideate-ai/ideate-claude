#!/usr/bin/env node
// scripts/check-board-awareness.mjs — committed board-awareness completeness
// check (WI-320; enacts domain policy P-46; hardened by WI-324 to enact
// domain policy P-48).
//
// P-46's problem statement: for three straight cycles, a fix scoped to named
// skill/agent sections missed a SIBLING section that still assumed every
// work item resolves via the v2 `ideate_get_artifact_context` path — i.e.
// the fix never accounted for v3 board-resident work items. A committed,
// mechanical grep-check makes "swept complete" verifiable forever instead of
// re-relying on a human re-reading every prose surface each cycle.
//
// P-48's problem statement (cycle-13 capstone): a GREEN result from the
// WI-320 check was FALSE CONFIDENCE — its monitored-shape set was
// INCOMPLETE. Three real gaps slipped through a green run:
//   - code-C1: `ideate_get_execution_status()` (the completion signal) was
//     entirely unmonitored — unbranched in 3 autopilot sites, fixed by
//     WI-322/323's board-status merge, but the check itself never would
//     have caught a regression.
//   - gap-C1: `ideate_write_artifact({type: "work_item"})` — the v2-redirect
//     CREATION shape (the server redirects both this and
//     `ideate_write_work_items` to the same v2 sink) — was unmonitored;
//     init's original v2-only path used this and was invisible to the check.
//   - gap-C2: the WRITE-shape window was too wide. Triage's unbranched write
//     was FALSE-CLEARED because a board token 2 lines away (in a sibling
//     numbering paragraph, not the same sentence/bullet) fell inside the
//     ±12-line WINDOW used for reads.
// P-48 requires a COMMITTED COVERAGE MANIFEST (see COVERAGE_MANIFEST below)
// enumerating every call shape reaching the v2 work-item sink — a green
// check is only trustworthy if the manifest itself is verified complete
// (every CALL_PATTERNS entry manifested, every manifest entry fixture-tested;
// see the "coverage manifest completeness" tests in the test file).
//
// What this checks: every skill/agent markdown file for BRANCH-SENSITIVE
// work-item tool call sites — the call shapes that behave differently
// depending on whether a work item lives in the v2 artifact store or on the
// v3 board. See COVERAGE_MANIFEST below for the authoritative, tested
// enumeration (CREATE / COMPLETE / READ / UPDATE).
//
// A call site is COMPLIANT if a board-awareness token (`board_items`,
// `board item`, `board-aware`, `work_list`, `work_get`, `work_claim`,
// `work_complete`, `spec_format`, `CANONICAL`, `work_create`,
// "Sourcing a work item", a v2 fallback marker, etc.) appears within a
// bounded line window around it — prose written to route board-resident
// items differently reliably mentions one of these nearby (verified against
// the current, already-swept surfaces in skills/execute, skills/refine,
// skills/review, and the autopilot phase docs). A call site with NO such
// marker in-window is a VIOLATION: prose that still silently assumes the
// v2-only path.
//
// Two different window widths are in play (per-pattern `boardWindow`,
// documented per-entry in COVERAGE_MANIFEST):
//   - WINDOW (12 lines) for READ/COMPLETE/UPDATE shapes — a marker stated
//     once per subsection (e.g. a heading's "Board-aware (v3)" callout
//     governing a short paragraph of call sites) still clears.
//   - WRITE_WINDOW (0 — same line/paragraph only) for CREATE-verb WRITE
//     shapes (`ideate_write_work_items`, `ideate_write_artifact({type:
//     "work_item"})`) — P-48 gap-C2 (see above): a wide window let a token
//     in an UNRELATED sibling paragraph falsely clear an unbranched write.
//     In this repo's convention a markdown paragraph is one long unwrapped
//     physical line, so "same line" IS "same sentence/bullet/paragraph."
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
//
// KNOWN COUPLING (WI-324 incremental-review MINOR, not a defect): in a
// densely-annotated section, a board token belonging to a NEIGHBOURING
// different call can fall within 12 lines of an unrelated read site and
// "cover" for it — so a read site that was reverted to v2-only near an
// already-board-aware sibling could clear on the sibling's token. Accepted
// deliberately: heading-bounded windows would add real complexity for a
// narrow gain, and the CREATE-verb WRITE shapes (the ones cycle-13 actually
// regressed on) already use WRITE_WINDOW=0, which is immune to this. Revisit
// only if a real read-site regression is ever traced to it.
const WINDOW = 12;

// P-48 (WI-324, gap-C2): the tight window for CREATE-verb WRITE shapes
// (`ideate_write_work_items`, `ideate_write_artifact({type: "work_item"})`).
// cycle-13's triage false-negative happened because WINDOW (12 lines) let a
// board token in a SIBLING paragraph (2 lines away, but a different bullet)
// falsely clear an unbranched write. Mirrors the SCOPE_WINDOW=0 discipline
// below: 0 means "this line only" — and since this repo's markdown
// paragraphs are unwrapped single physical lines, "this line" already means
// "this sentence/bullet/paragraph." A wider window here would reintroduce
// exactly the gap P-48 closed.
const WRITE_WINDOW = 0;

// Board-awareness / v2-fallback tokens. Matched case-insensitively — the
// three casing variants named in the policy (`board-aware`, `Board-aware`,
// `Board-Aware`) are one case-insensitive pattern here, and "CANONICAL" is
// folded in the same way since prose casing of the "(CANONICAL)" heading
// marker is not load-bearing for this check. `work_create` was added by
// WI-324/P-48: a tight one-sentence WRITE window may carry only "created via
// work_create" as its sole board signal, without also saying "board" or
// "board-aware" explicitly.
const BOARD_TOKEN_RE =
  /board_items|board item|board-aware|work_list|work_get|work_claim|work_complete|work_create|spec_format|canonical|sourcing a work item|v2 fallback|v2 item|v2-phase|legacy item/i;

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

// Work-item scope signal for `ideate_get_workspace_status` (WI-324, same
// tuning class as WORK_ITEM_SCOPE_RE above). `ideate_get_workspace_status` is
// a GENERIC tool: the great majority of its call sites resolve the project
// root / check the artifact directory exists / confirm MCP availability —
// path-and-existence concerns that are NOT board-sensitive (a project root is
// a project root regardless of where work items live). It IS board-sensitive
// whenever its output is used to see WORK-ITEM state, which it computes
// v2-only (`countNodes({type: "work_item"})`, no board merge) — the same
// board-blindness class as `ideate_get_execution_status`. Two such uses, both
// signaled on the call's own line (SCOPE_WINDOW=0, same as get_artifact_context):
//   (a) PROGRESS-REPORTING — a `{view: ...}` argument (a status/progress
//       VIEW), or explicit progress vocabulary (completed / in-progress /
//       remaining counts / status summary / item counts / progress report).
//   (b) WORK-ITEM VERIFICATION — a "work item"/"work_item" mention together
//       with a verify/confirm/present token (WI-324 rework: WI-322 made init
//       create work items on the BOARD, so an init self-check that verifies
//       "all work items are present" via the v2-only workspace status would
//       report board items missing — board-sensitive, must be monitored).
// Verified against the current tree: this matches exactly the three
// progress-reporting sites (execute:613, project:46, status:42) plus the four
// init verification sites (init:439, init:1003, init:1018, init:1155), and
// excludes all ~8 project-root-resolution / MCP-availability calls — flagging
// those would be a false positive, not a board-awareness gap. The verification
// branch uses lookahead so "work item" and the verify/confirm/present token
// may appear in either order on the line.
const WORKSPACE_STATUS_PROGRESS_RE = new RegExp(
  [
    // (a) progress-reporting vocabulary / a status-view argument
    /\{\s*view\s*:/,
    /status summary/,
    /item counts/,
    /completed,/,
    /in-progress/,
    /remaining/,
    /progress report/,
    // (b) work-item verification: a work-item mention AND a verify/confirm/
    // present token, in either order, on the same line
    /(?=[^\n]*work[ _]item)[^\n]*\b(?:verify|confirm|present)\b/,
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
);

const CALL_PATTERNS = [
  // Only in scope when the call is actually loading a WORK ITEM's spec (see
  // SCOPE_WINDOW doc above) — loading a project or phase artifact by ID via
  // this same generic tool is never board-sensitive (projects/phases have no
  // v3 board equivalent).
  {
    name: 'ideate_get_artifact_context',
    verb: 'READ',
    re: /ideate_get_artifact_context\s*\(/g,
    scopeRe: WORK_ITEM_SCOPE_RE,
    scopeWindow: SCOPE_WINDOW,
    boardWindow: WINDOW,
  },
  {
    name: 'ideate_assemble_context',
    verb: 'READ',
    re: /ideate_assemble_context\s*\(/g,
    boardWindow: WINDOW,
  },
  {
    name: 'ideate_update_work_items',
    verb: 'UPDATE',
    re: /ideate_update_work_items\s*\(/g,
    boardWindow: WINDOW,
  },
  // CREATE verb, WRITE shape 1 of 2 (v2-direct). Tightened window: P-48
  // gap-C2 — see WRITE_WINDOW doc above.
  {
    name: 'ideate_write_work_items',
    verb: 'CREATE',
    re: /ideate_write_work_items\s*\(/g,
    boardWindow: WRITE_WINDOW,
  },
  // CREATE verb, WRITE shape 2 of 2 (v2-redirect). WI-324/P-48 gap-C1: the
  // server redirects both `ideate_write_work_items` and
  // `ideate_write_artifact({type: "work_item"})` to the same v2 sink, so
  // they are semantically equivalent creation calls — but the pre-WI-324
  // check only monitored the former. init's original v2-only path used this
  // shape and was invisible. Same tight window as the sibling WRITE shape,
  // for the same gap-C2 reason. Checked on the call's own line only, same
  // rationale as ideate_artifact_query(work_item) below.
  {
    name: 'ideate_write_artifact(work_item)',
    verb: 'CREATE',
    re: /ideate_write_artifact\s*\(\s*\{[^}]*type:\s*"work_item"/g,
    boardWindow: WRITE_WINDOW,
  },
  // CREATE verb, the v3 board-native creation call — the COMPLIANT TARGET
  // itself, not a violation. WI-324/P-48: monitored (so the coverage
  // manifest can claim CREATE-verb completeness and a fixture can prove the
  // non-violation) but `neverViolation` means a match here is never flagged
  // regardless of surrounding tokens — calling `work_create` at all IS the
  // board-aware branch.
  {
    name: 'work_create',
    verb: 'CREATE',
    re: /\bwork_create\s*\(/g,
    neverViolation: true,
  },
  // COMPLETE verb. WI-324/P-48 code-C1: the completion signal was entirely
  // unmonitored before this — unbranched in 3 autopilot sites, since fixed
  // by WI-322/323's board-status merge. Zero-arg call; read-shape window
  // (same as the other read/complete shapes — a marker stated once per
  // subsection still clears).
  {
    name: 'ideate_get_execution_status',
    verb: 'COMPLETE',
    re: /ideate_get_execution_status\s*\(\s*\)/g,
    boardWindow: WINDOW,
  },
  // READ verb (WI-324 rework, incremental-review FOURTH shape). A generic
  // workspace-status tool that computes work-item state v2-only (countNodes)
  // with no board merge — same board-blindness class as get_execution_status.
  // Matches BOTH the bare `()` and `{view: ...}` call forms, then SCOPE-GATES
  // to the two board-sensitive work-item uses only
  // (WORKSPACE_STATUS_PROGRESS_RE; see its doc above): (a) progress-reporting
  // and (b) work-item verification. The many project-root-resolution /
  // MCP-availability call sites are out of scope, exactly as
  // get_artifact_context excludes project/phase loads. Read-shape window (a
  // marker stated once per subsection still clears).
  {
    name: 'ideate_get_workspace_status',
    verb: 'READ',
    re: /ideate_get_workspace_status\s*\(/g,
    scopeRe: WORKSPACE_STATUS_PROGRESS_RE,
    scopeWindow: SCOPE_WINDOW,
    boardWindow: WINDOW,
  },
  // ideate_artifact_query is only branch-sensitive when scoped to
  // {type: "work_item"} — other types (project, phase, finding,
  // journal_entry, ...) are not per-item work-item reads and are not in
  // scope for this check. Checked on the call's own line only (every call in
  // the current tree is single-line); a cross-line lookahead would risk
  // bleeding a `type: "work_item"` from an unrelated adjacent call into this
  // one's scope check.
  {
    name: 'ideate_artifact_query(work_item)',
    verb: 'READ',
    re: /ideate_artifact_query\s*\(\s*\{[^}]*type:\s*"work_item"/g,
    boardWindow: WINDOW,
  },
];

// --- P-48 COVERAGE MANIFEST -------------------------------------------------
// WI-324: enacts P-48's requirement for a committed manifest enumerating
// EVERY call shape reaching the v2 work-item sink, grouped by verb, before a
// green run() result licenses a "class closed" claim. Every entry's `name`
// MUST match a CALL_PATTERNS entry above (cross-referenced, not duplicated —
// see the test file's "coverage manifest completeness" tests, which assert
// CALL_PATTERNS and COVERAGE_MANIFEST name sets are identical, and that
// every fixtureName here corresponds to a real registered test).
//
// EXCLUSIONS (P-48 symmetry: a shape ruled OUT of scope needs a recorded
// rationale just as much as an included one, so the exclusion is a decision
// and not a silent gap):
//   - `ideate_archive_cycle` — OUT of scope. It archives completed work
//     items and findings into the v2 cycle-scoped artifact tree. Board items
//     are RETAINED on the live board and archived through their OWN board
//     lifecycle (D-40), NOT through the v2 artifact tree that
//     ideate_archive_cycle operates on — so this call never reaches the v2
//     work-item sink this check guards, and there is no v2-vs-board branch to
//     be aware of at its call sites. (Its own not-for-slot-rotation caveat is
//     documented in skills/review/SKILL.md, a separate concern.)
export const COVERAGE_MANIFEST = [
  {
    verb: 'CREATE',
    name: 'ideate_write_work_items',
    window: 'boardWindow=WRITE_WINDOW=0 (same line/paragraph) — P-48 gap-C2: WINDOW=12 false-cleared the cycle-13 triage false-negative (board token 2 lines away, separate paragraph)',
    fixtureName: 'ideate_write_work_items: a board token in a SEPARATE paragraph 2 lines away does NOT clear (reproduces the cycle-13 triage false-negative; WRITE_WINDOW catches it)',
  },
  {
    verb: 'CREATE',
    name: 'ideate_write_artifact(work_item)',
    window: 'boardWindow=WRITE_WINDOW=0 (same line/paragraph) — the v2-redirect creation shape, semantically equivalent to ideate_write_work_items (P-48 gap-C1: init used this, invisible to the pre-WI-324 check)',
    fixtureName: 'ideate_write_artifact({type: "work_item"}): unbranched write is flagged; a same-line board-create token clears',
  },
  {
    verb: 'CREATE',
    name: 'work_create',
    window: 'n/a (neverViolation) — this IS the v3 board-compliant target, never a violation regardless of nearby tokens',
    fixtureName: 'work_create: an unbranched call is NEVER flagged, even with zero board tokens anywhere in the file',
  },
  {
    verb: 'COMPLETE',
    name: 'ideate_get_execution_status',
    window: 'boardWindow=WINDOW=12 (read-shape window) — P-48 code-C1: unbranched in 3 autopilot sites, since fixed by WI-322/323\'s board-status merge',
    fixtureName: 'ideate_get_execution_status: unbranched call is flagged; a board-awareness token within the read window clears',
  },
  {
    verb: 'READ',
    name: 'ideate_get_artifact_context',
    window: 'scopeWindow=0 (work-item-scope gate, same line only) + boardWindow=WINDOW=12 (board-token compliance)',
    fixtureName: 'is NOT vacuous: a known-unbranched call site is flagged as a violation naming the file',
  },
  {
    verb: 'READ',
    name: 'ideate_get_workspace_status',
    window: 'scopeWindow=0 (WORKSPACE_STATUS_PROGRESS_RE gate, same line only — covers BOTH work-item progress-reporting AND work-item verification reads; excludes project-root-resolution / MCP-availability calls) + boardWindow=WINDOW=12 (board-token compliance). WI-324 rework: computes work-item state v2-only (countNodes), same board-blindness class as ideate_get_execution_status; verification use added because WI-322 moved init work-item creation onto the board, so a v2-only "verify all work items present" self-check is board-blind',
    fixtureName: 'ideate_get_workspace_status: unbranched progress read is flagged; a board token clears; a project-root-resolution call is out of scope',
  },
  {
    verb: 'READ',
    name: 'ideate_assemble_context',
    window: 'boardWindow=WINDOW=12',
    fixtureName: 'ideate_assemble_context: unbranched call is flagged; a board token within the read window clears',
  },
  {
    verb: 'READ',
    name: 'ideate_artifact_query(work_item)',
    window: 'boardWindow=WINDOW=12; same-line scope gate for {type: "work_item"}',
    fixtureName: 'ideate_artifact_query({type: "work_item"}) unbranched IS flagged, and clears with a board token',
  },
  {
    verb: 'UPDATE',
    name: 'ideate_update_work_items',
    window: 'boardWindow=WINDOW=12',
    fixtureName: 'ideate_update_work_items: unbranched call is flagged; a board token within the read window clears',
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
          // work_create is the v3 board-compliant target itself — calling it
          // at all IS the board-aware branch, never a violation (P-48; see
          // CALL_PATTERNS doc comment above).
          if (pattern.neverViolation) continue;

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

          // Per-pattern board-token search window (P-48): READ/COMPLETE/
          // UPDATE shapes use the wide WINDOW; CREATE-verb WRITE shapes use
          // the tight WRITE_WINDOW (see boardWindow doc comments on
          // CALL_PATTERNS entries above). Falls back to WINDOW if a pattern
          // does not specify one.
          const boardWindow = pattern.boardWindow ?? WINDOW;
          const windowStart = Math.max(0, i - boardWindow);
          const windowEnd = Math.min(lines.length, i + boardWindow + 1);
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
