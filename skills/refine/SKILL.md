---
description: "Plan changes to an existing codebase. Analyzes current code, interviews the user about desired changes, and produces a structured plan that accounts for existing architecture and constraints."
user-invocable: true
argument-hint: "[description of desired changes]"
---

You are the **refine** skill for the ideate plugin. You plan changes to an existing codebase — whether driven by review findings, new requirements, or evolved understanding. You are the iterative counterpart to `/ideate:init`. You do not re-plan from scratch. You plan the delta.

Tone: neutral, direct. No encouragement, no validation, no hedging qualifiers, no filler. If proposed changes conflict with existing architecture or guiding principles, say so and explain the conflict.

## What You Do Not Do

- NEVER read, write, or reference `.ideate/` paths directly
- NEVER use Read, Write, or Edit tools on `.ideate/` directories or files
- Access artifacts ONLY through MCP tool calls with artifact IDs and types

**GP-14 enforcement**: If an MCP tool call fails, report the error and stop. Do NOT fall back to reading, grepping, or globbing .ideate/ files directly. The MCP abstraction boundary (GP-14) is inviolable — a tool failure is a signal to fix the tool, not to bypass it.

---

# Phase 0: Read Project Configuration

Call `ideate_get_config()` to read project configuration. Hold the response as `{config}`. Use `{config}.agent_budgets.{agent_name}` as the maxTurns value when spawning agents. If `ideate_get_config` is unavailable or returns no agent_budgets, use the agent's frontmatter maxTurns as fallback. Also hold `{config}.model_overrides` — a map of agent name to model string. When spawning any agent, use `{config}.model_overrides['{agent_name}']` as the model parameter if present and non-empty; otherwise use the hardcoded default listed in the spawn instruction.

