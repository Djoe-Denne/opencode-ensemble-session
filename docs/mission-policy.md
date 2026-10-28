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
exclusive. The runtime reuses an existing native PM and injects the Ensemble
discovery contract without adding permissions or registering an agent. Command
and adapter regression tests do not imply a live PM smoke or deployment.
`start` remains the user's execution gate.

## Supervisor reports

The lead receives a checkpoint/decision reporting instruction during preparation,
both configuration flows, start, normal team turns and lead compaction. It writes
concise Markdown reports in `.opencode/missions/<team-id>/reports/` between
meaningful stages and presents a current report before every question to the user.
Reports include context, observed evidence, limitations and, when a decision is
needed, options/tradeoffs/recommendation. Link the artifact and summarize it before
asking. Reuse valid evidence; reporting adds neither approval gates nor test runs.

Reports and questions use plain, natural language for a user who has not read
previous reports or seen internal reasoning. Lead with the goal, concrete
problem, practical consequences, why a decision is needed and a recommendation.
Use descriptive work/feature names before optional internal task IDs. Explain
unavoidable terms at first use; add a short glossary only when useful. Keep
hashes, commits, raw paths and dense proof details in a later evidence section.
The chat summary and the question-tool payload must each be self-contained:
links are supplementary, not required reading. Option labels describe real
actions, with their effects, tradeoffs and limits in the descriptions. Preserve
facts versus hypotheses, meaningful scope/permission limits and unexecuted checks;
do not simplify by inventing results, timings or costs. Mandatory exact tool
approval labels remain unchanged and are explained in the question's context.

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

### Decisions and milestone continuation in both modes

`supervised` does **not** mean requiring user approval at every milestone.
Supervisors and workers decide routine technical/organizational details within
the current authorized phase, scope and plan. Ordinary worker disagreements are
resolved by the lead using evidence. After a checkpoint, review, QA result or
worker completion, report progress and continue the next authorized step after
integration and required checks; do not invent a new user go. Waiting for a
necessary worker result remains legitimate. Workers still stop and report after
their own assignment; continued mission coordination belongs to the lead.

Ask before changing the mission objective or making an architectural change not
already authorized in the mandate/plan. Architectural changes materially affect
system boundaries, component responsibilities, public or persisted contracts,
storage design or trust/security boundaries. Private helper refactors, local
implementation choices and compatible fixes are not architectural by themselves.
An already-approved architectural step does not require duplicate permission.

Explicit user holds, initial or revised policy approval (`config` then `start`),
mandatory lead plan review, native permissions, budget and safety/QA gates remain
binding. Explain the exact boundary for a real blocker; continue independent
authorized work where safe. A stable shared decision-boundary suffix is appended
to system instructions for both modes and compaction, before any optional
approved long-run priorities. It does not activate a draft or grant permissions.

### Long-run decision delegation

Long run is an approved delegation of decisions, not just resilience to a failed
classifier. In the mission draft (policy versions 1, 2 and 3), persist the user's
general decision priorities independently of classification:

```json
{
  "autonomy": {
    "mode": "long_run",
    "instructions": [
      "Preserve the original plan and prioritize quality over speed.",
      "Choose implementation details without asking me; prefer reversible decisions."
    ]
  }
}
```

This is a fragment of `model-policy.json`, not global configuration. For a
speed-oriented mission the user could instead request the fastest correct
implementation and defer nonessential improvements. Capture the user's actual
priorities; do not invent them or turn routine choices into a questionnaire.
Long run requires at least one nonempty instruction (at most 50, 2000 characters
each). Present the edited policy with `config`; only the user's `start` approves
and activates that exact revision. A draft, ordinary chat or classifier setting
cannot activate the delegation.

After approval the plugin appends a separate stable system block **after** the
existing host/team instructions, for the lead and all workers, including
compaction. It reads the last approved database revision, never the draft. No
task state, timestamp or revision counter enters this block. Reconfiguration
pauses new admission but leaves the existing approved delegation in force until
another contract is approved. The block changes only when approved autonomy
changes; appending it preserves the earlier system prefix but does not guarantee
provider cache hits. Worker model/QA admissions retain their existing revisions.

Necessary technical decisions and operational validations within the approved
mandate are delegated by default, not just implementation details. This includes
contract ratification, SDK publication, Kind operations and comparable steps:
these are not categorical exceptions or automatic user-approval gates. The model
checks prerequisites and existing authority, performs authorized steps, records
consequential decisions briefly and continues without confirmation. Progress
reports are informational, not permission requests. These defaults accompany any
approved long-run priorities; users need not repeat them in `instructions`.

Authorization comes from the approved objective, mandate and decision delegation,
not from enumerating every necessary architectural or contract decision in the
plan. This does not change the objective or expand scope. Initial `config`/`start`
and required model/QA policy revisions remain binding; domain contract ratification
is not itself such a revision. An explicitly reserved user decision stays reserved,
but an operation category alone is not evidence of a reservation.

Uncertainty, multiple valid options or technical difficulty alone are not hard
blockers. Research, tests, existing instructions and reasonable assumptions must
be considered before escalating a consequential unresolved dilemma. Before
escalation the model checks existing authorization, delivery to workers and safe
alternatives. Workers escalate unresolved boundaries to the lead through their
permitted reporting channel; the lead decides within the delegation first. Only
a genuine inability to choose compliantly warrants a user question: that unresolved
dilemma, conflicting requirements, indispensable missing authority/access, an
irreversible action outside the mandate, or an impossible objective. Explain the
specific unresolved decision or missing authority, not just an operation category.
Independent work continues where safe. Permissions, explicit prohibitions, approved
budgets, QA and critical safety/admission stops remain mandatory.

Approve `autonomy: { "mode": "supervised" }` to revoke the delegation. Approved
autonomy also determines classifier resilience; changing classifier settings
cannot downgrade it. Existing `classification.missionMode` remains compatible
for historical resilience-only policies, but does not inject a decision contract
or silently migrate an existing mission.

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
