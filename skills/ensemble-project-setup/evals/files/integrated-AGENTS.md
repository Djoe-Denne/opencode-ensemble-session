# Existing TypeScript Project

Use Bun. Do not edit generated clients.

<!-- ensemble-project-setup:policy:v1 -->
## Ensemble coordination

Load `opencode-ensemble` when an explicitly requested team mission is useful.
Delegate only after an explicit developer request. Work directly for small or
tightly coupled changes. The lead chooses profiles and team size per mission;
no explorer/architect/implementer sequence is required.

Each delegated mission needs bounded ownership, a deliverable, and verification.
The lead owns integration and runs `bun run typecheck`, `bun test`, and
`bun run build` before reporting completion.

USER CUSTOMIZATION: API owners must include latency notes with their results.
<!-- /ensemble-project-setup:policy -->

## Release practice

Release notes need human review. This is unrelated to agent setup.
