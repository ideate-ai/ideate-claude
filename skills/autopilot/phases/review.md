# Autopilot Phase 6b: Comprehensive Review Phase

## Entry Conditions

Called after Phase 6a (execute.md) completes. All pending work items have been attempted and have incremental reviews.

Available from controller context:
- `{project_root}` — absolute path to the project root
- `{project_source_root}` — absolute path to project source code
- `{cycle_number}` — current 1-based cycle counter
- `{formatted_cycle_number}` — cycle number zero-padded to 3 digits (e.g., cycle 1 → `001`)
- `{cycle_start_commit}` — git commit hash at start of execute phase (null if not a git repo)
- `{cycle_end_commit}` — git commit hash at end of execute phase

**Cycle output**: All review artifacts for this cycle are written via MCP tools using `cycle: {cycle_number}`. The MCP server manages the underlying storage.

## Instructions

### Read Project Configuration

Call `ideate_get_config()` to read project configuration. Hold the response as `{config}`. Use `{config}.agent_budgets.{agent_name}` as the maxTurns value when spawning agents. If `ideate_get_config` is unavailable or returns no agent_budgets, use the agent's frontmatter maxTurns as fallback. Also hold `{config}.model_overrides` — a map of agent name to model string. When spawning any agent, use `{config}.model_overrides['{agent_name}']` as the model parameter if present and non-empty; otherwise use the hardcoded default listed in the spawn instruction.

### Build Shared Context Package

Call `ideate_get_context_package()` — returns the pre-assembled context package. Hold the result as `{context_package}`.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

**GP-14 enforcement**: If an MCP tool call fails, report the error and stop. Do NOT fall back to reading, grepping, or globbing .ideate/ files directly. The MCP abstraction boundary (GP-14) is inviolable — a tool failure is a signal to fix the tool, not to bypass it.

**PPR-based context assembly (optional)**: For reviews scoped to specific artifacts, `ideate_assemble_context` can provide focused, graph-aware context. Call with seed artifact IDs and a token budget. This is useful when reviewing a specific module or feature area rather than the full project. For capstone reviews covering the full project, `ideate_get_context_package` remains the primary context source.

Pass `{context_package}` inline to all reviewer and journal-keeper prompts. Do not provide file paths to reviewers — pass the assembled content directly.

### Determine Review Scope

Determine whether to use **full review** or **differential review**.

Call `ideate_manage_autopilot_state({action: "get"})` and extract `last_full_review_cycle` and `full_review_interval`. Defaults: `last_full_review_cycle` = 0, `full_review_interval` = 3.

**Full review conditions** (any one → use full review):
- `{cycle_number}` is 1
- `({cycle_number} - last_full_review_cycle) >= full_review_interval`
- `{cycle_start_commit}` is null (git unavailable)

**If full review**: Set `{diff_mode}` = `"full"`. Set `{changed_files}` = all source files. Call `ideate_manage_autopilot_state({action: "update", state: {last_full_review_cycle: {cycle_number}}})`. Continue with Generate Review Manifest.

**If differential** (cycles 2+ within the interval):

1. Run `git diff --name-only {cycle_start_commit}..{cycle_end_commit}` in `{project_source_root}`.
   - If the command fails: fall back to full review. Append via `ideate_append_journal`: "Cycle {N}: differential diff failed — falling back to full review. Reason: {error}." Set `{diff_mode}` = `"full"`. Update `last_full_review_cycle`.
   - If no files changed: append via `ideate_append_journal`: "Cycle {N}: no source files changed — review skipped." Set `{last_cycle_findings}` = `{critical: 0, significant: 0, minor: 0}`. Return to controller immediately — do not spawn reviewers.
   - Otherwise: store file list as `{changed_files}`.

2. **Interface boundary detection**: For each file in `{changed_files}`, grep `{project_source_root}` source files for import/require/include statements referencing that file's name (without extension). Add matching files to `{changed_files}`. Best-effort — the full-review safety net covers any gaps.

3. Set `{diff_mode}` = `"differential"`. Store `{prior_cycle_formatted}` = previous cycle number zero-padded to 3 digits.

### Generate Review Manifest

Call `ideate_get_review_manifest()` — returns a pre-built manifest table matching work items to their incremental review verdicts and finding counts.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

