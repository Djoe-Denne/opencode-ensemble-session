# Optional mission preparation

The plugin runs discovery with an existing native PM, validates its versioned
JSON document, and imports initial tasks before execution is approved. The
runtime and its regression tests are integrated; a live host/model smoke test
is a separate verification and is not claimed here.

| Piece | State |
| --- | --- |
| Intervention contract, document parser, deterministic import | Delivered in `src/intervention-contract.ts`, `src/preparation-document.ts`, and `src/preparation-import.ts` |
| `/ensemble-mission <objective>` | Unchanged simple draft |
| `/ensemble-mission prepare [--pm <agent>] <mandat>` | Implemented; regression-tested through the command and host adapters |
| `/ensemble-mission prepare --accept <json>` | Implemented; lead correction after the initial candidate and five PM corrections are exhausted |
| Native structured output on public `session.prompt` | Not available. The path is a JSON text fallback |
| PM selection and admission | Existing native agent only; declared category `pm` and native availability are checked mechanically |
| Live PM session or smoke of either command | Not claimed by this document |

Simple preparation stays valid. On a V2 host that exposes the command API:

```text
/ensemble-mission <objective>
/ensemble-mission config
/ensemble-mission start
```

`config` still presents the draft. Only the user's `start` approves that draft
and opens execution. Publishing tasks early does not start workers. See
[command-prepared missions](mission-policy.md) and
[autonomous execution](autonomous-execution.md).

To keep an audit or consumer unpublished until the supervisor is ready, use
`publication: "deferred"`. Use `completion_policy: "lead"` on producers whose
consumers require integrated results. The same fields are accepted by PM task
documents; see [deferred publication and supervisor acceptance](task-publication.md)
for native corrections, dependency semantics and confidentiality limitations.

## Command syntax

`/ensemble-mission <objective>` is unchanged. Optional discovery uses:

```text
/ensemble-mission prepare [--pm <agent>] [--preplan <file>] [--history none|fork|checkpoint] [--before <messageID>] <mandat>
```

- On a new session, `<mandat>` is required.
- On an existing draft, `<mandat>` supplements the stored objective. Both are
  transmitted even when the mandate is explicit. Multiline text is preserved.
- Explicit mandates, stored objectives and resume clarifications each allow
  40000 characters (JavaScript string length). This Ensemble guard prevents
  accidental oversized input; it is not a native OpenCode context limit and
  does not count fork/checkpoint history. Output-document and intervention
  limits below remain unchanged.
- Options precede the mandate; quote paths containing spaces. Unknown and
  duplicate options are rejected. `--` ends option parsing.
- `--preplan` snapshots a nonempty project-local file (including realpath
  containment), up to 40000 characters / 160000 bytes. Missing, external and
  oversized files fail before native session creation; nothing is truncated.
- `--history none` (default) creates a fresh child. `fork` explicitly inherits
  the supervisor's projected native context; `checkpoint` requires `--before`
  with an existing source message ID, an **exclusive** boundary. This reuses the
  same-server continuity adapter, never pastes a fake history, compacts the
  supervisor or silently falls back to a fresh session. A fork is an independent
  native session and need not appear as a fresh child in the running-work menu.
- The objective, instructions, constraints, preplan, source, history choice and
  business-profile fingerprint are frozen with a SHA-256 dossier hash before
  the PM prompt. The dossier and preflight are included in durable supervisor
  context. Active preparation cannot silently change its dossier or PM.
- `--pm <agent>` names the exact native agent whose declared profile is `pm`
  and whose native availability is available. A homonym is not enough.
  `architect` and `qa` stay available to the supervisor under their own
  categories. No permission is added.
- Without `--pm`, the single admissible project PM is selected. If no agent
  qualifies, configure an existing native agent in `businessProfiles.byAgent`.
  If several qualify, the supervisor selects one with `--pm`. Ensemble adds
  its discovery contract to that agent's system context and compaction; it
  does not register an agent or broaden its native permissions.
- The discovery helper runs before `start`. It does not call `team_spawn`,
  does not insert a team member, and does not claim a task. It does not admit
  executing workers.
