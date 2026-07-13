# Autopilot Phase 6d: Refinement Phase

## Entry Conditions

Called only when Phase 6c (convergence check, inline in the controller) determines the cycle did not converge.

Available from controller context:
- `{project_root}` — absolute path to the project root
- `{cycle_number}` — current 1-based cycle counter
- `{last_cycle_findings}` — dict with `critical_count`, `significant_count`, `minor_count`
- `{pending_count_start_of_cycle}` — the number of pending work items at the start of this cycle (for divergence detection)
- `{completed_items}` — current set of completed work item numbers

## Instructions

Produce new work items that address all critical and significant findings from the comprehensive review.

Retrieve the cycle's review artifacts via `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})`. For each critical or significant finding:

1. Determine whether an existing work item covers the fix, or whether a new work item is needed.
2. If a new work item is needed, create it.

   **Board-aware numbering (v3)**: if the v3 work-state tools are present, call `work_list` in addition to the artifact index (`ideate_get_next_id({type: "work_item"})`) and take the maximum WI number across both — the board is invisible to the artifact index alone, and without this check, numbering can collide.

   **v3 board path**: If the v3 work-state tools (`work_create`, `work_claim`, …) are present in the session — detection is mechanical tool presence, never inferred (GP-24) — create the new work item ON THE BOARD via `work_create`, called per the tool's self-describing schema (P-44: the schema, not this text, is authoritative for parameter names and shapes; the creating actor's human principal is REQUIRED, with actor fields as flattened strings — no nested `actor` object). Supply: the title formatted `"WI-{NNN}: {title}"`; the full work-item body (objective, acceptance criteria, file scope, dependencies, implementation notes) as the opaque `spec` payload with `spec_format: "ideate/wi-v1"`; the creating actor — `{user}` (read `git config user.name` in `{project_root}`, defaulting to the literal string `"autopilot"` if unset, since this loop runs unattended) as the human principal, plus the acting agent's name; and `depends_on` — the board item IDs of any dependency items created in this same batch. A dependency on a legacy (v2 artifact) work item cannot be a board dependency — record it inside the spec payload's dependencies section instead and note it in the refinement journal entry so the executor enforces it manually.

   **v2 fallback (pre-v3 projects, or v3 tools absent)**: Call `ideate_write_work_items({items_array})` — atomically creates individual work items (WI-{NNN}) for each new work item. This is the complete legacy behavior, unchanged. Apply the loud-fallback protocol: say in your output, verbatim, "v3 work-state tools not detected — using v2 artifact fallback." **Missing-build escalation**: if `.ideate-work/` exists on disk at `{project_root}`, this project has previously used the board — the absence is then almost certainly a MISSING BUILD (the v3 server runs from `dist/`, which is git-ignored and never auto-built), not a pre-v3 project. Escalate to a warning: "WARNING: this project has board state (.ideate-work/ exists) but the v3 tools are unavailable — likely a missing build. Run `pnpm install && pnpm run build` in the plugin before continuing, or new work will silently split between v2 artifacts and the board." Autopilot runs unattended — route this warning to the proxy-human agent as an Andon event (per `execute.md` "Andon Cord → Proxy-Human Routing") rather than silently writing v2 items on a project with existing board state.

   If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

3. If an existing work item needs rework, append a rework note to its spec and remove it from `{completed_items}`. **Board items**: a board item's state lives on the board, not in an editable v2 spec — if a board item needs rework, do not attempt to edit its `spec` payload (opaque, immutable per the board's design); instead create a new dependent work item via the v3 board path above describing the required follow-up, and note the relationship in the refinement journal entry.

**Work item cap**: Create one work item per distinct finding group (e.g., one for all role-system findings, one for all README schema findings), not one per individual finding instance.

**Divergence check**: If the total pending work item count after this phase is greater than or equal to `{pending_count_start_of_cycle}`, stop the loop. Report: "Autopilot cycle is not converging — pending work items are not decreasing. Current: {N}. Previous: {M}. Stopping autonomous loop." Proceed to reporting.md.

Call `ideate_append_journal("autopilot", {date}, "refinement", {body})` — appends a structured journal entry atomically.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Write a refinement summary:

```markdown
## [autopilot] {date} — Cycle {N} refinement
Findings addressed: {N} critical, {N} significant
New work items created: {list of new item numbers and titles}
Work items reset for rework: {list of item numbers, if any}
```

After producing new work items, update `{completed_items}`: remove any items reset for rework. Add all new items to the pending set for the next cycle.

## Exit Conditions

- New or modified work items exist for each critical/significant finding group
- `{completed_items}` updated (rework items removed)
- Journal updated with refinement summary

Return to the controller. The controller will run Phase 6e (cycle limit check) and, if within limit, start the next cycle.

---

## Phase Transition

This section is invoked by the controller from Phase 6c-ii **only** — when the current phase has converged but the project is not yet complete and `{next_horizon_items}` is non-empty. It is NOT run as part of the normal refinement loop.

### Step 1: Promote Next Horizon

Call `ideate_artifact_query({type: "project", id: "{current_project}"})` to retrieve the current project artifact. Extract:
- `horizon.next` — the list of phase IDs to promote into active scope
- `horizon.later` — any phases beyond the next horizon (may be absent)

