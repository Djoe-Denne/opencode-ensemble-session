# Offline Setup Evaluations

`evals.json` defines three behavioral scenarios and their outcome criteria. Run each in a separate temporary project, both with this skill and without it. Keep reports and verification artifacts outside the fixture project, and preserve a byte-for-byte `before/` snapshot for comparison.

## Materialize a Fixture

Map the supplied files as follows:

```text
files/project-AGENTS.md       -> project/AGENTS.md
files/project-opencode.jsonc  -> project/opencode.jsonc
files/api-specialist.md       -> project/.opencode/agents/api-specialist.md
files/docs-reviewer.md        -> project/.opencode/agents/docs-reviewer.md
files/internal-skill.md       -> project/team-skills/internal-review/SKILL.md
```

Supply an existing absolute operational skill-source directory to both variants. They may verify that it contains `opencode-ensemble/SKILL.md`; they should not read that operational skill or contact a server. Candidate runs read this setup skill and its references; baselines do not.

For scenario 3, replace `AGENTS.md` with `files/integrated-AGENTS.md`, append `files/integrated-agent-note.md` to the API profile, and append the supplied operational skill source to the existing `skills` array before taking the baseline snapshot. This is the already-integrated input, not an executor change.

## Execution Boundaries

- The plugin string is fixture configuration, not a verified compatible installation. Model IDs are inert fixtures. Do not launch OpenCode against them or install dependencies.
- Native catalogs, global configuration, network, team operations, and service control are unavailable. Represent interactive questions in the saved response rather than asking the real user during evaluation.
- No application or dependencies are supplied. Do not execute the application verification commands listed in the fixture's `AGENTS.md`; use existing syntax parsers and file checks instead.
- Scenario 1 authorizes a proposal only. Scenario 2 explicitly authorizes three edits. Scenario 3 should find no necessary changes while preserving customization.

## Review

Compare file sets and bytes with the baseline, parse JSONC and agent frontmatter, inspect actual diffs and reports, then grade the `expectations` in `evals.json`. Equivalent unmarked coordination guidance is valid; a baseline does not fail merely for omitting this skill's marker convention.

These explicit, offline prompts check mutation scope, preservation, and repeat-run behavior. They do not verify live plugin discovery or establish that the skill outperforms an unaided agent. Report unavailable timing/token measurements as unavailable, not zero.
