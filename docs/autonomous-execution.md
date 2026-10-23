# Autonomous task execution (V2)

The default is one session and one model per task, with worker-controlled reasoning.
There is no automatic difficulty assessment and no separate planning/implementation
model grid.

## Configuration

Keep the model/effort catalogue in `~/.config/opencode/ensemble.json`:

```json
{
  "startingIntelligence": 50,
  "modelRouting": {
    "beta": 0.35,
    "models": [
      { "id": "provider/model", "reasoningEffort": "low", "intelligenceScore": 40, "averageCostPerTask": 1, "available": true },
      { "id": "provider/model", "reasoningEffort": "high", "intelligenceScore": 55, "averageCostPerTask": 2, "available": true }
    ]
  }
}
```

The IDs above are placeholders, not recommended native identities. Use the exact
provider, model and variant IDs advertised by your OpenCode host. Only enabled
catalogue pairs also supported by the host enter a new policy. The existing
project override remains supported; this feature does not rewrite global config.

`startingIntelligence` defaults to 50. Default planning candidates meet that
threshold; no qualifying pair is an explicit error, not a silent downgrade.
Selection is uniform over qualifying pairs using a task/revision-bound hash,
so it is reproducible after restart rather than redrawn every turn. It does not
optimize cost or promise balanced provider quotas. Lower enabled reasoning
variants of the selected model remain available for implementation.

## Opt-in supervisor selection (policy version 3)

Keep a strong automatic default while permitting explicit choices for simpler
planning tasks by configuring:

```json
{
  "startingIntelligence": 50,
  "planningIntelligenceRange": { "min": 35 }
}
```

This seeds **new** missions/direct V2 teams with policy version 3. Existing
approved missions and assignments are not migrated. Set the range to `null` to
seed version 2 again. A project range replaces the global range as a whole.
For a mission-local opt-in, edit the draft to `version: 3` and add the range,
then present it with `config` and approve with `start`.

The inclusive range has a required `min` and optional `max`, both on the actual
catalogue intelligence scale, not necessarily 0–100. It must contain
`startingIntelligence`. Without `max`, there is no upper bound. Automatic starts
still meet `startingIntelligence` and the range. Classification, if explicitly
enabled, selects within the range. Its min/max normalization uses that subset.

Only the lead can authorize an explicit planned pair in that range:

```typescript
team_tasks_add({
  tasks: [],
  execution_decisions: [{
    task_id: taskID,
    mode: "planned",
    kind: "code",
    model: approvedNativeModelID,
    variant: approvedNativeVariantID,
    reason: "User requested this model for a trivial task",
  }],
})
```

The reason is required (1–2000 characters), persisted and shown with the task.
An explicit choice takes precedence over classified selection but does not
disable classification readiness, budgets, critical stops, QA or permissions.
Omitting a variant means the exact host-default pair, not any variant of that
model. A variant requires a model. Never guess native identities from display
names such as Luna.

In version 3 the supervisor may also authorize `direct` code or mixed work,
as well as documentation/research, using the full approved catalogue without a
planning intelligence bound. The kind must be qualified, not `unspecified`.
Planning stays the default; a worker proposal needs the lead's decision before
admission. This grants no new native permissions. Version 2 retains its original
direct documentation/research restriction and disallows explicit planned models.

The model remains fixed within each task; lower implementation variants of
that same model remain available even outside the **planning** range. Changing
the range requires another policy approval and affects new admissions only.
`team_spawn.model`, messages and handoff cannot override this decision.
Older plugin versions do not support version 3 policies: finish/abort active
missions before downgrading. Do not rewrite stored revisions to downgrade them.

## Task lifecycle

1. Spawn a collaborative worker with `claim_task` and the intended expertise
   profile (normally `build` or a project-specific writer). Its worktree is
   allocated normally; planning uses restrictive tool permissions in that same
   session. No additional planner agent is required.
2. The worker plans, then calls
   `team_handoff({ phase: "implementation", reasoning: "low" })`.
   Omit `reasoning` to keep the current variant.
3. Ensemble checks task ownership and catalogue/native availability, applies
   `session.switchModel`, and restores the profile's implementation permissions.
4. During implementation, `team_handoff({ reasoning: "high" })` or a lower
   admitted variant adjusts effort. It cannot substitute another model/profile.
5. Spawn, direct claim and auto-dispatch share this boundary. The next task starts
   in planning again; model/phase/effort survive delivery and context transforms.

Planning permits reading, messaging, GrepAI, Serena read operations and Context
Mode file analysis/index/search. It denies edit/shell and general-purpose command
execution tools. These are tool permissions, not an OS sandbox: flexible MCP
tools are trusted to respect their read-only purpose. Native profile and host
restrictions still apply during implementation.

If a native control fails, its requested state remains pending and is not
advertised as applied. Retry the same phase/reasoning or report the blocker;
completion and ordinary routed delivery reject pending state. No automatic
abort, provider fallback, supervisor, timer or diagnostic RPC is added.

## Explicit classification and compatibility

Classification defaults to `off`. Explicitly configure a supported classifier at
mission preparation/configuration or direct team creation to choose the initial
pair from recorded task scores. `modelRouting.beta` is frozen with the catalogue
for that explicit selection. Afterwards the same worker execution path applies.

Command-prepared missions retain `prepare/config/start` approval. Direct V2 teams
freeze the same catalogue policy at explicit creation. Existing v1 grid policies
and V1/no-catalogue workflows retain read/operation compatibility; they are not
silently migrated. Autonomous workers need V2 model/catalogue/permission APIs,
an owned board task and collaborative reporting (not `final_response`).
