# Teammate profile template

Copy the skeleton that matches the spawn `report_mode`. Do not rewrite an existing profile automatically. A `model:` key is not binding for a mission teammate. Allows come after the `*` deny. Write globs start with `**/`. `shell` / `bash` stay denied. `subagent` stays denied.

## Collaborator

`report_mode` defaults to `team_message`. Declare `execute` and every member tool. Omit `edit` when the role does not write. Replace the example `edit` glob with the role's real deliverables.

```yaml
---
description: "Coéquipier Ensemble. Le modèle vient de la policy de mission. Compte-rendu par team_message."
mode: primary
permissions:
  - { action: "*", resource: "*", effect: deny }
  - { action: read, resource: "*", effect: allow }
  - { action: glob, resource: "*", effect: allow }
  - { action: skill, resource: "*", effect: allow }
  - { action: execute, resource: "*", effect: allow }
  - { action: team_message, resource: "*", effect: allow }
  - { action: team_broadcast, resource: "*", effect: allow }
  - { action: team_tasks_list, resource: "*", effect: allow }
  - { action: team_tasks_add, resource: "*", effect: allow }
  - { action: team_tasks_complete, resource: "*", effect: allow }
  - { action: team_claim, resource: "*", effect: allow }
  - { action: team_results, resource: "*", effect: allow }
  - { action: team_status, resource: "*", effect: allow }
  - { action: team_view, resource: "*", effect: allow }
  - { action: team_handoff, resource: "*", effect: allow }
  - { action: edit, resource: "**/docs/contracts/**", effect: allow }
  - { action: subagent, resource: "*", effect: deny }
---
```

Body, under 500 tokens: identity, the tools above called through `execute` on V2, a `<task-result>` via `team_message`, blockers sent to the lead, and no lead tools (`team_spawn`, `team_shutdown`, `team_merge`, `team_cleanup`, `team_create`). No `model:` key.

## Restrictive

Same `*` deny, then `read`, `glob` and `skill` only. Body marker `<!-- ensemble-report: final_response -->`. Spawn with `report_mode: "final_response"`. No `execute` allow and no Ensemble tool allow. The lead closes tasks.

`**/` is the prescribed glob form. It is not proof that the host matches a worktree path.
