# Command-prepared mission policy

On capable V2 hosts the user can run:

```text
/ensemble-mission <objective>
/ensemble-mission config
/ensemble-mission start
```

Preparation creates a draft and requests a plan using the project's instructions.
The plugin does not require a specific planner profile or sequence of agents.
Providers, exact native model/variant pairs, ordered alternatives and evaluation
criteria are configured together. The existing supervisor retains its native
OpenCode model; the mission policy controls calls orchestrated by Ensemble.

## Proposal, corrections and approval

1. Read the mission's `.opencode/missions/<team-id>/model-policy.json`.
2. Propose a complete complexity × risk grid and explain the selected models for
   known tasks. Both task scores are explicit integers 0–100. Criteria and scores
   are heuristics, not success probabilities.
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
scores never become zero, and explicit model/score overrides cannot evade the grid.

## Revisions and running work

Opening configuration pauses new admission. An edited file invalidates approval;
another preview and approval are required. Already-admitted tasks keep their
recorded policy revision. A reused worker is routed again for its next task.
Unassigned automatic scores are re-evaluated if the approved assessment rubric
changes; aggregate mission budgets are not reset. Native model alternatives are
recorded, not automatic provider retries.

Do not replace this policy using `team_message.model` or classification controls.
Keep project-specific scoring floors, TDD requirements and verification contracts
in project instructions. Direct `team_create` teams keep legacy operation.

## Trust boundary

The public SDK allows programmatic command invocation and does not authenticate
human origin. Command-only approval isolates the route from ordinary team tools,
but it is not proof of a human click or keystroke. A deployment requiring that
stronger guarantee needs a trusted host/transport policy. Do not invent metadata
flags and call them authentication.
