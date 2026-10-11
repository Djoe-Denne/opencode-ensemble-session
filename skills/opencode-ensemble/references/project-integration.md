# Integrating Ensemble into a Project

Use a discoverable skill plus a short project policy. Add native agent profiles only for specialties the project actually reuses. Team composition and context transitions remain decisions for each mission.

For assisted installation, invoke `@ensemble-project-setup` when that companion skill is installed. It inventories existing agents/configuration, distinguishes inferred preferences from explicit policy, proposes a diff for approval, and applies only the approved changes. This guide remains the manual integration reference. Ordinary team work uses `opencode-ensemble` afterward.

## 1. Make the Matching Plugin and Skill Available

The runtime plugin exposes team tools; the skill teaches how to use them. Loading a skill alone does not install the plugin or grant permissions.

For this local fork, load the plugin from its source directory and expose the canonical skill directory in the target project's OpenCode V2 configuration. Merge these fields with existing settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/absolute/path/to/opencode-ensemble-session" }],
  "skills": ["/absolute/path/to/opencode-ensemble-session/skills"]
}
```

Use the actual absolute path; forward slashes also work in Windows JSON paths. Share this path only where it exists. For a portable project-local skill, copy the **whole** `skills/opencode-ensemble/` directory into the target project's `.opencode/skills/opencode-ensemble/`, including its references. An already installed compatible plugin can keep its existing configuration.

Relative `skills` paths resolve from the active working directory, not from the configuration file. In the Ensemble repository, `opencode.json` uses `./skills` for sessions started at its root. For nested workspaces, use the project-local skill layout or a valid absolute shared path.

Do not assume the upstream released package/skill already contains this local fork's continuity features. Keep the installed plugin and skill versions aligned. Configure the fork's same-server HTTP connection separately when native inheritance needs it; see [context continuity](context-continuity.md).

In V2, only skill ID/name/description are initially advertised. The full body is loaded through the `skill` tool; references are read on demand. A user can explicitly request `@opencode-ensemble` to load it for a mission. Verify that `opencode-ensemble` appears in the skill catalog and the expected `team_*` tools are available after configuration is reloaded.

## 2. Add a Small Project Policy

Put this in the target project's `AGENTS.md`, adapted to its actual verification commands:

```markdown
## Multi-agent coordination

For missions that benefit from a team, load the `opencode-ensemble` skill
before coordinating work. Work directly when coordination adds no value.

The lead chooses profiles, team size, dependencies, and context transitions
for the mission. No role sequence is mandatory.

Each delegated mission needs a bounded scope, a deliverable, and verification
criteria. The lead owns integration and final project verification.

Follow the ownership rules and verification commands in this AGENTS.md.
```

Keep project-specific commands, architecture constraints, and ownership conventions here. Keep the reusable tool protocol in the skill so an update does not require editing every agent definition. A Markdown instruction is guidance; native permissions and Ensemble's lead/member authorization remain the enforcement mechanisms.

## 3. Define Optional Durable Profiles

A profile specifies reusable expertise, methods, output expectations, and native permissions. It does not prescribe which teammates to spawn or how many. Existing native profiles can be sufficient; no new profile is required for Ensemble.

For example, a project that often needs read-only contract review could create `.opencode/agents/contract-reviewer.md`:

```markdown
---
description: Reviews API contracts for compatibility and missing behavioral coverage
mode: all
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
---

Review the assigned contracts for compatibility, edge cases, and observable
behavior. Base findings on files and tests. Prioritize findings by impact and
distinguish verified defects from unresolved questions.

Follow the project's AGENTS.md. When participating in an Ensemble team, use
the team identity and reporting instructions supplied by the plugin.
```

This is a reusable specialty, not a required role. `mode: all` makes the native profile usable as a session profile or native subagent; Ensemble membership still comes from the team tools. For a custom read-only Ensemble member, pass `worktree: false` explicitly. The plugin's automatic read-only worktree shortcut recognizes built-in `explore`/`plan`, not arbitrary profile names.

Use `mode: primary` when a profile is intended only for session-level use. Reserve `mode: subagent` for native subagent-only profiles; prefer `primary`/`all` for handoff targets. Add a configured model only when a stable project preference is useful, remembering that native handoff retains the session's selected model.

A profile frequently used as the team lead may include a short reminder to load this skill before coordination. It need not duplicate all tool signatures or force an explorer/architect/implementer chain. A native subagent and an Ensemble teammate are different mechanisms; subagents beneath an Ensemble member cannot use team tools.

## 4. Supply the Current Mission at Spawn Time

Put changing details into `team_spawn.prompt`: the question or behavior, current file/subsystem ownership, expected result, verification criteria, and coordination points. Choose `context`, `claim_task`, `worktree`, and optional model/plan approval for that mission.

Choose among these independently:

- Parallel independent specialists, each with fresh context.
- Several workers forking directly from useful research.
- A single member handing its session to another specialty.
- Sequential tasks connected by dependencies.
- An independent fresh reviewer after integration.

Read [coordination patterns](coordination-patterns.md) for examples. Combine, shorten, or omit stages according to the actual work.

## Maintaining the Integration

- Update the skill and its references together; installed copies do not synchronize automatically.
- This repository's canonical source is `skills/opencode-ensemble/`. Keep the compatibility/distribution copy under `agent/skills/opencode-ensemble/` synchronized; expose only one copy to a project's skill discovery.
- Keep examples in references. Plugin behavior stays about sessions, permissions, tasks, messages, worktrees, and lifecycle rather than named business roles.
- Verify the project policy selects the skill without forcing teams for small tasks, and that a custom profile can participate without adopting a prescribed workflow.

Official V2 references: [skills](https://opencode.ai/v2/docs/skills/), [project instructions](https://opencode.ai/v2/docs/instructions/), [agent definitions](https://opencode.ai/v2/docs/agents/).
