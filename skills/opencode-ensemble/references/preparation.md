# Optional PM preparation

Use this when a mission should be split before `start`. Simple preparation
still works without it:

```text
/ensemble-mission <objective>
/ensemble-mission config
/ensemble-mission start
```

Do not invoke `start` for the user. `start` remains the execution gate.

## Command and intervention contract

The integrated plugin code imports an explicitly ready version 2 discovery document
once, before start, through `importPreparationDocument`. Legacy v1 parsing/replay
does not make a new v1 result ready. That path is
generic at the intervention-contract layer. PM discovery is the first concrete
case: category `pm`, contract id `pm-discovery`, native permissions copied, no
model and no extra tool.

The validated user command is:

```text
/ensemble-mission prepare [--pm <agent>] [--preplan <file>] [--history none|fork|checkpoint] [--before <messageID>] <mandat>
```

`/ensemble-mission <objective>` stays the simple draft. On a new session the
mandate is required. On an existing draft it is optional, and the stored
objective is always transmitted; explicit instructions supplement it. Multiline
mandates are preserved. Options precede the mandate; quote paths with spaces.
`--preplan` freezes a project-local file (at most 40000 characters / 160000 bytes).
Explicit mandates, stored objectives and resume clarifications each allow 40000
characters (JavaScript string length). These are Ensemble input guards, not native
OpenCode context limits: fork/checkpoint history is not counted. Output-document
and intervention-contract limits are separate and unchanged.
History defaults to none. Fork/checkpoint opt in to the supervisor's projected
native context, without compaction or fresh fallback; checkpoint requires an
exclusive source message boundary via --before. The dossier, source and hash
are inspectable in supervisor context. An active dossier cannot be replaced.
`--pm <agent>` is the exact native agent declared `pm` and
natively available, not a homonym. Without `--pm`, the single admissible project
PM is selected. If none qualifies, configure an existing native agent's category;
if several qualify, the supervisor selects one explicitly. Ensemble adds its
discovery contract to that PM's system context and compaction. It does not
install a native agent or broaden the profile's permissions.

The PM runs as the supervisor's native child, titled **Ensemble preparation
PM**, not as an executing team member. V2 Desktop lists active children in its
running-work menu, and the terminal exposes them through its native subagent
view. Selecting the child opens its session; do not force a navigation or
invent a tool call. The command acknowledges the queued PM promptly, then
returns its result or error separately. An active repeated `prepare` keeps the
same session without a second PM prompt. Preserve the selected PM's own native
permissions rather than the supervisor's inherited rules.

The running-work menu need not retain an idle child after completion. Report
the final mapping/questions in the supervisor's conversation. Older independent
PM sessions are not silently reparented or restarted.

In your current assistant reply, also reproduce the PM's actual native session
ID as a standalone inline-code value. V2 Desktop renders a full `ses_` plus
26-alphanumeric ID in assistant Markdown as an open-session button, without
requiring a parent link or a running PM. The acknowledgement is a user message,
so its ID alone is not sufficient. Keep this reference on resume, result, error,
and after compaction. Never invent/shorten an ID, put it in a fenced block or
construct a URL. Do not trigger another PM or model turn just to display it.
The server provides these reply instructions, not an injected assistant message
or a mechanically guaranteed button. The native client refuses missing or
archived sessions when the user clicks.

Only after the initial JSON candidate and five PM corrections are exhausted,
the lead may submit one document:

```text
/ensemble-mission prepare --accept <json>
```

`--pm` and `--accept` are mutually exclusive. The same parser validates that
JSON. Nothing is repaired silently. The helper runs before `start` without
`team_spawn`, a team member, or a claim, and it admits no executing worker.
Code imports only a ready v2 document. Blocked/incomplete candidates persist
without tasks or schema retries; resolve their blockers and explicitly use
`prepare --resume <clarification>`. Clarifications persist, not replace the frozen
dossier. Start refuses unfinished PM preparation; the simple no-PM path remains.
Invalid supervisor JSON returns
its issues without consuming the accepted correction. In the plugin repository,
the parser-checked examples and the
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

Root keys are `version`, `readiness`, `tooling`, `context`, `openQuestions`, `tasks`,
and `parallelGroups`. `version` is the number `2`. Readiness is
`{status: "ready"|"blocked"|"incomplete", reasons: string[], missingInformation: string[]}`;
tooling is `{catalogue: "verified"|"unverified", unavailable: string[]}`. Non-ready
needs a reason and can return empty tasks/groups. Ready permits no blockers,
missing information, unverified catalogue or unavailable required tools. These
are reported evidence, not a guarantee of plan quality or execution approval.
Task keys are only `id`,
`title`, `type`, `goal`, `dependsOn`, `planning`, `acceptanceCriteria`,
`verification`, and `handoff`, plus optional `agent`, `context`, `complexity`,
`risk`, `worktree`, and `report_mode`. Scores are integers 0–100; isolation is
boolean; reporting is `team_message` or `final_response`. These fields survive
import atomically and apply equally to auto-scale and manual spawn; conflicting
spawn overrides are refused. Explicit isolation/reporting also requires a new
session. For restrictive readers use `worktree:false` and
`report_mode:"final_response"`: the approved model is pinned without adding
permissions, team tools or phase transitions; the lead reviews the retained
candidate before completing the task. A first-task runtime qualification gates
authors, not preparation of that task. Import does not launch a worker.
`agent` names a verified native profile. `context` accepts the same
`fresh`/`fork`/`checkpoint`/`compact_fork` contract as `team_spawn` and is
preserved on the imported board task. Explicit context requires a new session
of the requested profile; omit it only when existing-worker reuse is acceptable.
Independent review/QA should specify `{ "mode": "fresh" }`. Omitted
`from`/`current` in an imported task means the supervisor session, not the PM.
Use real team sources and exclusive native checkpoint message IDs, never
invent them. `planning` is `{ required: boolean, reason }`.
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

Questions require boolean `blocking` and use `audience: "supervisor"` only. A ready
document permits nonblocking questions only. They stay on the document and are
not delegated as worker notes. Ask only what the supervisor must decide.

Every task has a handoff. `document` is the finding. Each source has a `path`
and a `note` that says what the path contributes. The parser does not open the
path. At least one source is required. Acceptance criteria and verification
are non-empty lists.

`parallelGroups[].isolation` is exactly `separate-worktrees`; it cannot include a
`worktree:false` task. `integrationNotes`
tells the supervisor how to reconcile those branches. A direct or transitive
dependency inside the group is rejected. Do not schedule two writers in one
shared worktree and call it a parallel group.

## Discovery tools

The host preflight distinguishes registered tool IDs, declared permissions and
MCP connection state. It cannot prove the effective session-filtered catalogue;
check required tools inside the PM before business discovery and report absence,
refusal and disconnection separately. Execute permission alone is insufficient.
Do not broaden profile rules or bypass unavailable tools. Business associations
are read freshly at each new admission; existing runs/policy are not rewritten.

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
JSON silently. Migration 24 stores the import, and migration 25 tracks the run,
mandate, rejected candidate, and issues. Retry `prepare` to resume the same
session after an error or to return an already-persisted result, even after
approval, without a new PM/model call. A first import still requires a draft.
Do not count missing, failed, interrupted, or unchanged responses as invalid
JSON. The host must expose wait/context/get/interrupt; the wait is bounded.
Report the returned dispositions, hold reasons, mapping, and full parallel
groups, not just task ids. Runtime regression tests use mocked hosts; they do
not certify a live PM smoke or deployment.

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
