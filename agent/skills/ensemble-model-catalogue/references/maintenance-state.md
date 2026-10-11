# Maintenance dates and discovery journal

Keep skill-maintenance state outside the runtime routing schema. Store
`ensemble-model-catalogue-state.json` beside the **target** `ensemble.json`:
global for the global catalogue, project-local for a project override. For the
versioned example, use the corresponding sidecar in `examples/`. Do not merge
an unrelated project's state or write evaluation dates into the seed as if its
user-supplied metrics had been independently refreshed.

Read existing state first and preserve its custom fields. Missing/invalid state
or dates mean unknown, not "today". Use a user-confirmed previous evaluation
date if available; otherwise ask for a baseline or explicitly label the run as
a first inventory. Do not claim exhaustive "since last sync" coverage without
a known cutoff. No journal needs to be created just to edit this skill.

## State shape

```json
{
  "version": 1,
  "lastEvaluatedAt": null,
  "lastSyncedAt": null,
  "knownNativeCandidates": [],
  "discoveries": []
}
```

- Dates: ISO-8601 UTC, for example `2026-10-11T09:00:00Z`. Reject malformed or
  future success dates; ask instead of silently replacing them.
- `lastEvaluatedAt`: last completed, approved refresh of all activated
  model/effort pairs with comparable sourced metrics.
- `lastSyncedAt`: last completed discovery/inventory synchronization across the
  configured providers, with every found newcomer accounted for. It does not
  imply that proposed newcomers were activated.
- `knownNativeCandidates`: provider/model ID plus effort, including activated
  and disabled entries. This is an inventory snapshot, not permission to route.
- `discoveries`: retain each ID/effort, first-seen time, supported introduction
  date (if known), event kind (`native_addition` or `model_release`), dated source
  URLs, recommendation, and decision (`pending`, `approved`, `declined`). A
  first-seen observation is not proof of a product's release date. Approval must
  name the specific model/effort; never record it based on inferred enthusiasm.

Freeze the discovery window before changing any dates:
`since = previous.lastSyncedAt ?? previous.lastEvaluatedAt`.
Gather all newcomers in that window and the native inventory delta, then judge
their usefulness separately. Keep pending discoveries visible on later runs,
even when their release date falls before the new cutoff. Do not repeatedly
propose declined candidates without new evidence or a user's request.

## Commit semantics

1. Read configuration + state; capture the old cutoff and native inventory.
2. Refresh activated candidates only; discover and document newcomers separately.
3. Propose data changes and a separate named activation decision for newcomers.
4. Back up both files. Apply only approved changes. Validate configuration and
   representative deterministic routes before recording success.
5. A complete approved refresh can advance both success dates and replace the
   inventory snapshot. Partial/failed/web-unavailable/unapproved runs keep the
   old success dates and inventory; record gaps and discoveries separately so
   the next run can resume without skipping models.
6. Availability-only edits do not advance either full-refresh timestamp.

Do not overwrite disabled entries' metrics in a routine refresh. If the user
later approves a newcomer, obtain comparable intelligence/cost and native effort
support before setting `available: true`; insufficient evidence means leave it
pending/unavailable and explain the blocker, not invent a zero cost or score.
If native OpenCode activation also requires a setting change, propose that exact
change for approval; never create provider accounts, buy credits or modify
credentials to make a recommendation usable.
