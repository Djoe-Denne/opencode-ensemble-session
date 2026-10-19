# SP-4 — Native switchModel with an omitted variant

Status: **Partial — historical evidence and corrected runner reviewed; integrated gate passed; SP-4 not accepted**.

Mission `team_mvffoozl_001l_8ws0e8`; task `task_mvffskns_001p_q6nz0q`.
Reporter: `sp4-switchmodel`, worker session `ses_eaafa96ebffeKoy1pYifABTrqz`.

## Result

On the observed OpenCode **2.0.32** host, switching Sol from explicit `xhigh`
to the same model with **no `variant` property** retained native
`model.variant: "default"`, not `xhigh`. Switching to Luna with the property
absent also retained `"default"`. This describes session state only; it does
not establish a provider's default effort or the settings of any executed
request. No inference, prompt or classification was requested.

An unknown string variant was accepted and persisted. Consequently, successful
`switchModel` is **not** evidence that a variant belongs to the native catalogue.
A numeric variant, invalid under the public schema, produced HTTP 400 and the
subsequent GET showed the previous model unchanged.

## Provenance and boundaries

- Native shell initially resolved to canonical `main`. Work stopped without
  edits or probes; the lead moved this worker's session and attached its branch.
  The repeated native shell proof (no artificial `cd`/`workdir`) then showed
  the worktree below, HEAD `517b0acc9c3e7c353b49d8dd2310bd0c518370f6`,
  branch `ensemble-crisp-comet-mission-60502567aec6ce4f#8ws0e8-sp4-switchmodel`,
  and clean Git status. Lead approval and the exclusive server-mutation lease
  preceded all writes and the native campaign.
- Worktree: `C:/Users/djden/.local/share/opencode/worktree/84ea7a/ensemble-crisp-comet-mission-60502567aec6ce4f#8ws0e8-sp4-switchmodel`.
- Public CLI executable:
  `C:/Users/djden/AppData/Roaming/ai.opencode.desktop/cli/2.0.32-x64/opencode-cli.exe`.
  `/api/info` reported version `2.0.32`, PID `51636`, URL
  `http://127.0.0.1:41037`. CLI discovery/authentication was used, not a new
  unauthenticated transport. This campaign uses the host's public HTTP contract
  through `api`, not the checkout's SDK adapter.
- Public `/openapi.json` described `session.create`, `session.get`, and
  `session.switchModel` (`POST /api/session/{sessionID}/model`). Its body is
  `{model: Model.Ref}`; `id`/`providerID` are required strings and `variant` is
  an optional string. No catalogue-membership enum was present.
- `/api/model` was recorded, not invoked. IDs were the exact SP-3/lead-approved
  `openai/gpt-6.1-sol` and `opencode-go/gpt-6-luna`, with no label translation.
- Campaign: **2026-10-19T16:40:36.172Z–16:40:40.446Z**, 26 CLI API requests,
  **one scratch created and seven switch attempts**. Each subprocess has a
  15-second timeout; the campaign checks a five-minute budget before requests.
  The sequence is sequential, below the approved 4-session/24-switch limits.
- SP-2's installed bundle is distinct from this checkout. No plugin reload,
  package installation, live DB access, global configuration, profile, hook or
  application source modification was performed. The authorized ignored
  `node_modules` junction points to the canonical checkout's existing packages.
  No shared package was modified.

## Exact bodies and native readbacks

The initial scratch GET had **no `model` field**. GET was performed before and
after every switch, including after the schema error. Successful switch CLI
responses were empty (recorded as `response: null`), not model readbacks.

1. Sent `{"model":{"providerID":"openai","id":"gpt-6.1-sol","variant":"low"}}`.
   After: `{"id":"gpt-6.1-sol","providerID":"openai","variant":"low"}`.
2. Sent `{"model":{"providerID":"openai","id":"gpt-6.1-sol","variant":"xhigh"}}`.
   Before: Sol `low`. After: Sol `xhigh`.
3. Sent `{"model":{"providerID":"openai","id":"gpt-6.1-sol"}}`.
   Before: Sol `xhigh`. After:
   `{"id":"gpt-6.1-sol","providerID":"openai","variant":"default"}`.
4. Sent `{"model":{"providerID":"opencode-go","id":"gpt-6-luna"}}`.
   Before: Sol `default`. After:
   `{"id":"gpt-6-luna","providerID":"opencode-go","variant":"default"}`.
