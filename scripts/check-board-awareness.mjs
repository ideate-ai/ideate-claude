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
  // READ verb (WI-327, cycle-14 code-C2/gap-C1 — the FOURTH read shape that
  // escaped the pre-WI-327 check). `ideate_get_review_manifest` builds its
  // manifest rows from v2 `work_item` nodes only (fetchAllWorkItems); on a
  // board project those rows omit board-resident items, and the tool now
  // prepends the WI-326 loud-incomplete marker. A prose site that surfaces the
  // manifest without honoring the marker / appending board rows is board-blind
  // — same class as get_execution_status. Read-shape window (a marker stated
  // once per subsection still clears). Matches the zero-arg and cycle-arg forms.
  {
    name: 'ideate_get_review_manifest',
    verb: 'READ',
    re: /ideate_get_review_manifest\s*\(/g,
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
    name: 'ideate_get_review_manifest',
    window: 'boardWindow=WINDOW=12 (read-shape window) — WI-327: the 4th read shape (cycle-14 code-C2/gap-C1), builds rows from v2 work_item nodes only; on a board project a surfacing site must honor the WI-326 marker and append board rows',
    fixtureName: 'ideate_get_review_manifest: unbranched call is flagged; a board token within the read window clears',
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

// --- P-48 REGISTRY GROUNDING (WI-327) ---------------------------------------
// gap-S1 (cycle-14 capstone, THE ROOT CAUSE): the pre-WI-327 completeness test
// only cross-checked CALL_PATTERNS against COVERAGE_MANIFEST — two hand-lists
// validated against EACH OTHER, never against the authoritative tool registry.
// So a newly-registered v2 work-item-read tool (get_review_manifest was the
// 4th) sailed through green indefinitely: nothing forced it to be classified.
//
// The fix (P-48's how_to_apply, registry-grounding endpoint): every tool in the
// AUTHORITATIVE v2 registry (mcp/artifact-server/src/tools/index.ts) must be
// EITHER monitored by a CALL_PATTERNS shape OR carry an explicit
// excluded-with-rationale entry. A tool in neither breaks the registry-grounded
// completeness test (registryCoverageGaps below) — it CANNOT silently escape.
// This is what makes a green check license a class-closed claim.

// Maps each monitored CALL_PATTERNS shape to the registered v2 tool it covers.
// Some patterns are type-scoped views of a generic tool (e.g.
// artifact_query(work_item) → ideate_artifact_query). `work_create` is a v3
// board tool, NOT in the v2 registry — it is the compliant target, monitored
// for coverage but absent from the registry diff (see registryCoverageGaps).
export const MONITORED_REGISTRY_TOOLS = {
  ideate_get_artifact_context: 'ideate_get_artifact_context',
  ideate_assemble_context: 'ideate_assemble_context',
  ideate_update_work_items: 'ideate_update_work_items',
  ideate_write_work_items: 'ideate_write_work_items',
  'ideate_write_artifact(work_item)': 'ideate_write_artifact',
  ideate_get_execution_status: 'ideate_get_execution_status',
  ideate_get_review_manifest: 'ideate_get_review_manifest',
  ideate_get_workspace_status: 'ideate_get_workspace_status',
  'ideate_artifact_query(work_item)': 'ideate_artifact_query',
  // work_create: v3 board tool, not registered in the v2 index.ts — no diff entry.
};

// Every registered v2 tool NOT monitored above, each with a rationale for why
// it does not reach the v2 work-item state sink this check guards. P-48: an
// exclusion is a recorded decision, not a silent gap. Adding a new registered
// tool without classifying it here (or monitoring it) FAILS registryCoverageGaps.
export const REGISTRY_EXCLUSIONS = {
  ideate_get_context_package: 'Returns architecture / guiding principles / constraints — no work-item data.',
  ideate_get_config: 'Returns project configuration — no work-item data.',
  ideate_get_convergence_status: 'Returns findings-by-severity + cycle-summary verdict — no work-item counts (WI-326 registry cross-check confirmed).',
  ideate_get_domain_state: 'Returns domain policies / decisions / questions — no work-item data.',
  ideate_check_workspace: 'Workspace structure/health diagnostics — no per-item work-item read.',
  ideate_get_tool_usage: 'Tool-call telemetry — no work-item data.',
  ideate_append_journal: 'Writes a journal entry — not a work-item write or read.',
  ideate_archive_cycle: 'Archives completed v2 work items/findings into the cycle-scoped artifact tree; board items are RETAINED on the live board and archived through their own lifecycle (D-40), so this never reaches the v2 work-item sink this check guards.',
  ideate_emit_event: 'Fires a hook event — no work-item data.',
  ideate_bootstrap_workspace: 'One-time workspace scaffolding — no work-item read/write.',
  ideate_get_next_id: 'Allocates the next artifact ID. Board-BLIND for WI numbering (Q-51 symptom-9), but that is a NUMBERING-COLLISION class — compensated at the skill level (WI-315: max across the artifact index and board items) with the durable fix being server-side board-aware numbering — NOT the work-item STATE read/write/complete class this check guards. Tracked separately from board-awareness.',
  ideate_manage_autopilot_state: 'Reads/writes autopilot session state — no work-item data.',
  ideate_update_config: 'Writes project configuration — no work-item data.',
};

// Path (relative to the ideate-claude repo root) of the authoritative v2 tool
// registry. registryCoverageGaps grounds coverage against THIS file, not
// against COVERAGE_MANIFEST — that is the whole point of gap-S1's fix.
export const REGISTRY_PATH = 'mcp/artifact-server/src/tools/index.ts';

// Parse the registered v2 tool names from index.ts. Returns a sorted array of
// `ideate_*` names taken from the `name: "ideate_..."` tool-definition entries.
export function readRegisteredTools(repoRoot) {
  const abs = join(repoRoot, REGISTRY_PATH);
  const src = readFileSync(abs, 'utf8');
  const names = new Set();
  const re = /name:\s*"(ideate_[a-z_]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return [...names].sort();
}

// The registry-grounded completeness check (gap-S1 fix). Given the list of
// registered tool names, returns { unclassified, stale }:
//   - unclassified: registered tools that are NEITHER monitored NOR excluded —
//     a new sink-reaching tool cannot hide here; this array being non-empty is
//     the failure that forces classification.
//   - stale: monitored/excluded entries that name a tool no longer in the
//     registry (a rename/removal left a dangling classification).
// Pure function (takes the name list, not the file) so a fixture can inject a
// fake registered tool and prove the check is registry-grounded, not
// self-referential.
export function registryCoverageGaps(registeredNames) {
  const registered = new Set(registeredNames);
  const monitored = new Set(Object.values(MONITORED_REGISTRY_TOOLS));
  const excluded = new Set(Object.keys(REGISTRY_EXCLUSIONS));

  const unclassified = [...registered]
    .filter((name) => !monitored.has(name) && !excluded.has(name))
    .sort();

  const stale = [...monitored, ...excluded]
    .filter((name) => !registered.has(name))
    .sort();

  return { unclassified, stale };
}

// M2 (cycle-14 carry-forward): belt-and-suspenders assertion that the
// construction guarantees this check RELIES ON are present in the engine
// source — if one is silently removed, this check (whose whole value now rests
// on those guards being real) must fail loudly rather than keep passing on
// prose alone. Reads the engine files under mcp/artifact-server and confirms:
//   - the write sink-guard (WI-321) AND update guard (WI-330): assertBoardNotActive
//   - the read loud-incomplete marker (WI-326): boardActiveNotice in the 3 read tools
//   - the shared presence module (WI-326)
export function engineGuardsPresent(repoRoot) {
  const missing = [];
  // Whitespace-tolerant needles (F-327-001 M2): a Prettier reformat that
  // wraps `assertBoardNotActive(\n  ctx` must not read as a missing guard.
  const checks = [
    { path: 'mcp/artifact-server/src/board-presence.ts', needle: /export function boardActiveNotice\b/, desc: 'WI-326 shared board-presence marker (boardActiveNotice)' },
    { path: 'mcp/artifact-server/src/tools/write.ts', needle: /assertBoardNotActive\s*\(\s*ctx\b/, desc: 'WI-321/WI-330 write+update sink guard (assertBoardNotActive)' },
    { path: 'mcp/artifact-server/src/tools/execution.ts', needle: /boardActiveNotice\s*\(\s*ctx\b/, desc: 'WI-326 read marker on get_execution_status / get_review_manifest' },
    { path: 'mcp/artifact-server/src/tools/analysis.ts', needle: /boardActiveNotice\s*\(\s*ctx\b/, desc: 'WI-326 read marker on get_workspace_status views' },
  ];
  for (const c of checks) {
    let src = '';
    try {
      src = readFileSync(join(repoRoot, c.path), 'utf8');
    } catch {
      missing.push(`${c.desc}: cannot read ${c.path}`);
      continue;
    }
    if (!c.needle.test(src)) missing.push(`${c.desc}: ${c.needle} not found in ${c.path}`);
  }
  // write.ts must guard BOTH sinks — assert the guard appears at least twice
  // (handleWriteWorkItems + handleUpdateWorkItems).
  try {
    const writeSrc = readFileSync(join(repoRoot, 'mcp/artifact-server/src/tools/write.ts'), 'utf8');
    const guardCalls = (writeSrc.match(/assertBoardNotActive\s*\(\s*ctx\b/g) || []).length;
    if (guardCalls < 2) missing.push(`WI-321/WI-330: expected assertBoardNotActive on BOTH the create and update sinks, found ${guardCalls} call(s)`);
  } catch {
    // already reported above
  }
  return { ok: missing.length === 0, missing };
}

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

  // P-48 registry grounding (WI-327): coverage is validated against the
  // authoritative tool registry, not against COVERAGE_MANIFEST alone.
  let registry = { unclassified: [], stale: [] };
  let registryReadError = null;
  try {
    registry = registryCoverageGaps(readRegisteredTools(ROOT));
  } catch (err) {
    registryReadError = err.message ?? String(err);
  }
  const registryOk = registryReadError === null && registry.unclassified.length === 0 && registry.stale.length === 0;

  // M2 (WI-327): the construction guarantees this check relies on are present.
  const guards = engineGuardsPresent(ROOT);

  const allOk = ok && registryOk && guards.ok;
  if (!allOk) {
    console.error('check-board-awareness: FAILED');
    for (const f of failures) console.error(`  - ${f}`);
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}: [${v.tool}] ${v.text}`);
    }
    if (registryReadError) console.error(`  - registry grounding: could not read ${REGISTRY_PATH} — ${registryReadError}`);
    for (const name of registry.unclassified) {
      console.error(`  - registry grounding: tool "${name}" is registered but NEITHER monitored NOR excluded-with-rationale (P-48) — classify it in MONITORED_REGISTRY_TOOLS or REGISTRY_EXCLUSIONS`);
    }
    for (const name of registry.stale) {
      console.error(`  - registry grounding: "${name}" is monitored/excluded but no longer registered — remove the stale classification`);
    }
    for (const m of guards.missing) {
      console.error(`  - engine guard missing: ${m}`);
    }
    process.exit(1);
  }
  console.log(`${summary}; registry-grounded (${readRegisteredTools(ROOT).length} tools classified); engine guards present`);
}
