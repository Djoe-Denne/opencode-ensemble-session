# Deterministic task model routing

`src/model-router.ts` exports the pure `routeModel({ complexity, risk, models,
beta })` API, returning `{ selected, fallback, demand, requiredIntelligence,
reason }`. There are no LLM/JEV calls, provider probes or random decisions.

## Algorithm and validation

- Integer complexity/risk scores: 0–100. Normalize to `c` and `r`.
- `demand = c + beta * r * (1 - c)`, default beta 0.35.
- Beta is finite and bounded to 0–1 so demand remains in 0–1 and risk never
  lowers the complexity floor. Invalid scores/configuration are rejected.
- Intelligence uses the **available** catalogue's actual min/max, not an
  assumed 0–100 model scale: `minI + demand * (maxI - minI)`.
- Among available models meeting that threshold, select minimum cost.
  Ties: higher intelligence, then model ID and reasoning effort in code-point
  order. Input arrays are not mutated; catalogue order cannot affect ties.
- Fallback: cheapest remaining sufficient candidate from a different provider,
  if any; otherwise cheapest remaining sufficient candidate from the same
  provider. Null if no alternative. Efforts of the same model are distinct.
- Defensive degradation: when a threshold cannot be met, select maximum
  available intelligence (cheapest on ties). Only equally strong alternatives
  qualify as degraded fallbacks. `selectModelForIntelligence` isolates this
  guard for testing arbitrary thresholds. In the normal bounded formula at
  least the catalogue's maximum always meets the computed threshold.
- An empty/all-unavailable catalogue has no meaningful selection; the API
  throws explicitly rather than inventing a model.

## Configuration

Merge `examples/ensemble.model-routing.json` into the plugin's
`~/.config/opencode/ensemble.json` or project `.opencode/ensemble.json`.
Only `modelRouting` needs changing; preserve all unrelated plugin settings.
Defaults: `{ "beta": 0.35, "models": [] }`, so routing is disabled until a
catalogue is supplied. Project beta-only changes retain the global catalogue;
a project `models` array replaces it completely. Set `models: []` to disable.
Malformed routing sections warn and retain inherited/default routing, without
discarding unrelated valid plugin settings.

Each candidate has `id`, `intelligenceScore`, `averageCostPerTask`, `available`;
optional `provider` (otherwise inferred from `id`) and `reasoningEffort`.
IDs used by spawn must be native `provider/model` IDs. A `default` effort means
no explicit native variant; all other efforts map to OpenCode's `variant`.
The configured provider must actually expose that variant: Ensemble does not
translate or guess effort names, nor confirm availability over the network.

The supplied 17-entry catalogue is user-provided data, not a benchmark claim
or live availability check. `averageCostPerTask` uses the user's actual amortized
USD cost when supplied, otherwise the supplied `cout_AA_usd` estimate.
For `cursor/grok-4.7` high, the user-confirmed Cursor-sponsored cost is $0.313
per task, replacing the $2.73 estimate. CursorBench costs are retained as optional
`cursorBenchCostPerTask` metadata, not mixed into the same ranking and not treated
as the user's actual bill. `paidFallback`, `level` and `usage` are
metadata only: they cannot override intelligence/cost eligibility. Availability
is initially declared true and must be maintained by the user/maintenance skill.

## Spawn priority and task board

1. Explicit `team_spawn.model` (with optional native `variant`).
2. Complexity/risk routing, when either score is supplied and the configured
   catalogue is nonempty. A missing dimension defaults to zero.
3. Existing Ensemble `modelsByAgent`, rotation/random pool, `defaultModel`.
4. OpenCode's native default (or inherited selection for a fork).

`team_tasks_add` stores optional `complexity`/`risk` in SQLite migration 13.
`team_spawn.claim_task` reads those scores; explicit spawn dimensions override
the corresponding board dimensions. Auto-scale uses the same spawn path and
therefore routes scored tasks without another decision maker. No supplied
scores means **unchanged model resolution**, even with a configured catalogue.

Selection happens before fork/session/worktree allocation, so bad scores or an
all-unavailable catalogue cannot strand resources. The chosen model, native
variant and full routing result (including fallback and reason) are persisted
on the member (`model`, `model_variant`, `model_routing`). Spawn returns the
explanation and fallback; subsequent deliveries preserve the selected variant.
A later lead `team_message.model` override clears routing provenance and the
old effort. The fallback is an auditable suggestion, **not an automatic retry**.

Profile frontmatter is not an input on this path either. Catalogue
`reasoningEffort` values are stored and delivered as native variant ids; they
are not translated into another label at `switchModel`. Canonical effort is an
annotation described in `docs/mission-policy.md`.

This V1 deliberately routes at spawn, not on every reused worker assignment.
Later tasks on the same member retain its model/variant and manual overrides.
Risk does not change review, plan approval, agent type or permissions.

## Usage

```typescript
// Tool input: explicit scores, or claim_task with scored board entries.
{ name: "implementer", prompt: "Implement the API", complexity: 65, risk: 30 }

// An explicit model always wins.
{ name: "reviewer", prompt: "Inspect the patch", model: "openai/gpt-6.1-sol", variant: "medium", complexity: 95, risk: 90 }
```

The minimum-cost rule is not load balancing: many tasks can choose one free
provider. Provider concurrency/quota scheduling remains a separate concern;
the router does not replace a sufficient cheap model to distribute load.

The classification integration API `routeNormalizedModel` accepts native
complexity/risk scores in **0..1** without rounding or a percentage round-trip.
`routeModel` and current board/tool inputs keep their existing 0–100 contract,
converting once on entry to the same deterministic algorithm. The classifier
bridge supports [mission-scoped classification](task-classification.md) with
persisted protocols, explicit classifier models and authorized failover. It
does not change the router's deterministic selection or review policy.

## Maintenance

Use `ensemble-model-catalogue` to update declared availability, model/effort
scores and comparable costs with source dates and approval. Validate updates
with `bun test test/model-router.test.ts test/model-routing-spawn.test.ts
test/model-catalogue.test.ts`, then run the full typecheck/test/build gate.

Full refreshes reevaluate **activated models only**. A separate discovery pass
considers models/efforts added since the previous synchronization (or previous
evaluation if no synchronization date is recorded), using native inventory
deltas and dated web sources. Useful newcomers require explicit user approval
before activation. Skill dates and pending/declined proposals live in the
sidecar `ensemble-model-catalogue-state.json`, not in the runtime router.
Missing dates are unknown; seed import is not an evaluation. Partial refreshes
do not advance success dates. This workflow does not change runtime routing.
