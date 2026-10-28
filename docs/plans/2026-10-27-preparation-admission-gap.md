# ARTIST preparation admission gap — 2026-10-27

## Current outcome after authorized repair

The user approved **correction and local deployment** after the initial
investigation. The fix is deployed in local package
`20261027-preparation-admission-ac2bbe7eb142` (bundle SHA-256
`ac2bbe7eb1424c27b0885aa2709e9ac58d38db7e05017a4249d66519c1509d21`).
Source changes are deliberately uncommitted; this is not an npm publication.

- Preparation and board tasks now preserve structured scores and isolation/
  reporting options. New-session contracts apply to explicit spawn and
  auto-scale, reject contradictory overrides, and are rechecked after allocation.
- Governed native-profile candidates can use final-response reporting without
  receiving team-tool grants or planning permission overlays. Fresh sessions
  explicitly clear inherited supervisor overrides with `permission:[]`.
  Native profile permissions remain authoritative. Candidates cannot transition
  execution phase/reasoning or close tasks; lead acceptance still gates consumers.
- Migration 29 adds nullable `spawn_options`. A coherent online database backup
  and migration rehearsal preserved the contents of all 23 existing tables.
  Live schema 29 and `integrity_check=ok` were verified after config hot reload;
  the service PID remained 4160. No service restart was required.
- Final local validation: typecheck passed; **1807 tests passed, 0 failed**;
  build passed; targeted Serena diagnostics were empty.
- Native qualification admitted `explore` in fresh context, without a worktree,
  under the governed task's selected model and final-response contract. Native
  session `ses_e82db3db4ffeVKP7no7EJI1Iwo` reported profile `explore`, no fork,
  and `permissions:[]`. Its first provider call failed with monthly Go quota
  exhaustion (HTTP 429), with zero tokens. Therefore **actual native reading
  and final-result delivery remain inconclusive**, not a claimed success.
  No model substitution or paid fallback was activated. The owned diagnostic
  worker was shut down and its team archived without falsely completing its task.
- The ARTIST supervisor received the repair details and limitations. Only its
  native `prepare --resume` command was invoked, keeping the existing dossier,
  contract and scores. No `start`, approval, classifier activation, source-engine
  changes or operator-pause override was performed. ARTIST QA qualification
  remains its first execution task before authors, not a proof already acquired.

Backup and deployment manifest:
`~/.config/opencode/local-plugins/ensemble/backups/20261027-preparation-admission-ac2bbe7eb142/`
and the new package's `deployment.json`. Rollback must account for schema 29;
do not point the old schema-28 plugin at the migrated database or overwrite
new live state with the backup without a separate controlled recovery decision.

## Initial investigation (before repair approval)

The ARTIST session “Accès préparé aux uniforms OpenGL” is blocked by an
incomplete Ensemble execution contract, not by a missing C++ design decision.
The plugin investigation confirmed the reported transport gap and found an
additional incompatibility with restrictive reviewers. No execution was
authorized, no live database was edited, and no ARTIST files were changed.

The supervisor was contacted through the native session prompt API and
acknowledged the findings. Its mission remains paused; messaging is not a
technical unblock or user approval.

## Reproduction boundary

- Repository HEAD: `88efee8f402a8f24322a0e2db681f7ce0e176bf3`.
- The globally configured Ensemble deployment identifies that same clean source
  commit in its deployment manifest. This is not evidence of an untested patch.
- Native OpenCode service: version 2.1.4, responding to `/api/info`.
- ARTIST supervisor: `ses_e8390245bffdS3NfX0qwRMR5ed`.
- Preparation PM: `ses_e8375229fffe2i54YJk4AVWb5i`.
- Latest examined PM candidate: `msg_17c97f060001rNsZrOHM4w8Q9o`.
  Version 2, blocked, six tasks, no parallel groups.

## Confirmed findings

### 1. Preparation cannot encode the requested admission contract

`PreparationTask` and `readTask` in `src/preparation-document.ts` accept
`agent` and `context`, but not `complexity`, `risk`, `worktree`, or
`report_mode`.

An isolated executable probe passed each additional field to the real parser.
Each was rejected with `tasks[0].<field> is not supported`.

`persistPreparedTask` in `src/preparation-import.ts` preserves the agent and
spawn context. Scores described in `handoff.document` remain prose. A probe
using the real importer and an in-memory migrated database produced:

