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

Each default task uses one session/model. The worker plans with read/search and
messaging permissions, then chooses its implementation reasoning with
`team_handoff({ phase: "implementation", reasoning: "<allowed native variant>" })`.
Omit reasoning to keep it. Afterwards `team_handoff({ reasoning: "<allowed variant>" })`
can raise or lower effort. Only admitted catalogue variants of that same model
are allowed. The worker decides when its plan is ready; no extra reviewer is
required by this feature. Keep project verification requirements bounded to the
actual deliverable. Report unsupported native controls instead of constructing
an unrelated proof platform.

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
