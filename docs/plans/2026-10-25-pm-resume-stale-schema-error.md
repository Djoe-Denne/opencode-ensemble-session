# PM resume: distinguish current validation from historical errors

## Incident and cause

The ARTIST handover PM was a real native fork. Its first response omitted five
`planning.reason` fields and was correctly rejected. Subsequent schema-valid
blocked responses passed an offline replay of the validator extracted from the
exact installed bundle. Nevertheless, explicit resumes presented those responses
as rejected with the original missing-field errors.

`runBoundedLoop` used the nonempty `errors_json` history to select
`correctionPrompt`, although the persisted candidate had since been replaced by
a valid blocked document. This confused historical correction accounting with
the current candidate's validation state. No native fork or validator relaxation
is needed.

## Correction

- Revalidate the current persisted candidate when entering the loop.
- Use correction wording only when that candidate actually fails validation.
- For a schema-valid paused candidate, supply the normal preparation contract,
  supervisor clarifications and previous candidate with an explicit readiness
  reassessment request, without claiming a new schema rejection.
- Keep `errors_json` and its lifetime correction budget. A new invalid response
  still receives its actual validation error and consumes a correction attempt.
- Do not change schema, persisted mission data, routing, native history or start
  approval. Existing ARTIST rows are not repaired or overwritten.

## Verification

Two regression tests failed before implementation on stale rejection wording,
then passed with the change:

1. Invalid JSON shape → corrected but blocked → incomplete on resume → new schema
   error → ready after correction. Verify the same fork/session, retained notes,
   unchanged historical accounting across valid pauses, no premature import and
   exactly one final import.
2. Invalid shape → valid blocked pause → five more invalid replies on resume.
   Verify the six-failure bound remains enforced and no task is imported.

Focused runtime suite: **81 pass, 0 fail**. Full working-tree gate:
`bun run typecheck`, `bun test`, `bun run build`: **1686 pass, 0 fail**, 98 test
files, 357 bundled modules. No additional model run or ARTIST resume was started.

## Deployment and preservation

Installed package: `20261025-pm-resume-1d9b70b0946b`.
SHA-256: `1d9b70b0946bcf34627b80593a89537f610addf342af6fef6373fcb1b787aec8`.
Public plugin discovery confirmed active status in ARTIST and the plugin project.
Activation used ordinary config watching, not service restart or location eviction.

A coherent SQLite/config backup was verified before activation. Schema remains
26 and integrity is `ok`. ARTIST team, mission policy, tasks, members, preparation
run and import rows were compared unchanged. Session identities, models,
permissions, outcomes and idle timestamps were preserved, with no new assistant
generation. The host refreshed only each session's `time.updated` timestamp.
Unrelated global configuration is unchanged after reversing the two package and
skill-path substitutions.

Preexisting 40000-character input-limit changes were already deployed in the
previous package. The user subsequently requested committing all current project
changes, so those changes and their documentation are included with this fix.
Temporary ignored evidence and deployment scripts stay outside Git. No Docker
resources were created.

The current ARTIST preparation remains blocked; deployment alone does not resume
it or erase the PM's latest request for clarification. A subsequent explicit
resume will use the corrected wording and re-evaluate current readiness.
