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
