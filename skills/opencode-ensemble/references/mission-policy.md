# Command-prepared mission policy

On capable V2 hosts the user can run:

```text
/ensemble-mission <objective>
/ensemble-mission config
/ensemble-mission start
```

Preparation creates a draft and requests a plan using the project's instructions.
The plugin does not require a specific planner profile or sequence of agents.
The default freezes enabled, natively supported model/variant pairs from
`ensemble.json` and a planning intelligence threshold (`startingIntelligence`,
default 50). Classification is explicitly opt-in, not a prerequisite.
The existing supervisor retains its native
OpenCode model; the mission policy controls calls orchestrated by Ensemble.

## Optional preparation

`/ensemble-mission <objective>` remains the simple draft. Optional discovery
before `start` is specified in [preparation](preparation.md):
`/ensemble-mission prepare [--pm <agent>] <mandat>`. A new session requires the
mandate. An existing draft may omit it and keep the stored objective. `--pm`
names the exact native `pm` agent that is available, not a homonym; otherwise
the supervisor arbitrates. Ensemble reuses that existing PM and injects its
discovery contract without installing an agent or adding permissions. After the initial
candidate and five PM corrections are exhausted, only the lead may run
`/ensemble-mission prepare --accept <json>`, with the same parser and without
`--pm`. The command runtime and import have regression tests; this does not
imply a live PM/model smoke or deployment. Only the user's `start` releases
execution.

## Proposal, corrections and approval

1. Read the mission's `.opencode/missions/<team-id>/model-policy.json`.
2. Present the catalogue pairs, metrics and planning threshold. Do not invent
   complexity/risk scores for default execution. Explicit historical v1 policies
   retain their configured grid; their scores are heuristics, not probabilities.
3. Apply the user's chat corrections to that draft, not global configuration or
   remembered context. A model equivalence is local to an ordered mission group,
   not a global or transitive claim about capabilities.
4. Ask the user to run `config` to display the exact edited policy. A `config`
   request with natural-language corrections is not itself a reviewed preview of
   the resulting edits.
5. Only the user's `start` command should approve and release execution. Do not
   invoke it for them or infer approval from ordinary chat, synthetic prompts,
   teammate plan approvals, or file fields.

The plugin checks the displayed hash, native model/variant availability and
configuration generation. Pending or failed preview delivery cannot authorize
execution. Publishing tasks early does not start workers or classifiers. Missing
scores never become zero, and explicit model/score overrides cannot evade policy.

## Decision boundaries in both modes

Supervised mode does not mean seeking a user go at every step. Decide routine
technical and organizational details within the authorized phase, scope and
approved plan. Resolve ordinary worker disagreements yourself from evidence.
After a milestone, checkpoint, review or QA result, report progress, integrate
results as needed, and continue the next authorized step. Wait for necessary
prerequisite results, not an invented user approval. Check remaining tasks and
reports when no worker is active rather than entering standby automatically.

Ask the user before changing the mission objective or making an architectural
change not already authorized. Architecture means material changes to system
boundaries, component responsibilities, public/persisted contracts, storage or
trust/security boundaries; local implementation details, private helper refactors
and compatible fixes are not automatically architectural. An architectural step
already explicitly approved in the plan does not require duplicate approval.

Explicit user holds, initial/revised `config`/`start`, mandatory plan review,
native permissions, budgets and safety/QA gates still apply. Worker plan review
normally needs the lead's approval, not a new user go. Explain the exact missing
authority or unresolved conflict for a genuine blocker, and continue independent
authorized work where safe. Workers stop after their own deliverable under their
reporting mode; the lead continues coordination and closes the mission.

A stable shared system suffix carries these boundaries for leads, workers and
compaction in both modes. It does not approve draft execution or change a model,
QA contract or permission. The optional approved long-run priorities below are
appended after it, preserving the earlier host-system prefix.

## Long-run autonomy

When the user requests long run, persist their general decision priorities in
the mission draft as `autonomy: { mode: "long_run", instructions: [...] }`.
This works with policy versions 1, 2 and 3, independently of classification.
Use the user's actual priorities (quality/fidelity to the plan, fastest correct
implementation, etc.). Do not invent preferences or ask a routine questionnaire
when the mandate already provides a reasonable basis. At least one nonempty
instruction is required; each is limited to 2000 characters, at most 50 total.
Present the exact contract with `config`; only the user's `start` activates it.
`classification.missionMode` alone is legacy resilience, not decision delegation.

After approval, a separate stable system block is appended after existing system
instructions for the lead and workers, including compaction and subsequent
resumption. It comes from the last approved revision, not mutable draft files or
task state. Pending configuration keeps the previous approved delegation for
existing work while new admission remains paused. To revoke it, present and
approve `autonomy: { mode: "supervised" }`. Model and QA admissions are unchanged.

Under this delegation, decide technical and organizational choices within scope
using those priorities. Record important decisions and continue without seeking
validation. Prefer reasonable reversible assumptions; uncertainty or several
valid options alone are not hard blockers. Before escalation, check agreements
already granted, delivery to workers and safe alternatives. A worker reports an
unresolved boundary to the lead through its permitted reporting channel; the
lead arbitrates within its mandate before asking the user. Escalate to the user
only if no compliant decision remains: conflicting requirements, indispensable
missing authority/access, an irreversible action outside the mandate, or an
impossible objective. Continue independent work where safe. Never bypass native
permissions, explicit prohibitions, QA, budget limits or critical safety stops.

## Mission verification