- Code imports only an explicitly `ready` version 2 document. `blocked` and
  `incomplete` results preserve their candidate/reasons/questions, import no
  tasks, and do not spend schema-correction attempts. Repeated prepare returns
  that diagnostic; `/ensemble-mission prepare --resume <clarification>` explicitly
  resumes the same PM. Clarifications persist separately from the frozen dossier.
  Invalid JSON is not repaired in place. `start` refuses an unfinished preparation;
  the simple mission path without PM is unchanged.
- New PM admissions read global → project business associations freshly; malformed
  files fail closed. Already-admitted runs and approved policy are not rewritten.

### Supervisor review of paused preparation

A blocked/incomplete notification reports the current task count and, when
present, historical validation errors explicitly labelled as history rather than
current blockers. The referenced native PM session contains the complete candidate
and earlier responses. The supervisor should compare them if a correction removed
tasks or introduced new blockers, distinguish preparation prerequisites from
future execution gates, and propose a targeted resume clarification when existing
evidence resolves the issue. This is a reasoning aid, not an automatic diagnosis
or recovery guarantee: genuine missing decisions remain blocked, and the plugin
does not auto-resume or approve start.

Correction prompts require preserving the plan unless a substantive defect is
identified. In particular, a ready document requires empty `readiness.reasons`;
positive justifications belong in `context`. The field-specific validation error
does not by itself establish missing information or a substantive blocker.

### Tool preflight is layered

The host persists registered tool IDs, declared ordered permission rules and MCP
connection state separately. `ctx.tool.list()` is not the session-filtered Code
Mode catalogue; the host labels that catalogue **unverified**. Allowing execute
does not authorize nested MCP actions. The PM must check the required tools in
its own effective catalogue and report missing/refused/disconnected capabilities.
No permissions are added automatically, including on a context fork. Narrow
read/analysis exceptions require a separate native-profile decision; granting a
whole MCP server or every Context Mode/Serena method is not a read-only policy.

### Readiness contract (version 2)

New documents add `readiness: { status, reasons, missingInformation }` and
`tooling: { catalogue, unavailable }`. Status is ready, blocked or incomplete;
catalogue is verified or unverified. Lists contain 0–50 nonempty strings, each
at most 2000 characters. Non-ready results need at least one reason. Each v2
question adds an explicit boolean `blocking`. Ready refuses blockers, missing
information, unavailable required tools and unverified tooling. This is reported
evidence, not a semantic quality guarantee or an execution approval.

```json
{
  "version": 2,
  "readiness": { "status": "blocked", "reasons": ["Required tools are not exposed"], "missingInformation": [] },
  "tooling": { "catalogue": "unverified", "unavailable": ["Serena symbol lookup"] },
  "context": "No implementation plan is ready for supervisor review.",
  "openQuestions": [{ "id": "tools", "question": "Can the required read-only tools be exposed?", "audience": "supervisor", "blocking": true }],
  "tasks": [],
  "parallelGroups": []
}
```

The historical v1 parser examples below remain valid **for compatibility parsing
and replay only**, not new imports. A newly returned v1 candidate is incomplete,
never implicitly ready. Existing v1 imports retain their hash, IDs and decisions;
they are not upgraded or reauthorized. `--accept` also requires ready v2 for a
new import and does not bypass readiness validation.

Only after the initial candidate and five PM corrections are exhausted, the
lead may submit one corrected document:

```text
/ensemble-mission prepare --accept <json>
```

- Lead only. `--pm` and `--accept` cannot be used together.
- `<json>` is one preparation document. `parsePreparationDocument` is the only
  validator.
- This is the supervisor's single accepted correction, not another PM turn
  and not a silent rewrite. Invalid JSON returns validation issues without
  consuming that correction.

`start` remains the user's execution gate after a successful import. A later
`prepare` can return an already-persisted result without creating a PM session,
including after approval; it does not authorize or modify those tasks again.

## Visible PM session and background completion

By default the helper is a native child of the supervisor, titled **Ensemble preparation
PM**. It is not an executing Ensemble member. On V2 Desktop, active children
appear in the native running-work menu; selecting an entry opens that session.
The terminal's native subagent view also uses the session family. Ensemble does
not force navigation or add a fake tool call to the conversation.

`prepare` acknowledges the PM session once its initial prompt is queued, without
holding the command open until discovery finishes. Its result or error is sent
back to the supervisor separately. A second call while that loop is active
keeps the same PM session instead of starting another prompt. A persisted import
can still be returned again; an acknowledgement is not an import or execution
approval.

