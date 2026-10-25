# Preparation input limit correction — 2026-10-25

User-authorized correction following the earlier deployment campaign. Historical
reports retain their original observations; this report records the new bound.

- Mandate, stored objective, preplan and resume clarification: 40000 characters
  each, measured by JavaScript string length. Preplan file guard: 160000 bytes.
- Shared validation reports the field, Ensemble as the source, limit and actual
  length. Native fork/checkpoint history is not included in this guard.
- Output-document and intervention-contract limits are unchanged. This is not
  a claim that any model can accept unlimited native history.
- Six regression cases first failed under the old limit, then passed: 39999 and
  40000 mandates, 27073 stored objective, field-specific 40001 rejection,
  multibyte preplan/byte guard, and resume rejection/acceptance.
- Full gate: typecheck, **1684 tests / 0 failures**, build; diff check clean.

Deployed immutable package:
`20261025-pm-preparation-da5345a2385c`.
Bundle SHA-256:
`da5345a2385c33aa090f1ac5e6fd7c430e18b69a19b1d56451c29b7e3b31b51c`.
Native plugin API confirms active in re-ff8. Config and coherent SQLite backup
are retained under the matching local-plugins/ensemble/backups directory.
Schema remains 26, live integrity ok. Only package/skills config pointers changed.

Target mission `team_mvnxgnse_0000_39vpc8`: team, policy, tasks, members,
preparation runs and imports compared unchanged against the backup. No native
PM session, prepare/start, mission relaunch or direct database write was used.
No commit or push requested for this correction. The two-PM profile installation
remains unapproved and unapplied.

Localisation: src/preparation-runtime.ts input validation; runtime regression
tests and current preparation documentation, including both skill mirrors.
Impact: input admission only; same prompts/import protocol and native continuity.
Limit: current shared Serena connection targets retro-eng/C++, not this separate
TypeScript repository; targeted file tools and executable tests were used without
reconfiguring the shared connection. No Docker resources created.
