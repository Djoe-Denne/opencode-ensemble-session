# Inventory and Inference

## Establish Scope

Record the requested project root, active working directory, and intended write scope. Consult its instructions before choosing search tools or commands. Check existing edits so the final diff can be attributed to this setup rather than unrelated work.

Inspect only configuration, agent definitions, and the small amount of project documentation needed to understand coordination and verification. Full codebase indexing or an architecture audit is not necessary for installation.

## Configuration and Discovery

Inspect project `opencode.json`/`opencode.jsonc` and `.opencode/opencode.json`/`.jsonc`, plus relevant ancestor/global configuration that contributes to the current location. Read only the fields needed for this task and do not reproduce secret values.

OpenCode V2 discovers configuration through ancestors and supports both direct and `.opencode` files; precedence and combined skill sources affect the result. Consult the installed host's public resolved catalog when available, or the current official V2 docs when merge details matter. A locally present file is not proof that its definitions win precedence.

Check:

- `plugins`: is Ensemble already configured, and from which source/version? A local fork and a published release may have different capabilities.
- `skills`: does `opencode-ensemble` resolve from one intended source? Include standard local/global skill discovery, not just explicit paths.
- `agents`: are profiles inline, Markdown-based, inherited, or defined more than once?
- Agent modes, model preferences, permission rules, and any configured default agent that affect the proposed uses.
- Actual `team_*` and skill catalog entries, if exposed by the current host. Discover public tool/API signatures before calling them. Do not rely on internal OpenCode APIs or guess an endpoint.

Record runtime checks as **verified**, **configured only**, or **unavailable** with evidence. If no server/catalog is available, continue with a filesystem proposal and preserve that distinction in the final report.

## Agent Definitions and Project Instructions

Read `.opencode/agents/*.md` plus any other native agent sources confirmed by the configuration/catalog. Markdown frontmatter carries native agent options; the body is the system prompt. Include applicable `AGENTS.md` files and the project's own documented verification commands.

For each relevant profile, note its actual ID/source, mode, specialty, write restrictions, model preference, and coordination language. Separate:

- **Explicit:** "only coordinate when asked", native edit/shell denies, required review, a selected provider/model.
- **Inferred:** a profile with planning expertise could sometimes coordinate; a documentation reviewer might benefit from fresh context.
- **Unknown:** effective permissions unavailable, duplicate IDs unresolved, whether a native subagent-only profile should become a handoff target.

A role label does not establish permissions or leadership. A read-only prompt is not native permission enforcement. Native `mode: subagent` is different from an Ensemble member; prefer `primary`/`all` for a requested session-level handoff profile, but change the mode only after a specific developer decision.

## Existing Ensemble Policy

Look for a skill-loading rule, reusable coordination policy, and these stable markers:

```text
<!-- ensemble-project-setup:policy:v1 -->
<!-- /ensemble-project-setup:policy -->
<!-- ensemble-project-setup:coordination:v1 -->
<!-- /ensemble-project-setup:coordination -->
```

Read their content, not just their presence. Equivalent unmarked guidance also counts. Multiple blocks, changed project preferences, or user edits require reconciliation, not blind replacement.

## Turn Observations into a Small Proposal

Example observation:

> `api-specialist.md` permits edits and has a fixed model; `docs-reviewer.md` is read-only. `AGENTS.md` requests coordination only when work is divisible. The plugin is configured, but the operational skill is not discoverable.

Example interpretation:

> Preserve both profiles and their models. Add the missing skill source and one project-level loading rule. Let the lead choose whether API/docs missions should run in parallel; do not add a permanent architect stage.

If the files instead require explicit permission before delegation, retain that requirement in the proposed policy. If a profile already follows `AGENTS.md`, an additional agent reminder is often redundant. Questions should settle actual ambiguity rather than make the developer repeat facts found in files.

Official references: [V2 configuration](https://opencode.ai/v2/docs/config/), [agents](https://opencode.ai/v2/docs/agents/), [skills](https://opencode.ai/v2/docs/skills/), [instructions](https://opencode.ai/v2/docs/instructions/).