The child uses the selected PM's native rules, not permissions inherited from
the supervisor. If the host cannot replace the inherited session rules, setup
fails before the PM is prompted. No permission is added to the PM profile.

The Desktop running-work menu may hide an idle child after completion. Do not
promise a permanent tool card: final questions and imported task mappings belong
in the supervisor's durable conversation. Sessions created by an older version
are not automatically reparented, restarted, or replaced by this change.

### Open an existing PM from the supervisor's reply

V2 Desktop can turn a complete native session ID into an open-session button in
**assistant Markdown**. The supervisor should repeat the PM's actual ID as a
standalone inline-code value in its current reply, including for a resumed,
independent, idle, or completed PM. The ID must be exactly `ses_` followed by
26 alphanumeric characters. Use the stored ID; never invent or shorten it.

The initial command acknowledgement is a **user** message. Showing an ID there
alone does not create this button. Preserve the access reference in the
supervisor's normal response and durable context, not just a sentence saying
that the PM is running. Do not wrap the ID in a URL, a Markdown link, or a
fenced code block. The native click resolves and opens the same session on the
current server; a missing or archived target is refused by the client.

This uses the supervisor response that the command already requests. It does
not need a second PM prompt, a replacement session, a synthetic completion
notice, or another model turn solely to manufacture an assistant message. The
server supplies response instructions; it does not inject assistant text or
mechanically add a Desktop button itself. A reference in the assistant's
reply remains useful even when the running-work menu no longer shows the PM.

## Two objects

The PM does not author both objects.

The **intervention contract** is the plugin's mandate around a native agent.
It is generic: any business category can have one. PM discovery is the first
built case, via `pmDiscoveryContract`. The contract carries no tool, permission,
model, or reasoning effort. `composeIntervention` copies the native permission
list and the read-only flag. It refuses the composition when the declared
profile is not the contract category, and when native availability is
`unavailable`. Availability `unverified` can still compose, and the prompt says
that availability is not confirmed. A read-only agent is told to stay
read-only and to return documentary handoffs for the plugin to persist. This
function does not spawn, does not change permissions, and does not admit tasks.

The **preparation document** is the JSON the discovery agent returns. Code
parses it with `parsePreparationDocument` and imports it with
`importPreparationDocument`. The supervisor does not create those initial rows.

### Intervention contract

`pmDiscoveryContract` fixes `version` to `1`, `id` to `pm-discovery`, and
`category` to `pm`. The ensemble text tells the agent to apply only that
mandate and its native profile, to add nothing, and not to launch tasks or
workers.

A hand-built contract uses the same checks. Text is trimmed. Empty text and
text over the maximum both fail as "must be a non-empty string". Identifiers
are lower kebab-case (`pm`, `pm-discovery`). Underscores, capitals, and a
trailing hyphen are rejected. Unknown keys are rejected.

| Field | Bound after trim |
| --- | --- |
| `id`, `category` | 1 to 64 characters, lower kebab-case |
| `mandate.objective`, `ensemble` | 1 to 4000 characters |
| `mandate.instructions` | 1 to 20000 characters |
| `target.agent` | 1 to 128 characters |
| `target.declaredProfile` | profile id, or `null` |
| `target.nativeAvailability` | `available`, `unavailable`, or `unverified` |
| `target.permissions` | array of non-empty strings, copied as-is |

There is no minimum such as 20, 40, or 400 characters. One non-whitespace
character is enough. `"  map the webhook  "` is stored as `map the webhook`.

Category mismatch keeps the native permissions and refuses composition. The
refusal names the agent, the declared profile, and the required category, and
it says that no permission was added. Native unavailability refuses the same
way. Those refusals are return values, not spawned sessions.

## Preparation document

`parsePreparationDocument` accepts version 2 (current) and version 1 (legacy
compatibility). The following field reference and legacy examples describe v1;
new v2 documents add the readiness/tooling fields and question blocking flag above.

| Field | Rule |
| --- | --- |
| Root keys | `version`, `context`, `openQuestions`, `tasks`, `parallelGroups` only |
| `version` | number `1` |
| `context` | string of 1 to 20000 characters after trim |
| `openQuestions` | 0 to 50 questions |
| `tasks` | 0 to 100 tasks |
| `parallelGroups` | 0 to 50 groups |
| Whole value | `JSON.stringify` length at most 200000 characters |