5. Sent `{"model":{"providerID":"openai","id":"gpt-6.1-sol","variant":"SP4-unknown-variant"}}`.
   Before: Luna `default`. After: Sol `SP4-unknown-variant`; CLI exit 0.
   This deliberately invalid catalogue string was used only as scratch state,
   never to execute a model.
6. Sent `{"model":{"providerID":"openai","id":"gpt-6.1-sol","variant":42}}`.
   CLI exit 1, stderr `HTTP 400 Bad Request`. After: Sol
   `SP4-unknown-variant`, unchanged. The CLI did not expose a structured error
   body in this observation; none is inferred.
7. Sent `{"model":{"providerID":"openai","id":"gpt-6.1-sol","variant":"low"}}`.
   After: Sol `low`. This restores only the owned scratch to a known state.

For steps 3 and 4 the recorded serialized body truly lacks the property. It
does not send `null`, `""`, `"none"` or `"default"` on the wire. `"default"`
is the **server's readback**, not a native variant invented by this harness.
The recorded Sol catalogue lists `low`, `medium`, `high`, `xhigh`, `max`:
`default` is **not** a listed Sol variant. Stored state and catalogue membership
are distinct observations, neither of which proves an executed provider effort.

## Profile interaction is not established

`GET /api/agent?location[directory]=<encoded worktree>` returned 13 agents:
`build`, `general`, `explore`, `compaction`, `title`, `summary`, `plan`,
`architect`, `code-reviewer`, `dev-reader`, `implementer`, `orchestrator`, `qa`.
None exposed a `model` with a variant. Every exposed `request` had empty
`settings`, `headers`, and `body`. Thus no existing profile bearing demonstrable
effort was available in this location's public view. No profile was fabricated,
modified, or selected to manufacture the missing proof. Inheritance from a
profile with an explicit effort remains **unobserved** by that first campaign.

## Profile effort follow-up

On 2026-10-19 at 18:09–18:10 UTC, the lead created a scratch profile only in
`%TEMP%/opencode-sp4-profile-probe`, outside this repository and outside the
global OpenCode configuration. Its public readback was `openai/gpt-6.1-sol`
with variant `xhigh`. The canonical project still listed its original 13 agents
and did not gain `sp4-effort`. No prompt was sent. The scratch session is
`ses_eaaa51494ffeWTkUEB6fA8XDgh`.

- Creating the session with that agent stored no `model`. The profile effort
  was not copied at creation.
- `switchAgent` to `sp4-effort` did not apply `xhigh`. After an explicit switch
  had stored `xhigh`, switching the agent again left `xhigh` unchanged.
- `switchModel` with the same model and no `variant` property then stored
  `variant: "default"`. The profile definition still read back as `xhigh`.

Omitting `variant` therefore clears the session effort and does not fall back
to the active profile's effort. This is session state, not an executed provider
request. The profile's own deny-all frontmatter was not the effective ruleset:
the host still exposed its default allow rules, so this profile was not used
for any tool execution.

## Retention and raw evidence

Owned scratch: **`ses_eaaf6ac4fffehftstPRMevylqC`**.
Title: `SP-4 retained-not-prompted 2026-10-19T16:40:36.916Z`.

Lifecycle labels in the manifest are `retained-not-prompted` and
`cleanup-not-supported`, not native lifecycle claims. Native initial `time`
exposed only `created` and `updated`; no `idle` or `archived` timestamp was
observed there. No `session.remove`, `session.abort`, archive operation, or
cleanup mutation was performed. The worker and lead model state was never a
mutation target. The mutation lease was released after this campaign.

Ignored local evidence directory (relative to the worktree):
`.opencode/sp4-20261019T-switch/`.

- `manifest.json`: owner, executable, directory, scratch ID, actual request
  bodies, timestamped CLI stdout/stderr/exit codes, raw API responses and
  observations. SHA256:
  `1ceeeaaafedded11dd759bcf4bc1e4b0856dab1f480ca711e4a828bcfabf368f`.
- `gate.log`: complete combined checkout gate output; it remains ignored.

