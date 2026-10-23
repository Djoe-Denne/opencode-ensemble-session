# Optional PM preparation

Use this when a mission should be split before `start`. Simple preparation
still works without it:

```text
/ensemble-mission <objective>
/ensemble-mission config
/ensemble-mission start
```

Do not invoke `start` for the user. `start` remains the execution gate.

## What is already code, and what is not

The integrated plugin code parses a version 1 discovery document and imports
it once, before start, through `importPreparationDocument`. That path is
generic at the intervention-contract layer. PM discovery is the first concrete
case: category `pm`, contract id `pm-discovery`, native permissions copied, no
model and no extra tool.

The validated user command is:

```text
/ensemble-mission prepare [--pm <agent>] <mandat>
```

`/ensemble-mission <objective>` stays the simple draft. On a new session the
mandate is required. On an existing draft it is optional, and the stored
objective remains. `--pm <agent>` is the exact native agent declared `pm` and
natively available, not a homonym. If none qualifies, or several qualify and
none is the appropriate default, the supervisor arbitrates. The reference PM
is a native executable agent implemented by the runtime. Its admission is still
being designed. This skill does not register that agent, and these instructions
are not a substitute for it.

Only after the initial JSON candidate and five PM corrections are exhausted,
the lead may submit one document:

```text
/ensemble-mission prepare --accept <json>
```

`--pm` and `--accept` are mutually exclusive. The same parser validates that
JSON. Nothing is repaired silently. The helper runs before `start` without
`team_spawn`, a team member, or a claim, and it admits no executing worker.
Code imports the first document that parses. Neither command is a verified
runtime here. In the plugin repository, the parser-checked examples and the
field tables live in `docs/preparation.md`. This reference is enough to write
a conforming document without that page.

The discovery agent returns one JSON preparation document. It does not return
the intervention contract. Code composes the contract around the native agent.
A read-only PM stays read-only and returns the document for the plugin to
persist. It does not write the worktree and it does not launch workers.

## Who imports

Code calls the import. The supervisor does not create the initial rows. The
import maps each PM id to a real task id, rewrites dependencies, and returns
that mapping. Show those returned ids. Do not invent task ids.

The same canonical document replays the same ids. A different document is
refused. Replay does not reauthorize the policy. The first import must happen
before `start`. After start, later work is a normal board addition, not a
second import. Nothing in the import spawns or admits a worker.

`planning.required: true` becomes `planned`. `false` becomes `direct`. The
stored decision is only `{ mode, kind }`. Do not put `model`, `variant`, or a
routing reason in the JSON. Kind is derived from `type`:

| `type` | kind |
| --- | --- |
| `implementation` | `code` |
| `architecture` | `mixed` |
| `documentation` | `documentation` |
| `research` | `research` |
| `review` | `mixed` |
| `qa` | `mixed` |

A missing policy is held like version 2: direct documentation and research can
be authorized; direct code and mixed work are held. Held tasks stay on the
board until the lead records an execution decision. Version 3 may authorize
direct code and mixed work when that policy says so. Do not relabel code as
documentation to avoid a hold.

## How to split the work

Text fields are trimmed. One non-whitespace character is enough. Do not invent
a minimum of 20, 40, or 400 characters. Do stay inside the maxima in
`docs/preparation.md`: context and handoff document 20000, goal and integration
notes 4000, most other prose 2000, title 200, source path 500, ids 64.

Root keys are only `version`, `context`, `openQuestions`, `tasks`, and
`parallelGroups`. `version` is the number `1`. Task keys are only `id`,
`title`, `type`, `goal`, `dependsOn`, `planning`, `acceptanceCriteria`,
`verification`, and `handoff`. `planning` is `{ required: boolean, reason }`.
`kind`, `mode`, and `model` are rejected.

Ids start with a letter and then use letters, digits, `_`, or `-`.

### Architecture versus a local plan

- `architecture` means the deliverable is a boundary other tasks will
  implement. Put the decision and one rejected alternative in the handoff.
  Dependent implementation tasks use `dependsOn`. They are not in the same
  parallel group.
- A local plan is `planning.required: true` on the task that will do the work,
  usually `implementation`. There is no `planning` task type.
- `planning.required: false` means the approach is already fixed. On version 2
  that is appropriate for documentation and research, not for code.

### Research, review, and QA

Keep them as separate tasks when the proof differs.

- `research` produces a finding and owns no code change.
- `review` reads a deliverable for defects and scope drift. It does not claim
  the test command ran.
- `qa` runs the agreed command and reports the actual result. It is not a
  reread of the diff.
- `documentation` changes a document. It is not a subsystem design.

Review and QA may share a parallel group only when neither depends on the
other. Both may depend on the implementation task outside the group.

### Questions, handoffs, and branches

Questions use `audience: "supervisor"` only. They stay on the document and are
not delegated as worker notes. Ask only what the supervisor must decide.

Every task has a handoff. `document` is the finding. Each source has a `path`
and a `note` that says what the path contributes. The parser does not open the
path. At least one source is required. Acceptance criteria and verification
are non-empty lists.