For each work item in `horizon.next`: if it is a **board item** (in `{board_items}` / carries `spec_format: ideate/wi-v1`), do NOT call `ideate_update_work_items` for it — a board item has no v2 artifact record, so that call has nothing to update and would error (it operates on the v2 store only). A board item's lifecycle status lives on the board (`work_get`/`work_list`); its phase membership is recorded when the phase artifact's `work_items` array is written (see below and the phase-artifact update), which is v2-phase machinery that stays v2 regardless of the board cutover. For a **v2 item**, call `ideate_update_work_items({updates: [{id: "{work_item_id}", status: "pending", phase: "active"}]})` to promote it from horizon to active scope.

Update the project artifact to reflect the promotion: call `ideate_write_artifact({type: "project", id: "{current_project}", content: {horizon: {next: {horizon.later items or []}, later: []}}})`. Preserve all other project artifact fields.

Print:
```
[autopilot] Phase transition — promoting {N} work items from horizon.next to active scope
Items: {list of work item IDs and titles}
```

### Step 2: Clear Completed Set

Remove all previously completed items from `{completed_items}` that are not part of the newly promoted set. The new cycle begins fresh against the promoted work items.

Call `ideate_get_execution_status()` to refresh the pending/completed sets (a v2-only signal). Update `{completed_items}` from the returned `completed` set. **Board-aware merge (v3)**: if the v3 work-state tools are present (mechanical tool presence, GP-24), ALSO call `work_list` and merge board status (authoritative for board items — done/open per the board, not the v2 scan), mirroring `phases/execute.md`'s Board-aware completion; if absent, the v2 scan alone decides (v2 fallback) — note "v3 work-state tools not detected — using v2 artifact fallback."

### Step 3: Spawn Transition Architect (optional)

If the promoted work items have unclear dependencies, ordering conflicts, or if the execution strategy does not specify an ordering for the new items, spawn the `ideate:architect` agent to produce a revised execution order:

```
subagent_type: "ideate:architect"
model: "{config.model_overrides.architect or 'sonnet'}"
prompt: "The autopilot is transitioning to the next project phase.
Newly promoted work items: {list of IDs and titles}
Execution strategy: {current strategy content}
Review the promoted items, resolve any dependency conflicts, and return a revised dependency ordering for the new items only. Do not modify the overall strategy fields. Return the revised ordering as structured content."
```

If the architect returns a revised ordering, update the execution strategy: call `ideate_write_artifact({type: "execution_strategy", content: {revised strategy with updated ordering for promoted items}})`.

If no ordering conflict exists, skip this step.

### Step 4: Write Transition Journal Entry

Call `ideate_append_journal("autopilot", {date}, "phase_transition", {body})`:

```markdown
## [autopilot] {date} — Phase transition
Previous phase converged at cycle {cycle_number}
Items promoted to active scope: {N} — {list of IDs and titles}
Items remaining in horizon.future: {N or "none"}
Phases completed so far: {phases_completed + 1}
Project appetite remaining: {project_appetite - (phases_completed + 1)} phases
```

### Exit Conditions (Phase Transition)

- `horizon.next` items promoted to active/pending via `ideate_update_work_items`
- Execution strategy updated to reflect new horizon state via `ideate_write_artifact`
- `{completed_items}` refreshed via `ideate_get_execution_status`
- Journal updated with phase transition entry
- If architect was spawned: execution strategy updated with revised ordering

Return to the controller (Phase 6c-ii). The controller will start the next cycle with the promoted work items.

## Artifacts Written (all via MCP)

- Work items — new board items created via `work_create` (v3 board path) or new v2 artifacts via `ideate_write_work_items` (v2 fallback, normal refinement)
- Work item status — promoted items updated via `ideate_update_work_items` (phase transition; v2-phase machinery for both board and v2 items — see note in Phase Transition Step 1)
- Execution strategy — horizon updated via `ideate_write_artifact` (phase transition)
- Journal entries — refinement summary and/or phase transition entry appended via `ideate_append_journal`

## Self-Check

Before returning to the controller, verify:

- [x] No `.ideate/` path references in any instruction
- [x] No occurrences of `ideate_get_project_status` in this file
- [x] Phase Transition section is invoked only from controller Phase 6c-ii, not from normal refine loop
- [x] Phase transition promotes items via `ideate_update_work_items`, not direct file writes
- [x] Project artifact horizon updated via `ideate_write_artifact`, not direct file writes
- [x] `{completed_items}` refreshed via `ideate_get_execution_status` after phase transition
- [x] Divergence check present in normal refinement path (pending count not decreasing)
- [x] Journal updated via `ideate_append_journal`, not direct file writes
- [x] Work item creation branches on mechanical v3 tool-presence (GP-24): `work_create` with board-aware numbering (`work_list` + `ideate_get_next_id`) when v3 tools are present; `ideate_write_work_items` as the loud, explicit v2 fallback (P-45) with the missing-build escalation
- [x] `work_create` actor parameters are flattened `actor_human`/`actor_agent` strings (no nested `actor` object), per P-44
- [x] Phase Transition Step 1 notes that `ideate_update_work_items` promotion is v2-phase machinery only — a board item's lifecycle status still lives on the board, not in this v2 status field