Durable, tracked evidence: **[native-evidence.json](native-evidence.json)**.
This is an offline publication of the final manifest, not another native run.
Its `manifest` preserves ownership/session ID, actual bodies of all seven
switches, all before/after readbacks including the 400, profile metadata,
public schema and catalogue observations. Only the catalogue response's
nonempty model `headers` fields were removed conservatively: some carried
account/organization identifiers. No original header value is included in the
removal log. There were no detected authorization/API-key/password/private-key
values in the publication after key/pattern and parsed-response review; public
schema definitions mentioning credential/token fields are definitions, not
actual credentials, and session `tokens` are usage counters.

- Original SHA256 was reverified unchanged:
  `1ceeeaaafedded11dd759bcf4bc1e4b0856dab1f480ca711e4a828bcfabf368f`.
- Published SHA256 (624,463 bytes):
  `0f1216181b4042e1d9ef5d5d57a51ef980ec622ad1535d4e693feb22749d259e`.
- The wrapper's `publication.removedPaths` enumerates all **73** removed paths
  as `/manifest/requests/3/stdout(JSON)/data/<index>/headers`; `stdout(JSON)`
  means a path inside the parsed JSON string. `publication.sourceSha256`
  identifies the original. The published hash differs because of these
  removals, reserialization of that one JSON-string response, and the wrapper.
- Offline structural comparison confirmed all manifest fields unchanged except
  those headers and that response's serialization. Sensitive account/org header
  values were also checked not to remain elsewhere in the publication.
- At documentary consolidation, ignored originals remained in the author's
  worktree. The lead subsequently verified both hashes and compared the
  structures before shutdown: only the 73 nonempty headers differed, and both
  identified private header values were absent from the publication. The branch
  was preserved before shutdown and then integrated with `team_merge`. Git does
  not preserve ignored originals; the tracked expurgated proof is the durable
  evidence. No native call or new campaign accompanied consolidation/integration.

## Reproduction and verification

Importing `eval/native-switch-model.ts` has no network side effects. The following
CLI invocation is historical, from the author runner preserved at
`f7798a39d3c300c02f7eac9e2759de13eb8ac11a`; its preconditions were human-verified,
not all enforced by that runner. It is **not** the corrected runner's interface.

```powershell
bun test test/native-switch-model.test.ts
bun eval/native-switch-model.ts --live <absolute-CLI-path> <owned-worktree> <ignored-manifest-path>
bun x biome check --config-path=docs/plans/SP-4/biome.json eval/native-switch-model.ts test/native-switch-model.test.ts
bun run typecheck && bun test && bun run build
```

- RED: four tests compiled and failed on missing observations/read ordering,
  not missing imports or compilation errors (exit 1, 0 pass / 4 fail).
- GREEN: same tests passed (exit 0, 4 pass / 0 fail). Coverage checks explicit
  native strings, absent variant serialization, before/after ordering, error
  readback, absent fields and no fabricated rejection of unknown variants.
- Biome targeted both files using the scoped configuration here (the root
  configuration excludes `eval/`); exit 0. Formatting changed no behavior.
- Full worktree gate: **exit 0**, TypeScript passed, **1306 tests passed /
  0 failed** across 74 files (44,731 assertions), build passed. The imported
  harness is typechecked through the included test file. Bun `1.4.2`.
- After documentary evidence consolidation, the identical full gate was rerun:
  **exit 0**, typecheck passed, **1306 pass / 0 fail**, 44,731 assertions across
  74 files, build bundled 336 modules. Ignored log:
  `.opencode/sp4-20261019T-switch/gate-documentary.log`. No live campaign rerun.
- This is a checkout gate, not installed-bundle parity or an inference test.
  Independent review and integrated G0 validation remain the lead's decision.

## Consequences for L2 / L5 (recommendations, not changes)

- Do not rely on omission to preserve the prior explicit effort. On this host,
  omission selects stored `default`, even for the same provider/model.
- When policy requires an explicit variant, validate exact provider/model
  catalogue membership, send it explicitly, and read back the native state.
  API success alone accepted an unknown variant here.
- Distinguish requested variant, native stored variant, profile/request
  settings and executed effort. Do not translate stored `default` into a
  provider-specific effort or equate it with policy `none`.
- Recovery/retry logic should preserve its intended explicit selection and
  inspect post-error state; this observed schema error left state unchanged,
  but other failures and profile precedence were not exercised. No generalized
  atomicity or provider behavior guarantee follows from this single campaign.

## Independent review and offline runner corrections