**Board-aware manifest rows (v3)**: `ideate_get_review_manifest()` sees only v2 artifacts. If the v3 work-state tools (`work_list`, `work_events`, …) are present in the session — detection is mechanical tool presence, never inferred (GP-24) — call `work_list` and hold `{board_items}`: items whose `spec_format` is `ideate/wi-v1` (the opaque `spec` payload is the work-item body). Append to `{manifest_content}` one row per board item: WI designation, title, board status, and — via `work_events(id)` — a one-line lifecycle summary (claimed/completed/released, by which actor, with the completion note). Board events are the authoritative status trail for these items; do not second-guess them from journal entries. **Mark each board row** (e.g. a `board` tag) so the reviewer prompts below and the Proportional Review Depth step can tell which items need the CLI-fallback line / spec-payload read. If the work-state tools are absent, the server manifest alone is complete (v2 fallback path) and `{board_items}` is empty — apply the loud-fallback protocol: say in your output, verbatim, "v3 work-state tools not detected — using v2 artifact fallback." If `.ideate-work/` exists on disk at `{project_root}`, escalate: "WARNING: this project has board state (.ideate-work/ exists) but the v3 tools are unavailable — likely a missing build (run `pnpm install && pnpm run build` in the plugin). Board items will be INVISIBLE to this review." A review that silently omits board items misstates coverage — since autopilot runs unattended, route this warning to the proxy-human agent as an Andon event (per `execute.md` "Andon Cord → Proxy-Human Routing") rather than silently proceeding with incomplete coverage.

**Reviewer CLI fallback for board evidence**: reviewer subagents usually lack the v3 MCP tools but have Bash. When a finding needs deeper checking than the manifest's one-line summary, a reviewer can pull a board item's full immutable event history directly: `node plugin/bin/ideate-work events --id <board-item-id>` (run from `{project_source_root}`; `--json` on read verbs for structured output).

Call `ideate_write_artifact({type: "cycle_summary", id: "review-manifest", content: {cycle: {cycle_number}, content: {manifest_content}}, cycle: {cycle_number}})` to write the manifest.

If `{diff_mode}` = `"differential"`: filter the manifest to work items whose scope includes at least one file in `{changed_files}`. Include a note: "Differential review — scope: {N} changed files + {M} boundary files." **Board rows (v3)**: board items carry an opaque `spec` payload with no server-parsed `scope` field, so this file-scope filter cannot match them. Do NOT drop board rows in differential mode — always include every board item from `{board_items}` in the filtered manifest (the Proportional Review Depth step already treats board items as full-coverage-by-default, so including them never under-reviews; silently dropping them is the exact board-blindness this cutover closes).

### Proportional Review Depth

Before spawning reviewers, assess severity and priority for each work item in the review manifest.

For each work item:

1. Read `severity`, `priority`, and `work_item_type` from work item metadata. **Board-aware (v3)**: for a board item (present in `{board_items}`, established via `work_list` in the Generate Review Manifest step), read these fields from its `spec` payload if it carries them; for a v2 item, read from `ideate_artifact_query({type: "work_item"})`, which does NOT return board items. If either severity or priority is absent (common for board items, whose opaque payload need not carry them), default to `medium` — the default path spawns all three reviewers, so an absent value never silently reduces coverage.

2. **Default**: Spawn all three reviewers (code-reviewer, spec-reviewer, gap-analyst).

3. **If BOTH `severity` AND `priority` are `low`**:
   a. Route to the proxy-human agent:
      > Andon: Work item {WI-NNN} is low severity / low priority ({work_item_type}). Proposing code-reviewer only for this item. Approve reduced review?
   b. If the proxy-human approves: spawn code-reviewer only for this item. Log via `ideate_append_journal`: "Reduced review for {WI-NNN}: low severity + low priority. Spawned code-reviewer only. Proxy-human approved."
   c. If the proxy-human rejects or defers: spawn all three reviewers for this item.
   d. If no proxy-human is available: default to full review (spawn all three reviewers). Do not silently reduce review without confirmation.

4. **Capstone review always uses all reviewers regardless of per-item decisions.** The three-reviewer parallel spawn below covers cross-cutting concerns.

The default behavior (full reviewer set) is unchanged for all work items where severity or priority is not `low`, or where only one of the two is `low`.

### Spawn Three Reviewers in Parallel

Spawn all three simultaneously. Do not wait for one before starting another.

