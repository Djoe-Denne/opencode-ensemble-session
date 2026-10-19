# Mission-scoped task classification

`team_create` discovers classification capabilities once and stores the effective
policy in SQLite. The lead's prompt and compaction context recall that decision:
do not choose a different method for each task. Later configuration changes do
not silently alter an existing mission. Existing teams without a snapshot and
legacy tasks remain compatible. This feature does not change review policy.

## Configure an explicit model and protocol

Add `classification` to the plugin's `ensemble.json`, or pass partial overrides
to `team_create`. These are placeholders, **not recommended/activated models**:

```json
{
  "classification": {
    "mode": "auto",
    "missionMode": "supervised",
    "helperModel": "provider/helper-chosen-by-user",
    "generalModel": "provider/classifier-chosen-by-user",
    "specialized": true,
    "fallbacks": [
      { "method": "general", "model": "provider/classifier-chosen-by-user", "variant": "medium" }
    ],
    "limits": { "maxAttempts": 3, "maxCalls": 1000, "concurrency": 1 }
  }
}
```

- `auto` freezes the detected JEV tool for general tasks. If JEV is absent,
  it uses `generalModel` **only if explicitly selected**; otherwise manual
  operation remains available. `specialized: true` selects a detected x86 tool
  for tasks explicitly marked `task_type: "x86"`.
- `jev`, `general`, or `x86` imposes that method for the mission, overriding
  specialization. `off` explicitly disables automatic classification.
- `helperModel`/`helperVariant` select the technical session that invokes JEV or
  x86, not the classifier tool's backend model. No helper model is inferred from
  the lead, the worker catalogue, a free tier or a provider preference.
- `generalModel`/`generalVariant` select the embedded, tool-denied general
  classifier. They are not an implicit fallback when a detected JEV later fails:
  only entries in `fallbacks` authorize failover.
- `toolId` and `x86ToolId` disambiguate effective native tool IDs. Discovery
  checks the contract; multiple matches require an explicit choice.
- Global/project partial configuration merges, including `limits`. A project
  fallback array replaces the inherited chain. Invalid sections warn and retain
  inherited settings without discarding unrelated configuration.

The default is `auto`/`supervised`, with **no helper/general model chosen**,
specialization disabled, and no authorized fallback. If the frozen method is
JEV or x86 without `helperModel`, or general without `generalModel`,
`/ensemble-mission config` shows that block and `/ensemble-mission start`
refuses approval. The explicit choices are `team_message` classification or
`mode: "off"`. `team_create` and mission prepare still open the draft. A legacy
team with no mission-policy row refuses unscored `team_tasks_add` in that same
unset state; tasks that already have both scores stay `not_required`. Policies
already frozen in SQLite keep their stored limits. Missing host capabilities
fail explicitly for imposed automatic methods.

Only after an explicit user instruction may the lead change the frozen policy:

```js
team_message({ to: "lead", classification: { helperModel: "provider/chosen-model" } })
```

This requeues unresolved classification work and records the policy change.
Completed classifications remain unchanged, worker sessions are not rerouted,
and mission count/time/volume usage is **not reset**. To increase a budget,
explicitly raise its limit rather than silently starting a new counter.

## Scores and rubric

Internal classification uses **0..1**, retaining the native JEV value without
rounding, multiplying by 100 or dividing it again. `routeNormalizedModel` accepts
these values directly with the existing deterministic demand/cost algorithm.
The public `routeModel` API and board inputs remain integer percentages for
compatibility; `routeModel` converts those once at its boundary.

`classification-protocol.ts` exports:

- `discoverJevTool`: recognizes compatible `jev_ask`/namespaced contracts by ID
  and input schema. An arbitrary ID requires explicit selection. Ambiguous
  discovery requires a user choice, not arbitrary provider preference.
- `buildJevClassificationInput`: fixed, consistently ordered low-to-high
  complexity/risk anchors. Existing normalized manual dimensions are omitted
  from the questions. Task content remains data, not helper instructions.
- `normalizeJevClassification`: validates native `answers.<dimension>.score`
  or a public tool result wrapper, preserves manual overrides and attaches the
  protocol/model provenance. Missing/invalid scores are rejected. This function
  validates/normalizes the **result shape**, not its numerical scale.

