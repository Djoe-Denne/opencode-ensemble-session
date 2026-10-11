# Coordination Patterns

These are optional recipes, not required stages. Choose, combine, or omit them according to the mission. Profile names, team size, and context transitions belong to the project and task; keep ownership narrow and outputs verifiable.

## Pattern: Scout, Builder, Reviewer

Best for unfamiliar code or risky changes.

Team:
- `scout`: `explore`, `worktree: false`, maps files, tests, risks, and recommended slice boundaries.
- `builder`: `build`, `worktree: true`, implements one narrow change.
- `reviewer`: `explore`, `worktree: false`, reviews the merged diff and test evidence.

Why it works:
- The scout reduces blind implementation.
- The builder has a focused edit surface.
- The reviewer checks the integrated result instead of creating another branch.

Use `plan_approval: true` when the mission or project policy needs a reviewed implementation plan. Choose a native fork from the scout when its actual history is useful, or fresh context when a scoped independent prompt is sufficient. Keep independent final review fresh.

## Pattern: Parallel Independent Slices

Best when two or three vertical slices do not overlap.

Team:
- `api-dev`: `build`, owns backend endpoint or service change.
- `ui-dev`: `build`, owns frontend state or component change.
- `qa`: `build`, owns tests after one or both implementation tasks complete.

Task setup:
- Add implementation tasks first.
- Add QA task with `depends_on` pointing to the implementation task IDs.
- If both builders may touch shared contracts, settle those contracts before parallel edits, directly or through a focused research mission.

Avoid this pattern when two builders would edit the same files or would need constant synchronization.

## Pattern: Research Fan-Out

Best for comparing options before implementation.

Team:
- Two or three `explore` teammates.
- All use `worktree: false`.
- Each investigates a different option, subsystem, or risk.

Lead responsibility:
- Give each researcher an explicit question.
- Ask for a recommendation with tradeoffs and evidence.
- Do not merge anything because no branches should be produced.

## Pattern: QA After Implementation

Best when tests should reflect actual implementation details.

Task setup:
- Builder task: implement and commit the narrow change.
- QA task: `depends_on` builder task ID.
- Reviewer task: `depends_on` builder and QA task IDs.

Prompt QA to verify behavior from the public API or user flow, not to simply mirror implementation internals.

Completing a dependency does not copy its files into another worktree. Integrate the producer's changes into the intended base before spawning dependent implementation/testing work. Native inheritance also requires clean matching Git HEADs for a cross-directory move.

## Pattern: Hotfix With Plan Approval

Best for production-risk changes.

Team:
- `scout`: quick read-only impact map.
- `fixer`: `build`, `plan_approval: true`.
- `reviewer`: read-only final review.

Lead flow:
1. Spawn scout first.
2. Use scout findings to constrain fixer's prompt.
3. Approve or reject the fixer's plan through `team_message`.
4. Merge only after reading the task result and inspecting the diff.
5. Run targeted verification before cleanup.

## Pattern: Continue Under Another Specialty

Best when one conversation should continue under a different available profile, without another parallel worker.

- The current member calls `team_handoff({ agent: "target-profile" })` when the next specialty is needed.
- Its next provider turns keep the same history, identity, tasks, worktree, and selected model.
- The member still reports to the lead; it cannot create new workers by changing its profile name.
- If the next stage should write in an isolated directory, ask the lead to spawn an inherited writer instead of assuming handoff creates a worktree.

Possible specialties include API design, compatibility review, test design, or documentation. An explorer becoming an architect is just one instance of this pattern.

## Pattern: Fan Out from Useful History

Best when several independent missions need the same accumulated evidence.

- The lead chooses an existing team session as the source; it can be the lead or a finished member whose native session remains available.
- Each worker receives `context: { mode: "fork", from: "source-member" }` and its own bounded mission delta. Choose the number of workers from actual independent slices.
- A checkpoint limits inheritance before an unwanted turn; `compact_fork` is an explicit choice to compact a distinct idle source first.
- Writers get separate worktrees. Check clean matching Git HEADs; conversation history is not a Git patch transfer.
- Use fresh context for an independent reviewer so it assesses the result without inheriting the source's conclusions.

Read [context continuity](context-continuity.md) before applying these native operations.