**Differential reviewer additions** (include in all three prompts when `{diff_mode}` = `"differential"`):

> **Differential review scope** — this is cycle {cycle_number}; only a subset of files changed since cycle {prior_cycle_formatted}.
>
> **Changed files** (review these and their direct dependencies):
> {changed_files — one path per line}
>
> **Prior cycle baseline**: Retrieve prior cycle review artifacts via `ideate_artifact_query({type: "cycle_summary", cycle: {prior_cycle_number}})`. Use them as a baseline — findings already present in the prior cycle are known; focus on new or changed issues.
>
> Do not re-examine files outside the changed and boundary file lists unless a change in a listed file directly affects an unlisted file's behavior. If you encounter such a case, note it and include the affected file.

**ideate:code-reviewer**
- Model: sonnet
- MaxTurns: `{config}.agent_budgets.code-reviewer` (fallback to agent frontmatter default)
- Tools: Read, Grep, Glob, Bash
- Prompt:
  > You are conducting a comprehensive code review of the entire project.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Review manifest**: Retrieve via `ideate_artifact_query({type: "cycle_summary", id: "review-manifest", cycle: {cycle_number}})` — your index of all work items and incremental review status. Read individual work items and incremental reviews only when investigating specific findings.
  >
  > Project source code is at: {project_source_root} — read source files as needed.
  >
  > Focus on cross-cutting concerns: consistency across modules, patterns spanning multiple work items, integration between components, systemic issues no single-item review could see.
  >
  > **Dynamic testing (comprehensive scope)**: After your static review, perform the dynamic checks defined in your agent instructions under "Step 3 — Comprehensive review scope (full project)". Discover the project's test model and run the full test suite. Report test failures per the severity guidance in your agent instructions.
  >
  > Verdict is Fail if there are any Critical or Significant findings or unmet acceptance criteria. Otherwise Pass.
  >
  > **Board evidence (v3)**: if the manifest marks an item as a `board` row and you need its full lifecycle beyond the manifest's one-line summary, pull the authoritative event trail directly (requires Bash): `node plugin/bin/ideate-work events --id <board-item-id>` from the project root (`--json` for structured output). Use this to verify a finding against a board item rather than trusting the coordinator's summary.
  >
  > Return your complete findings as the final section of your response. Use the standard review output format. Do NOT use the Write tool — return the content in your response.

**ideate:spec-reviewer**
- Model: sonnet
- MaxTurns: `{config}.agent_budgets.spec-reviewer` (fallback to agent frontmatter default)
- Tools: Read, Grep, Glob
- Prompt:
  > Verify that the implementation matches the plan, architecture, and guiding principles.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Module specs**: Call `ideate_artifact_query({type: "module_spec"})` to retrieve all module specs (if they exist).
  >
  > **Review manifest**: Retrieve via `ideate_artifact_query({type: "cycle_summary", id: "review-manifest", cycle: {cycle_number}})` — use as an index. Read individual work items and incremental reviews only when investigating specific findings in their file scope.
  >
  > Project source code is at: {project_source_root} — read source files as needed.
  >
  > Focus on cross-cutting adherence: do all components collectively follow the architecture? Are interfaces consistent across module boundaries? Are guiding principles upheld across the entire codebase?
  >
  > For each guiding principle, state whether it is satisfied or violated. The `## Principle Violations` and `## Principle Adherence Evidence` sections of your output are used for automated convergence checking — ensure both sections are present even if empty.
  >
  > **Board evidence (v3)**: if the manifest marks an item as a `board` row and you need its full lifecycle beyond the manifest's one-line summary, pull the authoritative event trail directly (requires Bash): `node plugin/bin/ideate-work events --id <board-item-id>` from the project root (`--json` for structured output). Use this to verify a finding against a board item rather than trusting the coordinator's summary.
  >
  > Return your complete findings as the final section of your response. Use the standard review output format. Do NOT use the Write tool — return the content in your response.