The actual JEV `score` result is a normalized score determined by the ordered
criteria. It is not a free-form integer from a prompt. Reversing the criterion
order reverses the meaning, so the rubric is versioned as `ensemble-task-v1`.
JEV confidence is not the risk score. These are heuristic routing inputs, not
calibrated success probabilities. The x86 adapter maps the tool's **0–100**
reconstruction complexity and judgement uncertainty to 0–1 exactly once;
uncertainty becomes risk. It never substitutes the raw JEV evidence scores or
confidence for that tool's published contract.

## Board admission

`team_tasks_add` starts classification asynchronously; it does not block the
lead's tool call. Two manually supplied dimensions bypass classification; a
partial manual dimension is preserved while only the missing value is filled.
Task work state and classification state are independent:
`not_required`, `pending`, `running`, `completed`, `blocked`.
Fully manual tasks become `not_required` immediately with zero classifier
attempts. They do not emit an asynchronous classifier-completion notification:
inspect their board state once rather than waiting for such a notification.

`team_claim`, pool dispatch/scaling and `team_spawn.claim_task` exclude tasks
until classification completes (or is not required). Successful native 0–1
scores are persisted with protocol/model/method provenance and routed directly
through `routeNormalizedModel`. Explicit spawn models still win. Reused workers
do not have their models changed on the next task.

`team_tasks_list` exposes precise scores and block reasons; `team_status` shows
mission mode/state, classification counts, usage and recent incidents. Claims
are atomic and late results cannot overwrite a new policy or changed task data.
Completed tasks are not continuously reclassified. Repeated task edits are
bounded. x86 tasks require real `classification_input.assembly` and
`architecture` (`x86-32`/`x86-64`); missing evidence is never fabricated.

## Resilience and mission modes

`team_create.mission_mode` overrides `classification.missionMode`.
These modes govern classification admission/failover; they do not enable
`autoDispatch`/`autoScale` or replace the existing worker watchdog/lifecycle.

- **supervised** (default): apply authorized retries/fallbacks; mark the mission
  `attention` when exhausted and instruct the lead to ask the user. Independent
  classified/manual work remains eligible.
- **long_run**: isolate failed task classifications and continue independent
  work without asking for an unapproved fallback. A hard budget failure stops
  new admission with `critical`; cleanup safety failures are critical in either
  mode. Existing workers are never automatically aborted, reset or rerouted.

Defaults for `limits`: `retries: 1`, `retryDelayMs: 100`, `maxAttempts: 3` per
task, `maxCalls: 1000`, `maxDurationMs: 1800000`, `maxInputBytes: 10000000`,
`concurrency: 1`, `circuitThreshold: 3`, `circuitCooldownMs: 60000`, and
`maxCircuitRechecks: 1`. Only a timeout, provider error, or missing execution
proof is retried. A forbidden tool, modified input, envelope disagreement,
cleanup failure, or admission failure is terminal. Retries and the ordered
fallback chain share the task
attempt cap. Every reserved attempt, including failed calls and rechecks,
consumes the persistent mission count and serialized input-volume budgets.
The duration budget is elapsed wall time from the first reservation.

An open circuit skips repeated outages and permits only bounded half-open probes
after cooldown, on subsequent eligible evaluations. It does not poll or retry
unchanged blocked tasks indefinitely. Incidents record failures, fallback usage,
budget exhaustion and retained helpers. Limits do **not guarantee a monetary
cost cap** or successful classification.

Concurrency is capped separately from the worker pool within the plugin runtime,
including across mission DB handles, and bounded by global configuration.
Durable task admission prevents double ownership; this is not a distributed
provider-call semaphore across separate OpenCode server processes.

## Native execution bridge

`invokeNativeClassifier` uses a fresh native helper session and an explicitly
selected orchestration model/variant. It creates no worktree, is not registered
as an Ensemble worker and does not inherit a teammate's history. The selected
helper model is separate from the JEV backend model reported by the tool.