Every stored string is trimmed. The minimum length is 1. The maxima above are
the real limits. A field is not rejected for being shorter than 20, 40, or 400
characters.

Task ids and question ids match `^[A-Za-z][A-Za-z0-9_-]{0,63}$` after trim, so
they are 1 to 64 characters, start with a letter, and then use letters, digits,
underscore, or hyphen.

### Tasks

| Field | Rule |
| --- | --- |
| `id` | stable identifier, unique in `tasks` |
| `title` | 1 to 200 characters |
| `type` | `implementation`, `architecture`, `documentation`, `research`, `review`, or `qa` |
| `goal` | 1 to 4000 characters |
| `dependsOn` | 0 to 50 unique ids that exist in this document |
| `planning.required` | boolean |
| `planning.reason` | 1 to 2000 characters |
| `acceptanceCriteria` | 1 to 50 strings, each 1 to 2000 characters |
| `verification` | 1 to 50 strings, each 1 to 2000 characters |
| `handoff.document` | 1 to 20000 characters, the finding itself |
| `handoff.sources` | 1 to 50 objects `{ path, note }` |
| `sources[].path` | 1 to 500 characters. The parser does not open the file |
| `sources[].note` | 1 to 2000 characters saying what the path contributes |

Unknown keys are rejected, including `kind`, `mode`, `model`, `variant`,
`reason`, and `priority`. The business type is the only type field.
Execution kind and planned/direct mode are derived later. They are not JSON
input.

Tasks may also include `agent` (a verified native profile, 1 to 200 characters)
and `context` using the `team_spawn` shape: `mode` is `fresh`, `fork`,
`checkpoint`, or `compact_fork`, with optional `from` and a checkpoint-only
exclusive native `messageID`. These are preserved on the imported board task.
Explicit context requires a new session and enforces the requested profile;
it cannot be satisfied by reusing an old worker. Independent review/QA should
specify `{ "mode": "fresh" }`. Omitted context preserves pool reuse. For imported
tasks, omitted `from`/`current` means the supervisor session, not the temporary
PM session. See [task pool](task-pool.md) for capacity and failure behavior.

Optional `complexity` and `risk` are integer PM scores from 0 to 100. Optional
`worktree` is a boolean; `report_mode` is `team_message` or `final_response`.
These are persisted atomically, not inferred from handoff prose. Explicit
isolation/reporting also requires a new session; auto-scale and manual spawn
apply the same contract and reject conflicting overrides before allocation.
Existing documents without these fields retain their defaults and replay hash.
`worktree:false` cannot appear in a `separate-worktrees` parallel group.

For restrictive QA, use `agent`, `context:{mode:"fresh"}`, `worktree:false`, and
`report_mode:"final_response"`. In a governed mission the candidate runs under
native profile permissions and the approved model; it needs no team tools or
phase transition. The retained final response does not complete its task or
release dependent authors. The lead first reviews and persists/integrates it.
Runtime qualification can be the first task; its future proof is not required
to prepare that task. Import itself launches nothing; user `start` is unchanged.

Dependencies must form a DAG. An unknown id, a duplicate id, a self-dependency,
and a longer cycle are all rejected. The cycle message names the ids in order.

### Questions stay with the supervisor

Each question has `id`, `question` (1 to 2000 characters), and `audience`.
The only accepted audience is `supervisor`. Questions are not worker tasks and
are not rewritten into teammate notes. Zero questions is valid. Duplicate
question ids are rejected.

Ask here only for a decision the supervisor must make. Do not hide that
question inside a task goal and leave `openQuestions` empty.

### Handoffs

`handoff.document` is the finding. `sources` are commented citations. A
read-only PM does not write the worktree; the import persists the handoff on
the task row and renders it into the task text. A note that only says "source"
or a document that only says "see above" can still parse if it is non-empty.
That is a bad handoff. The note has to say what was taken from the path.

### Parallel groups are separate branches

A group is work that may proceed on separate worktrees. The only isolation
value is `separate-worktrees`. `taskIds` lists 1 to 50 known task ids. `reason`
is 1 to 2000 characters. `integrationNotes` is 1 to 4000 characters and is the
reconciliation note for the supervisor.

The parser rejects a group that contains a direct or transitive dependency
between its members. Two writers in one shared worktree are not a parallel
group. Sequencing those tasks with `dependsOn` is the alternative.

