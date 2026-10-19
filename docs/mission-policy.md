# Command-prepared missions

Ensemble separates a mission's proposal from permission to execute it. Project
instructions still choose the workflow, agent profiles, verification requirements
and scoring conventions. No `orchestrator` or `project-manager` profile is required.

On V2 hosts exposing the public command API:

```text
/ensemble-mission Implement an isolated cache with compatibility tests
/ensemble-mission config
/ensemble-mission start
```

The first command prepares a team and a draft, without starting workers. `config`
opens a single discussion for provider restrictions, model choices, ordered
alternatives and evaluation criteria. The supervisor edits the draft in response
to the user's chat corrections. Run `config` again to present the resulting
policy, then `start` to approve that exact version and enable execution.

This is not a global provider reconfiguration. It controls calls orchestrated by
Ensemble for this mission; the existing supervisor conversation keeps its native
OpenCode model.

## Durable policy

Each command-prepared mission gets:

```text
.opencode/missions/<team-id>/model-policy.json
```

An explicit `missionPolicy` in the effective global/project `ensemble.json` is
copied into that file. Otherwise, the existing available model catalogue seeds a
visible proposal: its low, middle and high capability entries initialize three
groups. Catalogue scores and costs are **proposal inputs only**, never runtime
routing inputs. This draft is not an assertion that its models are adequate;
review it before approval. A configured catalogue or explicit default policy is
required to prepare a mission.

Example of the policy shape (replace illustrative native IDs with available ones):

```json
{
  "version": 1,
  "providers": ["provider-a", "provider-b"],
  "assessment": {
    "complexity": ["Low: local and well understood.", "High: interacting, ambiguous contracts."],
    "risk": ["Low: reversible and isolated.", "High: security or persisted data at stake."]
  },
  "complexityBands": [0, 34, 67, 101],
  "riskBands": [0, 34, 67, 101],
  "groups": {
    "light": [{ "id": "provider-a/light" }],
    "standard": [{ "id": "provider-a/standard", "variant": "medium" }],
    "strong": [{ "id": "provider-b/strong", "variant": "high" }]
  },
  "matrix": [
    ["light", "standard", "strong"],
    ["standard", "standard", "strong"],
    ["strong", "strong", "strong"]
  ]
}
```

Bands are integer boundaries: left-inclusive, right-exclusive. `[0,34,67,101]`
means 0–33, 34–66 and 67–100. Matrix rows are risk bands; columns are complexity
bands. Every score pair has exactly one cell, with no rule priority or overlapping
regions. The matrix and band counts must agree.

Group names are mission-local aliases, not universal model performance classes.
The first candidate is the principal model. Further candidates express approved,
ordered alternatives; they are recorded in the routing result, not automatic
provider retries. An equivalence means “acceptable in this mission and group,”
not a transitive or global model equivalence.

## Approval and enforcement

The plugin stores the presented policy hash in SQLite. `start` rejects unseen
file changes, validates native model/variant availability, and records an approved
revision. Merely writing an `approved` property into JSON grants nothing.
Pending or failed preview delivery leaves no approvable presentation. A start
waiting for model discovery cannot approve a later configuration, and repeated
start on the same approved presentation does not launch the supervisor twice.
If the start confirmation/continuation delivery fails after approval commits, the
policy remains approved and workers may already be running. Inspect session/status
before explicitly resuming the supervisor in chat; a transport error is not proof
that the native inbox rejected the message.

Approval is restricted to the native command route, not to ordinary chat,
synthetic messages, teammate plan approvals or tool fields. The public V2 SDK
does **not** authenticate human command origin: its public API can invoke a
command programmatically. Authenticated-human-only approval therefore requires
an additional trusted host/transport contract; this plugin does not claim it.

Opening configuration pauses new admission. Running workers retain their original
revision; subsequent tasks use the newly approved policy. Task and member routing
records retain scores, selected cell/group, exact model/variant and policy hash.
If assessment criteria change, unassigned automatically evaluated tasks are
re-evaluated; aggregate classification budgets and already-running tasks remain
unchanged. Preview-only `config` does not wake the supervisor; an explicit chat
correction can resume it to edit the draft.

For these missions:

- Spawn, direct claims, auto-dispatch, auto-scale and classifier admission respect
  the same approval gate. Publishing tasks before `start` does not execute them.
- Both complexity and risk are required; missing dimensions do not become zero.
- A spawn cannot replace the recorded task scores or select an unrelated model.
- A reused worker is routed again when it claims its next task.
- A direct worker claim awaits the public native model switch before returning
  the task. If pinning fails, the claim is released and the worker is quarantined;
  a database model update is not treated as proof of native selection.
- `team_message` cannot replace policy-controlled models or classifier settings.
- Legacy assignment, model pools, random choice and per-agent defaults cannot
  override the grid. Editing defaults does not rewrite an approved mission.
- Model alternatives and any configured LLM classifier must respect the approved
  providers. Unsupported or unavailable candidates fail explicitly.

Assessment remains heuristic. Manual scores use integers 0–100; native classifier
scores remain 0–1 and are converted once at the mission-routing boundary. The
conversion uses conservative ceiling after snapping integer multiplication noise
within a few ULPs: normalized 0.28 and manual 28 select the same cell. The raw
classifier result is not rounded or rewritten. The
mission's frozen assessment criteria are supplied to supported LLM classifiers.
They do not turn task scores into calibrated success probabilities.

Legacy teams created directly with `team_create` keep their existing behavior.
The command is capability-gated on V2; no V1 command emulation or private OpenCode
APIs are used. ARTIST's development floor, GPU checks and specialist profiles stay
in ARTIST rather than becoming plugin defaults.
