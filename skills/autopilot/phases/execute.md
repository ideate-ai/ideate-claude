# Autopilot Phase 6a: Execute Phase

## Entry Conditions

Called by the autopilot loop controller at the start of each cycle. The following variables are available from the controller context:

- `{project_root}` — absolute path to the project root
- `{project_source_root}` — absolute path to the project source code
- `{cycle_number}` — current 1-based cycle counter
- `{completed_items}` — set of work item numbers already completed

## Instructions

Execute all pending work items following the execution strategy (loaded by the controller via `ideate_artifact_query({type: "execution_strategy"})`).

### Read Project Configuration

Call `ideate_get_config()` to read project configuration. Hold the response as `{config}`. Use `{config}.agent_budgets.{agent_name}` as the maxTurns value when spawning agents. If `ideate_get_config` is unavailable or returns no agent_budgets, use the agent's frontmatter maxTurns as fallback. Also hold `{config}.model_overrides` — a map of agent name to model string. When spawning any agent, use `{config}.model_overrides['{agent_name}']` as the model parameter if present and non-empty; otherwise use the hardcoded default listed in the spawn instruction.

### Board-Aware Work Item Read (v3)

Call `ideate_artifact_query({type: "work_item"})` — returns all v2 work items. **Board-aware read (v3)**: if the v3 work-state tools (`work_claim`, `work_list`, …) are present in the session — detection is mechanical tool presence, never inferred (GP-24) — ALSO call `work_list` and include items whose `spec_format` is `ideate/wi-v1`: the opaque `spec` payload IS the work-item body (objective, acceptance criteria, file scope, dependencies, implementation notes). Hold `{board_items}` — the set of work items that live on the board, with their board item IDs. Items returned only by the artifact query are legacy v2 items; both kinds execute in the same cycle. If the work-state tools are absent, the artifact query alone is the complete set (v2 fallback path) and `{board_items}` is empty — apply the loud-fallback protocol immediately below.

**v3 Detection and Fallback (GP-24 / P-45)**

Detection of the v3 work-state/record tools is mechanical tool presence in the session — never inferred (GP-24). When a v3 tool is ABSENT and a fallback branch is taken, the fallback must be LOUD, never silent (P-45):

- Say in your output, verbatim: "v3 work-state tools not detected — using v2 artifact fallback." Where a journal write is already in flow, include the same line in the journal body.
- **Missing-build escalation**: if `.ideate-work/` exists on disk at `{project_root}`, this project has previously used the board — the absence is then almost certainly a MISSING BUILD (the v3 server runs from `dist/`, which is git-ignored and never auto-built), not a pre-v3 project. Escalate the note to a warning: "WARNING: this project has board state (.ideate-work/ exists) but the v3 tools are unavailable — likely a missing build. Run `pnpm install && pnpm run build` in the plugin before continuing, or new work will silently split between v2 artifacts and the board." Autopilot runs unattended — there is no user to give the chance to fix it before proceeding, so route this warning to the proxy-human agent as an Andon event (see "Andon Cord → Proxy-Human Routing" below) rather than silently continuing on a project with a possible split-brain.

Every v2-fallback branch in this phase document applies this protocol; the sections below reference it rather than restating it.

**Resolve `{user}`**: the human principal for board actor attribution. Read `git config user.name` in `{project_root}`; if unset or empty, use the literal string `"autopilot"` (autopilot runs unattended — there is no user to ask). Hold this as `{user}` for the rest of this phase.

### Prepare Context Digest

Before spawning workers, assemble a **context digest** for each pending work item using PPR-based context assembly. This provides graph-aware, relevance-ranked context within a token budget.

**PPR-based context assembly**: For each pending work item, call `ideate_assemble_context({seed_ids: [{current_work_item_id}], token_budget: {config}.ppr.default_token_budget, include_types: ["architecture", "guiding_principle", "constraint"]})`. The tool runs Personalized PageRank over the artifact graph, ranks all artifacts by relevance to the seed work item, and assembles context within the token budget. Always-include types (architecture, principles, constraints) are included regardless of PPR score.