Imported groups are stored with the document. The import does not create
worktrees. Existing spawn isolation remains the way a later, admitted worker
gets its own branch.

## Example that parses

One non-empty character is valid. This is the lower bound, not a realistic
mission:

<!-- parse:ok -->
```json
{
  "version": 1,
  "context": "x",
  "openQuestions": [],
  "tasks": [
    {
      "id": "T",
      "title": "T",
      "type": "documentation",
      "goal": "x",
      "dependsOn": [],
      "planning": { "required": false, "reason": "x" },
      "acceptanceCriteria": ["x"],
      "verification": ["x"],
      "handoff": {
        "document": "x",
        "sources": [{ "path": "p", "note": "n" }]
      }
    }
  ],
  "parallelGroups": []
}
```

A document with no tasks also parses. Context is still required:

<!-- parse:ok -->
```json
{
  "version": 1,
  "context": "No split is justified yet.",
  "openQuestions": [],
  "tasks": [],
  "parallelGroups": []
}
```

This mission document is the shape to imitate. Research and documentation are
direct. Architecture, implementation, QA, and review are planned. QA and review
depend on the implementation and not on each other, so they can share a
parallel group. The architecture task is not in that group.

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

Surrounding whitespace is removed before the limits are applied. The value
below parses, and the stored context is `Bounded read.`:

<!-- parse:ok trimmed-context -->
```json
{
  "version": 1,
  "context": "  Bounded read.  ",
  "openQuestions": [],
  "tasks": [],
  "parallelGroups": []
}
```

## Counterexamples

Each snippet is otherwise aimed at one mistake. The parser reports every issue
it sees; the line under the snippet is one issue the real parser produces.

Blank text fails. There is no separate "too short but non-empty" error.

<!-- parse:fail context must be a string of 1 to 20000 characters -->
```json
{
  "version": 1,
  "context": "   ",
  "openQuestions": [],
  "tasks": [],
  "parallelGroups": []
}
```

Expected issue: `context must be a string of 1 to 20000 characters`

`version` is the number 1.

<!-- parse:fail version must be 1 -->
```json
{
  "version": "1",
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [],
  "parallelGroups": []
}
```

Expected issue: `version must be 1`

An extra root key is not stored for later.

<!-- parse:fail document.model is not supported -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "model": "cursor/grok-4.7",
  "openQuestions": [],
  "tasks": [],
  "parallelGroups": []
}
```

Expected issue: `document.model is not supported`

Questions are addressed to the supervisor only.

<!-- parse:fail openQuestions[0].audience must be supervisor -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [
    { "id": "owner", "question": "Who owns deduplication?", "audience": "lead" }
  ],
  "tasks": [],
  "parallelGroups": []
}
```

Expected issue: `openQuestions[0].audience must be supervisor`

<!-- parse:fail openQuestions[1].id duplicate question id -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [
    { "id": "owner", "question": "Who owns deduplication?", "audience": "supervisor" },
    { "id": "owner", "question": "Who approves the boundary?", "audience": "supervisor" }
  ],
  "tasks": [],
  "parallelGroups": []
}
```

Expected issue: `openQuestions[1].id duplicate question id`

`planning` is not a task type. A local plan is `planning.required` on the task
that does the work.

<!-- parse:fail tasks[0].type must be one of implementation, architecture, documentation, research, review, qa -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [
    {
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
    }
  ],
  "parallelGroups": []
}
```

Expected issue: `tasks[0].type must be one of implementation, architecture, documentation, research, review, qa`

Kind, mode, and model are derived or chosen later. They are illegal document
fields.

<!-- parse:fail tasks[0].kind is not supported -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [
    {
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
    }
  ],
  "parallelGroups": []
}
```

Expected issue: `tasks[0].kind is not supported`

<!-- parse:fail tasks[0].planning.required must be a boolean -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [
    {
      "id": "note-rule",
      "title": "Note the rule",
      "type": "documentation",
      "goal": "Record the rule.",
      "dependsOn": [],
      "planning": { "required": "false", "reason": "The page change is local." },
      "acceptanceCriteria": ["The page states the rule."],
      "verification": ["The page contains the sentence."],
      "handoff": {
        "document": "State the rule.",
        "sources": [{ "path": "docs/webhooks.md", "note": "Page that should state the rule." }]
      }
    }
  ],
  "parallelGroups": []
}
```