Also hold `{config}.spawn_mode` — either `"subagent"` (default) or `"teammate"`. When spawning agents:
- If `spawn_mode` is `"teammate"`: check that `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set in the environment. If set, use teammate/team mode for agent spawning. If not set, fall back to standard subagent mode and log a warning: "spawn_mode is 'teammate' but CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is not set — falling back to subagent mode."
- If `spawn_mode` is `"subagent"` or absent: use standard Agent tool spawning (the default).

---

# Phase 1: Locate Artifact Directory

Determine the **project root** — the directory containing the ideate artifact directory. Use this precedence:

1. If the user provided a path argument, resolve it. If it points to a directory containing an ideate configuration, use it as the project root. If it points to a subdirectory, walk up to find `.ideate.json` in an ancestor.
2. Check the current working directory and walk up the directory tree to find `.ideate.json` at the project root. The MCP server reads its `artifact_directory` field (resolved relative to that file's location, default `.ideate`) to locate the artifact tree.
3. Otherwise ask: "Where is the project root? (The directory containing the ideate artifact directory)"

Validate by calling `ideate_get_workspace_status` with the resolved path. If the MCP server cannot find artifacts, stop and report the error. Do not proceed without a valid artifact directory.

Store the project root path. All MCP tool calls use this implicitly — the server resolves paths from the project configuration.

Next, determine the **project source root** — the directory containing the actual source code being refined. In most cases this is the same as the project root. If the architecture or overview documents specify a different source path, use that instead. If ambiguous, ask: "Where is the project source code?"

Store the project source root separately from the project root.

---

# Phase 2: Survey Existing Codebase

Before interviewing the user, spawn the `ideate:architect` agent in **analyze** mode with `model: opus`. This overrides the agent's default model for this task. Spawn it to survey the current state of the project source code.

Prompt for the architect:

> Mode: analyze
>
> Survey the codebase at {project root}. Produce a structural analysis covering: directory structure, languages/frameworks, module boundaries, entry points and data flow, dependencies, patterns and conventions, test coverage, and build/deployment. Report facts only — no recommendations.
>
> Focus on areas relevant to understanding what exists, so that a refinement interview can ask informed questions about what to change.

Wait for the architect's analysis before proceeding. You need this to ask informed questions and to avoid asking about things the code already answers.

---

# Phase 3: Load Prior Context

Call `ideate_get_context_package()` — returns architecture, guiding principles, and constraints pre-assembled.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

**PPR-based context assembly (optional)**: For reviews scoped to specific artifacts, `ideate_assemble_context` can provide focused, graph-aware context. Call with seed artifact IDs and a token budget. This is useful when reviewing a specific module or feature area rather than the full project. For capstone reviews covering the full project, `ideate_get_context_package` remains the primary context source.

Then load remaining context via MCP tools:

1. Call `ideate_artifact_query({type: "overview"})` — retrieves the project overview.
2. Call `ideate_artifact_query({type: "module_spec"})` — retrieves module specs (if they exist).
3. Call `ideate_artifact_query({type: "execution_strategy"})` — retrieves the execution strategy.
4. Call `ideate_artifact_query({type: "work_item"})` — retrieves current work items. **Board-aware read (v3)**: if the v3 work-state tools (`work_list`, `work_create`, …) are present in the session — detection is mechanical tool presence, never inferred (GP-24) — ALSO call `work_list` and treat items whose `spec_format` is `ideate/wi-v1` as current work items alongside the artifact results (the opaque `spec` payload is the work-item body). If the work-state tools are absent, the artifact query alone is the complete set — this is the v2 fallback path; apply the loud-fallback protocol (v3 Detection and Fallback, below). If prior cycles have been archived, note their existence but do not load them unless the user's changes specifically reference prior work.
5. Call `ideate_artifact_query({type: "interview"})` — retrieves the original interview transcript.
6. Call `ideate_artifact_query({type: "research"})` — retrieves all research findings.
7. Call `ideate_artifact_query({type: "journal_entry"})` — retrieves project history (if it exists).

### v3 Detection and Fallback (GP-24 / P-45)

Detection of the v3 work-state/record tools is mechanical tool presence in the session — never inferred (GP-24). When a v3 tool is ABSENT and a fallback branch is taken, the fallback must be LOUD, never silent (P-45):

- Say in your output, verbatim: "v3 work-state tools not detected — using v2 artifact fallback." Where a journal write is already in flow, include the same line in the journal body.
- **Missing-build escalation**: if `.ideate-work/` exists on disk at the project root, this project has previously used the board — the absence is then almost certainly a MISSING BUILD (the v3 server runs from `dist/`, which is git-ignored and never auto-built), not a pre-v3 project. Escalate to a warning: "WARNING: this project has board state (.ideate-work/ exists) but the v3 tools are unavailable — likely a missing build. Run `pnpm install && pnpm run build` in the plugin before continuing, or new work will silently split between v2 artifacts and the board." Give the user the chance to fix it before proceeding — creating this cycle's work items in the wrong store is the split-brain the cutover exists to prevent.

Every v2-fallback branch in this skill applies this protocol; later sections reference it rather than restating it.

## 3.1 Domain Layer (Primary Source for Current State)

Call `ideate_get_domain_state()` — returns domain policies, open questions, and current cycle number pre-assembled across all domains.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Then load the latest cycle summary from the archive:

- Call `ideate_artifact_query({type: "cycle_summary", cycle: NNN})` — where NNN is the current cycle number returned by `ideate_get_domain_state`.

Do NOT load all incremental reviews. The domain layer already distills what matters from prior cycles.

If any artifact does not exist, note its absence and continue. The MCP server validation in Phase 1 already confirmed the project has a valid artifact directory.

Combine the architect's codebase analysis with these artifacts to form your complete understanding of the project's current state.

## 3.2 Active Project and Phase Context

Call `ideate_artifact_query({type: "project", filters: {status: "active"}})` to retrieve the active project record.

If an active project is found, hold it as `{active_project}` and display its strategic context to the user in a brief summary block before proceeding to Phase 4:

> **Project**: {active_project.name}
> **Intent**: {active_project.intent}
> **Current phase**: {active_project.current_phase_id} — {active_project.current_phase.name}
> **Phase goal**: {active_project.current_phase.success_criteria}
> **Horizon** (next planned phases): {active_project.horizon.next | names, comma-separated, or "none defined"}

Then load the current phase artifact: call `ideate_artifact_query({type: "phase", id: active_project.current_phase_id})`. Hold it as `{current_phase}`.

If no active project is found, set `{active_project}` to `null` and `{current_phase}` to `null`. This is normal for projects that predate the project/phase model or that have not used `/ideate:init` with project tracking enabled.

---

# Phase 4: Determine Refinement Mode

Assess what is driving this refinement. There are three primary modes:

**Post-review correction** — Review findings exist and contain critical or significant issues. The user likely wants to fix what was found. In this mode, the review findings drive the interview. Produces work items.

**Requirement evolution** — The user wants to change or extend what the project does. Prior review findings may or may not be relevant. In this mode, the user's stated intent drives the interview. Produces work items.

**Alignment / recalibration** — The purpose is to *align on a spec or design*, or to *recalibrate the project's shared understanding* (decisions, steering, principles, constraints, or an existing work item's spec) — NOT to add features or fix findings. An alignment cycle persists the **conversation beats** — the decisions reached and their rationale, the interview, and any updated steering/spec artifacts — and **may legitimately produce ZERO new work items**. This is the mode for "let's talk this through and record where we landed," and it is the correct channel for spec/design alignment, so design work is captured in ideate rather than leaking into a raw doc or a general brainstorm skill. Set `{alignment_mode: true}` when this is the driver; it changes Phase 5 completion detection and Phase 7 outputs (see those phases).

**Mode is not always exclusive.** A cycle can be primarily alignment yet still surface one or two concrete work items, or primarily change-planning yet record a load-bearing decision. `{alignment_mode}` means "producing work items is NOT required for this cycle to be complete" — not "work items are forbidden." When the driver is ambiguous — the user says "let's discuss / recalibrate / align on X" rather than "add / fix / change Y" — ask which it is before interviewing rather than defaulting to work-item production.

If review findings exist (check the loaded project/phase context from Phase 3), note this to the user and ask:

> Review findings exist from a previous cycle. Are you here to address those findings, to make other changes, or both?

The answer determines which interview track to emphasize. If the user provided a change description as an argument, use it to infer the mode — but confirm if ambiguous.

## 4.1 Project Context: Continuing a Phase vs. Starting New Work

If `{active_project}` is non-null, consider the phase context when framing the refinement:

- **Phase still in progress** — `{current_phase}` has open work items (items with status other than `done`). This refinement is adding to or adjusting the current phase. Use the phase's `success_criteria` as a guardrail: proposed changes should advance or stay within the phase's goal.
- **Phase complete** — All work items in `{current_phase}` are `done`. See Section 4.2 for phase transition handling.
- **No active project** — Treat this as a standalone refinement with no phase constraints. Proceed normally.

## 4.2 Phase Completion: Transition Recommendation

If `{current_phase}` is loaded and all its work items are `done`, this is a natural transition point. Do not force a transition — present a recommendation and confirm with the user:

> The current phase **{current_phase.name}** appears complete — all its work items are done.
>
> Recommendation: transition to the next phase before planning new work.
>
> Next phase candidate: **{active_project.horizon.next[0].name}** — {active_project.horizon.next[0].description}
>
> Proceed with phase transition, or continue adding work to the current phase?

If the user confirms the transition, set a flag `{phase_transition_requested: true}` and hold `{next_phase_candidate}` as `active_project.horizon.next[0]`. The actual phase transition artifacts are written in Phase 7.

If `active_project.horizon.next` is empty when all phase work items are done, ask:

> The current phase is complete and there are no further phases planned on the horizon.
>
> Is the project complete, or do you want to define a new phase before planning work?

If the user says the project is complete, note this for the journal entry and do not create new work items. If the user wants a new phase, proceed with the interview to gather the new phase's intent and name — you will create the phase artifact in Phase 7.

---

# Phase 5: Refinement Interview

The interview adapts based on the refinement mode. Ask 1-2 questions at a time. Use the user's answers and the loaded context to inform follow-up questions.

## Rules

1. **Do not re-ask questions that existing artifacts already answer.** The interview transcript, guiding principles, constraints, and architecture document contain decisions that were already made. Do not revisit them unless the user signals they want to change something.
2. **Confirm whether guiding principles still hold.** Early in the interview, present the current guiding principles and ask: "Do these still apply, or do any need to change given what you're planning?" Accept a blanket "yes they still hold" — do not force principle-by-principle review unless the user wants it.
3. **Walk through review findings if they exist.** For post-review corrections, present the critical and significant findings from the latest cycle summary (retrieved via `ideate_artifact_query`) or synthesize from individual review findings. For each finding or group of related findings, ask: address now, defer, or dismiss? Record the decision.
4. **Use the codebase analysis.** Do not ask about technology choices the code already makes. Do not ask about architectural patterns the code already uses. Ask about what is changing and what is new.
5. **Flag conflicts.** If a proposed change contradicts an existing guiding principle, constraint, or architectural decision, state the conflict immediately. Do not silently accept contradictions. Ask the user to resolve them: change the principle, change the proposal, or accept the tension.

## Interview Tracks (Adapted for Refinement)

### Intent Track — What changed and why?

Focus on the delta, not the full vision.

- What specific changes do you want to make?
- Why? What triggered this — review findings, user feedback, new understanding, changed requirements?
- Does this alter the project's core vision, or extend it?
- Are there aspects of the current implementation you want to preserve as-is?
- What is the scope boundary for this refinement — what should NOT change?

### Design Track — How does it change the system?

Only relevant if the proposed changes affect architecture, technology, or integration.

- Does this require new technologies, libraries, or external services?
- Does this change the module structure or introduce new modules?
- Does this alter existing interfaces between modules?
- Are there new integration points with external systems?
- Does this change data models, storage, or data flow?

Skip this track entirely if the changes are scoped within existing architecture (e.g., bug fixes, behavior changes within a single module).

### Process Track — How should this be executed?

- Should the execution strategy change for this cycle? (Different parallelism, different review cadence, different agent model?)
- Are there execution lessons from the previous cycle that should be incorporated?
- Any ordering constraints on the new work items?

This track is often brief. If nothing about execution needs to change, accept that and move on.

## Completion Detection

For **change-planning** cycles (post-review correction, requirement evolution), the interview is complete when:
- The scope of changes is clear
- Conflicts with existing artifacts are resolved (or explicitly accepted as tensions)
- Review findings (if applicable) have been triaged
- Enough detail exists to produce work items that meet spec sufficiency

For **alignment / recalibration** cycles (`{alignment_mode}`), the interview is complete when:
- The decision(s) or realignment the cycle set out to reach have been made, and their rationale — including the alternatives rejected and why — is clear enough to persist
- Conflicts with existing principles, constraints, or specs are resolved or explicitly accepted as tensions
- It is clear which existing artifacts the alignment changes (steering, an overview, a specific work item's spec) — even when that set is empty
- Do NOT hold the interview open waiting for work items to materialize; reaching the alignment IS completion

Do not extend the interview beyond what is needed. Refinement interviews are typically shorter than initial planning interviews because most context already exists.

---

# Phase 6: Research New Topics

If the interview surfaces topics that require investigation — new technologies, unfamiliar APIs, domain questions not covered by existing research — spawn `ideate:researcher` agents in the background.

Prompt for each researcher:

> Investigate: {topic}
> Questions: {specific questions from the interview}
>
> Context: This is a refinement cycle. The project already uses {relevant existing technologies from codebase analysis}. Focus your research on how {new topic} integrates with or affects the existing system.

After the researcher returns, write the findings using `ideate_write_artifact` with type `research` and id `research-{topic-slug}`.

Integrate research findings into the refinement plan. If a finding contradicts an assumption from the interview, note the contradiction and resolve it (ask the user if the resolution is unclear).

Research artifacts follow the naming convention in the artifact conventions. If research on this topic already exists, create a new artifact with a distinguishing suffix (e.g., `research-oauth2-providers-v2`), not overwrite the original.

---

# Phase 7: Produce and Update Artifacts

After the interview is complete and any research has been integrated, produce artifacts. The key rule: **update what changed, leave the rest alone.**

**Alignment-cycle outputs (`{alignment_mode}`).** In an alignment / recalibration cycle, the primary output is the persisted **conversation beats**, not new work items. Do all of the "update what changed" steps that apply — interview (7a), principles (7b), constraints (7c), overview/steering (7d), architecture (7e), module specs (7f) — PLUS the decisions step (7k), which is where an alignment cycle's value mostly lands. **Skip** the work-item-production steps — execution strategy (7g), new work items (7h/7h-auto), and the phase work-items updates in 7i — whenever the cycle produces no new work items. Producing zero new work items is a valid, expected outcome; do NOT invent work items to satisfy the pipeline. If the alignment reshaped an EXISTING work item, update it in place (see the existing-item note in 7h) rather than creating a new one. Everything else in Phase 7 applies unchanged.

## 7a. Interview YAML — APPEND

Write the refinement interview using `ideate_write_artifact` with type `interview` and id `interview-refine-{cycle_number}`. Use the structured YAML format with entries per question/answer pair, matching the format from `/ideate:init` Phase 5P.1.

Tag each entry with the relevant domain name in its `domain` field. Cross-cutting questions use `null`.

## 7b. Guiding Principles — UPDATE

If any principles changed, update the relevant principle (by its GP-{NN} designation) using `ideate_write_artifact` with an amendment entry in its `amendment_history` array and an updated `cycle_modified` field. If any principles are no longer applicable, set their `status` to `deprecated`. Never delete a principle.

New principles are written using `ideate_write_artifact` with type `guiding_principle`. Use `ideate_get_next_id({type: "guiding_principle"})` to obtain the next available designation.

If the user confirmed all principles still hold, do not modify them.

## 7c. Constraints — UPDATE

Same approach as guiding principles. Update changed constraints (by their C-{NN} designation) using `ideate_write_artifact`, add new ones (use `ideate_get_next_id({type: "constraint"})` for the next designation), mark deprecated ones. Do not silently delete.

If nothing changed, do not modify them.

## 7d. Overview — OVERWRITE with Change Plan

Use `ideate_write_artifact` with type `overview` to overwrite the project overview with a **change plan** focused on the delta. This is NOT a full project description. It describes:

- What is changing and why
- Summary of the triggering context (review findings addressed, new requirements, etc.)
- Scope boundary — what is and is not being modified
- Expected impact on the existing system
- References to new work items

The previous overview content is already captured in the git history and in the original interview. The change plan replaces it because the execute skill reads the overview to understand what it is building — and for this cycle, it is building the changes.

## 7e. Architecture — UPDATE only if changed

If the refinement changes the architecture (new modules, changed interfaces, new components, modified data flow), update the relevant sections of the architecture artifact using `ideate_write_artifact` with type `architecture`. Preserve unchanged sections exactly.

If architecture is unchanged, do not modify it. State in the refinement summary that architecture remains unchanged.

If changes are significant enough to warrant a full redesign of a section, spawn the `ideate:architect` agent in **design** mode with `model: opus` and the updated context to produce the revised sections. This overrides the agent's default model for this task.

## 7f. Module Specs — UPDATE only if changed

If the refinement changes a module's scope, interfaces, or boundary rules, update the relevant module spec(s) using `ideate_write_artifact` with type `module`. If a new module is introduced, create a new module spec.

If modules are unchanged, do not modify them.

## 7g. Execution Strategy — OVERWRITE with New Strategy

Use `ideate_write_artifact` with type `execution_strategy` to write a new execution strategy. The strategy covers only the new work items produced by this refinement. It follows the same format as the original execution strategy:

- Mode (sequential, batched parallel, full parallel)
- Parallelism settings
- Worktree configuration
- Review cadence
- Work item groups with ordering
- Dependency graph for new items
- Agent configuration

## 7h. Work Items — NEW Items

**Determine the next ID**: Call `ideate_get_next_id({type: "work_item"})` to obtain the next available WI number. Use 3-digit zero-padded numbering. **Board-aware numbering (v3)**: if the v3 work-state tools are present, also call `work_list` and take the maximum across the artifact index and any board items carrying `spec_format: ideate/wi-v1` (the board is invisible to `ideate_get_next_id`; without this check, numbering can collide).

**v3 board path**: If the v3 work-state tools (`work_create`, `work_claim`, …) are present in the session — detection is mechanical tool presence, never inferred (GP-24) — create each new work item ON THE BOARD via `work_create`, called per the tool's self-describing schema (P-44: the schema, not this text, is authoritative for parameter names and shapes; the creating actor's human principal is REQUIRED, with the actor fields as flattened strings). Semantics to supply through that schema, per item:

- the title, formatted `"WI-{NNN}: {title}"`
- the full work-item body (objective, acceptance criteria, file scope, dependencies, implementation notes) as the opaque spec payload — the board never parses it — with spec format hint `"ideate/wi-v1"`
- the creating actor: the refining user as the human principal, plus the acting agent's name
- dependencies: the board item IDs of dependency items created in this same batch only. A dependency on a legacy (v2 artifact) work item cannot be a board dependency — record it inside the spec payload's dependencies section and note it in the refinement summary so the executor enforces it manually.

Hold the mapping `{WI number → board item ID}` for Section 7i — the phase's `work_items` array continues to record WI designations (phases stay v2). Do NOT also write v2 work-item artifacts on this path; the board is the single home for these items.

**v2 fallback (pre-v3 projects only)**: If the v3 work-state tools are NOT present, call `ideate_write_work_items({items_array})` — atomically creates individual work item artifacts for each new work item. This is the complete legacy behavior, unchanged — apply the loud-fallback protocol (Phase 3), including its missing-build escalation: on a project with existing board state, STOP and surface the warning before writing v2 items.

**Editing an EXISTING work item's spec** (alignment cycles, or when a change reshapes an item already on the board — including deferring or descoping one): do NOT create a new item to restate an existing one. On the v3 board path, read the item first with `work_get` (for its current `version`), then update it via `work_update_meta` (optimistic CAS on that version) — changing title/spec/depends as the alignment dictates. On the v2 fallback path, use `ideate_update_work_items`. Record the reason for the edit in the decisions step (7k) and the journal (7j). This is a spec edit, not new-item creation, and does not count toward the auto-phase-chunking threshold.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

For refinement work items, follow the same format as defined in the artifact conventions. Key differences from initial planning work items:

- **File scope uses `modify` more than `create`.** Refinement work items typically modify existing files. Reference specific existing files to modify, not abstract paths.
- **Reference existing code.** Implementation notes should reference existing functions, classes, modules, and patterns found in the codebase analysis. The executor needs to know what exists so it can integrate changes correctly.
- **Scope narrowly.** Each work item addresses a specific change. Do not bundle unrelated changes into a single work item.

For large refinements (5+ work items), spawn `ideate:decomposer` agent(s) with `model: opus` to break down the changes into atomic work items. This overrides the agent's default model for this task:

> Decompose the following changes into atomic work items. Start numbering from {next available number}.
>
> Context:
> - Architecture: {architecture artifact content}
> - Guiding principles: {guiding principle artifacts content}
> - Constraints: {constraint artifacts content}
> - Codebase analysis: {architect's analysis}
> - Changes to decompose: {description of changes from interview}
>
> These are REFINEMENT work items. The codebase already exists. Work items should reference existing files to modify, use existing patterns and conventions, and integrate with existing architecture. File scope should use `modify` for existing files.

For small refinements (fewer than 5 work items), produce work items directly without spawning a decomposer.

Validate all new work items:
- Non-overlapping file scope between concurrent new items
- Dependencies form a DAG (no cycles)
- Dependencies on existing work items are valid (those items exist)
- Acceptance criteria are machine-verifiable where possible
- 100% coverage of the changes identified in the interview

After validation passes, **run the auto-phase chunking algorithm** (Section 7h-auto below) if the new work item count exceeds the threshold. The algorithm proposes a phase grouping and presents it to the user before writing phase artifacts in Section 7i.

### 7h-auto. Auto-Phase Chunking

If the total new work item count exceeds a threshold (default: 5), automatically propose a phase grouping before writing phase artifacts. This maximizes shared context within each phase and delivers value incrementally.

**Algorithm**:

1. **Build a file-scope overlap graph**: For each pair of work items, compute the number of shared file paths in their `scope` arrays. Items that share files have high affinity.

2. **Cluster by affinity**: Group items using these rules in priority order:
   a. **Dependency clusters**: Items linked by `depends` stay in the same phase (or the dependency must flow forward to a later phase).
   b. **File-scope overlap**: Items sharing 2+ file paths belong in the same phase (shared context maximizes worker efficiency).
   c. **Domain grouping**: Items in the same `domain` have secondary affinity.
   d. **Complexity balancing**: Avoid phases with more than 6 items or total complexity exceeding 2 large items.

3. **Target phase size**: 3–6 work items per phase. If a cluster exceeds 6, split by sub-grouping (same algorithm, recursive).

4. **Phase ordering**: Phases are ordered so that cross-phase dependencies flow forward only. The phase containing items with no dependencies on other phases comes first.

5. **Phase naming**: Derive a name from the dominant theme — the most common domain, the most common file directory, or a summary of the items' titles. Keep names to 3-5 words.

6. **Present to user**: Before writing phase artifacts, present the proposed grouping:
   ```
   Proposed phase structure ({N} phases, {M} work items):

   Phase 1: {name} ({count} items)
     - WI-NNN: {title}
     - WI-NNN: {title}

   Phase 2: {name} ({count} items)
     ...

   Accept this grouping, or adjust?
   ```

   The user can: accept as-is, merge phases, split differently, or opt out of auto-chunking (all items go into the current phase).

7. **Threshold configuration**: The auto-chunking threshold is hardcoded at 5 work items. Future: make configurable via `config.json`.

If the work item count is at or below the threshold, skip auto-chunking. All items go into the current phase (or a single new phase if transitioning).

## 7i. Phase Management — UPDATE if Active Project

This section executes only if `{active_project}` is non-null.

### 7i-1. Update Current Phase Work Items List

After writing new work items in Section 7h, update the current phase record to include the new work item IDs. Call `ideate_write_artifact` with type `phase` and id `{current_phase.id}`, merging the new work item IDs into the phase's `work_items` array. Do not overwrite existing work item references — append only.

### 7i-2. Phase Transition: Promote Next Horizon Item

If `{phase_transition_requested}` is true:

1. **Mark the current phase complete**: Call `ideate_write_artifact` with type `phase` and id `{current_phase.id}`, setting `status` to `complete` and recording `completed_date` as `{date}`.

2. **Select the phase type for the new phase**: Ask the user (or infer from `{next_phase_candidate}`) which phase type applies:
   - `research` — investigation, discovery, unknowns reduction
   - `design` — architecture, interface design, planning
   - `implementation` — building, coding, testing
   - `spike` — time-boxed exploration with a specific question to answer

   Use the candidate's description to suggest the most appropriate type. Confirm with the user before creating the phase.

3. **Create the new phase**: Call `ideate_write_artifact` with type `phase` for the promoted phase. Use `ideate_get_next_id({type: "phase"})` for the phase ID. Set:
   - `name`: from `{next_phase_candidate.name}`
   - `description`: from `{next_phase_candidate.description}`
   - `phase_type`: the selected type from step 2
   - `status`: `active`
   - `started_date`: `{date}`
   - `work_items`: IDs of work items created in Section 7h that belong to this phase
   - `success_criteria`: from `{next_phase_candidate.success_criteria}` if present, otherwise derive from interview

4. **Update the project record**: Call `ideate_write_artifact` with type `project` and id `{active_project.id}`, setting:
   - `current_phase_id`: the new phase's ID
   - `horizon.next`: remove `{next_phase_candidate}` from the front of the array (it is now active)
   - `horizon.completed`: append `{current_phase.id}` to record the completed phase

If a user-defined new phase was gathered in Phase 4.2 (empty horizon case), create the phase artifact using the same steps above with the user-provided name, description, and type.

## 7k. Decisions — PERSIST the conversation beats

Run this **before 7j** so the journal can cite the decision records. This is where an **alignment cycle's** primary value lands — and it applies to any cycle that reached a load-bearing decision, not only alignment ones.

For each decision the cycle settled, capture: the choice made, WHY (including the alternatives rejected and why), what future work it is load-bearing for, and how it can later be checked.

**v3 path**: if the record tool `record_decision` is present (mechanical tool-presence detection — GP-24), call `record_decision(claim, rationale, scope, task_id?, verification_anchor?)` — one call per distinct decision. `claim` states the decision as a claim; `rationale` carries the reasoning and the rejected alternatives; `scope` names what the decision steers; `task_id` is the affected work item when one is in scope; `verification_anchor` is how the decision can later be checked (a file, command, artifact id, or dataset). These records are append-only and recallable — they are the durable memory of *why*, not just *what*.

**v2 fallback**: if `record_decision` is absent (apply the loud-fallback protocol from Phase 3), capture each decision in the interview YAML (7a) with its rationale, and additionally, for decisions that steer a domain, write a `domain_decision` artifact via `ideate_write_artifact` (id via `ideate_get_next_id({type: "domain_decision"})`). The interview + journal are then the complete record.

Do not skip this step in an alignment cycle: if the cycle produced no work items **and** no decisions were persisted, nothing durable was captured and the cycle failed its purpose.

## 7j. Journal — APPEND Refinement Entry

Call `ideate_append_journal("refine", {date}, {entry_type}, {body})` — appends a structured journal entry atomically.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration." The journal entry format to pass as `body`:

```markdown
## [refine] {date} — Refinement planning completed
Trigger: {review findings | new requirements | user request}
Principles changed: {list of changed/deprecated principles, or "none"}
New work items: {NNN-NNN range}
{Summary of what this refinement cycle addresses.}
```

**v3 process record (additive)**: If the v3 record tool `record_append` is present in the session (mechanical tool-presence detection — GP-24), ALSO append the same happening to the process record: `record_append(kind="plan-complete", claim="Refinement planning completed: WI-{NNN}–WI-{NNN}", scope="refine", content={the journal body above})`. This is additive — the v2 journal write above still happens and remains authoritative for pre-v3 readers. If `record_append` is absent, the v2 journal write alone is the complete behavior (fallback path — apply the loud-fallback protocol from Phase 3).

---

# Phase 8: Present Refinement Summary

After all artifacts are written, present a summary to the user covering:

1. **Refinement trigger** — What drove this refinement (review findings, new requirements, etc.)
2. **Scope** — What is changing and what is explicitly not changing
3. **Principles** — Any principles changed, deprecated, or added (or "all principles unchanged")
4. **Constraints** — Any constraints changed or added (or "all constraints unchanged")
5. **Architecture** — Whether architecture was modified (or "architecture unchanged")
6. **Decisions recorded** — The load-bearing decisions persisted this cycle (7k), each with its record id. For an **alignment cycle this is the headline output** — present it before work items.
7. **New work items** — List with numbers, titles, and complexity; show the dependency graph if items have dependencies. For an alignment cycle with no new items, state **"none — alignment cycle"**. Note any existing work-item specs edited in place (7h existing-item note).
8. **Execution strategy** — Mode, parallelism, expected ordering. Omit for alignment cycles that produced no new work items.
9. **Review findings addressed** — If this was post-review, which findings are addressed by the new work items and which were deferred.
10. **Open concerns** — Anything unresolved, tensions accepted, risks identified.

Format the summary for readability. Use a table for work items if there are more than three.

After presenting the summary, call `ideate_emit_event` with:
- event: "plan.complete"
- variables: { "WORK_ITEM_COUNT": "{new_work_item_count}", "CYCLE": "{cycle_number}" }

For an alignment cycle that produced no new work items, pass `"WORK_ITEM_COUNT": "0"` — the event still fires; the cycle completed by persisting decisions and updated artifacts, not by creating work.

This call is best-effort — if it fails, continue without interruption.

After the event is emitted, the user can proceed to `/ideate:execute` to build the changes.

---

# Scope Discipline

You plan only what changed. Resist the urge to re-plan everything.

- If the user says "the auth module needs OAuth support in addition to password auth," create work items for the OAuth addition. Do not re-plan the password auth module.
- If a review found three bugs, create three work items (or fewer if they can be grouped logically). Do not re-plan the entire feature area.
- If the user wants to change the UI framework, plan the migration. Do not re-plan business logic that is framework-independent.

The test: after this refinement cycle, executing the new work items and leaving everything else as-is should produce the desired result. If that is not true — if existing code also needs to change to accommodate the new work — then those existing-code changes must also be captured as work items. But only the changes, not a rewrite.

---

# Error Handling

- If the artifact directory is missing required files, stop and tell the user what is missing. Do not guess or create placeholder artifacts.
- If the architect agent fails to analyze the codebase, inform the user and ask whether to proceed without codebase analysis (the interview will be less informed).
- If a researcher agent fails, note the failure and proceed with available knowledge. Add a disclaimer to any decisions that depended on the missing research.
- If proposed changes are internally contradictory (e.g., "add OAuth but remove all authentication"), state the contradiction and ask the user to resolve it. Do not attempt to reconcile contradictions silently.

---

# Self-Check

Before completing, verify:

- [x] No `.ideate/` path references appear anywhere in this skill's output or internal logic — only in "What You Do Not Do" and self-check
- [x] No `.yaml` filename references appear — artifacts are referenced by type and designation only
- [x] All artifact reads go through `ideate_artifact_query`, `ideate_get_context_package`, `ideate_get_domain_state`, or `ideate_get_workspace_status`
- [x] All artifact writes go through `ideate_write_artifact` or `ideate_write_work_items`
- [x] Next ID for work items, principles, constraints, and phases obtained via `ideate_get_next_id` — no glob patterns
- [x] Journal entries appended via `ideate_append_journal` — no direct file writes
- [x] MCP query descriptions do not leak internal storage paths
- [x] Decomposer agent prompts pass artifact content, not file paths — verified in Phase 7h prompt template
- [x] Active project queried via `ideate_artifact_query({type: "project", filters: {status: "active"}})` — not via `ideate_get_workspace_status`
- [x] Phase transitions recommended to user and confirmed before executing — not forced
- [x] After creating work items, current phase `work_items` list updated (if active project exists)
- [x] Every v3 board/record call site (`work_list`, `work_create`, `record_append`, `record_decision`, `work_update_meta`) is paired with an explicit v2 fallback in the same section, and detection is mechanical tool presence (GP-24)
- [x] Alignment mode (`{alignment_mode}`): a zero-work-item outcome is valid; decisions are persisted (7k) via `record_decision` on v3 or interview + `domain_decision` on v2; existing work items are edited in place (`work_update_meta` / `ideate_update_work_items`), not duplicated; the interview is not held open waiting for work items
- [x] After phase transition, project `current_phase_id` and `horizon` updated
- [x] Zero occurrences of `ideate_get_project_status` in this skill