Reviewer `sp4-review`, candidate `result_mvfippeq_003q_ibf7ov`, independently
confirmed the published hash, 73 unique removed paths, request/observation
alignment, omission/default, unknown-string acceptance, the 400/readback and
final Low state. It did not compare the private original itself or execute the
gate. It found two P1 and two P2 runner issues: implicit CLI startup/unlocked
host, unenforced root/output/approval with overwrite risk, POST evidence lost
on failed readback, and restoration missing from `finally`.

Architect contract `runner-contract.md` was persisted before offline changes.
The lead kept a fixed experiment rather than a generic campaign framework:

- The public exported runner itself requires `--live`, process-scoped
  `ENSEMBLE_SP4_APPROVED=1`, `--expected-head`, `--expected-branch`,
  `--service-url`, `--service-pid` and `--output`. Authentication, if needed,
  comes only from process-scoped `ENSEMBLE_SP4_PASSWORD` and is never included
  in the audit. There is no CLI/API discovery, service startup or new package.
- Git/FS I/O supplies facts, not a preflight verdict. The runner checks real cwd,
  registered linked worktree, exact branch/HEAD, real `.opencode` confinement,
  and new untracked/ignored output. Output must match
  `.opencode/sp4-<new-run>/manifest.json`. A new directory plus `open(...,"wx")`
  reserves it exclusively; checkpoints use that acquired file handle only.
- HTTP uses the explicit loopback endpoint; `/api/info` version 2.0.32/PID must
  match before creation. Requests impose manual redirects and reject 3xx; no
  native service is started. Only fixed read endpoints and the created scratch
  session/model endpoints are permitted. Negative variants still reach the
  scratch API rather than being rejected locally as catalogue errors.
- GET-before, POST and one GET-after have independent result/error fields.
  A failed readback retains the POST response without a hidden retry; a failed
  GET-before prevents that scenario's POST.
- Six scenarios are followed by a `finally` recovery of the verified owned
  scratch to Sol `low` and one recovery read. The created ID is kept before
  checkpointing. Proof failures do not skip recovery. Missing/different state,
  failed target verification, deadline, or evidence errors remain `uncertain`;
  no success is inferred from HTTP alone. Normal requests reserve 15 seconds
  for recovery inside the five-minute budget, with a 5-second HTTP maximum;
  creation/switch attempts are counted before sending (caps 4/24).

A future live run needs a **new explicit lease and approved physical worktree**
with all connection/branch/HEAD arguments. The old invocation above now fails
closed. No corrected runner was executed live. Raw ignored metadata may contain
identifiers: never force-add its output; publish only separately reviewed and
expurgated evidence, as done for the historical campaign.

TDD of the integration corrections: first **4 pass / 12 fail**, with compilable
runner stubs and meaningful guard/readback failures. The first implementation
produced **15 pass / 1 fail**: the remaining assertion incorrectly counted the
read-only `/api/model` catalogue call as a model mutation. Correcting that
assertion to inspect POST mutations yielded **33 pass / 0 fail** across the
SP-1/SP-4 focused regression files (17 + 16 tests), and typecheck passed.
Only I/O facts/effects are faked: tests invoke the real public runner and its
actual guards, never an injectable `preflight` or `safe` verdict.

Two additional recovery edge cases were then written first: a failed recovery
POST must remain uncertain even when the previous model was already Low, and an
exception with an empty message must not become a false success. Both failed
meaningfully (**16 pass / 2 fail**); after correcting success criteria and empty
error messages, the focused regression reported **35 pass / 0 fail** across
SP-1/SP-4 (17 + 18 tests), with typecheck passing. Scoped local Biome checked
the two SP-4 TypeScript files successfully. No network requests were used.

Historical JSON is unchanged. These are offline corrections, not a new native
campaign, proof of profile-effort inheritance, inference or G0 acceptance.
Follow-up independent review and the combined integrated gate remain required;
OQ-103 stays blocking.

### Follow-up review: unknown creation, Windows paths and finalization

Fresh reviewer `sp4-fix-review`, candidate `result_mvfk2763_0040_f81ek3`, found
two further P2s: loss of a creation response incorrectly left `not-created`, and
scratch-location comparison did not reuse admission's Windows path equality.
It also identified a certain finalization divergence: a checkpoint could claim
`verified` before file close, although close failure made the return uncertain.

The lead corrected these offline with tests first (**18 pass / 4 fail**), then
**39 pass / 0 fail** across the SP-1/SP-4 focused files and passing typecheck:

- A dispatched creation without a usable returned ID is now `uncertain` with
  an explicit unknown-creation message. No retry, guessed ID, replacement or
  model mutation follows. Tests simulate the server-side creation followed by
  response loss, a missing ID and an invalid ID.
- Admission and scratch verification now share path equality. A Windows path
  differing only in separators/casing is accepted; a different root is refused
  before model mutation.
- The saved file is a **nonterminal checkpoint**: `finalization: "pending-close"`,
  recovery never `verified`. An observed Low readback remains a distinct fact
  in `restoration.stateVerified`. Only the post-close returned result (and CLI
  summary) can attest `finalization: "closed"` and verified recovery. Failed
  close returns uncertainty and cannot leave a standalone checkpoint claiming
  terminal success. A checkpoint alone is not a completion attestation. This
  deliberately avoids claiming a post-close write or crash-safe/fsynced storage.

Tests cover both close failure and successful post-close return, in addition to
the final-checkpoint failure. The historical native JSON remains unchanged and
no live correction campaign was run. Follow-up review and a fresh combined gate
are still required after these code changes.

Candidate `result_mvfk5vke_0045_ezqfhn` confirmed those three corrections but
found a residual P2: intermediate post-creation checkpoints still carried the
initial `not-created` value. The runner now marks uncertainty immediately when
counting a creation attempt, before dispatch or any later checkpoint. A test
checks **every** snapshot for normal creation, lost response and missing ID,
not only the final result. RED was **22 pass / 1 fail**; after the one-line state
transition, focused SP-1/SP-4 regression was **40 pass / 0 fail**, with typecheck
and scoped local Biome passing. No new native call was performed.

## Combined integrated checkout gate

After integrating the historical artifacts and offline runner corrections, the
lead executed `bun run typecheck && bun test && bun run build` on `main`:
2026-10-19 17:52:59.817–17:53:29.235 UTC, **exit 0**. Typecheck passed;
**1337 tests passed, 0 failed**, across 75 files; build bundled 336 modules into
`dist/index.js` (1.30 MB). Full local log:
`C:/Users/djden/AppData/Local/Temp/opencode/ensemble-sp4-integrated-gate-2026-10-19T17-52-59-817Z.log`.

The fresh follow-up review was still running at this gate. This is a checkout
verification, not acceptance of SP-4/G0 or execution of the corrected runner
against a native service. Only this result note was added after the command;
any subsequent code correction requires a new full gate.

After the unknown-creation, Windows-equality and closure corrections, the lead
reran the exact same full gate on the integrated tree at
2026-10-19 17:57:58.192–17:58:28.246 UTC: **exit 0**, typecheck passed,
**1341 tests passed, 0 failed** across 75 files, and the build again bundled
336 modules into `dist/index.js` (1.30 MB). Log:
`C:/Users/djden/AppData/Local/Temp/opencode/ensemble-sp4-final-integrated-gate-2026-10-19T17-57-58-192Z.log`.
Only this gate note was added afterward; follow-up review was still pending.

After the last intermediate-checkpoint correction, the exact full gate passed
again at 2026-10-19 17:59:49.210–18:00:13.126 UTC: **exit 0**, typecheck passed,
**1342 tests passed, 0 failed** across 75 files; 336 modules built successfully
into `dist/index.js` (1.30 MB). Log:
`C:/Users/djden/AppData/Local/Temp/opencode/ensemble-sp4-snapshot-final-gate-2026-10-19T17-59-49-210Z.log`.
The runner and test hashes were identical before/after this command; only this
documentation was updated afterward. Final review confirmation remains separate
from that gate and does not resolve the spike's missing native evidence.

Final candidate `result_mvfk7n4i_004a_fq01rr` independently confirmed the residual
checkpoint correction and its non-vacuous all-snapshot tests, with **no further
confirmed defect**. Its earlier checks of unknown creation, Windows paths and
nonterminal finalization remain valid. The reviewer did not run commands or
repeat a campaign; the lead's gate above supplies the integrated verification.

The artifacts are receivable as a **partial** Phase 0 result. SP-4 itself remains
**not accepted**, because no profile carrying a reasoning variant was observed
and no executed request's effort was measured. SP-1's runtime hook/tool/Code Mode
question OQ-103 is also unresolved; G0 and Phase 1 remain blocked. These offline
runner fixes do not authorize a new campaign, profile/config change, plugin
replacement or live-database migration.