Expected issue: `tasks[0].planning.required must be a boolean`

Ids start with a letter.

<!-- parse:fail tasks[0].id must be a stable identifier -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [
    {
      "id": "1note",
      "title": "Note the rule",
      "type": "documentation",
      "goal": "Record the rule.",
      "dependsOn": [],
      "planning": { "required": false, "reason": "The page change is local." },
      "acceptanceCriteria": ["The page states the rule."],
      "verification": ["The page contains the sentence."],
      "handoff": {
        "document": "State the rule.",
        "sources": [{ "path": "docs/webhooks.md", "note": "Page that should state the rule." }]
      }
    }
  ],
  "parallelGroups": []
}
```

Expected issue: `tasks[0].id must be a stable identifier`

Acceptance criteria and sources cannot be empty lists. A missing file path is
not the parser's check; an empty citation list is.

<!-- parse:fail tasks[0].acceptanceCriteria must contain 1 to 50 strings -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [
    {
      "id": "note-rule",
      "title": "Note the rule",
      "type": "documentation",
      "goal": "Record the rule.",
      "dependsOn": [],
      "planning": { "required": false, "reason": "The page change is local." },
      "acceptanceCriteria": [],
      "verification": ["The page contains the sentence."],
      "handoff": {
        "document": "State the rule.",
        "sources": [{ "path": "docs/webhooks.md", "note": "Page that should state the rule." }]
      }
    }
  ],
  "parallelGroups": []
}
```

Expected issue: `tasks[0].acceptanceCriteria must contain 1 to 50 strings`

<!-- parse:fail tasks[0].handoff.sources must contain 1 to 50 commented sources -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [
    {
      "id": "note-rule",
      "title": "Note the rule",
      "type": "documentation",
      "goal": "Record the rule.",
      "dependsOn": [],
      "planning": { "required": false, "reason": "The page change is local." },
      "acceptanceCriteria": ["The page states the rule."],
      "verification": ["The page contains the sentence."],
      "handoff": { "document": "State the rule.", "sources": [] }
    }
  ],
  "parallelGroups": []
}
```

Expected issue: `tasks[0].handoff.sources must contain 1 to 50 commented sources`

Unknown and cyclic dependencies fail.

<!-- parse:fail tasks.dependsOn: unknown task ids missing-task -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [
    {
      "id": "note-rule",
      "title": "Note the rule",
      "type": "documentation",
      "goal": "Record the rule.",
      "dependsOn": ["missing-task"],
      "planning": { "required": false, "reason": "The page change is local." },
      "acceptanceCriteria": ["The page states the rule."],
      "verification": ["The page contains the sentence."],
      "handoff": {
        "document": "State the rule.",
        "sources": [{ "path": "docs/webhooks.md", "note": "Page that should state the rule." }]
      }
    }
  ],
  "parallelGroups": []
}
```

Expected issue: `tasks.dependsOn: unknown task ids missing-task`

<!-- parse:fail tasks: dependency cycle map-webhook -> shape-guard -> map-webhook -->
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
      "dependsOn": ["shape-guard"],
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
  "parallelGroups": []
}
```

Expected issue: `tasks: dependency cycle map-webhook -> shape-guard -> map-webhook`

A parallel group cannot contain a dependent pair. The dependency can be
transitive: `guard-insert` depends on `shape-guard`, which depends on
`map-webhook`, so `map-webhook` and `guard-insert` are still coupled.

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
  "parallelGroups": [
    {
      "taskIds": ["map-webhook", "shape-guard"],
      "reason": "These look independent.",
      "integrationNotes": "They are not independent: shape-guard depends on map-webhook.",
      "isolation": "separate-worktrees"
    }
  ]
}
```

Expected issue: `parallelGroups[0].taskIds couples dependent tasks shape-guard and map-webhook`

<!-- parse:fail parallelGroups[0].isolation must be separate-worktrees -->
```json
{
  "version": 1,
  "context": "Bounded read.",
  "openQuestions": [],
  "tasks": [],
  "parallelGroups": [
    {
      "taskIds": ["map-webhook"],
      "reason": "One writer in the shared checkout.",
      "integrationNotes": "No reconciliation because there is only one directory.",
      "isolation": "shared-worktree"
    }
  ]
}
```

