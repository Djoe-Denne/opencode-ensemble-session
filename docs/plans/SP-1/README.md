# SP-1 — Native V2 permission semantics

Status: **partial observed Phase 0 spike; lead acceptance pending**. No Phase 1 fix.
Owner: `sp1-permissions`, task `task_mvffsknr_001n_9nlxbd`.
Observation date: 2026-10-19 UTC.

## Scope and provenance

The native shell initially resolved to the canonical checkout on `main`.
The worker stopped without writes. The lead moved only this worker session,
then independently verified its native location. The worker rechecked its
actual shell cwd (not a Context Mode sandbox cwd), Git top-level, branch,
HEAD and clean status before submitting the plan. Implementation and native
probes began only after explicit lead approval.

All paths below are relative to the actual isolated worktree `W` unless stated:

`C:/Users/djden/.local/share/opencode/worktree/84ea7a/ensemble-crisp-comet-mission-60502567aec6ce4f#8ws0e8-sp1-permissions`

- Branch: `ensemble-crisp-comet-mission-60502567aec6ce4f#8ws0e8-sp1-permissions`.
- Base and HEAD during the native campaign:
  `e446c88003c43be7b7848835a6d79953b3460d25`.
- Native service: OpenCode **2.0.32**, PID **51636**, loopback port **41037**.
- Native campaign: **16:34:18.155–16:34:20.289 UTC**, approximately 2.134 seconds.
- Seven new scratch sessions, **71** public `session.permission.create`
  requests: **22 allow, 49 deny, zero ask/error/timeout**.
- No prompt, inference, model override, classifier, Code Mode invocation,
  actual file-tool execution, external file write, or additional worktree.

`docs/plans/sp2-checkout-installed-parity.md` remains the installed-bundle
provenance reference. This experiment used the already-running native host;
it did not deploy this checkout or repair checkout/installed schema divergence.
GrepAI and Serena were read-only against the canonical source index; they were
not reconfigured to this worktree. Context Mode handled tests and evidence.

## Delivered and executed

- `eval/native-permissions.ts`: importable, network-inert harness. Live mode
  requires both `--live` and `ENSEMBLE_SP1_APPROVED=1`, isolated worktree/Git
  preflight, host version 2.0.32, and a new evidence output under this directory.
  It reads the existing service registration without logging credentials.
- `test/native-permissions.test.ts`: ten offline tests; injected transport only,
  no mocked permission-matching business logic and no host calls during tests.
- `native-2026-10-19T16-34-17.877Z.json`: generated native campaign evidence,
  including exact plans/bodies, decisions, request IDs/times, session readbacks,
  public API fragments, profile rules and hashes. SHA256:
  `5ca73e9af7fde5a1738addd649b41fe18d752d8e2d048a4d6694c484515f8740`.
- `native-status-2026-10-19T16-35-05.270Z.json`: selected owned-session projection
  transcribed from a subsequent read-only `GET /api/session/active`; no unrelated
  session IDs retained. All seven scratch sessions were absent from that
  process's foreground-drain list. The public endpoint calls this inactive;
  this is not a verified native idle/archived session-state field.

The ignored files actually present in `W` are:

- `.opencode/sp1-permissions-2026-10-19T16-34-18.154Z/manifest.json`.
- `.opencode/sp1-permissions-2026-10-19T16-34-18.154Z/gate.log`.
- `node_modules`: approved junction to
  `C:/Users/djden/source/repos/opencode-ensemble-session/node_modules`.
  No install or dependency-content mutation was performed.
- `dist/index.js`: locally built output, not deployed.

The manifest's owner is this worker; campaign ID is
`2026-10-19T16-34-18.154Z`. Every session carries matching `ensemble.sp1`
metadata and an `ENSEMBLE_SP1_<campaign>_<group>` title. This metadata is only
an ownership marker, **not native archival or idle state**.

## Direct results: expected hypotheses versus observations

All permission requests used action `edit`. Paths are resource strings;
they do not need to exist and no file tool was invoked.

### Rule order, not specificity

Hypothesis: last matching rule wins, rather than most-specific rule.

