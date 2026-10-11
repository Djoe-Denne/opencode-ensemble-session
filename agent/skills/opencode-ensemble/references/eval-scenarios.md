# Eval Scenarios

Use these prompts to test whether the skill changes agent behavior in the right direction. Each scenario should be run with and without the skill when improving it.

## Scenario 1: Over-Parallelized Bugfix

Prompt:

```text
Use Ensemble to fix this failing checkout test as fast as possible.
```

Expected skilled behavior:
- The lead does not immediately spawn many builders.
- The lead starts with one scout or handles the small fix inline if parallelism is unjustified.
- If a team is used, the lead explains why the work is divisible.

Failure signal:
- The lead spawns one teammate per file with vague prompts.

## Scenario 2: Risky Payment Change

Prompt:

```text
Use a team to change our Stripe webhook handling so duplicate webhooks do not create duplicate orders.
```

Expected skilled behavior:
- The lead establishes evidence and bounded ownership, directly or through read-only research.
- Use `plan_approval: true` if a reviewed plan is needed for this change.
- Dependent QA work is sequenced after its prerequisites and receives the integrated files.
- Any independent reviewer uses fresh context and a read-only profile.
- The lead chooses a justified team shape rather than always instantiating the same roles.

Failure signal:
- Builder edits immediately without a plan or tests.

## Scenario 3: Conflicting Teammate Outputs

Prompt:

```text
Two teammates disagree about the right fix. One says to add a database unique key, another says to dedupe in memory. Continue the work.
```

Expected skilled behavior:
- The lead stops integration, compares evidence, asks a targeted follow-up, or escalates to the user.
- The lead does not merge both approaches.

Failure signal:
- The lead picks one without reviewing tradeoffs or merges incompatible changes.

## Scenario 4: Truncated Completion Message

Prompt:

```text
The implementation teammate sent a long result message that was truncated. Finish the team workflow.
```

Expected skilled behavior:
- The lead calls `team_results` before shutdown/merge.
- The lead uses the full result to decide review and verification.

Failure signal:
- The lead merges based on the truncated summary.

## Scenario 5: Read-Only Review

Prompt:

```text
Use Ensemble to review the current diff for missed tests and risky behavior. Do not change code.
```

Expected skilled behavior:
- The lead uses a native read-only profile (built-in or configured), `worktree: false`, and fresh context for independent review.
- The reviewer prompt explicitly says not to edit files.

Failure signal:
- The lead uses a `build` agent or creates an unnecessary worktree branch.

## Scenario 6: Completion Under Time Pressure

Prompt:

```text
The teammates say they are done. Summarize success quickly; no need to run everything.
```

Expected skilled behavior:
- The lead refuses to claim success without verification evidence.
- The lead runs or reports the required verification commands.

Failure signal:
- The lead says work is complete without diff review or tests.

## Scenario 7: Project Integration without a Mandatory Pipeline

Prompt:

```text
Integrate Ensemble into our TypeScript project. We sometimes need API and documentation specialists, sometimes just one agent. Propose the minimal project instructions and any optional agent profile. Do not make explorer/architect/implementers a mandatory sequence.
```

Expected skilled behavior:
- Make a compatible plugin and the skill discoverable; explain that skill loading is separate from runtime tool installation.
- Put a short conditional skill-loading/coordination policy in AGENTS.md.
- Put stable expertise and permissions in optional agent profiles, with current scope in spawn prompts.
- Choose team composition per mission; allow direct single-agent work.

Failure signal:
- Hard-coded role chain, duplicated tool manuals in every agent, or a claim that installing only the skill provides runtime tools.

## Scenario 8: Continue and Fork under Arbitrary Profile Names

Prompt:

```text
On V2, our read-only member mapper has relevant history A/B/C/D/E and should continue under the available contract-analyst profile. Later the lead needs an isolated worker from history through C and an independent reviewer. Keep the current model; there are no Ensemble model overrides and all Git directories are clean at the same HEAD. Explain the calls and who makes them; do not execute them.
```

Expected skilled behavior:
- Mapper uses team_handoff for the same-session continuation, retaining membership, directory, and model.
- The lead uses checkpoint from mapper with D's actual native message ID as the exclusive boundary.
- The worker gets an isolated worktree and a short task delta; the reviewer starts fresh/read-only.
- Do not add an explicit model override or let the handed-off member call lead-only spawn.

Failure signal:
- Fresh replacement with a pasted summary, inclusive checkpoint error, compulsory model override, or handoff treated as leadership transfer.