```json
{
  "complexity": null,
  "risk": null,
  "agent": "qa-planner",
  "spawn_context": "{\"mode\":\"fresh\"}",
  "classification_status": "not_required"
}
```

This is not silent dropping of accepted structured fields: those fields are
not supported at all. Describing them in text does not configure execution.

`previewMissionTask` in `src/mission-policy.ts` reads recorded scores and
rejects conflicting spawn overrides. Supplying the missing PM scores only at
spawn is therefore not a general repair. Catalogue policies can operate
without scores, but that does not satisfy ARTIST's explicit scoring contract.

### 2. Auto-scale cannot request restrictive reporting or reader isolation

`pumpTeam` in `src/dispatch.ts` selects the task and calls `executeTeamSpawn`
with name, agent, prompt and claim_task. Task context is recovered by spawn,
but there is no corresponding task-level worktree/reporting contract.

`executeTeamSpawn` defaults to isolated worktrees for custom profiles. Only
the built-in `plan` and `explore` names receive the built-in read-only
worktree exception. A custom `qa-planner` name does not imply `worktree:false`.

`dispatchMessage` tells auto-scaled workers to complete the task and report
through team tools. A restrictive profile cannot be made compatible merely
by writing “final_response” in its task description.

### 3. Adding import fields alone would not fix restrictive QA

`executeTeamSpawn` explicitly rejects final-response reporting for catalogue
mission execution:

```text
Autonomous workers require claim_task and collaborative reporting
```

A second executable probe used the real mission preparation/configuration/
approval functions on an isolated fixture, then requested a fresh qa-planner
with `worktree:false`, a claimed task, and `report_mode:final_response`.
It received that rejection, with zero native sessions and zero worktrees
allocated. No live mission was approved by this probe.

This restriction is also documented at the end of
`docs/autonomous-execution.md`. It is an execution-mode incompatibility, not
a transient transport failure. Removing the guard without defining task
ownership, completion and lead-reviewed integration would be unsafe.

## Important non-findings

- Import is not admission: `writeImport` requires an unapproved mission draft;
  `pumpTeam` checks `assertMissionAdmission` before dispatch. The import probe
  created zero members. There is no demonstrated pre-start worker-launch bug.
- Explicit fresh context already has native task semantics. A differently named
  `require_context` field is not needed to establish this contract.
- Session permission overrides alone do not prove the complete effective native
  profile permission composition. No QA privilege escalation was demonstrated.
- No new GPU, C++ correctness or engine performance finding was established.
- The scope was the preparation-to-dispatch path. This is not an audit of every
  historical team or all plugin safety invariants.

## Required correction, before claiming an unblock

1. Define one typed task admission contract shared by preparation, board,
   explicit spawn and auto-scale. Preserve validated scores, profile/context,
   isolation and reporting atomically; reject incompatible overrides before
   allocating resources. Preserve legacy defaults and canonical replay.
2. Define a native restrictive-review path for governed missions that retains
   native permissions, uses fresh context, returns a retained final candidate,
   and leaves acceptance/integration to the lead. Do not grant team tools to
   solve a reporting-mode incompatibility.
3. Preserve the existing PM candidate/dossier and approval gates. A repaired
   plugin must not mark the candidate ready or approve the mission by itself.
   Resume preparation with the verified new capability; user `start` remains
   necessary. Review dependent-task integration barriers explicitly.
4. Test the complete path: PM JSON → persisted task → policy routing →
   auto-scale → restrictive native result → lead review, including negative
   cases, replay, pre-start refusal and conflicting spawn overrides. Run a
   native ARTIST QA qualification before admitting authors.

This changes the plugin's execution contract, not just a prompt or a local
configuration value. It needs an explicit implementation/deployment scope;
changing ARTIST requirements, disabling auto-dispatch, editing live database
rows, fabricating completion or repeatedly resuming the PM are not fixes.

## Verification

Baseline on the examined commit:

- `bun run typecheck`: passed.
- `bun test`: 1788 passed, 0 failed, 103 files.
- `bun run build`: passed.
- Parser/import and governed final-response probes: reproduced the limits above.
  SQLite fixtures were in-memory; the second probe's owned temporary policy
  directory was removed afterwards.

The green suite does not establish support for the missing combined workflow.
No production fix or deployment had been made at that initial investigation
stage. The authorized repair and its later verification are recorded above.