**Board items (v3)**: a board item is not in the artifact graph — do not seed PPR with its WI designation (the seed resolves to nothing). For items in `{board_items}`, skip the PPR call and use the manual fallback below for project-scoped context; the item-scoped spec comes from the board payload (see **Sourcing a Work Item's Spec/Context (Board-Aware)**).

Hold the returned context as `{ppr_context[item_id]}`. Pass it to the worker as their context digest.

**Fallback**: If `ideate_assemble_context` is unavailable or returns an error — or the current work item is a board item (see above) — fall back to the existing manual context digest construction:

Call `ideate_get_context_package()` — returns the architecture document, guiding principles, and constraints as a single pre-assembled package. Hold the result as `{context_package}`.

For each pending work item:
1. Use the architecture section from `{context_package}`. Check its total line count.
   - If the architecture content is ≤200 lines total, skip digest preparation for that item and pass the full content.
   - If >200 lines, extract:
     - The full `## Interface Contracts` section — always included in full, uncapped (contracts span modules and must not be truncated regardless of length)
     - Sections mentioning any file path in the work item's `file_scope`
     - The component map entry for the relevant component
     - Cap all non-interface-contracts content at 150 lines total; if over this limit, include the component map entry first, then file-scope sections. If the interface contracts section alone exceeds 150 lines, include only the interface contracts section.
2. Include guiding principles from `{context_package}` in full (typically short enough to include entirely).
3. Include constraints from `{context_package}` in full.

Store as `{work_item_context_digest[item_id]}`. Pass to the worker instead of the raw architecture content. Include a note that the full documents are available via MCP tools if more detail is needed.

### Sourcing a Work Item's Spec/Context (Board-Aware)

- **Board items (v3)** — for items in `{board_items}`: the opaque `spec` payload (already held from `work_list`) IS the work-item spec — objective, acceptance criteria, file scope, dependencies, implementation notes — supplemented by `work_get` for current state and `work_events` for prior lifecycle (a previously released item's handoff note is required reading before respawning). Do NOT call `ideate_get_artifact_context` with a board item's WI designation: board items have no v2 artifact, and the call fails with "Artifact not found". Module spec / domain policies / research for a board item come from the project-scoped `{context_package}` (and `ideate_artifact_query({type: "module_spec"})` / `{type: "research"}` if needed), keyed off the item's file scope, since the board payload is opaque to the server.
- **v2 items (fallback)** — for legacy items not in `{board_items}` (or when the work-state tools are absent, per the loud-fallback protocol above): call `ideate_get_artifact_context({artifact_id})` — returns the work item spec, module spec, domain policies, and research as one pre-assembled package.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

### Context for Every Worker

Also provide the project source root path and relevant domain policies (if not already included).

**GP-14 enforcement**: If an MCP tool call fails, report the error and stop. Do NOT fall back to reading, grepping, or globbing .ideate/ files directly. The MCP abstraction boundary (GP-14) is inviolable — a tool failure is a signal to fix the tool, not to bypass it.

Every worker subagent receives:

1. The work item context — per **Sourcing a Work Item's Spec/Context (Board-Aware)** above (board `spec` payload plus `work_get`/`work_events` for a board item; the `ideate_get_artifact_context` package for a v2 item).
2. _(Implementation notes are inline in the board `spec` payload, or in the v2 work item's `notes` field — included in the context above.)_
3. The context digest — `{ppr_context[item_id]}` from the PPR-based context assembly in the "Prepare Context Digest" step above, or `{work_item_context_digest[item_id]}` if fallback was used. Includes a note that full documents are available via MCP tools if more detail is needed.
4. The relevant module spec — from the canonical source above (for a board item, resolved from its file scope via `{context_package}`; for a v2 item, included in the `ideate_get_artifact_context` response). If the item spans modules or no modules exist, the full architecture doc from `{context_package}` is used instead.
5. _(Included in context digest)_
6. _(Included in context digest)_
7. Relevant research — from the canonical source above.
8. Project source root — the absolute path `{project_source_root}`.

All paths provided to workers must be absolute.

### Work Item Type Context Adjustment

After loading the work item spec per **Sourcing a Work Item's Spec/Context (Board-Aware)** above (board `spec` payload for items in `{board_items}` — read `work_item_type` from the payload if it carries one, else default to feature; `ideate_get_artifact_context` for v2 items), read `work_item_type`. Adjust the context loading depth for that work item's worker as follows:

- **feature, spike**: Full context — architecture, principles, module spec, dependencies. (This is the default path; no change from existing behavior.)
- **bug**: Focused context — related findings (from `ideate_artifact_query({type: "finding"})` filtered to the affected file paths), affected file history if available, and reproduction information from the work item notes. Omit module specs for unrelated modules.
- **chore, maintenance**: Minimal context — work item spec and direct dependencies only. Skip architecture sections not referenced in the work item's file scope. Skip unrelated module specs.

If `work_item_type` is absent or unrecognized, default to **feature** (full context). This preserves existing behavior for all work items that predate this field.

Pass only the adjusted context subset to the worker. The worker still receives the note that full documents are available via `ideate_get_context_package()` if more detail is needed.

The worker prompt must instruct the agent to:
- Build exactly what the work item specifies
- Write source files under `{project_source_root}`
- Follow the context digest for system context (and read full architecture at the provided path if more detail is needed)
- Use the guiding principles from the digest to resolve ambiguous situations (read full principles if needed)
- Respect all constraints from the digest (read full constraints if needed)
- Not make design decisions beyond what the spec prescribes
- Report completion with a list of files created or modified
- Never read, write, or reference `.ideate/` paths directly — artifact writes must go through MCP tools (GP-14). If you discover you have already written to `.ideate/` directly, re-sync by writing through the appropriate MCP tool and discard the direct-file write (P-87).

The worker prompt must also include this self-check instruction:

> **Before reporting completion**, walk every acceptance criterion from the work item spec. For each, determine:
> - `satisfied` — met and verifiable from the code or output you produced
> - `unsatisfied` — not met; fix before reporting completion, then re-verify
> - `unverifiable` — cannot check without test execution, running services, or external validation
>
> Do not report completion while any criterion is `unsatisfied`. Fix it first.
>
> Include a `## Self-Check` section in your completion report listing each criterion and its status:
>
>     ## Self-Check
>     - [x] {criterion text} — satisfied
>     - [ ] {criterion text} — unverifiable: {brief reason}

**Skipping completed items**: Before starting a work item, check whether its number is in `{completed_items}`. If so, skip it and report: "Skipping work item NNN: {title} — already completed."

**Hook: work_item.started**: Before spawning the worker for each work item (after the skip check passes), call `ideate_emit_event` with:
- event: "work_item.started"
- variables: { "WORK_ITEM_ID": "{work_item_id}", "WORK_ITEM_TITLE": "{work_item_title}" }

This call is best-effort — if it fails, continue without interruption.

**Hook: work_item.completed**: After each work item passes incremental review (findings handled, rework complete if any), call `ideate_emit_event` with:
- event: "work_item.completed"
- variables: { "WORK_ITEM_ID": "{work_item_id}", "VERDICT": "{review_verdict}" }

Where `{review_verdict}` is `"pass"` if the review passed without rework, `"rework"` if it passed after rework, or `"fail"` if unresolvable. This call is best-effort — if it fails, continue without interruption.

### Board Claim Discipline (v3)

For each work item in `{board_items}`, the coordinator holds the board lease around the worker's lifetime. If the item is NOT in `{board_items}` — a legacy v2 item, or the work-state tools are absent — skip this block entirely: the v2 flow in the rest of this phase is the complete behavior (fallback path).

- **Claim before spawn**: After the skip check and the `work_item.started` hook, call `work_claim` per the tool's self-describing schema (P-44: the schema, not this text, is authoritative for parameter names and shapes). Supply the item's board ID, `{user}` (resolved above) as the human principal, and the worker's agent type as the acting agent — the actor fields are flattened strings (no nested `actor` object), and the human principal is required. Hold the returned claim token. If the claim is rejected (dependencies not done, or already claimed), do NOT spawn the worker — re-check with `work_get`; if the board state contradicts the plan's dependency ordering, route to the Andon cord → proxy-human (see below).
- **Renew on long items**: The default lease is hours-scale. Before spawning any rework pass on the same item — and at any natural checkpoint on an item that has been in flight for a long stretch — call `work_renew` with the held token. A rejected renew means the lease expired and the item may have been reclaimed: stop work on it and route to the Andon cord → proxy-human.
- **Complete on review pass**: When the item passes incremental review (findings handled, rework done), call `work_complete` with the held token and a `note` summarizing the outcome in one or two sentences (what was built, rework rounds, review verdict). The note is not optional on this path — it becomes the item's durable process record.
- **Release on failure**: If the item cannot proceed (worker retry exhausted, Andon-blocked, cycle stopped), call `work_release` with the held token and a handoff `note` stating what was attempted and what remains. Never leave a claim to expire silently when the outcome is known.

The board's claim discipline REPLACES v2 work-item status updates for items in `{board_items}` — neither the coordinator nor its workers issue `ideate_update_work_items` status changes for board items. Findings and journal entries stay v2 for all items. The `work_item.started` / `work_item.completed` event hooks continue to fire for all items regardless of path.

**Update work item status**: After each work item passes incremental review (findings handled, rework complete if any) and after emitting the `work_item.completed` event: **board items** (in `{board_items}`) do NOT get a separate status-update call — `work_complete` in Board Claim Discipline above IS the status transition. **v2 items** (fallback path): call `ideate_update_work_items({updates: [{id: "{work_item_id}", status: "done"}]})` to transition the work item from 'pending' to 'done'. This ensures `ideate_get_execution_status` reflects completed items. If the call fails, log the error but continue — the status update is informational, not blocking.

**Refreshing execution status mid-cycle**: If the `{completed_items}` set needs to be refreshed mid-cycle (e.g., after a partial failure and retry), call `ideate_get_execution_status()` — returns current completed, pending, and blocked sets. Use the returned `completed` set to update `{completed_items}` before skipping decisions. **Board-aware completion (v3)**: for items in `{board_items}`, board status is authoritative: an item whose board status is `done` is completed regardless of what `ideate_get_execution_status` reports, and an item whose board status is `open` or `in_progress` is NOT completed even if the execution-status scan suggests otherwise (check via `work_list` or `work_get`). Merge `{completed_items}` accordingly. If the work-state tools are absent, `ideate_get_execution_status` alone decides (v2 fallback path — apply the loud-fallback protocol above). If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

### Execution Modes

Execute according to the mode in the execution strategy (loaded by the controller via `ideate_artifact_query({type: "execution_strategy"})`):

**Sequential**: Execute one work item at a time in dependency order. Select the next item whose dependencies are all complete. Build it. Trigger incremental review. Handle findings. Update journal. Repeat.

**Batched parallel**: Execute work items in groups from the execution strategy. Spawn one subagent per work item up to the parallelism limit. Wait for the group. Trigger incremental reviews for all completed items. Handle findings. Update journal. Proceed to the next group.

**Full parallel (teams)**: Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Construct the shared task list respecting dependency ordering. Each teammate picks up the next available item whose dependencies are satisfied. On each item's completion, trigger incremental review, handle findings, and update journal.

**Worktree isolation**: If the execution strategy specifies worktrees, create a git worktree for each concurrent subagent before spawning it (`git worktree add` with branch `ideate/NNN-{name}`). After a work item's incremental review passes, merge back using `git merge --no-ff ideate/NNN-{name}`. Resolve trivial conflicts (whitespace, import ordering) automatically. For substantive merge conflicts, route to the Andon cord → proxy-human (see below). After a successful merge: `git worktree remove {path}` and `git branch -d ideate/NNN-{name}`.

**Workspace rename on phase transition**: When a phase transition has occurred (i.e., the controller entered this cycle via Phase 6c-ii → Phase Transition in refine.md), update the workspace label by calling `ideate_manage_autopilot_state({action: "update", state: {workspace_label: "phase-{phases_completed}"}})`. This is informational — it tags the session state so activity reports can group work by phase. Best-effort: if the call fails, continue without interruption.

### Incremental Review (Per Work Item)

When a work item completes, spawn the `ideate:code-reviewer` agent with:
- The work item spec
- The list of files created or modified
- The architecture document
- The guiding principles
- The worker's self-check results (the `## Self-Check` section from the worker's completion report)

Instruct the code-reviewer: "Spot-check at least 2 `satisfied` claims. Prioritize investigation of `unverifiable` criteria."

Include the following in the code-reviewer's prompt:

  > **Unverifiable claims**: The worker's self-check may contain criteria marked `unverifiable`. For each:
  > 1. List all `unverifiable` criteria explicitly in your findings.
  > 2. Attempt to verify at least 2 of them by reading the relevant source files. If verifiable by file inspection, reclassify as `satisfied` or `unsatisfied`.
  > 3. Only accept `unverifiable` for criteria requiring runtime testing, external system dependencies, or human judgment that cannot be derived from file contents.
  >
  > **Dynamic testing (incremental scope)**: After your static review, perform the dynamic checks defined in your agent instructions under "Step 2 — Incremental review scope (single work item)". Discover the project's test model, run the smoke test, and run tests scoped to the changed files. If the smoke test fails, report a Critical finding titled "Startup failure after [work item name]".

Write the result via `ideate_write_artifact({type: "finding", id: "F-{WI}-{SEQ}", content: {cycle: {cycle_number}, work_item: "{WI}", content: <findings from response>}})`.

**Review format**:

```markdown
## Verdict: {Pass | Fail}

{One-sentence summary.}

## Critical Findings

### C1: {title}
- **File**: `path/to/file.ext:line`
- **Issue**: {description}
- **Impact**: {what goes wrong}
- **Suggested fix**: {concrete fix}

## Significant Findings

### S1: {title}
- **File**: `path/to/file.ext:line`
- **Issue**: {description}
- **Impact**: {what goes wrong}
- **Suggested fix**: {concrete fix}

## Minor Findings

### M1: {title}
- **File**: `path/to/file.ext:line`
- **Issue**: {description}
- **Suggested fix**: {concrete fix}

## Unmet Acceptance Criteria

- [ ] {criterion} — {why not met}
```

If a severity section has no findings, include the header with "None." underneath.

**Review finding handling**:

- **Minor findings**: Fix immediately, silently. Note rework in the journal entry.
- **Significant findings within scope**: Fix. Note rework in the journal entry.
- **Critical findings — "Startup failure after ..."**: Diagnose root cause immediately. If fixable within scope: apply surgical fix, note in the journal: `Rework: Startup failure root cause diagnosed and fixed. {brief description of fix}.` Re-run smoke test. If smoke test still fails after fix, treat as indeterminate and route to Andon cord → proxy-human. If not fixable (scope change required, cause indeterminate): note in journal — `Diagnosis: {root cause finding}. Routing to Andon — cause not fixable within work item scope.` Route to Andon cord → proxy-human.
- **Smoke test infrastructure failure (runner cannot execute)**: Determine if the failure is a regression caused by this work item (config files, dependency manifests, port bindings changed). If regression: diagnose, apply surgical fix (no scope expansion, no architectural decisions), re-run. If still fails: journal — `Diagnosis: {root cause finding}. Routing to Andon — smoke test infrastructure failure persists after fix.` Route to Andon cord → proxy-human. If not a regression: journal — `Smoke test infrastructure failure detected. Not a regression — routing to Andon.` Route to Andon cord → proxy-human.
- **Critical findings fixable within scope (non-startup-failure, non-infrastructure-failure)**: Fix. Note as significant rework in the journal entry.
- **Critical findings that are scope-changing or worktree merge conflicts**: Do NOT fix. Route to Andon cord → proxy-human (see below).
- **Unmet acceptance criteria**: Attempt to fix. If unfixable due to spec issues, route to Andon cord → proxy-human.

### GP-14 Violation Re-Sync (P-87)

When a worker's completion report lists any `.ideate/` file modifications, the parent must:

1. Record a **minor finding** in the incremental review output citing GP-14 and P-87: the worker bypassed the MCP abstraction boundary. The finding tracks the worker-prompt defect; re-sync is the mechanical recovery, not the fix.
2. Re-issue each `.ideate/` write via the appropriate MCP tool — `ideate_write_artifact`, `ideate_update_work_items`, `ideate_append_journal`, or equivalent — to establish canonical provenance in the runtime artifact graph.

The direct write by the worker is still a violation even when mitigated. See P-87 for the full policy text.

### Andon Cord → Proxy-Human Routing

When an Andon event occurs (scope-changing finding, merge conflict, spec ambiguity, environment failure), do NOT pause and present it to the user. Instead:

1. Formulate an `andon_event` description containing: what the issue is, which work item triggered it, what options are on the table, what context from artifacts is relevant.

2. Invoke the `ideate:proxy-human` agent via the Agent tool:

   ```
   subagent_type: "ideate:proxy-human"
   model: "opus"
   prompt: "[Andon Event for proxy-human agent]

   Project root: {project_root}
   Cycle: {cycle_number}

   Event:
   {andon_event_description}

   Write your decision via ideate_write_artifact with type 'proxy_human_decision' following the format defined in your agent definition."
   ```

3. Wait for the proxy-human agent to respond.

4. The proxy-human agent writes its decision via `ideate_write_artifact({type: "proxy_human_decision", id: "PHD-{cycle}-{seq}", content: {...}})`. No separate recording step needed.

5. Apply the decision. If the decision is `"deferred"`, add it to the cycle's deferred items list and continue with other work items where possible. Immediately print to running output:
   ```
   [autopilot] ⚠ Deferred: {event description} — proxy-human deferred this decision. See activity report for details.
   ```
   Do NOT interrupt the loop or ask the user. This is logging only.

**If the Agent tool is not available**: Handle the event yourself — use the guiding principles and constraints from `{context_package}` (loaded via `ideate_get_context_package()` in the Prepare Context Digest step), apply them to the event, make the best decision, and record it via `ideate_write_artifact({type: "proxy_human_decision", id: "PHD-{cycle}-{seq}", content: {cycle: {cycle_number}, trigger: "fallback", triggered_by: [], decision: "{decision}", rationale: "{rationale}", timestamp: "{ISO timestamp}", status: "resolved"}})`.

### Worker Agent Failure

If a subagent fails (crashes, times out, produces no output):
1. Record the failure in the journal
2. Retry once with the same work item and context. For board items, call `work_renew` with the held token before respawning — the claim stays held across the retry.
3. If the retry fails, route to proxy-human as an Andon event. For board items, call `work_release` with the held token and a handoff note (Board Claim Discipline above) before routing; legacy v2 items have no board state to release (fallback path).
4. Continue with items that do not depend on the failed item

### Journal Updates (Per Work Item)

After each work item completes (and after any rework), append a journal entry via `ideate_append_journal`.

Call `ideate_append_journal("autopilot", {date}, {entry_type}, {body})` — appends a structured journal entry atomically.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

```markdown
## [autopilot] {date} — Cycle {cycle_N} — Work item NNN: {title}
Status: {complete | complete with rework}
{Deviations from plan. Decisions made. Notable observations.}
```

If rework occurred:

```markdown
## [autopilot] {date} — Cycle {cycle_N} — Work item NNN: {title}
Status: complete with rework
Rework: {N} minor, {N} significant findings fixed from incremental review.
{Description of significant fixes if any.}
```

After each item completes, call `ideate_manage_autopilot_state({action: "get"})` to read the current `total_items_executed`, increment it, then call `ideate_manage_autopilot_state({action: "update", state: {total_items_executed: {N+1}}})` to persist the update.

## Exit Conditions

- All pending work items have been attempted (skipped, completed, or failed+deferred)
- Each completed item has an incremental review finding written via `ideate_write_artifact`
- Each completed item has its status updated to 'done' — via `work_complete` (Board Claim Discipline) for board items, via `ideate_update_work_items` for v2 items
- `total_items_executed` is updated via `ideate_manage_autopilot_state`
- Journal has an entry for each completed item (via `ideate_append_journal`)

Return to the controller. The controller will proceed to Phase 6b (review.md).

## Artifacts Written (all via MCP)

- Findings (F-{WI}-{SEQ}) — one per work item reviewed, via `ideate_write_artifact`
- Journal entries — appended per work item and per Andon event, via `ideate_append_journal`
- Work item status — updated to 'done' for each completed item, via `work_complete` for board items and via `ideate_update_work_items` for v2 items
- Board claims — claimed via `work_claim`, renewed via `work_renew`, completed via `work_complete`, released via `work_release` (all for items in `{board_items}`)
- Autopilot session state — `total_items_executed` and `workspace_label` updated via `ideate_manage_autopilot_state`
- Proxy-human decisions (PHD-{cycle}-{seq}) — if Andon events occurred, via `ideate_write_artifact` with type `proxy_human_decision`

## Self-Check

Before returning to the controller, verify:

- [x] No `.ideate/` path references in any instruction
- [x] No occurrences of `ideate_get_project_status` in this file
- [x] Workspace rename on phase transition uses `ideate_manage_autopilot_state`, not direct file writes
- [x] Every completed work item has a finding written via `ideate_write_artifact`
- [x] Every completed board item has status updated via `work_complete`; every completed v2 item has status updated via `ideate_update_work_items` — no universal `ideate_update_work_items` call survives outside the v2 branch
- [x] `total_items_executed` updated via `ideate_manage_autopilot_state` after each item
- [x] Journal entries written via `ideate_append_journal`, not direct file writes
- [x] Board-Aware Work Item Read establishes `{board_items}` via mechanical tool-presence detection (GP-24), with a loud v2 fallback and `.ideate-work/` missing-build escalation (P-45)
- [x] `ideate_get_artifact_context` is called only inside the v2 branch of "Sourcing a Work Item's Spec/Context (Board-Aware)" — board items are sourced from the board `spec` payload plus `work_get`/`work_events`
- [x] Board Claim Discipline block covers claim-before-spawn, renew-before-rework, complete-on-pass, and release-on-failure, with actor parameters as flattened `actor_human`/`actor_agent` strings (no nested `actor` object), per P-44
- [x] Worker Agent Failure and Andon routing renew/release the board claim for board items before retrying or escalating