- `allow-last`: session rules `edit * deny`, then `edit docs/plans/** allow`.
  `docs/plans/sp1-probe.md` was **allow**.
- `deny-last`: exact same rules reversed. The same resource was **deny**.
- Both results held with explicit `agent: architect` and with the agent field
  omitted from the request. Both sessions themselves had agent `architect`.

This is direct support for last-match ordering on the tested native endpoint.
It is not a claim about every host release or another policy layer.

### Relative, absolute, outside-root and separator behavior

The unmodified native architect profile exposed `edit * deny`, followed by
`edit docs/plans/** allow` (other profile rules are in the JSON evidence).

- Relative `docs/plans/sp1-probe.md`: **allow**.
- Relative `src/sp1-probe.ts`: **deny**.
- Absolute `W/docs/plans/sp1-probe.md`: **deny**, including backslash spelling.
- Synthetic absolute sibling resource
  `<parent-of-W>/sp1-outside/docs/plans/sp1-probe.md`: **deny**.
- Relative `docs/plans/../../src/sp1-probe.ts`: **allow**.
- One request containing both allowed docs and denied src resources: **deny**.

With session rules `edit * deny`, then
`edit W/docs/plans/** allow`, the absolute worktree resource became **allow**
for both slash and backslash spelling. Relative docs remained **deny**.
With a session allow for the synthetic absolute sibling glob, that outside-root
string became **allow**. There was no external write or real outside-root tool.

**Important:** the traversal-shaped string result demonstrates that a direct
permission request is not a substitute for a real tool's path canonicalization
or root-confinement test. It does **not** establish a working filesystem escape.

### Profile/session interaction

Hypothesis under test: the source comment in `src/v2-client.ts` says session
creation permissions lose to agent rules. The direct native endpoint provided
counterexamples on this host:

- Session `edit * allow` made all eight resources **allow**, including src and
  outside-root strings that the architect profile otherwise denied.
- Session `edit * deny` made all eight resources **deny**, including relative
  docs that the architect profile otherwise allowed.
- A request with explicit `agent: architect` did not restore profile precedence.

Thus native `session.create` permissions are effective and can dominate these
profile decisions in this experiment. Do not turn this into a universal
statement about adapter metadata, plugin hooks, actual tools, or Code Mode.
No adapter or evaluate-hook correction was made. The lead must reconcile the
source comment with the separately observed native contract before Phase 1.

### Strict repetitions and historical 3-success/2-refusal report

One baseline architect session, no explicit session permission rules, contained
three separately repeated cases. Within each case the complete request body,
action, resources, explicit agent and session ID were identical:

- Relative docs: **allow ×5**.
- Absolute worktree docs: **deny ×5**.
- Relative src: **deny ×5**.

Configuration SHA256 before and after the entire campaign matched:
`3c41a226ce0b0dd13ca0735aa258ea1f32e4756add201e774560b931d1df376e`.
The complete native architect response hash also matched:
`17893778c3f818393bf68b92db70adadc57a85f3dcb724c2a08901f82f46fdc7`.
No saved permission reply was issued. These finite observations did not
reproduce mixed 3/2 outcomes; they neither explain nor disprove the historical
case. In particular, changing resource spelling is not nondeterminism.

## Resource contract and remaining unknowns

The public development SDK file actually read was
`W/node_modules/@opencode/plugin/dist/promise/permission.d.ts`
from package `@opencode/plugin` 2.0.26. `PermissionEvaluation` declares
`readonly resources: ReadonlyArray<string>`, plus `sessionID`, optional agent,
action, metadata/source, mutable effect/message. It has **no singular resource**.
The native host's public permission-create schema likewise accepts plural
`resources: string[]`; rule objects separately have singular `resource: string`.
The complete SDK excerpt/hash and native OpenAPI hash are in the evidence.

- **OQ-101:** result-envelope assumption is guarded by code/tests: only HTTP 200
  with `data.id` and native `effect` is a decision. Malformed success, HTTP error,
  transport failure, timeout and ask are distinct; nondecisions stop the run.