**ideate:gap-analyst**
- Model: sonnet
- MaxTurns: `{config}.agent_budgets.gap-analyst` (fallback to agent frontmatter default)
- Tools: Read, Grep, Glob
- Prompt:
  > Find what is missing from the implementation — things that should exist but do not.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Interview transcript**: Call `ideate_artifact_query({type: "interview"})` to retrieve the most recent interview transcript. If no interviews exist, proceed without interview context.
  >
  > **Module specs**: Call `ideate_artifact_query({type: "module_spec"})` to retrieve all module specs (if they exist).
  >
  > **Review manifest**: Retrieve via `ideate_artifact_query({type: "cycle_summary", id: "review-manifest", cycle: {cycle_number}})` — use as an index. Read individual work items and incremental reviews only when investigating specific gaps in their file scope.
  >
  > Project source code is at: {project_source_root} — read source files as needed.
  >
  > Focus on gaps spanning the full project: missing requirements from the interview, integration gaps between components, implicit requirements the project as a whole should meet.
  >
  > **Board evidence (v3)**: if the manifest marks an item as a `board` row and you need its full lifecycle beyond the manifest's one-line summary, pull the authoritative event trail directly (requires Bash): `node plugin/bin/ideate-work events --id <board-item-id>` from the project root (`--json` for structured output). Use this to verify a finding against a board item rather than trusting the coordinator's summary.
  >
  > Return your complete findings as the final section of your response. Use the standard review output format. Do NOT use the Write tool — return the content in your response.

Wait for all three to complete. After each reviewer returns, extract the findings from the agent's response and write them via MCP:

- After **code-reviewer** returns: call `ideate_write_artifact({type: "cycle_summary", id: "code-quality", content: {cycle: {cycle_number}, reviewer: "code-reviewer", content: <findings from response>}})`.
- After **spec-reviewer** returns: call `ideate_write_artifact({type: "cycle_summary", id: "spec-adherence", content: {cycle: {cycle_number}, reviewer: "spec-reviewer", content: <findings from response>}})`.
- After **gap-analyst** returns: call `ideate_write_artifact({type: "cycle_summary", id: "gap-analysis", content: {cycle: {cycle_number}, reviewer: "gap-analyst", content: <findings from response>}})`.

After writing all three artifacts, verify the writes succeeded before proceeding.

### Spawn Journal-Keeper (After Reviewers Complete)

**ideate:journal-keeper**
- Model: sonnet
- MaxTurns: `{config}.agent_budgets.journal-keeper` (fallback to agent frontmatter default)
- Tools: Read, Grep, Glob
- Prompt:
  > Synthesize the project history into a decision log and open questions list.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Journal**: Call `ideate_artifact_query({type: "journal_entry"})` to retrieve the most recent journal entries (last 20 entries).
  >
  > **Interview transcript**: Call `ideate_artifact_query({type: "interview"})` to retrieve the most recent interview transcript. If no interviews exist, proceed without interview context.
  >
  > **Plan overview**: Call `ideate_artifact_query({type: "overview"})` to retrieve the plan overview.
  >
  > **Review manifest**: Retrieve via `ideate_artifact_query({type: "cycle_summary", id: "review-manifest", cycle: {cycle_number}})` — use as an index. Read individual incremental reviews only when cross-referencing specific findings.
  >
  > **Review findings** (read via MCP — call `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})` to retrieve the code-quality, spec-adherence, and gap-analysis review artifacts for this cycle).
  >
  > Return your complete output as the final section of your response. Do NOT use the Write tool — return the content in your response.

After the journal-keeper returns, extract the output from the agent's response and write it via MCP: call `ideate_write_artifact({type: "cycle_summary", id: "decision-log", content: {cycle: {cycle_number}, reviewer: "journal-keeper", content: <output from response>}})`.

### Collect Review Findings

Retrieve all four review artifacts via MCP: call `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})` to retrieve code-quality, spec-adherence, gap-analysis, and decision-log artifacts for this cycle.

Walk all findings and classify into: Critical, Significant, Minor, Suggestion.

Build `last_cycle_findings` for return to the controller:
- `critical_count`: number of critical findings
- `significant_count`: number of significant findings
- `minor_count`: number of minor findings

### Emit review.complete Hook

After computing `last_cycle_findings`, call `ideate_emit_event` with:
- event: "review.complete"
- variables: { "CYCLE_NUMBER": "{cycle_number}", "FINDING_COUNT": "{total_finding_count}" }

Where `{total_finding_count}` = `critical_count + significant_count + minor_count`. This call is best-effort — if it fails, continue without interruption.

### Spawn Domain Curator

