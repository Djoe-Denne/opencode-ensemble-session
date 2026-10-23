# Minimal Patch Recipes

Adapt these to the observed project and approved proposal. A recipe is not authorization to write files or change permissions.

## Make a Compatible Skill Discoverable

Prefer a correct existing source. If a compatible local plugin/skill checkout is selected, these are V2 configuration fragments to merge with current settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/absolute/path/to/opencode-ensemble-session" }],
  "skills": ["/absolute/path/to/opencode-ensemble-session/skills"]
}
```

Replace paths with verified locations before applying; never commit a placeholder as a working installation. Add only the missing field/entry. Existing compatible plugin configuration need not change just to expose a skill. Relative `skills` paths resolve from the active working directory, so do not assume they are relative to the config file or work from every nested workspace.

For a portable project-local copy, copy the selected **whole** `opencode-ensemble` skill directory into `.opencode/skills/opencode-ensemble/`, including its references. The setup skill can be made available similarly when requested. Compare any existing installation before copying; identical content needs no rewrite. Shared-source versus vendored-copy preference belongs in the approved proposal.

Keep source definitions unambiguous: standard local/global discovery may already provide the same ID even when the `skills` array is absent. Do not add both a vendored skill and an explicit shared source unless the developer deliberately chooses and understands the precedence.

The plugin exposes runtime tools; skills supply instructions. Installing either does not prove the other is active. Continuity-capable forks may need explicit same-server HTTP configuration when the host omits native fork. Refer to `opencode-ensemble`'s continuity guide and the verified host's API; use server-side environment variables for authentication, never a secret value in project policy or agent text.

## A Project Policy Block

When no equivalent policy exists, propose this block in `AGENTS.md`, adapted to the project's language and delegation constraints:

```markdown
<!-- ensemble-project-setup:policy:v1 -->
## Ensemble coordination

For missions that benefit from a team, load the `opencode-ensemble` skill
before coordinating work. Work directly when one agent is sufficient.

The lead chooses profiles, team size, dependencies, and context transitions
for the mission. No role sequence is mandatory.

Each delegated mission needs a bounded scope, a deliverable, and verification
criteria. The lead owns integration and the project's final verification.

Keep reusable protocol in the skill, durable expertise in native profiles,
and current task ownership in spawn prompts. Follow this project's existing
delegation, permission, model, and verification policies.
<!-- /ensemble-project-setup:policy -->
```

If the project already has equivalent unmarked guidance, retain it without adding this block. If a change is useful, propose a surgical edit to the existing paragraph. Preserve an explicit user-approval requirement for delegation rather than replacing it with autonomous team creation.

## An Optional Agent Reminder

Only add this to an existing profile if the developer approves its purpose, and equivalent text is absent:

```markdown
<!-- ensemble-project-setup:coordination:v1 -->
Follow the project's AGENTS.md. When asked to coordinate an Ensemble team,
load `opencode-ensemble`. When participating as a member, follow the team
identity, task scope, and reporting instructions supplied by the plugin.
<!-- /ensemble-project-setup:coordination -->
```

This is a body-only addition. Preserve the profile ID, frontmatter, model, permissions, mode, expertise, and existing system instructions. It grants neither tools nor lead rights. Most member profiles can rely on `AGENTS.md` and the plugin's injected instructions without any reminder.

## Teammate permission block

Approval is mandatory before this block is written. It is a distinct change from the coordination reminder above. Use the collaborator or restrictive skeleton in [teammate-profile.md](teammate-profile.md). Run `bun scripts/lint-agent-profiles.ts` on the agent directory and show the report. Do not apply the diff unless the developer approves that exact permission change.

If a developer specifically wants a changed mode/model/permission, make that a distinct proposed change with its rationale. For example, a subagent-only profile cannot simply be assumed suitable for a session handoff. A profile called reviewer is not automatically read-only; a read-only body and write-capable native permissions are an inconsistency to discuss, not silently repair.

## Business Profile Associations

Agent creation/adaptation includes a category proposal, even if the harness does
not consume it yet. First verify the selected Ensemble plugin supports
`businessProfiles`; if unknown/unsupported, leave target files unchanged for this
part and explain the compatibility decision needed. Do not silently upgrade.

The initial categories are `supervisor`, `pm`, `architect`, `developer`, `qa`,
`reviewer`, `researcher`, and `documentalist`. They describe mission supervision,
requirements/priorities, design/contracts, implementation/tests, acceptance and
regressions, critical review, sourced research, and knowledge maintenance,
respectively. They are not a required team topology or eight agents to create.

Propose one principal category per exact native agent ID, based on its actual
responsibilities. Several agents may share a category. Preserve an existing
explicit mapping even if its name suggests another role. For a genuinely mixed
or unclear specialty, ask one grouped consequential question (after the setup
report), or retain it as unresolved in a proposal-only run. Do not silently assign
a default or overwrite the user's category. Approval of a new agent alone does
not approve an unseen categorization; include both in the same concrete proposal.

Merge only the approved entries into the project's `.opencode/ensemble.json`:

```json
{
  "businessProfiles": {
    "extensions": {
      "security-reviewer": { "description": "Review security boundaries and threats" }
    },
    "byAgent": {
      "api-specialist": "developer",
      "docs-reviewer": "reviewer",
      "security-reader": "security-reviewer"
    }
  }
}
```

These are examples, not instructions to create agents or infer roles from names.
Only declare a custom extension for an approved need; reuse existing ones.
Extensions use lower-kebab-case IDs and non-empty descriptions, cannot replace
the eight initial IDs, and cannot carry execution settings. Keep all unrelated
config and native agent permissions, models, modes and bodies unchanged unless
those separate edits were approved. Do not invent a `businessProfile` field in
agent frontmatter, `opencode.json` or an extra setup-state file.

Global then project maps merge per entry; the project replaces matching keys.
Reuse an identical inherited mapping without adding a local duplicate. An empty
map does not delete inherited entries. Validate the final references after
merging, while rejecting malformed explicit layers; unknown references must
produce a diagnostic, not silently revive an old mapping. Use the selected
plugin's existing validator/pure helper when available; syntax alone does not
validate the business contract. Keep project writes local: overriding a global
mapping needs an explicit project decision, not an edit to the global file.

Declaration, disk presence and native availability are independent. Report the
exact native ID, chosen category, origin and validation evidence; never claim a
native agent exists or is available because a mapping was written. No model
routing, permissions, lead authority, direct admission or automatic QA pipeline
is enabled by a category, including supervisor/researcher/documentalist. Missing
mappings preserve behavior, and an identical second setup run is a no-op.

## Approval and Repeat Runs

Before applying, show a compact diff or exact per-file changes. Offer apply, revise, or diagnosis only through the question tool when available. If this same proposal was already approved and its target files are unchanged, proceed without asking again.

For every repeat run:

1. Re-read the current config, instructions, profile bodies, and relevant source resolution.
2. Compare intended meaning as well as marker/content presence. Normalize equivalent paths only for comparison; preserve the user's spelling in files.
3. Keep identical or semantically equivalent configuration and policy untouched.
4. Update a single existing setup block only through an approved focused patch. Do not remove user customization just because it sits inside a marker.
5. If a marker is duplicated, incomplete, or conflicts with another policy, show the ambiguity and propose the smallest reconciliation.

Do not create an extra setup-state file by default. The chosen project policy, configuration, optional markers, and the final change report are enough for another run to inspect the current state.