Expected issue: `parallelGroups[0].isolation must be separate-worktrees`

That last snippet also reports an unknown task id because `tasks` is empty.
The isolation failure is enough to show the point.

## Architecture and a local plan

Use `type: "architecture"` when the deliverable is a boundary or contract that
other tasks will implement. The derived kind is `mixed`. Set
`planning.required` to `true` when that decision is not already settled. The
handoff is the decision, including a rejected alternative. Implementation
tasks depend on it. They do not share its parallel group.

A local plan is not a task type. Set `planning.required` to `true` on the
implementation task, and say why in `planning.reason`. The worker then follows
the existing planned path: read and search first, then implementation. Set
`planning.required` to `false` only when the approach is already fixed.

Do not call a one-file change architecture. Do not call an unsettled
cross-module write a direct implementation. On a missing policy or a version 2
policy, direct implementation, architecture, review, and QA are held. Direct
documentation and direct research are the version 2 direct kinds. Relabeling
code as documentation so it will not be held is a false type. The lead still
qualifies the real scope before admission.

## Research, review, and QA

These three types stay separate when their acceptance criteria differ.

| Type | Derived kind | Use it for | Do not use it for |
| --- | --- | --- | --- |
| `research` | `research` | A finding. No code change is owned. Direct is allowed on version 2. | A known edit. That is `implementation`. |
| `review` | `mixed` | Reading a deliverable for defects, missed cases, and scope drift. | Running the agreed commands. That is `qa`. |
| `qa` | `mixed` | Running the agreed checks and reporting the actual result. | Only reading the diff. That is `review`. |
| `documentation` | `documentation` | A document change. Direct is allowed on version 2. | Designing a subsystem. That is `architecture` or `implementation`. |
| `architecture` | `mixed` | A boundary other tasks implement. | The local plan of one implementation task. |
| `implementation` | `code` | The code change. | An open-ended survey. That is `research`. |

Review and QA may sit in one parallel group when neither depends on the other,
even if both depend on the implementation task. `integrationNotes` says how the
supervisor reconciles those branches. A passing test does not close the review,
and a review comment does not replace the QA command.

## Planned and direct, without a model

`preparationExecutionDecision` reads `planning.required` and the business type.

| `planning.required` | Stored mode |
| --- | --- |
| `true` | `planned` |
| `false` | `direct` |

The decision object is `{ mode, kind }`. It has no `model`, `variant`, or
`reason`. Putting those on the decision throws before authorization.
Routing still happens later, from the approved mission policy, when a task is
admitted. The discovery JSON does not choose a model or a reasoning effort.

`authorizePreparationDecision` then applies the current policy:

- A missing policy is treated like version 2 for this hold.
- Version 2 direct work is authorized for `documentation` and `research`.
- Version 2 direct `code`, `mixed`, and `unspecified` are held. The hold reason
  comes from the policy check: direct execution needs a qualified kind, and
  version 2 is limited to documentation or research.
- Planned work does not carry a model, which is what version 2 requires.
- Version 3 can authorize direct code and mixed work when that policy accepts
  the decision. This page does not ship a version 3 catalogue fixture and does
  not widen version 2.

Held rows are still imported. They store the execution request and leave the
decision empty. Claim then fails until the lead records a decision through the
existing `execution_decisions` path: "Task execution proposal requires a
supervisor decision before admission". Authorized rows store `mode`, `kind`,
and the lead session as `authorizedBy`. The import does not spawn either kind.

## Import by code

`importPreparationDocument(db, teamId, value, policy?)` is the initial import.
The supervisor does not call it to create the first tasks and does not type
those rows by hand.

The function parses the document, hashes the canonical parsed JSON, and writes
one transaction:

- The team must already exist, and a mission draft must already exist.
- The first import must happen before `approved_hash` is set. After `start`,
  the first import throws "Initial preparation import must happen before
  mission start".
- Each PM id is mapped to a new plugin task id. Dependencies are rewritten to
  those ids. The returned mapping is the id list to show the user.
- Tasks with dependencies are `blocked`. Tasks without dependencies are
  `pending`. Priority is `medium`. The document has no priority field.
- The same team and the same canonical document replay the original import id,
  task ids, and decisions. Key order and trimmed whitespace do not create a
  second import.