**ideate:domain-curator**
- Model: opus
- MaxTurns: `{config}.agent_budgets.domain-curator` (fallback to agent frontmatter default)
- Prompt:
  > Maintain the domain knowledge layer for this project.
  >
  > **Project root**: {project_root}
  > **Cycle number**: {cycle_number}
  > **Review type**: cycle
  >
  > **Review source**: Call `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})` to retrieve the code-quality, spec-adherence, gap-analysis, and decision-log review artifacts for this cycle.
  >
  > Follow the domain-curator agent instructions. Extract policy-grade, decision-grade, question-grade, and conflict-grade items from this cycle's review artifacts. **Do not write any artifacts directly.** Return all proposed domain updates as structured content in the final section of your response. For each update, include the artifact type, designation, and the full content.

Wait for the curator to complete. After the curator returns:
1. Parse its response to extract each domain artifact it proposes to write (type, designation, content).
2. For each proposed domain update, call `ideate_write_artifact` with the correct artifact type:
   - For policies: `ideate_write_artifact({type: "domain_policy", id: "P-{N}", content: {...}})`
   - For decisions: `ideate_write_artifact({type: "domain_decision", id: "D-{N}", content: {...}})`
   - For questions: `ideate_write_artifact({type: "domain_question", id: "Q-{N}", content: {...}})`
3. Update the domain index: call `ideate_write_artifact({type: "domain_index", content: {current_cycle: {cycle_number}}})`.
4. Verify that at least one domain artifact was written. If not, note the failure in the journal.

### Archive Cycle (After Domain Curator)

Call `ideate_archive_cycle({cycle_number})` — archives completed work items and findings into the cycle directory. This is equivalent to the standalone review skill's Phase 7.5 archival.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

### Update Journal

Append a review summary via `ideate_append_journal`.

Call `ideate_append_journal("autopilot", {date}, "review_complete", {body})` — appends a structured journal entry atomically.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

```markdown
## [autopilot] {date} — Cycle {N} review complete
Critical findings: {N}
Significant findings: {N}
Minor findings: {N}
```

### Phase 6c: Convergence Branch (three-way)

This section is invoked by the controller immediately after `ideate_get_convergence_status` returns. It defines the three-way branching on `principle_verdict`. The controller reads this section for Phase 6c; Phase 6c-ii is a separate step that only runs if this section confirms convergence.

**Why three branches, not two**: `principle_verdict: unknown` means the automated checker could not establish a trustworthy Pass/Fail verdict for the current cycle — either because the spec-adherence output was present but in an unexpected format (a *parse failure*, `principle_verdict_source: step3`), or because the only spec-adherence artifact found belongs to an earlier cycle (a *stale cycle-slot artifact*, `principle_verdict_source: stale` — WI-221). Neither case is a *principle violation*. Treating `unknown` the same as `fail` hides tooling/data defects as convergence failures and can send autopilot into an infinite refine loop that never resolves the underlying issue. The `unknown` case must be surfaced explicitly, with the specific cause distinguished, so the user or proxy-human can diagnose and resolve it (fix the formatter output, or re-run review to refresh a stale slot) rather than guessing.

#### Step 1: Parse the convergence status payload

The payload from `ideate_get_convergence_status` is YAML text. Parse these fields:

