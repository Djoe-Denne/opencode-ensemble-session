# OpenCode Ensemble Skill

Guidance for choosing useful Ensemble teams, native context transitions, and project integration. Team composition is decided per mission; example role sequences are optional.

## Use this Local Fork

For interactive onboarding, use the companion `ensemble-project-setup` skill. It inspects existing agents and configuration, proposes small changes for approval, and reconciles repeat runs without duplicating policy. Use `opencode-ensemble` for the actual team missions afterward.

Expose this repository's `skills/` directory through OpenCode V2's `skills` configuration, or copy the whole `opencode-ensemble/` directory into the target project's `.opencode/skills/`. The Ensemble repository already exposes its canonical skill through root `opencode.json`.

Load a matching runtime plugin separately. See [project integration](references/project-integration.md) for configuration, a short `AGENTS.md` policy, and an optional native agent profile. The skill does not install tools or choose a mandatory team topology.

## Upstream Installation

For the published upstream skill:

```bash
npx skills@latest add hueyexe/opencode-ensemble --skill opencode-ensemble
```

The published upstream version may not include this local fork's native continuity guidance. Keep plugin and skill versions aligned.

Use this skill to decide whether a team is worthwhile, choose available profiles, share native context, hand off a session, select model strategy, write bounded mission prompts, review results, and integrate work. Invoke `@opencode-ensemble` explicitly in V2, or let the project's `AGENTS.md` direct the agent to load it when coordination is useful.

## Structure

```text
opencode-ensemble/
├── SKILL.md
└── references/
    ├── project-integration.md
    ├── mission-policy.md
    ├── mission-reporting.md
    ├── preparation.md
    ├── context-continuity.md
    ├── coordination-patterns.md
    ├── prompt-recipes.md
    ├── lead-checklists.md
    ├── anti-patterns.md
    └── eval-scenarios.md
```

`SKILL.md` is the short operational guide. Reference files provide deeper patterns, prompt recipes, checklists, anti-patterns, and pressure scenarios.

`skills/opencode-ensemble/` is the canonical source in this repository. Keep `agent/skills/opencode-ensemble/` synchronized as a distribution copy; expose only one copy to skill discovery.
