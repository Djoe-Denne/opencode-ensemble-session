# Lead Checklists

Use the relevant checks for the chosen mission; they do not prescribe a team topology.

## Pre-Spawn Checklist

- The user goal is one sentence.
- The task is large enough to justify coordination overhead.
- Each teammate has one clear owner area.
- No two builders are expected to edit the same files.
- Read-only work uses a native read-only profile and `worktree: false`; custom names do not imply permissions.
- Use `plan_approval: true` where the mission or project policy calls for reviewed plans.
- Task dependencies are represented with `depends_on`.
- Context strategy and model policy match the mission; an independent review starts fresh.
- Verification commands are known before work starts.

Resolve unknowns directly or through a focused research mission before committing to a larger team.

## Spawning Checklist

- Call `team_create` before `team_spawn`.
- Add shared tasks with `team_tasks_add` before assigning task IDs.
- Spawn teammates one at a time and wait for each tool result.
- Keep teammate prompts focused and under one clear responsibility.
- Tell teammates what to report, not just what to do.
- Do not describe lead-only tools in teammate prompts.
- A claimed task is unblocked, and its producer's files are available on the intended base; dependency completion alone does not transfer changes.
- For inherited spawns, confirm a team-scoped source, required native capabilities, and clean matching Git HEADs before a cross-directory move.
- For checkpoint mode, use the exclusive native boundary; for compact_fork, use a distinct idle source.
- For handoff, confirm that retaining the current directory and model is intended; only the calling session changes profile.

## While Running Checklist

- Wait for `team_message` updates instead of polling `team_status` repeatedly.
- Use `team_results` for full content when a message is truncated or consequential.
- Forward relevant findings between teammates when it changes their work.
- Reject unclear plans instead of approving them under time pressure.
- Stop and ask the user if teammate outputs conflict with each other or with the user's goal.
- Present a linked checkpoint report between meaningful stages, and a current
  decision report before every user question: context, evidence, limits, options,
  consequences and recommendation. Group related questions; do not add approvals.
- Use Markdown by default. A Canvas requires an owned running preview backend
  and a verified loopback URL/content; otherwise use Markdown. Track its handle
  and keep it available during the decision, then stop it when no longer needed.

## Merge Checklist

- Read the teammate's task result.
- Shut down the teammate with `team_shutdown`.
- If shutdown warns about uncommitted changes, resolve that before merging.
- Merge with `team_merge`, not manual git commands.
- Inspect `git diff` after each merge.
- If two branches overlap in surprising files, review before merging the next branch.

## Cleanup Checklist

- All active teammates are complete, shut down, or intentionally force-stopped.
- Relevant teammate branches have been merged or deliberately left out.
- Verification commands have passed or blockers are clearly reported.
- `team_cleanup` has run after review and verification.
- Final user summary includes what changed, tests run, and any residual risks.
- Final report is saved/linked, and any owned report preview no longer needed
  is stopped without affecting unrelated services.

## Verification Checklist

Use the repository's own commands. For opencode-ensemble itself, run:

```bash
bun run typecheck && bun test && bun run build
```

If a command fails, report the failure with the command and error summary. Do not claim the team completed successfully.
