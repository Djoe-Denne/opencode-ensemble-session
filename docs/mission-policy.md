# Command-prepared missions

For the current catalogue policies (versions 2 and opt-in 3), see
[autonomous execution](autonomous-execution.md). Version 3 adds an approved
planning range and lead-authorized per-task model choices, without changing the
automatic starting threshold. The grid/cell and mandatory-score rules below
describe historical version 1, not unclassified catalogue tasks. Direct V2 teams
also freeze catalogue policies at creation when the native capabilities exist.

New V2 missions default to [autonomous task execution](autonomous-execution.md):
a strong catalogue start, one session/model per task, and worker-controlled
reasoning. Classification is opt-in. The grid sections below describe explicitly
configured or historical version-1 policies, not the new default.

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

## Optional PM preparation

The simple draft above stays the default. Optional discovery before `start` is
specified in [preparation](preparation.md):
`/ensemble-mission prepare [--pm <agent>] <mandat>`. A new session requires the
mandate. An existing draft may omit it and keep the stored objective. After the
initial candidate and five PM corrections are exhausted, only the lead may run
`/ensemble-mission prepare --accept <json>`. `--pm` and `--accept` are mutually
exclusive. The parser and the import are integrated. The commands, the
executable reference PM, and its admission are not verified here. `start`
remains the user's execution gate.

## Supervisor reports

The lead receives a checkpoint/decision reporting instruction during preparation,
both configuration flows, start, normal team turns and lead compaction. It writes
concise Markdown reports in `.opencode/missions/<team-id>/reports/` between
meaningful stages and presents a current report before every question to the user.
Reports include context, observed evidence, limitations and, when a decision is
needed, options/tradeoffs/recommendation. Link the artifact and summarize it before
asking. Reuse valid evidence; reporting adds neither approval gates nor test runs.

Canvas is optional and requires a running owned loopback preview backend with
verified HTTP/content and a recorded handle/URL. Keep it accessible while the user
decides and stop only the owned preview when no longer needed. If serving is
unavailable, use Markdown; if persistence is unavailable, present Markdown inline
and declare the limitation. Never bypass native permissions to produce a report.

This is a prompt/skill contract, not a filesystem-writing engine or a question-tool
interceptor: the lead authors the reports. The plugin does not certify that a
report was written or that a preview backend is running. The mission schema and
approval hash are unchanged. See the operational skill's mission-reporting guide.

## Durable policy

QA is configured in the same mission discussion with
`verification: { "level": "light" | "proportionate" | "reinforced", "commands": [], "acceptance": [] }`.
The default is proportionate. The lead offers the level and only consequential
command/acceptance choices interactively; there is no new questionnaire per task.
The displayed contract is hashed and approved by `start`, then transmitted to
workers from their admitted revision. Commands are declarative, never executed
automatically by the plugin. No role pipeline or new QA gate is added. Project
safety and mandatory rules cannot be silently waived by a lighter level.

Each command-prepared mission gets:

```text
.opencode/missions/<team-id>/model-policy.json
```

An explicit historical `missionPolicy` in the effective global/project
`ensemble.json` is copied into that file. Otherwise, a version-2 proposal freezes
enabled, natively supported catalogue entries and `startingIntelligence` (50 by
default). There is no generated grid. Review the catalogue envelope before
approval; already-admitted tasks retain their revision.

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

## Reasoning effort precedence

An approved mission executes only the cell returned by `routeMissionModel`. The pair `(id, variant)` is the native identity passed to `switchModel`. Profile frontmatter `model:`, `modelsByAgent`, the pool and `defaultModel` are not read. `team_spawn.model` / `.variant` and `team_message.model` cannot replace that cell.

An omitted `variant` means the host default. The plugin does not invent a default variant id and does not copy a profile effort into the call. A canonical effort (`default`, `low`, `medium`, `high`, `xhigh`, `max`) is an annotation for display, calibration warnings and the teammate system prompt. Alias labels such as `extra high` or `Grok 4.7 Extra High` explain a refusal; they are sent to the host only when that exact string is a native `variant.id`.

A higher risk or complexity band that uses a lower canonical effort produces a calibration warning in the proposal. The warning does not block `start`. Historical approved policies without an `effort` field stay valid. The comparison in `assertMissionMemberModel` uses the native id only.

Legacy teams without `mission_policy` keep the catalogue order in `docs/model-routing.md`. That path also ignores profile frontmatter and does not translate efforts at delivery.

V1 shells export `ENSEMBLE_MODEL`, `ENSEMBLE_VARIANT` and `ENSEMBLE_EFFORT` from the persisted member row. The V2 shell hook has no session id, so the same identity travels in the system prompt instead.

## Approval identity and schema hold

`start` on a file whose hash already matches the latest `mission_policy_revision` row restores `approved_hash` and does not insert another revision. A different hash still creates the next revision. Tasks already admitted keep their stored route.

Writer spawn no longer continues in the shared directory when `worktree.create` or `workspace.create` fails. `plan`, `explore`, and `worktree: false` stay off and say why. New worktree names are `ensemble-<hash8 of project id>-<short team id>-<member>`.

Checkout migrations 17–20 are intentional no-ops (`SELECT 1`). The installed plugin already used `user_version` 15–20 for a different history, so those slots cannot be copied here. Migration 21 adds `worktree_state`, `checkout_branch`, `preserved_branch`, `short_path`, `toolchain_link`, `member_provider_attempt`, and `member_result.origin` / `superseded`. It is registered in `MIGRATIONS` and runs on a checkout database. Do not load this checkout against the live `~/.config/opencode/ensemble.db`: that database is already at `user_version` 20, and opening it would execute migration 21.
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