It never invokes the discovered tool's raw `execute` callback. A normal native
prompt executes through OpenCode's permission and tool-hook pipeline. The public
`permission.evaluate` hook denies unrelated actions for that helper only. Tool
hooks reject unrelated tools, modified payloads and duplicate invocations; only
an observed completed execution counts as evidence. Model-authored answer text
cannot substitute for an actual JEV call. A single Code Mode script is rewritten
to discover the exact catalogue path and invoke the approved payload in the same
execution. Its return value is a tagged envelope `{ protocol, toolId, output }`.
That envelope proves execution when the nested tool hook is absent. If both
exist and differ, the attempt is a violation. A completed `execute` without
the envelope still fails; once the injected dispatcher was seen, the error
says it was not executed. No second model turn is needed to progress from discovery to the call.
The generated dispatcher validates and traverses that path without `eval` or
`Function`; native tool hooks still verify the effective tool ID and input.
For Code Mode tools, the helper receives only a transport instruction, not the
task/ASM payload: Ensemble injects the original approved input directly into
the dispatcher. This avoids asking a routing helper to read, reconstruct or
reason about data that only the classifier needs. Direct-only tools still
receive their exact input in the helper prompt; general classification still
receives the rubric and task it must assess.
The tool-backed attempt finishes when the approved native tool completes and,
for Code Mode, its enclosing dispatcher completes successfully. It does not
wait for a final helper narrative or another provider turn; removal then stops
the helper while its guards are still installed. Dispatcher failures and
violations observed before that boundary still reject the attempt. The deadline
still bounds discovery, setup and actual tool execution, not optional narration.
Arbitrary model-authored JavaScript,
network fetches or unrelated calls cannot run through that dispatcher. The
embedded general classifier has **all tools denied** and must return valid JSON.

The default 30-second attempt deadline covers discovery, creation, setup,
execution wait and result retrieval. Cleanup has a separate bounded safety grace
(five seconds per removal/disposal operation). Helpers created late after a
timeout are recorded and removed without being prompted. Removal precedes guard
disposal; failed removal retains the restrictions, names the helper, records its
session ID and stops new admission. No worker branch is touched.

Before deleting a failed helper, the bridge takes a bounded native diagnostic
snapshot (at most one second of separate readback grace). The persisted failure
includes the helper ID, last execution phase, native outcome/model, numeric
token/time metadata and message count, recent tool or
Code Mode errors, and native assistant errors. Prompt text, tool inputs/results
and provider response bodies are not copied; error strings are bounded and
common credential patterns are redacted. Unavailable readback does not prevent
cleanup, and cancellation remains an `AbortError`. A failed native general
session cannot supply a valid classification merely by leaving JSON in its
transcript. A generic missing-execution error or whole-attempt timeout is not,
on its own, proof that the JEV backend failed.

SQLite migration 14 stores policy/mode/state, scores/provenance, incident and
budget data, helper identities and admission leases. Restart recovery is scoped
to the current project. It removes recorded stale helpers before re-admission
and uses a one-shot lease-expiry wake rather than idle polling. Crashes may cause
a remote call to be repeated: **exactly-once provider execution is not promised**.
Unsupported stored protocol versions fail rather than silently switching rubric.

## Verification

```powershell
bun test test/classification-protocol.test.ts test/classification-adapters.test.ts test/classification-runtime.test.ts test/board-classification.test.ts test/v2-classification.test.ts
$env:OPENCODE_TEST_BIN = 'C:\Users\djden\AppData\Roaming\ai.opencode.desktop\cli\2.0.26\opencode-cli.exe'
bun run eval:classification
```

The native fixture launches an isolated OpenCode server with local canned model
and JEV responses. It exercises the actual public plugin API, native sessions,
permissions and tool hooks without paid provider calls or production sessions.
It verifies discovery, unrounded scores, a single successful call, denial of an
unrelated tool, rejection of fabricated tool evidence, helper cleanup, Code Mode
nested single-pass dispatch with model-authored JavaScript overwritten,
exact bridge-injected input and a deliberately stalled helper continuation,
tool-denied general classification, a real board claim, x86
mapping, a disappeared JEV backend with authorized fallback, and a mission with
JEV actually removed from the tool registry. Canned scores verify integration,
not the quality or calibration of a chosen model's real-world assessments.

Verified on OpenCode Desktop CLI **2.0.26**. On this host `permission.rules`
is absent from the public plugin context; `permission.evaluate` is supported
and is the tested restriction mechanism.