- Replay does not read, fingerprint, or reauthorize the policy argument.
  `policy_hash` remains the audit of the first import only. An omitted policy
  is stored as an empty fingerprint.
- A different document for that team throws "A different preparation document
  was already imported for this mission". Later additions use the normal task
  board. They are not a second preparation import.
- A unique-constraint race replays the winning row when it is the same document.
- Nothing is spawned or admitted.
- The pre-start helper is not a teammate: no `team_spawn`, no team-member row,
  and no claim. Executing workers stay unadmitted.
- Import runs in code on the first document that parses. `--accept` is that
  document only when the PM's initial candidate and five corrections produced
  none. It does not replace a document already imported.

The supervisor can add further tasks after this import with the existing board
tools. That does not revise the stored preparation document.

## JSON recovery

Public V2 `session.prompt` accepts text, files, agents, skills, metadata,
delivery, resume, and id. It sets `additionalProperties` to false and has no
structured-output or JSON-schema field. Native structured output is not active
on this host. A model metadata flag is not a public prompt parameter. The
discovery session asks for one JSON object and parses the text with
`parsePreparationDocument`. Do not send `format`, `json_schema`, or any other
unpublished field.

The recovery contract is:

1. The PM returns an initial JSON candidate.
2. The same parser validates it. On failure the PM may correct the candidate
   at most five times. Each correction sees the candidate and the parser issues.
3. Only after that initial candidate and those five corrections are exhausted,
   the lead may run `/ensemble-mission prepare --accept <json>`.
4. That document is validated by the same parser. There is no looser schema
   and no silent repair.

Migration 24 stores the preparation document and task mapping; migration 25
stores the PM run, mandate, session/model identity, rejected candidate, issues,
and correction count. The same running session can resume after a transport
failure; simultaneous loops for that run are refused. A missing, failed,
interrupted, or unchanged assistant response is not counted as invalid JSON.
The host must provide `session.wait`, `session.context`, `session.get`, and
`session.interrupt`; the wait has a ten-minute deadline. A timeout interrupts
the helper rather than inventing a JSON response.

After an import commits, retrying `prepare` returns the stored task ids,
decisions, hold reasons, questions, and parallel groups. It does not need a new
model call or reauthorize the tasks. If delivery to the supervisor fails, the
error explicitly says that the import remains committed. First-time imports
remain forbidden after approval. Tests exercise these paths with mocked host
operations and in-memory SQLite; no live recovery smoke is claimed.

## Serena and GrepAI

Use each tool for the job it actually answers. A call that is not used in the
handoff is not evidence. A canonical index does not prove what an uncommitted
worktree contains.

GrepAI locates behavior when the file is unknown. Use a descriptive English
query and a small result set, then open the file. Exact renames, error strings,
counts, and known symbol names belong to exact search. If the tool catalog has
no GrepAI tool, say so and search exactly. An empty result means check the
source root, exclusions, and index coverage before calling the behavior absent.
A parent source root can be the real index even when the nested repo has no
`.grepai/` directory. Do not initialize an index unless that was requested.

Serena is for a known symbol: file overview, the function body, then references
before changing a contract other code uses. Compare the active root with the
expected source root once. A parent root can be correct. Do not call
`activate_project` on a shared connection. Uncommitted worktree edits are read
from the worktree. Serena on the canonical checkout does not see them.

Good handoff source: `src/preparation-document.ts`, note "`parsePreparationDocument`
rejects unknown keys and trims text". Bad handoff source: a path of `.` with a
note of "searched the repo", or a Serena hit from `main` cited as the
uncommitted worktree file.

When a worker command runs, its working directory is that worker's worktree.
Do not checkout, restore, or clean the user's main worktree to inspect a
teammate branch.

## What this commit does not change

Preparation adds no sixteenth team tool. The public SDK surface stays the
public SDK surface. Transport extraction still reads `._client`. `promptAsync`
stays fire-and-forget. Every `session.abort()` path still preserves the branch
first. Version 2 and version 3 execution policies stay in place. Tests for this
contract use an in-memory database and do not open a live Ensemble database.

## Verification boundary

The document examples are checked with `parsePreparationDocument`. Runtime
regression tests additionally exercise command parsing, admission, corrections,
recovery, and the V2 adapter using mocked host operations and in-memory SQLite.
A green project gate is not a live PM/model smoke test, nor proof that an
installed plugin or Desktop session has loaded this checkout.