- `converged` — boolean
- `condition_a` — boolean (zero critical/significant findings)
- `condition_b` — boolean
- `principle_verdict` — string: `pass`, `fail`, or `unknown`
- `principle_verdict_source` — string: `step1`, `step2`, `step3`, or `stale`. `stale` (WI-221) means a spec-adherence artifact WAS found but its own recorded cycle predates `{cycle_number}` — the cycle-directory slot was reused and never refreshed for the current cycle. This is distinct from a generic parser failure (`step3`) and calls for a different remediation (re-run review for the current cycle, not fix the parser).
- `principle_verdict_warning` — string (present only when `principle_verdict` is `unknown`). Format: `unexpected format; patterns tried: <patterns>; content snippet: <snippet>` for a generic parse failure, or a staleness-specific message (mentioning "stale" and the artifact's recorded cycle) when `principle_verdict_source` is `stale` or when a stale artifact was detected while no content matched the current cycle at all.
- `stale_artifact_cycle` — integer (present only when a stale artifact was detected, whether or not `principle_verdict_source` is `stale`): the cycle the stale artifact actually belongs to.
- `stale_artifact_cycle_modified` — integer or `null` (present alongside `stale_artifact_cycle`): the stale artifact's node-level `cycle_modified` bookkeeping field, for additional diagnosis.

When `principle_verdict` is `unknown`, also derive these two discrete diagnostic fields from `principle_verdict_warning`:

- `patterns_tried` — the substring between `patterns tried: ` and `; content snippet:` in `principle_verdict_warning`. If the marker is absent (e.g. a staleness warning, which has no "patterns tried" segment), set to the literal string `"(parse failed — warning format unexpected)"`.
- `content_snippet` — the substring after `content snippet: ` in `principle_verdict_warning` (trailing, no further delimiter). If absent, set to the literal string `"(parse failed — warning format unexpected)"`.

These two fields are surfaced as distinct lines in the Andon event below so that the proxy-human (and any future automated handler) can inspect them without re-parsing the composite warning string.

#### Step 2: Three-way branch on `principle_verdict`

**Branch A — `principle_verdict: pass`**

Set `{phase_converged}` = `condition_a` (i.e., `true` only if there are also zero critical/significant findings). In this branch `converged` from the payload equals `condition_a` — `condition_b` is already `true`, so `converged = condition_a AND condition_b` reduces to `converged = condition_a`. Use `converged` from the payload directly for routing: proceed to Phase 6c-ii if `converged` is true; otherwise proceed to Phase 6d.

**Branch B — `principle_verdict: fail`**

Set `{phase_converged}` = false. Proceed to Phase 6d (refinement). This is the normal non-convergence path: principles are violated and must be addressed.

**Branch C — `principle_verdict: unknown`** (parse failure — NOT a principle violation)

Resolves Q-159 — unknown verdict must be distinguished from fail so the proxy-human can diagnose parser failures separately from principle violations.

Do NOT proceed to Phase 6d. Instead, raise an Andon event carrying the full diagnostic context. The event content differs slightly depending on whether `principle_verdict_source` is `stale` (WI-221 — a spec-adherence artifact exists but belongs to an earlier cycle) or a generic parse failure (`step3`), because the two causes call for different remediation:

1. **If `principle_verdict_source` is `stale`, or `stale_artifact_cycle` is present** (a stale artifact was detected — see Step 1): formulate the Andon event as a cycle-slot staleness event, not a generic parse failure:
   ```
   Andon: principle_verdict:unknown (stale cycle-slot artifact) — spec-adherence has not
   been refreshed for the current cycle.
   Cycle: {cycle_number}
   principle_verdict_warning: {principle_verdict_warning field from payload}
   stale_artifact_cycle: {stale_artifact_cycle field from payload}
   stale_artifact_cycle_modified: {stale_artifact_cycle_modified field from payload}
   condition_a: {condition_a} (zero critical/significant findings: {true|false})
   Cause: a spec-adherence artifact was found, but it was last written for cycle
   {stale_artifact_cycle} — not the requested cycle {cycle_number}. The cycle-directory
   slot was reused (or a prior review's write to this slot never completed) and has not
   been refreshed. This is NOT a parser defect and NOT a confirmed principle violation —
   there is simply no verified review output for the current cycle yet.
   Options:
     (a) Re-run `/ideate:review` for cycle {cycle_number} to refresh the stale slot, then
         retry the convergence check — this is the preferred resolution.
     (b) Treat as fail for this cycle — proceed to refinement without a verified review
         (use only if re-running review is not currently possible).
     (c) Halt autopilot — stop and let the user inspect the situation directly.
   ```
   Do NOT offer "treat as pass" for a stale-artifact Andon — the stale artifact's own verdict must never be treated as authoritative for the current cycle (this is the exact WI-221/PR-002 failure mode: silently trusting a leftover artifact).

2. **Otherwise** (generic parse failure — `principle_verdict_source: step3` with no stale artifact detected), formulate the Andon event surfacing `patterns_tried` and `content_snippet` as discrete lines:
   ```
   Andon: principle_verdict:unknown — spec-adherence output could not be parsed.
   Cycle: {cycle_number}
   principle_verdict_warning: {principle_verdict_warning field from payload}
   patterns_tried: {patterns_tried field derived in Step 1}
   content_snippet: {content_snippet field derived in Step 1}
   condition_a: {condition_a} (zero critical/significant findings: {true|false})
   Cause: the automated verdict parser did not find a recognizable Pass/Fail signal in
   the spec-reviewer output. This is a parse failure, not a principle violation.
   Options:
     (a) Treat as pass for this cycle — accept the review output as-is and continue
         (use only if you have manually verified principle adherence).
     (b) Treat as fail for this cycle — proceed to refinement and add a work item
         to fix the spec-reviewer output format.
     (c) Halt autopilot — stop and let the user inspect the spec-adherence artifact
         directly.
   ```

3. Route to the proxy-human agent via the Andon cord mechanism defined in `execute.md` ("Andon Cord → Proxy-Human Routing"). Pass the full event description above (whichever variant applies), including the discrete diagnostic fields plus the original `principle_verdict_warning` string for completeness. This implements the resolution of **Q-159** (distinguish `unknown` from `fail`) and **WI-221** (distinguish a stale cycle-slot artifact from a generic parser failure) — `unknown` now has a dedicated branch, surfaced diagnostics tailored to the actual cause, and a human-in-the-loop decision path rather than being silently folded into `fail`.

4. Apply the proxy-human decision:
   - **Stale-artifact variant**: decision `(a)` — re-run review: do not set `{phase_converged}` here; return to Phase 6a/6b for cycle `{cycle_number}` to produce a fresh review, then retry the convergence check. Decision `(b)` — treat as fail: set `{phase_converged}` = false, proceed to Phase 6d. Decision `(c)` or `deferred`: set `{phase_converged}` = false, halt the loop, proceed to Phases 7–9.
   - **Generic parse-failure variant**: decision `(a)` — treat as pass: set `{phase_converged}` = `condition_a`. If `condition_a` is true, proceed to Phase 6c-ii. If false, proceed to Phase 6d. Decision `(b)` — treat as fail: set `{phase_converged}` = false. Proceed to Phase 6d. Decision `(c)` or `deferred`: set `{phase_converged}` = false. Halt the loop. Proceed to Phases 7–9 (max cycles path, noting parse-failure halt).

5. Journal the outcome via `ideate_append_journal`:
   ```markdown
   ## [autopilot] {date} — Cycle {N} — principle_verdict:unknown Andon
   principle_verdict_source: {step3 | stale}
   principle_verdict_warning: {warning text}
   stale_artifact_cycle: {value, if present}
   proxy-human decision: {(a) | (b) | (c) | deferred}
   outcome: {treat-as-pass | treat-as-fail | re-run-review | halted}
   ```

#### Step 3: Update session state

Call `ideate_manage_autopilot_state({action: "update", state: {convergence_achieved: {phase_converged}, last_cycle_findings: {critical: N, significant: N, minor: N}}})`.

---

### Phase Convergence Check and Project Progress Assessment

This section is invoked by the controller from Phase 6c-ii, after `ideate_get_convergence_status` has confirmed the phase converged. It is NOT run on every cycle — only when the controller invokes it.

**Step 1: Assess project success criteria**

If `{current_project}` is null, set `{project_complete}` = false and skip to Step 2.

Otherwise, retrieve the active project: call `ideate_artifact_query({type: "project", id: "{current_project.id}"})` to get the current project record with its success criteria.

For each criterion in `{project_success_criteria}`:
1. Determine whether it is satisfied by querying the current cycle's review artifacts (call `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})`) and the current work item completion status (call `ideate_get_execution_status()` — a v2-only signal). **Board-aware (v3)**: if the v3 work-state tools are present (mechanical tool presence, GP-24), ALSO call `work_list` and treat a board item's `done` status as authoritative for its completion; if absent, the v2 signal alone decides (v2 fallback) — note "v3 work-state tools not detected — using v2 artifact fallback."
2. A criterion is satisfied if: (a) the relevant work items are all done — where a board-resident work item's done-ness is read from its board status (`work_list`), not `ideate_get_execution_status()`, so a criterion whose work lives on the board can be correctly judged complete — AND (b) none of the three cycle review artifacts report any Critical or Significant findings that directly contradict the criterion, AND (c) the spec-adherence artifact confirms the relevant principle or requirement is met.

Set `{project_complete}` = true if ALL criteria are satisfied. Set `{project_complete}` = false if any criterion is unsatisfied.

**Step 2: Identify next horizon items**

Call `ideate_artifact_query({type: "project", id: "{current_project.id}"})` to retrieve the project record. Extract `horizon.next` from the project (the canonical location for phase horizon data). If the project has no `horizon.next` field or it is empty, set `{next_horizon_items}` = [].

Otherwise, set `{next_horizon_items}` = the list of phase entries from `horizon.next`.

**Step 3: Append project progress to journal**

Call `ideate_append_journal("autopilot", {date}, "project_progress", {body})` with:

```markdown
## [autopilot] {date} — Cycle {N} project progress
Phase converged: yes
Project success criteria met: {yes | no | N/A (no active project)}
{If no: list each unsatisfied criterion with a one-line reason}
Next horizon items: {count} — {list of item IDs, or "none"}
Phases completed: {phases_completed + 1}
Appetite: {project_appetite or "N/A"}
```

**Step 4: Return to controller**

Return `{project_complete}` and `{next_horizon_items}` to the controller (Phase 6c-ii).

## Exit Conditions

- Cycle summary artifacts written via MCP: code-quality, spec-adherence, gap-analysis, decision-log
- Review manifest written via `ideate_write_artifact`
- `last_cycle_findings` dict populated with critical, significant, minor counts
- Journal updated with review summary and metrics summary (via `ideate_append_journal`)
- If invoked from 6c-ii: `{project_complete}` and `{next_horizon_items}` returned to controller; journal updated with project progress entry

Return to the controller with `last_cycle_findings`. The controller will run Phase 6c (convergence check).

## Artifacts Written (all via MCP)

- Cycle summaries (code-quality, spec-adherence, gap-analysis, decision-log) — via `ideate_write_artifact`
- Review manifest — via `ideate_write_artifact`
- Journal entries (review summary + metrics summary + project progress) — via `ideate_append_journal`
- Domain layer (policies, decisions, questions) — updated by domain-curator via `ideate_write_artifact`

## Self-Check

Before returning to the controller, verify:

- [x] No `.ideate/` path references in any instruction
- [x] No occurrences of `ideate_get_project_status` in this file
- [x] Phase Convergence Check section is clearly marked as invoked from 6c-ii only (not every cycle)
- [x] Project success criteria assessment uses `ideate_artifact_query` and `ideate_get_execution_status`, not direct file reads
- [x] `{project_complete}` and `{next_horizon_items}` returned to controller after project progress assessment
- [x] Project progress journal entry written via `ideate_append_journal`, not direct file write
- [x] All review artifacts written via `ideate_write_artifact`, not direct file writes
- [x] Domain artifacts written via `ideate_write_artifact` after parsing curator response
- [x] Phase 6c section defines three-way branch: pass → converge, fail → refine, unknown → Andon
- [x] unknown branch carries principle_verdict_warning, patterns_tried, and content snippet from payload
- [x] unknown treated as parse failure (not principle violation) — rationale documented in Phase 6c section
- [x] WI-221: unknown sub-case `principle_verdict_source: stale` is distinguished from generic parse failure (`step3`) in Step 1 parsing, the Andon event, and the proxy-human decision options — stale never offers "treat as pass"
- [x] WI-221: stale-artifact Andon carries `stale_artifact_cycle` and `stale_artifact_cycle_modified` from the payload; unknown (including stale) is still never folded into fail
- [x] pass branch behavior unchanged — cycles with principle_verdict:pass still converge on Condition B
- [x] Q-159 (distinguish unknown from fail) resolved by the three-way branch; closed via `ideate_write_artifact` with type `question`, status `resolved`
- [x] patterns_tried and content_snippet extracted from principle_verdict_warning as discrete Andon payload fields (Phase 6c Step 1)
- [x] Branch A clarifies that `converged` equals `condition_a` when `condition_b` is already true — routing uses `converged` from payload
- [x] Generate Review Manifest establishes `{board_items}` via mechanical tool-presence detection (GP-24) and appends board rows to the manifest, with a loud v2 fallback and `.ideate-work/` missing-build escalation (P-45)
- [x] Proportional Review Depth's severity/priority/work_item_type read branches on `{board_items}` (spec payload) vs. v2 (`ideate_artifact_query`) — no universal `ideate_artifact_query({type: "work_item"})` read survives outside the v2 branch
- [x] All three reviewer prompts (code-reviewer, spec-reviewer, gap-analyst) carry the board-evidence CLI-fallback line for `board`-tagged manifest rows