`config` proposes a QA level: `light`, `proportionate` (default), or `reinforced`.
Store the selection as `verification: { level, commands?, acceptance? }` in the
mission draft, present it again, and let the user approve with `start`. Do not
execute those strings automatically: report the checks actually performed.
Model/reasoning selection is independent of this choice. Existing project safety
and mandatory testing contracts remain applicable; ask about conflicts instead
of silently overriding them. No fixed QA agent pipeline is prescribed.
Running tasks retain their admitted QA revision; changed QA applies to new tasks.

## Worker execution

### Opt-in version 3 model choices

A configured `planningIntelligenceRange: { min, max? }` seeds new catalogue
missions/direct V2 teams with version 3; null/absent keeps version 2. The range
contains `startingIntelligence`, has inclusive bounds on the catalogue scale,
and no maximum by default. `config` must present any edited draft before `start`.
Never migrate an approved revision or change the lead's native model.

Version 3 keeps the strong automatic threshold. The supervisor can authorize an
explicit planned `model`/`variant` within the range on an unadmitted task using
`execution_decisions` (or `execution` on its own new task), with a non-empty
`reason` of at most 2000 characters. Follow an applicable user model directive
through this contract; outside-range/unapproved choices need policy correction,
not a spawn override. A member's proposal is not authorization. A variant needs
its model; omitted variant means the exact native-default pair.

An explicit choice wins over automatic classified selection, but does not clear
classification readiness or safety stops. Without that choice, classification
in version 3 considers only the planning range. An unclassified automatic start
also meets startingIntelligence. Implementation may use other approved variants
of the same fixed model, even below the planning range.

The supervisor may qualify documentation, research, code or mixed tasks for
direct execution in version 3, selecting from the full approved catalogue
without the planning threshold. `unspecified` cannot be direct; planning remains
the default. Native profile permissions, isolation, dependencies and QA remain
mandatory. Version 2 retains its documentation/research-only direct contract
and forbids explicit planned models. The version 2 restrictions in the section
below must not be applied to opt-in version 3 choices.

Already-admitted decisions are immutable, including after release. Pending
native application is not success. Do not use message/handoff/spawn overrides
to change the initial task model. Abort/finish missions before downgrading to a
plugin that cannot read version 3; do not edit stored revisions as a workaround.

Each default task uses one session/model. The worker plans with read/search and
messaging permissions, then chooses its implementation reasoning with
`team_handoff({ phase: "implementation", reasoning: "<allowed native variant>" })`.
Omit reasoning to keep it. Afterwards `team_handoff({ reasoning: "<allowed variant>" })`
can raise or lower effort. Only admitted catalogue variants of that same model
are allowed. The worker decides when its plan is ready; no extra reviewer is
required by this feature. Keep project verification requirements bounded to the
actual deliverable. Report unsupported native controls instead of constructing
an unrelated proof platform.

### Direct documentation and research

Planning remains the default for code, mixed work, and unclear scope. A member
can propose an explicit task boundary through `team_tasks_add`:
`execution: { mode: "direct", kind: "documentation" }` (or `"research"`).
The board marks it proposed and holds admission until the supervisor decides.
`task_type`, classification scores, affinity, and a worker's handoff do not
authorize direct execution. The supervisor qualifies the actual scope; labels
are not an automatic content classifier or permission grant.

Only the lead can record `execution_decisions` for existing unassigned tasks:

```ts
team_tasks_add({
  tasks: [],
  execution_decisions: [{ task_id: taskID, mode: "direct", kind: "research",
    model: approvedModelID, variant: approvedNativeVariant }],
})
```

Use the actual task ID returned by `team_tasks_add`. Omit model/variant for
deterministic selection within the approved catalogue; when providing a variant,
provide its model too. The lead can instead require planning with
`{ task_id: taskID, mode: "planned", kind: "mixed" }`, without model overrides.
A lead's `execution` on a newly added task is already its decision. The same
contract works for initial tasks and proposals added during execution, without
adding a tool or changing the mission's approved model policy.

Direct tasks start in implementation, without applying the planning intelligence
threshold or inventing scores. Models and exact native variants must still be
approved and available. Authorized direct tasks do not require classification,
even when the mission opts into a classifier. Authorization retires any pending
classification lease; late results cannot overwrite the decision. Classification
budgets and mission-wide critical safety stops are not reset or bypassed.
Spawn, claim, and dispatch apply the same decision and
restore the native profile, not blanket edit/shell permissions. User instructions,
read-only profiles, write isolation, QA, dependencies, and admission checks remain
in force. Use an appropriate task-owning profile; the existing restriction on
standalone built-in `plan`/`explore` workers is unchanged.

Decisions cannot rewrite an admitted assignment, even if its task was later
released. Running work retains its admitted policy revision and direct decision.
New admissions still require the current mission approval; model availability or
native application failures fail closed using the existing recovery paths.

## Revisions and running work

Opening configuration pauses new admission. An edited file invalidates approval;
another preview and approval are required. Already-admitted tasks keep their
recorded policy revision. A reused worker is routed again for its next task.
Unassigned automatic scores are re-evaluated if the approved assessment rubric
changes; aggregate mission budgets are not reset. Native model alternatives are
recorded, not automatic provider retries.

Do not replace this policy using `team_message.model` or classification controls.
The admitted model stays fixed; its current reasoning is recorded separately.
Canonical effort is an annotation, never a replacement for native variant IDs.
Keep project-specific scoring floors, TDD requirements and verification contracts
in project instructions. Direct V2 teams with a configured catalogue use the same
execution path; V1/no-catalogue teams and historical grid policies remain compatible.

## Trust boundary

The public SDK allows programmatic command invocation and does not authenticate
human origin. Command-only approval isolates the route from ordinary team tools,
but it is not proof of a human click or keystroke. A deployment requiring that
stronger guarantee needs a trusted host/transport policy. Do not invent metadata
flags and call them authentication.
