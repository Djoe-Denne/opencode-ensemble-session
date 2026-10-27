# Context Continuity

Use native context inheritance when an existing conversation is relevant to the next mission. Use a handoff when the same session should continue under another profile. Neither operation prescribes a particular team shape.

## Capabilities and Connection

- Fresh spawning remains available on V1 and V2. Inheritance and handoff require this fork's V2 continuity capabilities; V1 rejects them explicitly.
- Prefer the host's native `session.fork` when exposed. Otherwise Ensemble discovers the existing shared server through the public `Service.discover()` API and obtains authentication headers in memory via `Service.headers()`. It never starts a service. No per-session configuration or persisted credentials are needed.
- For a private/non-registered server, explicitly configure `v2ApiUrl` in `.opencode/ensemble.json` or `OPENCODE_ENSEMBLE_V2_API_URL` in the server process, plus `OPENCODE_ENSEMBLE_V2_AUTHORIZATION` when required. Explicit URLs never receive discovered credentials. Keep authentication out of prompts, skills, and committed project files.
- The adapter verifies source identity across the native and HTTP views. A missing capability, mismatched server, or failed authentication is an explicit error. Do not retry by silently dropping the requested context.

## Spawn Modes

The `context` field accepts `mode`, optional `from`, and a checkpoint-only `messageID`:

```ts
context: { mode: "fresh" }
context: { mode: "fork", from: "mapper" }
context: { mode: "checkpoint", from: "mapper", messageID: "msg_actual_boundary" }
context: { mode: "compact_fork", from: "mapper" }
```

These are choices, not sequential stages:

- Omit `context` or choose `fresh` for independent work. Fresh rejects source/boundary options.
- Choose `fork` for the source's full projected native history, followed by the new mission delta. The child and source subsequently evolve independently.
- Choose `checkpoint` for an exclusive native boundary. With messages A/B/C/D/E, pass **D's** real ID to include C and omit D/E. Never invent an ID or use a task ID here.
- Choose `compact_fork` only for a **distinct idle source**. Native compaction changes that source's projected context; OpenCode's completed compaction record supplies the summary and retained recent context. It is not a pasted summary in a fresh session.

Sources default to `current`; `lead`, member names, and native IDs from the same team are supported. A completed member remains a valid source while its native session exists. An initializing source is rejected. Only the lead can spawn, even when the useful source belongs to another member.

## Task-Level Context

Put `context` on the task itself in `team_tasks_add` or the PM preparation
document when it is a requirement, not just on a later `team_spawn` call.
Explicit `fresh` means a new session without inherited conversation history.
All four modes require a new session; old workers cannot manually claim or be
auto-dispatched that task. The task's `agent` is enforced for this admission.
Spawn with `claim_task` inherits its stored context/profile and rejects conflicts.
Omitted task context retains normal pool reuse. Auto-scale creates the required
session within capacity; otherwise work stays pending until an explicit spawn
or capacity becomes available. Never silently substitute reuse or fresh history.

For added tasks, omitted `from`/`current` is bound to the task creator. For PM
imports it means the supervisor session, not the temporary PM session. Checkpoint
requires a real exclusive native `messageID`; source names/IDs must belong to
the team. See `docs/task-pool.md` for scheduling details.

## Handoff

Inside the session that should change profile:

```ts
await tools.team_handoff({ agent: "target-profile" })
```

Use an available native profile; for reusable session/handoff profiles, choose `mode: primary` or `mode: all` in the agent definition as appropriate. The next provider turns use the target profile. The current tool invocation is not restarted under a new identity.

Handoff keeps session ID, history, task ownership, team role, worktree, and selected model. It changes neither the number of teammates nor lead privileges. Native target-agent policy replaces Ensemble-owned overrides while user session rules are retained. Concurrent handoffs of the same session are rejected until the pending one completes or is reconciled.

If the selected model should change as well, the lead can use `team_message({ to: "member-name", model: "provider/model" })`. Do not assume the target profile's preferred model replaces the session's existing selection. Spawn-level `model` and Ensemble `defaultModel`/`modelsByAgent`/pool settings may likewise override a fork's inherited selection; inspect policy before promising model continuity.

## Files and Isolation

Inherited writers are forked, moved into their worktree, switched to the target profile, and given their mission before provider execution is admitted. Ensemble guards initialization so native control wakes cannot execute the writer at the source directory.

A cross-directory move requires clean Git state and matching HEADs at source and destination. A conversation fork does not copy uncommitted files or source-only commits. Integrate the source branch, commit the intended shared base, or resolve dirty state before retrying. Preserve the user's changes while doing so.

`worktree: false` deliberately shares a directory. A handoff of a shared-directory researcher into a writer stays there; use a new isolated fork when independent implementation is intended. Custom read-only profiles need native permissions plus an explicit `worktree: false`; their name alone changes nothing.

## Admission and Recovery

The plugin persists source/boundary provenance and pending initialization. A failed spawn releases claims and removes known unadmitted resources. If OpenCode already admitted the task despite a lost response, recovery adopts the existing child instead of removing its work. Interrupted handoffs reconcile the actual native agent/model.

Before retrying an uncertain spawn, inspect the returned error/team state and any recovery notice so you do not duplicate admitted work. Creation acknowledgements lost before the native resource ID is known, including late worktree creation after a timeout, remain outside the proven cleanup guarantee.

Admitted workers use the normal report → shutdown → merge → verify → cleanup lifecycle. Dependencies are still task-board state: inherited history never makes a blocked task claimable.
