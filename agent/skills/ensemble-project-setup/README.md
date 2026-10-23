# Ensemble Project Setup

Interactive onboarding for an existing OpenCode project: inspect its agents/configuration, infer a coordination policy, propose a small diff, apply approved changes, and verify. It preserves existing profiles, permissions, models, and user edits by default. Repeating setup can legitimately produce no changes.

Creating or adapting agents also proposes an explicit principal business category
in Ensemble's `.opencode/ensemble.json` (`businessProfiles.byAgent`). This works
as declarative metadata even before the harness uses categories. Existing and
inherited associations are preserved; unclear roles are discussed, never inferred
automatically from names. No permission, model or lead authority follows from a
category. The selected plugin must support this configuration before it is applied.

## Use

In a project where this skill is available:

```text
@ensemble-project-setup Integrate Ensemble into this project. Analyze our
existing agents and instructions, then propose the smallest useful changes
for approval. Keep team composition flexible.
```

To verify an existing integration:

```text
@ensemble-project-setup Check whether our current Ensemble setup still matches
our project instructions. Preserve customizations and propose only necessary changes.
```

To include categorization of existing project agents:

```text
@ensemble-project-setup Propose business categories for our declared agents.
Preserve existing associations, native names, models and permissions. Show the
project ensemble.json diff for approval; do not change global configuration.
```

The Ensemble repository exposes `skills/` through its root `opencode.json`, so both `ensemble-project-setup` and `opencode-ensemble` are discoverable from its root. For another project, expose that verified shared directory in V2's `skills` configuration or copy this whole skill directory into `.opencode/skills/ensemble-project-setup/`.

This skill does not replace the runtime plugin or the operational `opencode-ensemble` skill. It helps configure a compatible installation and project policy. It can produce a filesystem proposal without native server access; runtime checks remain explicitly unverified until performed.

## Contents

- `SKILL.md`: the interactive workflow and mutation boundaries.
- `references/inventory.md`: configuration and agent discovery, evidence, and inference.
- `references/patch-recipes.md`: minimal configuration/policy/profile changes and repeat-run rules.
- `references/validation.md`: verification and representative scenarios.
- `evals/`: proposal, approved-application, and no-op fixtures for behavioral evaluation.

The canonical source is `skills/ensemble-project-setup/`; `agent/skills/ensemble-project-setup/` is its synchronized distribution copy. Expose only one copy to discovery.