`parallelGroups[].isolation` is exactly `separate-worktrees`. `integrationNotes`
tells the supervisor how to reconcile those branches. A direct or transitive
dependency inside the group is rejected. Do not schedule two writers in one
shared worktree and call it a parallel group.

## Discovery tools

GrepAI answers "where is this behavior?" when the file is unknown: a
descriptive English query, a few results, then open the file. Exact symbols,
error strings, and counts use exact search. If GrepAI is absent from the tool
catalog, say so. Do not treat a missing nested `.grepai/` directory as proof
that a parent source root has no index, and do not initialize an index unless
asked.

Serena answers a known symbol: overview, body, then references before changing
a shared contract. Check the active root against the expected source root.
Do not call `activate_project` on a shared connection. A canonical Serena root
does not show uncommitted worktree edits; read the worktree file and cite that
file.

A handoff that says "searched the repo" without a path and a specific note is
not evidence, even if the parser accepts a non-empty string.

Run worker commands with the worker worktree as the working directory. Do not
checkout or restore the user's main worktree.

## JSON, not a native schema

Public V2 `session.prompt` has no structured-output field. Native structured
output is not active. Ask for one JSON object and validate the text with the
same parser. Do not send `format` or `json_schema`.

Recovery: the initial candidate, then at most five PM corrections that each see
the candidate and the parser issues. Only after those are exhausted, the lead
runs `/ensemble-mission prepare --accept <json>`. That JSON uses the same
parser. `--pm` and `--accept` are mutually exclusive. Do not repair invalid
JSON silently. Resume follows the migration already applied (`user_version`,
preparation tables in migration 24). This reference does not verify that loop.

## Document to imitate

<!-- parse:ok -->
```json
{
  "version": 1,
  "context": "Duplicate Stripe events can create two orders. The webhook insert is the boundary.",
  "openQuestions": [
    {
      "id": "stripe-owner",
      "question": "Which service owns Stripe event deduplication?",
      "audience": "supervisor"
    }
  ],
  "tasks": [
    {
      "id": "map-webhook",
      "title": "Map the webhook path",
      "type": "research",
      "goal": "Name the function that inserts an order from a Stripe event.",
      "dependsOn": [],
      "planning": { "required": false, "reason": "The path is a bounded read." },
      "acceptanceCriteria": ["The handoff names the insert function and its file."],
      "verification": ["The cited path is present at the recorded revision."],
      "handoff": {
        "document": "Order creation is reached from the Stripe webhook handler.",
        "sources": [{ "path": "src/webhooks/stripe.ts", "note": "Handler that calls the order insert." }]
      }
    },
    {
      "id": "shape-guard",
      "title": "Decide the idempotency boundary",
      "type": "architecture",
      "goal": "Choose where a duplicate event id is rejected.",
      "dependsOn": ["map-webhook"],
      "planning": { "required": true, "reason": "The boundary is a contract other tasks will implement." },
      "acceptanceCriteria": ["The handoff states the accepted boundary and one rejected alternative."],
      "verification": ["The cited source supports the chosen boundary."],
      "handoff": {
        "document": "Reject the duplicate at the event-id insert. Do not dedupe later in the order reader.",
        "sources": [{ "path": "src/webhooks/stripe.ts", "note": "Insert is the first durable write." }]
      }
    },
    {
      "id": "guard-insert",
      "title": "Add the idempotency guard",
      "type": "implementation",
      "goal": "A repeated event id creates one order.",
      "dependsOn": ["shape-guard"],
      "planning": { "required": true, "reason": "The write changes persistence and needs a reviewed local plan." },
      "acceptanceCriteria": ["A second delivery of the same event id does not create a second order."],
      "verification": ["The focused webhook regression covers the duplicate event."],
      "handoff": {
        "document": "Implement the unique event-id insert decided by shape-guard.",
        "sources": [{ "path": "src/webhooks/stripe.ts", "note": "Site of the event insert." }]
      }
    },
    {
      "id": "check-webhook",
      "title": "Run the webhook regression",
      "type": "qa",
      "goal": "Execute the agreed webhook checks and report the actual result.",
      "dependsOn": ["guard-insert"],
      "planning": { "required": true, "reason": "The check follows the implementation and reports a command result." },
      "acceptanceCriteria": ["The report quotes the command and its pass or fail result."],
      "verification": ["The command is the repository webhook test, not a reread of the diff."],
      "handoff": {
        "document": "Run the webhook regression after guard-insert is integrated.",
        "sources": [{ "path": "test/checkout-webhook.test.ts", "note": "Existing duplicate-delivery coverage to run." }]
      }
    },
    {
      "id": "read-diff",
      "title": "Review the idempotency diff",
      "type": "review",
      "goal": "Inspect the merged guard for missed retries and scope drift.",
      "dependsOn": ["guard-insert"],
      "planning": { "required": true, "reason": "Review inspects the diff after the implementation exists." },
      "acceptanceCriteria": ["Findings are ordered by severity, or the review says there are none."],
      "verification": ["The review cites the diff and does not claim the test command was run."],
      "handoff": {
        "document": "Read the guard diff. A passing test is not a substitute for this review.",
        "sources": [{ "path": "src/webhooks/stripe.ts", "note": "Implementation under review." }]
      }
    },
    {
      "id": "note-contract",
      "title": "Document the idempotency rule",
      "type": "documentation",
      "goal": "Record that a duplicate event id creates one order.",
      "dependsOn": [],
      "planning": { "required": false, "reason": "The page change is local." },
      "acceptanceCriteria": ["The page states that a duplicate event id creates one order."],
      "verification": ["The linked contract page contains that statement."],
      "handoff": {
        "document": "Document the rule without changing the insert.",
        "sources": [{ "path": "docs/webhooks.md", "note": "Contract page that should state the rule." }]
      }
    }
  ],
  "parallelGroups": [
    {
      "taskIds": ["check-webhook", "read-diff"],
      "reason": "QA runs the checks and review reads the diff. Neither task depends on the other.",
      "integrationNotes": "Keep the branches separate. If both touch the test file, the supervisor keeps the QA assertion and records review comments in the report.",
      "isolation": "separate-worktrees"
    }
  ]
}
```

