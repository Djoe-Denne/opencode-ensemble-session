# Deferred publication and supervisor acceptance

Publication, dependency readiness and acceptance are separate contracts. Keep a
consumer off the shared board until its inputs and independent briefing are
ready; do not cancel or falsely complete tasks to change their scheduling.

## Native interface

The existing `team_tasks_add` tool accepts two optional task fields:

- `publication: "published" | "deferred"` (default `published`).
- `completion_policy: "assignee" | "lead"` (default `assignee`).

Only the lead may explicitly set these fields. Preparation documents accept the
same fields; the initial import preserves them before mission approval, without
launching workers. Existing documents and tasks retain their former defaults.

Use `completion_policy: "lead"` on a producer whose consumers must wait for
supervisor review and integration. Its author reports a deliverable but cannot
close the task. The supervisor runs the agreed checks, integrates the result,
then calls `team_tasks_complete`. This is an authorization gate, not automatic
proof that integration or checks actually occurred.

For existing, unassigned tasks before admission, the lead can make one atomic,
justified batch through the same tool:

```json
{
  "tasks": [],
  "task_controls": [
    {
      "task_id": "<actual producer ID>",
      "completion_policy": "lead",
      "reason": "Consumers require integrated and verified inputs"
    },
    {
      "task_id": "<actual audit ID>",
      "publication": "deferred",
      "reason": "Prepare the independent audit before publishing it"
    }
  ]
}
```

Publish later with `publication: "published"` and a reason. This can immediately
trigger configured classification and dispatch, but never bypasses mission
approval, dependencies, native permissions or the concurrency limit. Publishing
a blocked task leaves it blocked. Resolving dependencies on a deferred task
leaves it deferred. Deferring a producer never resolves any dependency.

## Safety and visibility

- Deferred tasks cannot be claimed, spawned, classified or completed. Pool
  selection and admission enforce publication independently.
- The lead still sees them, labelled, in `team_tasks_list`. Other members do
  not see their rows or counts in board/status/compaction projections.
- The unauthenticated shared dashboard omits deferred tasks and dependency IDs
  that point to them. Use the lead's task-list tool for the private projection.
- Controls reject assigned, routed, terminal, previously admitted or currently
  classifying tasks, and retained result candidates. Admission is recorded even
  if delivery subsequently fails or a worker's task is requeued.
- An allocation already in flight must recheck the task's control revision
  before delivering its prompt. A concurrent correction rolls it back.
- Controls preserve IDs, content, dependency edges and execution decisions;
  they do not stop running agents or implement general task revision/deletion.
  A reason and before/after revision are retained in `task_control_event`.

## Independent audits

For a new independent audit, record `publication: "deferred"`,
`context: { "mode": "fresh" }`, the intended native profile and
`report_mode: "final_response"` before import/addition. Choose `worktree` for
the actual read/write mandate. Qualify the native profile's permissions and
prepare a self-contained briefing before explicitly publishing the task.

Fresh history and final-response reporting alone are **not** board isolation.
After publication, the audit is shared like any other published task. Native
profile permissions still govern what its session can read or execute.

Deferral cannot retract earlier messages, prompts, classifier inputs, logs or
copies of the preparation document. Do not put private audit instructions in
other published task descriptions or shared messages. This is an Ensemble
publication boundary, not an operating-system or repository secrecy boundary.

## Migration and deployment

Migration 30 is additive. Old tasks remain published with assignee completion;
known assignment/routing/terminal state backfills an admission timestamp.
Historical admission of an old, already-requeued legacy task cannot be
reconstructed if the previous schema retained no evidence. Never interpret a
null timestamp as proof that no information was previously disclosed.

Tests use isolated databases; building this change does not update a deployed
plugin or repair an existing mission. Deploying to a shared service, migrating
its live database and correcting its actual task IDs are separate operations.
Do not run an older plugin against the migrated schema or overwrite live state
with a backup as an implicit rollback.