- **OQ-102:** raw API resource strings are not known to equal actual file-tool
  paths. The traversal-shaped input is deliberately preserved by a test; no
  filesystem-confinement claim follows from its permission decision.
- **OQ-103, unresolved:** actual `permission.evaluate` event payload and Code Mode
  behavior were not observed. The SDK is a type contract, not runtime evidence.
  The host exposed no public direct evaluate/tool-execute endpoint. Prompts,
  inference, observer-plugin installation and live hook changes were excluded.

Smallest proposed follow-up, requiring separate lead authorization: an isolated
native fixture that observes the public hook without changing its effect, then
replays the same harmless edit operation directly and through Code Mode with a
deterministic, explicitly governed caller. Capture action/resources/agent,
effect, tool identity and canonical path for both. Do not reload this shared
service, select an ungoverned model, or silently substitute SDK types for those
observations. No such follow-up was launched here. This missing runtime
hook/Code Mode evidence remains a blocking completeness question for lead
review/G0; this report does not establish the full SP-1 contract.

## Retention, not destructive cleanup

The native public API had no archive operation, and session update accepted
only title/metadata/permissions. The lead explicitly approved retaining owned
scratch sessions rather than removing or aborting them. Final `session.get`
readbacks showed the expected location/agent/ownership and zero tokens/cost;
that endpoint had no status/state field. The later `session.active` readback
established absence from foreground drains, not an idle field or archival.
Retention classification: **retained-not-prompted /
cleanup-not-supported**, with no archive/remove/abort performed.

Owned sessions, in group order:

- allow-last: `ses_eaafc7450ffexcIlOzpXld9JwL` (8 permission requests).
- deny-last: `ses_eaafc7334ffekwcVcBsbnlqaFq` (8).
- architect-baseline: `ses_eaafc7226ffeNCDAIqR4L2knwy` (23).
- session-allow: `ses_eaafc709affeKPsYXSIvaW8TAU` (8).
- session-deny: `ses_eaafc6f78ffeyUr4xch04rBHAs` (8).
- absolute-allow: `ses_eaafc6e39ffezVWaCw5FUdGB9X` (8).
- outside-allow: `ses_eaafc6d2dffep4UYS4Faa9HWfZ` (8).

No global/saved permissions, profile, hook, source configuration, live DB,
migration, plugin install/reload, existing session or branch was changed.
The shared-server mutation lease was released to the lead after this campaign.
There were no Docker resources to register.

## Commands and actual verification

Native-location checks used `Get-Location`, `git rev-parse --show-toplevel`,
`git rev-parse HEAD`, `git branch --show-current`, `git status --short`.
The approved dependency prerequisite used `New-Item -ItemType Junction` only.

TDD commands: `bun test test/native-permissions.test.ts`.
First RED: **0 pass / 5 fail**, including empty plan, missing five repetitions,
wrong decision classification and missing fail-closed stop behavior (compilable
stub, no import/compiler error). A subsequent guard RED was **8 pass / 1 fail**
(missing explicit-live guard); timeout RED was **9 pass / 1 fail** (timeout
misclassified as transport). GREEN: **10 pass / 0 fail**. A standalone
`bun run typecheck` also passed before native execution.

Exactly one live campaign was executed with the pre-review harness preserved at
`8ea850a485769777deffad1a39b905770f91c5c8`. The following is its historical
command, not a command executed again after the corrections documented below:

```powershell
$env:ENSEMBLE_SP1_APPROVED = '1'
bun eval/native-permissions.ts --live --output docs/plans/SP-1/native-2026-10-19T16-34-17.877Z.json
```

Exit **0**; seven sessions/71 decisions; no retry or second campaign.
The environment flag was scoped to the spawned process, not persisted globally.
Read-only GETs inspected `/api/info`, `/openapi.json`, architect/config, native
session readbacks and `/api/session/active`; credentials never entered evidence.
After the mutable campaign ended, two additional read-only OpenAPI inspections
located/documented `session.active`, followed by its read-only status projection
at 16:35:05.270 UTC. These were performed before reading the lead's subsequent
instruction to make no additional server calls. No server calls followed
receipt of that instruction; no additional mutations occurred after the campaign.

