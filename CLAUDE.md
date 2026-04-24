# Ideate

A Claude Code plugin providing a structured SDLC workflow. Ideate takes a rough idea through planning, execution, review, and refinement — accumulating knowledge across cycles in a domain layer so later cycles get faster, not slower.

## Plugin structure

```
agents/          # Specialized agents (code-reviewer, architect, domain-curator, etc.)
skills/          # User-invocable skills (plan, execute, review, refine, autopilot)
scripts/         # Utility scripts (validate-specs.sh, migrate-to-optimized.sh)
.ideate/          # Artifact workspace (per-project or monorepo-integrated). The plugin participates in a monorepo-level artifact workspace when developed in that environment; the authoritative .ideate/ lives at the monorepo root. Standalone plugin use works with a local .ideate/ in the user's project root.
```

## Skills

| Skill | What it does |
|---|---|
| `/ideate:init` | Initialize a project — auto-detects existing codebase (survey + lightweight interview) vs new project (full interview, research, architecture, work items) |
| `/ideate:execute` | Build work items with per-item incremental review |
| `/ideate:review` | Capstone review: cycle (default), `--domain`, `--full`, or natural language scope |
| `/ideate:refine` | Plan the next cycle of changes |
| `/ideate:autopilot` | Autonomous execute → review → refine loop until convergence |
| `/ideate:project` | Manage projects and phases — create, view, switch, complete, archive |
| `/ideate:triage` | Quick work item intake — bug reports, feature requests, chores |
| `/ideate:status` | Project status views — workspace, project, or phase perspective |
| `/ideate:settings` | Interactive configuration for agent budgets, model overrides, and PPR weights |

## Artifact structure

Skills produce YAML artifacts accessed exclusively through MCP tools. The layout is anchored by a pointer file at the project root:

```
<project-root>/
├── .ideate.json             # Config pointer (schema_version 9, artifact_directory)
└── .ideate/                 # Artifact tree (default; overridable via artifact_directory)
    ├── projects/            # PR-{NNN}.yaml per project
    ├── phases/              # PH-{NNN}.yaml per phase (scoped within a project)
    ├── plan/                # architecture.yaml, overview.yaml, execution-strategy.yaml
    ├── steering/            # guiding-principles.yaml, constraints.yaml, research/
    ├── work-items/          # WI-{NNN}.yaml per work item
    ├── principles/          # GP-{NN}.yaml per guiding principle
    ├── constraints/         # C-{NN}.yaml per constraint
    ├── policies/            # P-{NN}.yaml per domain policy
    ├── decisions/           # D-{NN}.yaml per domain decision
    ├── questions/           # Q-{NN}.yaml per domain question
    ├── interviews/          # refine-{NNN}/ per cycle
    ├── cycles/              # {NNN}/ per cycle (findings, journal entries, summaries)
    ├── modules/             # Module specs (if used)
    └── research/            # RF-*.yaml research findings
```

`.ideate.json` is a JSON file at the project root. Minimal example:

```json
{
  "schema_version": 9,
  "artifact_directory": ".ideate"
}
```

The `artifact_directory` field is a path relative to `.ideate.json`'s containing directory (or an absolute path that passes through unchanged). When absent, the default is `".ideate"`. All other configuration fields (`agent_budgets`, `model_overrides`, `spawn_mode`, etc.) are co-located in `.ideate.json` rather than inside the artifact tree.

All artifacts are YAML files with one file per artifact. The domain layer (policies, decisions, questions) is maintained by the domain-curator agent after each review cycle. `cycles/` contains immutable cycle-scoped artifacts (findings, journal entries, summaries).

## Development workflow

Ideate uses its own workflow to develop itself. The `.ideate/` directory is the artifact directory for ideate's own planning and review.

- Work items: `.ideate/work-items/WI-{NNN}.yaml`
- Cycle reviews: `.ideate/cycles/{NNN}/`
- Domain knowledge: `.ideate/policies/`, `.ideate/decisions/`, `.ideate/questions/` (4 domains: workflow, artifact-structure, agent-system, project-boundaries)

To run a review cycle on ideate itself: `/ideate:review`

**Changes to ideate must go through the refinement cycle** (`/ideate:refine` → `/ideate:execute`), not direct code edits. Ideate uses its own structured SDLC workflow for self-development.

## Key conventions

- The domain curator uses opus; all other agents default to sonnet unless overridden
- `spawn_session` (outpost) is an optional enhancement; Agent tool is the primary spawning mechanism
- `DEFER` (not `DEFERRED`) is the proxy-human deferral signal that autopilot checks for

## Self-Check

| Acceptance criterion | Status |
|----------------------|--------|
| `projects/` directory in artifact structure diagram | Done |
| `phases/` directory in artifact structure diagram | Done |
| Zero references to `ideate_get_project_status` | Done — not present |
| Zero references to `ideate_bootstrap_project` | Done — not present |
