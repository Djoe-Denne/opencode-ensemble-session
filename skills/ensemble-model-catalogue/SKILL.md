---
name: ensemble-model-catalogue
description: Reevaluate activated Ensemble models, discover models added since the last evaluation/synchronization using dated web sources, and propose useful newcomers for user-approved activation. Use when explicitly asked to refresh the Ensemble model catalogue, update benchmark costs or change candidate availability.
disable-model-invocation: true
---

# Ensemble model catalogue maintenance

Update the catalogue, not the routing algorithm or review policy. Runtime
selection is deterministic TypeScript; neither a model nor JEV chooses routes.

## Workflow

1. Identify the target: global `~/.config/opencode/ensemble.json`, project
   `.opencode/ensemble.json`, or the fork's versioned
   `examples/ensemble.model-routing.json`. Read existing settings; never replace
   the whole file or synchronize a template over user customization.
2. Read the maintenance journal beside the target configuration, following
   [maintenance-state.md](references/maintenance-state.md). Check
   `lastEvaluatedAt` and `lastSyncedAt` before starting. Freeze the discovery
   cutoff at the previous `lastSyncedAt`, falling back to the previous
   `lastEvaluatedAt`. No date means unknown: request a baseline from the user
   or explicitly perform a first inventory; never infer an evaluation date
   from seed import, file modification time or a benchmark's publication date.
3. Reevaluate only activated models: the catalogue's `available: true` entries
   enabled in the user's native OpenCode configuration/listing. Separate
   model+effort pairs. Report conflicting/unknown access instead of silently
   treating it as activation. Do not refresh scores/costs for disabled entries
   or reactivate them as part of the ordinary reevaluation pass.
4. Separately discover **all** new models and reasoning variants added since
   that cutoff, within the user's configured providers. Compare the previous
   native inventory with the current one, then use dated web research:
   provider release notes/model documentation and comparable benchmark sources.
   Include newly exposed native IDs even when the underlying model launched
   earlier; distinguish native addition from product launch. An undated search
   snippet is not release-date evidence. Record unknown dates/coverage gaps.
   This discovery pass does not authorize reevaluating all older disabled
   models. For an explicitly narrow availability-only request, preserve its
   scope rather than starting an unsolicited full refresh/web search.
5. Keep intelligence comparable and costs on one task benchmark/currency basis.
   The seed uses AA USD for `averageCostPerTask`; CursorBench is metadata only.
   Missing cost is not zero. Preserve an existing value with a caveat or mark
   a new candidate unavailable pending evidence. Do not estimate numbers with
   an LLM/JEV. Record source URL/dataset and retrieval date in the update note.
6. Consider every discovered newcomer, then shortlist practical additions using
   sourced evidence: sufficient coding/tool support, a better intelligence/cost
   tradeoff, a useful capability, or a provider-diverse fallback. Explain each
   recommendation, cost basis, native ID/effort, access requirements and source
   dates. Ask for explicit activation approval for the named candidates.
   No new candidate becomes available automatically: neither native listing
   nor a good benchmark score is user consent. Before approval, keep candidates
   outside the active router (journal/proposal, or `available: false` if the user
   approves staging). An existing disabled model also requires explicit
   permission to reactivate. Preserve declined and pending candidates in the
   journal so a later cutoff does not lose pending decisions or repeatedly
   propose a rejected model without new evidence.
7. Retain unknown/custom models and unrelated plugin settings. Duplicate
   `(id, reasoningEffort ?? "default")` pairs,
   nonfinite/negative costs or intelligence, and beta outside 0–1 are invalid.
   Propose the minimal diff and ask approval before applying externally sourced
   refreshes; approval of score/cost updates is not activation approval for new
   or disabled candidates. Keep beta unchanged unless specifically requested. Keep
   `paidFallback`, `level`, `usage` and CursorBench metadata; they do not override
   the deterministic eligibility rule.
8. After approval, back up the target and journal, apply only the approved fields,
   then run the routing/config tests and typecheck/test/build gate in the fork. Run
   `routeModel` on `(0,0)`, `(50,50)` and `(100,100)` with the updated catalogue
   to disclose any change of winner/fallback. Check monotonic risk thresholds.
9. Record UTC evaluation/synchronization dates and native inventory only after
   the approved complete refresh and validation succeed. On failed, partial or
   unapproved refreshes, do not advance a success timestamp. Targeted changes
   do not pretend to be a full reevaluation or synchronization. Persist sourced
   pending/declined discoveries separately; do not insert them into the active
   catalogue merely to advance a date.
10. Report changed active entries, discovery cutoff and coverage, every new
    candidate considered, recommended activations, user decisions, source/date,
    unresolved availability and any effect on routing. Distinguish declared
    availability from live validation. Explain if a reload is needed; a
    successful build is not proof a running host reloaded. Do not buy provider
    credits, publish the plugin, or mutate OpenCode credentials/provider configuration.

## Reference

In the fork, read `docs/model-routing.md` and `src/model-router.ts` for the
schema, deterministic tie-breaking and configuration precedence. The seed is
user-provided, not a claim that every entry is currently usable.

Example: “Mark `opencode/step-5-preview-free` unavailable; do not change costs”
changes only that entry's `available` field, recomputes the three example routes
and preserves custom models, costs, beta and all other plugin settings.