Required worktree gate, run via `cmd.exe /d /s /c`:

```text
bun run typecheck && bun test && bun run build
```

Exit **0**: typecheck passed; **1312 tests passed, 0 failed**, across **74 files**,
44,763 assertions, 20.81 seconds; build passed and produced `dist/index.js`.
This is a checkout gate, not an installed-plugin deployment or G0 acceptance.
The ignored gate log SHA256 is
`6f604f4e70559806961a8c98473e264e6841ee5f6ad788226e6a62325b72030b`.

Biome lint also passed for both owned TypeScript files, with unchanged output.
Because repository Biome includes only src/test, each file was supplied through
stdin with `--stdin-file-path=test/native-permissions-check.ts --write`; stdout
was compared with the input and no file was written by that command. No `any`
types, internal SDK APIs, promptAsync calls, session.abort calls, or new runtime
dependencies were added. All exported functions have JSDoc.

Residual lead decisions: accept or reject this evidence; reconcile adapter
precedence assumptions; approve or defer OQ-103's separate experiment; preserve
the distinction between native policy strings and actual tool confinement.
This worker does not close SP-1 or authorize Phase 1/G0.

## Independent review and integration corrections

Fresh reviewer `sp1-review` returned candidate `result_mvfhniin_003b_53us3m`
for task `task_mvfhhqq2_0037_8552fs`. It independently checked both JSON files,
the harness, tests and this report. It confirmed 7 sessions / 71 decisions,
22 allow / 49 deny, the strictly identical 5/5/5 series, stable hashes and no
malformed recorded decision or identified authentication secret. The artifact
set is useful as a **partial** spike, not completion of SP-1/G0.

It also identified three harness defects. The lead applied offline integration
corrections, confined to the harness, its tests and this documentation:

- Native `effect` must be a string before enum membership is tested. Arrays
  such as `["deny"]` must stop as `protocol-error`, not become decisions through
  `String()` coercion.
- A response body that is not JSON retains its HTTP status. A 200 response is
  `protocol-error`; a non-200 response remains `http-error`, rather than being
  mislabeled a transport failure. Actual fetch/body-read failures still use
  the separate transport/timeout handling.
- The harness no longer reads `service.json` or assumes its private `port` and
  mandatory-password fields. It requires explicit `--service-url` and
  `--service-pid` from the operator's approved public connection information.
  The URL is intentionally limited to a root HTTP(S) loopback endpoint, without
  userinfo/query/fragment. Optional authentication is supplied only through
  process-scoped `ENSEMBLE_SP1_PASSWORD`, never in the URL, evidence or logs.
  Public `/api/info` must match both version 2.0.32 and the expected PID before
  any session can be created. There is no discovery fallback, `ensure`, service
  startup or new dependency. A future separately authorized live run needs
  these extra connection arguments; the historical command above used the old
  harness and is retained verbatim as evidence.

The explicit-endpoint design avoids importing an undeclared client dependency
solely for optional eval discovery. Public `Service.discover` is an appropriate
source of operator connection information; the harness does not duplicate its
registration-file parser or start a service to obtain that information.

Integration TDD: `bun test test/native-permissions.test.ts` first produced
**10 pass / 4 fail**, with meaningful assertions/stubs rather than import or
compiler errors, then **14 pass / 0 fail** after the minimum fixes. Tests include
non-string effects, malformed JSON with success/error HTTP status, explicit
endpoint/PID and optional authentication, and mismatched host identity.

After the URL-constructor portability cleanup and import ordering, the focused
test recheck again reported **14 pass / 0 fail**. An offline replay of all 71
recorded permission responses through the stricter classifier changed **zero**
classifications; it did not contact the server or repeat the campaign.

These are offline robustness corrections. **No new campaign, HTTP call, model
request, permission change or session operation was performed for them.** The
recorded native JSON files remain unchanged and describe the earlier harness.
Follow-up review and the integrated full gate remain required; OQ-103 is still
blocking, with no new hook/tool/Code Mode evidence.

