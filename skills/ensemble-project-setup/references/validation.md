# Validation and Scenarios

## Validate What Was Actually Changed

- Confirm every write is within the approved project/files and matches the approved proposal. Compare against the starting state, including pre-existing edits.
- Parse changed JSON/JSONC and native agent frontmatter with an existing appropriate parser or native validation capability. Preserve JSONC comments; JSON.parse is not a JSONC validator. Do not use the potentially legacy schema at the editor `$schema` URL to infer V2 fields; use current V2 docs and the installed host's contract.
- Check configured local source paths, copied skill references, and duplicate IDs. An inaccessible path is not a working installation. A shared absolute path is machine-specific; a relative skill source must resolve from the intended active working directory.
- Verify that unapproved agent frontmatter fields, permissions, models, native modes, and unrelated instruction content are unchanged. New coordination text should not grant lead rights or imply automatic model changes on handoff.
- Check `AGENTS.md` policy for consistency with existing delegation and verification requirements. Required roles or a fixed team size should come from explicit project policy, not a template.
- Inspect ignored status for new files intended to be shared. Report it and propose a narrow ignore-rule change if wanted; do not silently change repository ignore policy.
- Re-evaluate the desired state after applying: no duplicate skill paths, policy blocks, agent reminders, or unnecessary profiles should be proposed by a second run.

Use the active skill/agent/tool catalogs when available to verify discovery after the host's normal reload. A valid file on disk does not prove runtime activation. If runtime access or reload is unavailable, report exactly what was checked and what remains unverified. Do not restart a service or run model-backed team operations merely to make validation look complete.

Run the repository's required checks appropriate to the files changed. For the Ensemble repository itself, the required checks are `bun run typecheck`, `bun test`, and `bun run build`.

## Representative Scenarios

### Diagnosis without approval

A project has custom API and read-only documentation profiles, JSONC comments, a configured plugin, and a policy requiring explicit approval before delegation. The user asks for a proposal.

Expected: inspect evidence, preserve the delegation rule, propose only missing integration, explain uncertain runtime status, request a decision, and leave all target files untouched. Do not automatically create an orchestrator/architect/implementer set.

### Apply a bounded approved proposal

The developer has approved a precise skill-source addition, one project policy block, and a short body-only reminder in one existing profile.

Expected: apply only those changes, preserve comments/frontmatter/models/permissions, retain unrelated sources and user text, and leave other profiles untouched. Do not ask again for the same approval or treat it as permission to run a live team test.

### Rerun on an already integrated project

The operational skill already resolves through an existing source; a customized policy block preserves approval-before-delegation, and agents already follow `AGENTS.md`.

Expected: report no necessary modifications, preserve user customization even inside setup markers, and add neither another skill source nor redundant per-agent reminders.

### A conflicting profile

A native `mode: subagent` profile with a fixed model is requested as a session-level handoff target, or a purported read-only agent has write-capable permissions.

Expected: identify the exact conflict and ask for a targeted decision. Do not change mode/model/permissions merely to satisfy inferred behavior.

## Final Report Shape

Use concise prose in the developer's language:

```text
Policy: <the confirmed coordination behavior>
Changes: <actual files, or no changes needed>
Verified: <syntax, preservation, links, repeated-state comparison, catalogs actually checked>
Still unverified: <only concrete remaining checks, if any>
Usage: @opencode-ensemble <the next mission>
```

For a proposal-only run, replace the changes/verification claims with the proposed diff and the question needed to proceed. Never report an unapplied proposal as installation completed.