## Counterexamples

These are rejected by the parser. The quoted issue is the one to recognize.

<!-- parse:fail context must be a string of 1 to 20000 characters -->
```json
{ "version": 1, "context": "   ", "openQuestions": [], "tasks": [], "parallelGroups": [] }
```

Expected issue: `context must be a string of 1 to 20000 characters`

<!-- parse:fail tasks[0].type must be one of implementation, architecture, documentation, research, review, qa -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [{
    "id": "local-plan",
    "title": "Plan the edit",
    "type": "planning",
    "goal": "Write the local plan.",
    "dependsOn": [],
    "planning": { "required": true, "reason": "The approach is not settled." },
    "acceptanceCriteria": ["The plan names the file."],
    "verification": ["The cited file exists."],
    "handoff": {
      "document": "Edit one guard.",
      "sources": [{ "path": "src/webhooks/stripe.ts", "note": "File the plan would name." }]
    }
  }],
  "parallelGroups": []
}
```

Expected issue: `tasks[0].type must be one of implementation, architecture, documentation, research, review, qa`

<!-- parse:fail tasks[0].kind is not supported -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [{
    "id": "note-rule",
    "title": "Note the rule",
    "type": "documentation",
    "kind": "documentation",
    "goal": "Record the rule.",
    "dependsOn": [],
    "planning": { "required": false, "reason": "The page change is local." },
    "acceptanceCriteria": ["The page states the rule."],
    "verification": ["The page contains the sentence."],
    "handoff": {
      "document": "State the rule.",
      "sources": [{ "path": "docs/webhooks.md", "note": "Page that should state the rule." }]
    }
  }],
  "parallelGroups": []
}
```

Expected issue: `tasks[0].kind is not supported`

<!-- parse:fail parallelGroups[0].taskIds couples dependent tasks shape-guard and map-webhook -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [
    {
      "id": "map-webhook",
      "title": "Map the webhook",
      "type": "research",
      "goal": "Name the insert.",
      "dependsOn": [],
      "planning": { "required": false, "reason": "Bounded read." },
      "acceptanceCriteria": ["The handoff names the function."],
      "verification": ["The path exists."],
      "handoff": {
        "document": "The handler inserts the order.",
        "sources": [{ "path": "src/webhooks/stripe.ts", "note": "Handler." }]
      }
    },
    {
      "id": "shape-guard",
      "title": "Shape the guard",
      "type": "architecture",
      "goal": "Choose the boundary.",
      "dependsOn": ["map-webhook"],
      "planning": { "required": true, "reason": "The boundary is shared." },
      "acceptanceCriteria": ["The handoff names the boundary."],
      "verification": ["The source supports it."],
      "handoff": {
        "document": "Reject at the insert.",
        "sources": [{ "path": "src/webhooks/stripe.ts", "note": "Insert site." }]
      }
    }
  ],
  "parallelGroups": [{
    "taskIds": ["map-webhook", "shape-guard"],
    "reason": "These look independent.",
    "integrationNotes": "They are not independent: shape-guard depends on map-webhook.",
    "isolation": "separate-worktrees"
  }]
}
```

Expected issue: `parallelGroups[0].taskIds couples dependent tasks shape-guard and map-webhook`

Also rejected, with the same parser: `version` as a string, `audience` other
than `supervisor`, `planning.required` as a string, an id that starts with a
digit, empty acceptance criteria, empty sources, an unknown dependency, a
dependency cycle, and `isolation` other than `separate-worktrees`.

## Unchanged limits

This flow adds no team tool. Keep the public SDK, `._client`, fire-and-forget
`promptAsync`, and branch preservation before `session.abort()`. Worker
commands use the worker worktree as cwd and never restore `main`.
