---
name: ensemble-project-setup
description: "Analyzes an OpenCode project's agents and instructions, proposes an Ensemble integration and explicit business-profile categories for developer confirmation, and applies minimal approved changes. Use when asked to install, set up, integrate, configure, or reconcile Ensemble, create or adapt agent profiles, categorize project agents, or rerun onboarding. Ordinary team execution uses opencode-ensemble instead."
license: MIT
compatibility: "OpenCode V2 project configuration; file read/edit tools and an interactive question tool or conversation. Native capability checks are optional when no server is available."
metadata:
  author: opencode-ensemble contributors
  version: "1.0.0"
---

# Ensemble Project Setup

Integrate Ensemble into the project's existing way of working. Diagnose first, propose a small diff, get approval for that proposal, apply it, and verify. The outcome can be **no change**. Team composition remains a per-mission decision.

## Scope and Existing Decisions

- Resolve the target project from the user's request; use the current project when they say "this project". Distinguish its root, active working directory, and inherited configuration. If the target is ambiguous, clarify before writing while collecting independent information.
- Read project instructions and current Git/file state. Preserve existing edits, profile names, models, permissions, native agent modes, tools, unrelated settings, and project conventions by default.
- Keep changes project-local unless a developer explicitly approves a wider scope. Reading relevant inherited configuration does not authorize editing global files.
- Reuse decisions already made in the conversation. An approval of a concrete proposal need not be requested again; a generic request to install is not approval of an unseen diff.
- This setup skill does not start a team or send model prompts to test installation. A live team smoke test is a separate explicit developer choice.

## 1. Diagnose the Existing Project

Read [inventory](references/inventory.md) for the bounded discovery procedure. Collect:

- Applicable `AGENTS.md` instructions and verification commands.
- Project and relevant inherited OpenCode JSON/JSONC configuration: plugin sources, skill sources, inline agents, permissions, and model preferences.
- Existing native agent Markdown definitions and their intended use, modes, permissions, and expertise. Account for inline/global definitions and duplicate IDs; a file alone is not proof of the effective profile.
- Whether a compatible Ensemble plugin and the `opencode-ensemble` skill are configured and actually discoverable. Distinguish configured, found on disk, and verified in the active catalog.
- Any existing integration policy or managed blocks from a previous run.
- Existing `businessProfiles` in project/global Ensemble configuration and whether the selected plugin supports it; distinguish inherited mappings, local mappings and agents with no declared category.
- When agent Markdown is present, run `bun scripts/lint-agent-profiles.ts <agents-dir>`. Show the JSON report. Propose a permission diff as a separate change and do not apply it without approval. See [profile lint](references/profile-lint.md) and [teammate profile](references/teammate-profile.md).

Prefer native resolved catalogs when available through public tools. Otherwise mark runtime status **unverified** and use filesystem evidence. Do not invent a plugin version, capability, agent API, or successful installation check.

## 2. Infer a Policy, Then Resolve Ambiguities

Explain the inferred behavior in a few sentences with supporting file paths. Separate explicit project rules from hypotheses. Agent names suggest specialties; permissions and instructions determine actual constraints.

Determine only durable project preferences: when coordination is useful, ownership/verification conventions, whether some reusable profiles are intended to coordinate, and whether reviews should be independent. Choose no permanent team size or mandatory explorer/architect/implementer sequence.

