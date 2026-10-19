# SP-4 — Offline runner-correction contract

Status: **Proposed — selected as a bounded integration brief by the lead**.
This does not accept SP-4, its profile-effort question, OQ-103 or G0.

Architect `sp4-contract` returned candidate `result_mvfj705d_003v_05mr48` for
task `task_mvfj2t51_003t_yyk8ti`. It inspected the integrated source in read-only
mode, without commands, native requests, edits or tests. It could not access the
separate task body/review report through its allowed readers. The lead compared
the proposal against review `result_mvfippeq_003q_ibf7ov`: all four findings
correspond to the code and the brief below.

## Scope and inputs

Only `eval/native-switch-model.ts`, `test/native-switch-model.test.ts` and
`docs/plans/SP-4/` may change. No production code, hooks, tool count, profiles,
configuration, model routing or runtime dependencies change. No live campaign
is authorized by this correction.

Keep a fixed experiment, not a general campaign framework. The public runner
takes process arguments/environment/cwd and injectable I/O facts/effects.
It must execute its own guards even when imported and called directly.
There is no injectable `preflight`, `safe` verdict or prevalidated transport.

Pure SP-1 helpers `validateNativeEndpoint`, `assertNativeHostIdentity` and
`parsePermissionHttpResponse` can be reused. Do not reuse SP-1's worktree
validator or broaden its permission-endpoint transport.

## Admission and connection

Before HTTP, require `--live`, process-scoped approval, an explicitly approved
branch and full HEAD, a registered linked worktree at the real cwd, and a new,
untracked, ignored output under `.opencode/sp4-*/manifest.json`.
Reject traversal, canonical/nonmatching roots, symlink escape, existing output
or output directory. Acquire the output exclusively; all checkpoints use only
that acquired output.

Use an explicit loopback endpoint/PID and optional process authentication.
Validate `/api/info` version 2.0.32 and PID before every possible creation path.
No CLI discovery, `ensure`, private registration parser or service startup.
HTTP redirects must not be followed.

## Observation and recovery

For each scenario, record separately the GET before, switch result/error, and
one GET after. A failed GET before prevents that scenario's POST. A failed GET
after never discards the POST response or triggers an implicit second GET.

Keep six experimental switch bodies; move restoration to `finally`. Record a
usable created scratch ID before checkpointing. Once its target is verified,
attempt restoration only of that scratch to `openai/gpt-6.1-sol` / `low`, then
perform one explicitly labeled recovery readback. Evidence failure must not
skip this bounded recovery attempt. No creation retry, replacement scratch,
abort, removal, prompt, inference or worker/lead model mutation.

Recovery states are `verified`, `uncertain`, `not-created`; verification requires
the expected native readback and a trustworthy evidence outcome. Failures,
missing/different readbacks, exhausted budgets or failed final evidence must
not be reported as successful recovery. Preserve the distinct observed facts.

Follow-up review clarified two edges. `not-created` is valid only when no
creation was dispatched; a lost/malformed creation response is `uncertain`,
without any retry, replacement scratch or guessed session ID. Scratch location
uses the same path equality as admission (including Windows casing).

The evidence file is explicitly a **nonterminal checkpoint**, not a standalone
completion attestation. Every saved snapshot has `finalization: "pending-close"`
and cannot mark recovery `verified`. It may record the separate native fact
`restoration.stateVerified: true`. Only the result returned after a successful
final checkpoint and file close may set `finalization: "closed"` and recovery
`verified`; the CLI prints that post-close summary. Failed evidence/close keeps
the returned result `uncertain`. A checkpoint alone, even with a final readback,
does not attest successful completion and must not be consumed as such. There
is no claim of crash-safe/fsynced durability or a post-close write to the file.

Reserve time for recovery within 5 minutes; at most 4 creations and 24 switch
attempts, counted before sending. No POST after the deadline.

## Required RED cases and verification

- Invoke the exported runner directly with each invalid admission fact; no HTTP.
- Existing/unignored/tracked output, creation collision, symlink escape, wrong
  HEAD/branch/root or unregistered/canonical tree must fail closed.
- Missing/forbidden endpoint, wrong PID/version, HTTP failure and 307/308 must
  produce no creation, fallback or service startup.
- POST succeeds then GET fails; POST rejects then GET fails; GET before fails:
  preserve results and assert exact call counts, without hidden read retries.
- Checkpoint failure after creation/switch, recovery POST failure, absent or
  different recovery readback and failed final evidence: only the owned scratch
  may be targeted, and uncertainty must remain visible.
- Keep exact omission and unknown-string acceptance tests; intentionally negative
  variants must reach the scratch API rather than being rejected as catalogue
  validation by the fixture.

Tests may fake filesystem/Git/HTTP/clock I/O, not policy decisions. Confirm RED
with compilable stubs, GREEN, focused SP-1/SP-4 regressions, independent review,
then `bun run typecheck && bun test && bun run build` on the integrated tree.
Historical native evidence remains unchanged; no new native result is implied.