Follow-up candidate `result_mvfi0m7h_003g_129chb` confirmed the three corrections
by inspection, but found an additional P2: automatic HTTP redirection could
escape the endpoint allowlist and hide the intermediate response in the log.
The lead extracted the transport actually used by `live` into the import-inert
`createPermissionTransport` factory. Its injected HTTP boundary is tested
offline; the live path passes the real `fetch` to that same implementation.
Requests now set `redirect: "manual"`. All 3xx responses are refused with their
original HTTP status and a **local** `redirect-refused` marker; the redirect
destination/body is not followed, read or presented as a native decision.

This second TDD cycle produced **14 pass / 3 fail** on compilable transport
stubs, then **17 pass / 0 fail**. The added tests exercise 307/308 options and
refusal, owned-endpoint checks before fetch, and HTTP/protocol separation at
the actual transport boundary. Their fetch implementations are injected local
fakes, not requests to any server. No new native campaign was run.

Final follow-up candidate `result_mvfia4s6_003l_yw2aco` independently confirmed
the redirect fix and its live wiring by inspection, with **no new confirmed
defect**. It checked refusal before response-body reading, original status in
the audit, safe stop/checkpoint behavior, ownership before HTTP, and preservation
of the three earlier corrections. It did not execute tests or HTTP requests.
The lead's post-fix recheck passed all **17 focused tests** and typecheck; this
is not a substitute for the integrated full gate recorded separately below.
OQ-103 remains blocking regardless of artifact correctness.

## Integrated gate after review corrections

The lead executed `bun run typecheck && bun test && bun run build` on the
integrated `main` tree at 2026-10-19 17:08:06.630–17:08:30.430 UTC: **exit 0**.
Typecheck passed; **1319 tests passed, 0 failed**, across 74 files; build bundled
336 modules into `dist/index.js` (1.30 MB). The full local log is
`C:/Users/djden/AppData/Local/Temp/opencode/ensemble-sp1-partial-integrated-gate-2026-10-19T17-08-06-630Z.log`.

Only this documentation was changed afterward to record the result. The gate
validates the integrated partial artifacts and corrections, not the installed
plugin, a new native campaign, SP-4's not-yet-integrated artifacts or G0. SP-1
itself remained **incomplete** pending OQ-103 at that gate. The later runtime
follow-up is recorded below and still does not expose the raw hook payload.

## Runtime tool and Code Mode follow-up

On 2026-10-19 at 18:12–18:14 UTC, the lead used a scratch profile and four
scratch sessions in `%TEMP%/opencode-sp1-runtime-probe`. The profile selected
`openai/gpt-6.1-sol` variant `low` and combined the host's default rules with
the architect pattern: deny `edit *`, allow `edit docs/plans/**`, and deny
`shell`. No project file or global profile was changed. The governed prompts
used that scratch model only.

- The public `session.shell` endpoint returned 204 and created
  `docs/plans/sp1-shell.txt` despite the shell denial. No permission request was
  recorded. This endpoint is not evidence of the edit hook.
- A real model turn called the tool `patch` for `docs/plans/sp1-direct.txt`.
  The tool completed and the file contained `ok`. No permission request event
  was visible.
- The same `patch` tool aimed at `outside.txt` failed with exactly
  `Permission denied: edit`. The file was not created. The public failure does
  not include the evaluated resource list.
- Code Mode's `execute` tool wrote `docs/plans/sp1-code-mode.txt` through
  JavaScript `fs.writeFileSync`. A second execute prompt aimed outside
  `docs/plans` did not create a file: the script invoked another tool with an
  invalid payload, so this is not an observed edit denial.
- The public event stream showed tool start, success, and failure. It did not
  include a `permission.evaluate` payload with `resources`, agent, and effect.
  The historical 3-success/2-denial mix was not reproduced: these were different
  resources with one allow and one deny.

OQ-103 is therefore partially observed. Real edit enforcement and one Code Mode
write are established. The raw hook arguments remain unexposed by the host's
public events, and Code Mode filesystem writes are not yet shown to pass
through the same `edit` decision.