When creating or adapting an agent, include a proposed principal business profile
in the setup proposal, even if no current harness behavior consumes it. Read the
[business-profile recipe](references/patch-recipes.md#business-profile-associations).
Use responsibilities and existing instructions as evidence, not an automatic
mapping from the agent name. Preserve explicit existing categories; resolve only
ambiguous or conflicting choices with the developer. A category neither grants
permissions nor makes an agent lead; do not require all eight initial profiles.

QA depth is a mission choice through `/ensemble-mission config`, not a permanent
agent pipeline. Optional PM discovery (`/ensemble-mission prepare`) is an
operational command documented by `opencode-ensemble`, not a setup action.
Setup does not install that command. Discovery reuses an existing native agent
explicitly associated with category `pm`; Ensemble supplies its intervention
contract, not a new native agent. Diagnose any project obligations that conflict with light,
proportionate (default), or reinforced verification. Surface conflicts for human
arbitration; never silently weaken security, data integrity or accepted ADRs.
When generating/adapting QA profiles, use [mission verification](references/mission-verification.md).

Generate/adapt supervisors to present a concise checkpoint between meaningful
stages and a contextual decision report before every user question. Default to
Markdown, link the report and summarize the options/recommendation before asking.
Canvas requires an owned running loopback preview backend with verified URL and
report content; otherwise use Markdown. Preserve permissions and existing
scientific independence. This reporting duty does not add approvals or QA runs.
Use the operational `opencode-ensemble` mission-reporting reference for details.
Apply this rule to setup's own clarification/approval questions too: the current
inventory/proposal can serve as the report if it contains the decision context.

Ask the smallest set of consequential questions, usually one to three, using the question tool when available. For example:

- Is the inferred coordination policy correct, or should this project remain single-agent by default until explicitly requested?
- Should an existing profile get a short coordination reminder, or is project-level `AGENTS.md` guidance enough?
- If a required installation source is unknown, which compatible local/plugin source should be used?

Do not ask again about facts or choices already supplied. If a custom profile's mode or permissions conflict with a desired use, explain the conflict and request a specific decision. Do not silently broaden capabilities, change its model, or turn a native subagent into a session-level profile.

## 3. Propose the Minimal Integration

Use [patch recipes](references/patch-recipes.md). Present:

1. Observed setup and the proposed project policy.
2. Exact target files and a compact diff or precise per-file changes.
3. Remaining assumptions, including any unverified runtime capability.
4. A clear choice to apply, revise, or keep diagnosis only.

For agent creation/adaptation or categorization requests, include the proposed
`businessProfiles.byAgent` entries in `.opencode/ensemble.json`, any approved
custom extensions, and the reason for each category. Report existing/inherited,
proposed and unresolved categories separately. The exact association is part of
the approved diff, not an implicit consequence of creating an agent. Do not add
this metadata to OpenCode agent frontmatter or its native configuration schema.

Usually the proposal is just a discoverable operational skill and a short `AGENTS.md` policy. Keep reusable protocol in `opencode-ensemble`; put durable expertise/permissions in optional native profiles and changing missions in spawn prompts. Existing agent bodies often need no edit.

Add a profile-specific reminder only if it has a concrete purpose and is approved. Reuse equivalent existing guidance. Offer a new profile only for an identified recurring specialty requested by the developer, not to complete an example topology.

Resolve plugin and skill sources deliberately. Prefer an existing compatible installation; never substitute an upstream release for a local continuity-capable fork without checking the required capabilities. Include any plugin loading, skill copying, or ignore-rule adjustment in the proposal. Never put authentication values into a diff or a committed file.

## 4. Apply Only the Approved Changes

- If approval is pending, finish with the proposal/question. Do not modify project files merely to stage an unapproved proposal.
- Re-read target sections before patching. If concurrent edits invalidate the approved diff, adapt the proposal and obtain a decision on the changed portion.
- Patch existing JSONC/YAML/Markdown in place, preserving comments, formatting conventions, unknown fields, and unrelated text. Do not rewrite whole config files just to add a skill source.
- Add only missing sources; respect configuration precedence and duplicate skill/profile IDs. Do not replace existing arrays or install a second conflicting copy.
- Use the stable block markers in the recipes only for newly inserted setup-owned guidance. On subsequent runs, reconcile that block in place. User edits inside a marker remain user work, not permission to overwrite them.
- When equivalent unmarked guidance already exists, keep it or propose a focused edit instead of appending another block.
- Avoid blanket directory copies over an existing skill installation. Compare the selected source/version and affected files first. Keep project configuration, secrets, and other profiles out of copied skill assets.
- Apply approved business-profile mappings project-locally, preserving unrelated settings, custom extensions and inherited associations. Reuse a matching inherited mapping instead of duplicating it. If businessProfiles is unsupported or compatibility is unknown, report that blocker and propose compatibility verification; do not silently upgrade the plugin or claim the category was registered.

## 5. Verify and Report

Follow [validation](references/validation.md): check syntax with available tooling, local links/source resolution, agent-field preservation, approved-diff scope, and effective discovery where possible. Run project-required checks appropriate to the edited files. Do not install parsers or restart services just to claim validation without including that operation in scope.

Repeat the inventory comparison without applying more changes. A second setup run should find the intended integration already present, not duplicate sources, blocks, or profiles. Check that generated files intended for version control are not accidentally ignored; ask before changing ignore policy.

Report briefly:

- Adopted coordination policy and changed files, or why no edits were needed.
- Business categories retained/registered, agents still unresolved, and configured versus runtime-verified evidence; categorization does not imply the harness uses it.
- Validation actually performed and any runtime checks still unverified.
- How to invoke `@opencode-ensemble` for future missions.

Use the developer's language for questions and summaries; follow existing repository language for files unless requested otherwise.

## References and Boundaries

- [Inventory](references/inventory.md): inspect effective project context and infer intent.
- [Patch recipes](references/patch-recipes.md): configuration, stable policy blocks, optional agent reminders, and repeat runs.
- [Validation](references/validation.md): checks and representative scenarios.

For operating a team, use `opencode-ensemble`. If its native continuity details are needed during diagnosis, read that installed/source skill's relevant references without running its team workflow. Do not recurse into setup while already performing this setup.
