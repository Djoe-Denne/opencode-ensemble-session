# Worker reporting and lead review

Execution activity, result availability, task validation and integration are
different states. An inactive native session is not evidence of successful work.

## Restrictive profiles

Use the explicit `final_response` reporting mode for QA/reviewer profiles that
cannot invoke Code Mode or team tools:

```typescript
team_spawn({
  name: "qa-plan",
  agent: "qa",
  prompt: "Return the regression plan. Do not edit files.",
  worktree: false,
  claim_task: planTaskID,
  report_mode: "final_response",
})
```

This mode adds no session permission grants. Native agent restrictions remain
in force, including through permission-evaluation hooks, inherited spawning and
handoff. It does not infer read-only capabilities from the name `qa`; select an
appropriate native profile and use `worktree: false` when no isolated writes are
needed. Read-only built-in profiles can own tasks in this mode because only the
lead is responsible for task closure.

Workers return findings, plans or blockers in their final response and stop.
Spawn instructions, context/compaction reminders, shutdown and watchdog paths do
not require them to call unavailable team tools. These workers are not reused by
the automatic task pool: review and any subsequent assignment belong to the lead.

## Profile contract

Two classes, detected and never rewritten automatically:

- Collaborator (`team_message`, the default): the profile allows `execute` and
  the Ensemble member tools after a `*` deny, and the body reports through
  `team_message`. The template is
  `skills/ensemble-project-setup/references/teammate-profile.md`.
- Restrictive (`<!-- ensemble-report: final_response -->` and spawn
  `report_mode: "final_response"`): deny-all read/glob/skill is legitimate. The
  linter does not require Ensemble tools. The lead closes tasks.

The permission hook does not grant `edit` or `bash`. Those stay on the profile.
`bun scripts/lint-agent-profiles.ts <agents-dir>` reports the gap. Applying a
permission diff needs a separate approval.

## Native candidates

On inactivity, Ensemble retrieves the latest assistant response, requiring a
normal `stop` finish, a completion timestamp, current-work-period provenance and
nonempty visible text. It rejects stale responses, errors, interrupted/truncated
turns, tool-call continuations and reasoning-only messages. It also checks native
activity rather than relying solely on cached member status. Unknown/unsupported
message shapes are not treated as successful output.

The plugin persists a **candidate**, with the worker identity, native session and
message IDs, associated task IDs and full content. A unique native-message key and
transactional inbox insertion prevent repeated events or restarts from creating
duplicate candidates or notifications. Lead wake signals are best-effort and may
be retried after a restart; exactly-once native transport delivery is not claimed.

The lead retrieves full candidates with `team_results({ from: "qa-plan" })`.
Reading marks them read, not accepted. Retained candidates can be retrieved again
using `team_results({ candidate_id: "result_..." })`. Candidates are only exposed
to their team's lead and survive ordinary worker shutdown. Even content larger
than the team-message limit is retained in full.

Neither recovery nor reading changes task completion or releases consumers. The
lead must review the candidate, persist/commit/integrate the required artifact,
perform the applicable verification, and only then call `team_tasks_complete` on
the prerequisite. Completing these tasks is lead-only, including fallback
candidates whose original assignee has since been released. For a QA-plan →
author workflow, do not complete the plan merely because the response is visible.

This is an explicit lead-controlled integration barrier, not an automatic proof
that a commit or merge happened. Legacy task dependencies still resolve on board
completion (or cancellation); model any separate integration prerequisite as its
own lead-owned task where necessary.

## Existing workers

`team_message` remains the default mode. Workers send structured `<task-result>`
reports with `status` (`completed` or `failed`), `summary` and `details`. Questions,
progress updates and reports from an earlier work period do not count as final
reports. The completed-member wake guard remains effective for real reports.

If such a worker stops without a structured team report but has a valid native
final response, Ensemble can recover it as a candidate for lead review rather
than unnecessarily waking it. If no final response is available, inactivity is
not turned into success. Restrictive workers are reported to the lead instead of
being instructed to use unavailable tools.

V2 startup recovery retrieves already-idle candidates, including workers stopped
during graceful shutdown, and retries pending lead inbox wake signals. Explicit
execution failure remains a failure; a later duplicate idle event cannot erase
it or resurrect a shut-down worker. The V1 event path also supports native
candidate recovery, subject to the message metadata exposed by its SDK.

## Supervisor liveness safety check

While the plugin is loaded, an internal timer checks each project's active
missions every **ten minutes**. No external cron or OS scheduled task is needed.
This is a conditional recovery backstop, not a periodic task reminder to workers
and not a replacement for normal event-driven report delivery.

A wake is eligible only when unfinished board work (`pending`/`in_progress`) or
unreviewed worker reports remain, the mission is running under its approved
policy (legacy teams retain their existing admission rules), and recorded work
has not changed for at least ten minutes. The check consults native session
activity, including the lead, workers and classification helpers; stale SQLite
`busy` flags alone cannot conceal an inactive worker. A native busy/retry/unknown
state, worker initialization, pending configuration, an archived project/team or
an attention/critical stop suppresses the wake. Completed/blocked-only missions
without pending reports are left alone. Pending native permission requests also
suppress V2 recovery when the host exposes the public permission-list API; failed
or malformed status/permission inspection is not treated as proof of idleness.

Immediately before waking, activity and admission are checked again. A concise
diagnostic is saved to the lead's team inbox, then a persistent synthetic message
wakes the idle lead to inspect missing reports and resume permitted coordination.
The check never spawns, aborts, completes tasks, changes the mission policy or
grants permissions. It does not certify that a worker finished successfully.

An unchanged incident reuses the same inbox diagnostic, and persisted recovery
state limits delivery to at most one attempt per team per ten-minute window,
including across concurrent plugin instances and reloads. If the lead remains
inactive with unattended work, a later check may retry; transport acceptance
alone is not proof that coordination resumed. `promptAsync` is never awaited.
The V2 timer stops on plugin disposal; V1 runs the same safety check through the
existing watchdog lifecycle. No recovery runs while the OpenCode service/plugin
is stopped, and this backstop does not by itself identify the original cause of
a lost report, dead event subscription or failed model execution.
