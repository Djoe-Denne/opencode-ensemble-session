# Anti-Patterns

These are the coordination failures Ensemble should prevent, not amplify.

## Anti-Pattern: Spawning Because The Task Feels Hard

What it looks like:
- The lead creates a team before identifying independent slices.

Why it fails:
- More agents add merge, review, and communication overhead. Parallelism helps only when the work can be separated.

Better approach:
- Handle the question directly or use one focused research mission. Add workers only after useful boundaries are clear.

## Anti-Pattern: Vague Delegation

What it looks like:
- Prompts such as "fix the tests", "review this", or "handle the frontend".

Why it fails:
- Teammates produce broad, overlapping, or unverifiable work.

Better approach:
- Name the files, behavior, constraints, output format, and verification command whenever possible.

## Anti-Pattern: One Agent Per File

What it looks like:
- The lead splits work mechanically by filenames rather than user-visible behavior.

Why it fails:
- Features usually cross file boundaries. File-based slicing creates integration gaps and duplicated assumptions.

Better approach:
- Slice by behavior, subsystem, or vertical flow. Assign files only when ownership is already clear.

## Anti-Pattern: Parallelizing Coupled Edits

What it looks like:
- Two builders modify the same schema, shared component, test helper, or API contract simultaneously.

Why it fails:
- Merge conflicts are the minor problem. The larger problem is incompatible design choices.

Better approach:
- Use one builder for the shared contract, then unblock dependent tasks with `depends_on`.

## Anti-Pattern: Polling The Team

What it looks like:
- The lead repeatedly calls `team_status` or `team_tasks_list` while teammates are working.

Why it fails:
- It wastes turns and can distract the lead from review and integration.

Better approach:
- Wait for teammate messages. Use status tools when the user asks for a snapshot or when a teammate appears stalled.

## Anti-Pattern: Trusting A Result Without Review

What it looks like:
- The lead merges and summarizes a teammate branch based only on "done".

Why it fails:
- Teammates can miss tests, drift from scope, or make unsafe assumptions.

Better approach:
- Read `team_results`, run `team_merge`, inspect `git diff`, and verify with project commands.

## Anti-Pattern: Letting Read-Only Agents Write

What it looks like:
- A scout or reviewer receives a default worktree and broad editing prompt.

Why it fails:
- Read-only roles create extra branches and blur ownership.

Better approach:
- Use a native read-only profile, such as `explore`, with `worktree: false`. Configure permissions explicitly for custom profiles; a role label does not prevent writes.

## Anti-Pattern: Hiding Plan Approval In The Prompt

What it looks like:
- The lead tells a teammate "send me a plan first" but omits `plan_approval: true`.

Why it fails:
- The teammate may start editing immediately because the tool-level spawn mode did not reinforce the gate.

Better approach:
- Pass `plan_approval: true` for risky work and approve or reject through `team_message`.

## Anti-Pattern: Turning a Recipe into a Required Pipeline

What it looks like:
- Every request creates an explorer, an architect, and three implementers regardless of scope.
- Agent Markdown files duplicate the skill and require specific downstream role names.

Better approach:
- Keep coordination know-how in the skill, project policy in `AGENTS.md`, and expertise in optional profiles. Choose team size and transitions from the actual mission; a single agent is a valid outcome.

## Anti-Pattern: Replacing Native History with a Pasted Summary

What it looks like:
- A requested inherited worker is created fresh with a manually copied transcript or summary.
- Fork errors are bypassed by removing `context` or disabling worktree isolation.

Better approach:
- Use native fork/checkpoint/compact_fork and report capability or Git-state failures explicitly. An independently scoped fresh mission is a separate deliberate decision, not a silent fallback.

## Anti-Pattern: Treating Handoff as Promotion or Isolation

What it looks like:
- A member switches to a profile named `orchestrator` and attempts lead-only spawning.
- A shared-directory researcher switches to a writer and assumes it gained a worktree or a different model.

Better approach:
- Handoff keeps team identity, directory, and selected model. Ask the lead to create isolated follow-up workers or change a teammate's model when that is the intended operation.

## Anti-Pattern: Always Overriding the Model

What it looks like:
- Every fork injects a model just because an example did so, defeating intentional source-model inheritance.
- Handoff is expected to apply the target profile's default model automatically.

Better approach:
- Inspect task/project model policy. Use explicit overrides deliberately; otherwise retain the native/configured selection. Handoff and model selection are separate operations.

## Anti-Pattern: Folding Discovery into One Shared Worktree

What it looks like:
- A preparation document uses `type: "planning"`, puts `model` or `kind` in the JSON, or addresses a question to a teammate.
- Two dependent tasks share a parallel group, or two writers are told to edit one checkout.
- A read-only PM writes files, or a worker command runs against the user's main checkout.

Why it fails:
- The parser rejects the illegal document, or the import holds direct code on version 2. Coupled edits lose the reconciliation note that separate branches are there to provide.

Better approach:
- Follow [preparation](preparation.md): supervisor questions, documentary handoffs with sources, `planning.required` for a local plan, and `isolation: "separate-worktrees"` only for tasks that do not depend on each other. Keep `start` as the user's execution gate.
