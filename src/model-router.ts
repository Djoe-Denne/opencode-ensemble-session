/** One independently scored model/reasoning-effort combination. */
export interface RoutingModel {
  id: string
  provider?: string
  reasoningEffort?: string
  intelligenceScore: number
  averageCostPerTask: number
  available: boolean
  cursorBenchCostPerTask?: number
  paidFallback?: string
  level?: string
  usage?: string
}

/** Deterministic routing configuration; an empty catalogue disables routing. */
export interface ModelRoutingConfig {
  beta: number
  models: RoutingModel[]
}

/** Optional scores; missing dimensions default to zero when routing is requested. */
export interface TaskRoutingScores {
  complexity?: number
  risk?: number
}

/** Selection and an independently eligible alternative, not an automatic retry. */
export interface ModelSelection {
  selected: RoutingModel
  fallback: RoutingModel | null
  reason: string
}

/** Full auditable result of the deterministic router. */
export interface ModelRoute extends ModelSelection {
  demand: number
  requiredIntelligence: number
}

/** Validate integer task dimensions without scoring them with a model. */
export function validateTaskRoutingScores(scores: TaskRoutingScores): void {
  Object.entries(scores).forEach(([name, value]) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100)) {
      throw new Error(`${name} must be an integer from 0 to 100`)
    }
  })
}

/** Validate the catalogue and the bounded risk coefficient. */
export function validateModelRoutingConfig(config: ModelRoutingConfig): void {
  if (!Number.isFinite(config.beta) || config.beta < 0 || config.beta > 1) {
    throw new Error("modelRouting.beta must be a finite number from 0 to 1")
  }
  if (!Array.isArray(config.models)) throw new Error("modelRouting.models must be an array")
  const identities = new Set<string>()
  config.models.forEach(model => {
    if (!model || typeof model.id !== "string" || !model.id.trim()) throw new Error("Model id must be a non-empty string")
    if (typeof model.available !== "boolean") throw new Error(`Model ${model.id}: available must be boolean`)
    if (!Number.isFinite(model.intelligenceScore) || model.intelligenceScore < 0) throw new Error(`Model ${model.id}: intelligenceScore must be finite and non-negative`)
    if (!Number.isFinite(model.averageCostPerTask) || model.averageCostPerTask < 0) throw new Error(`Model ${model.id}: averageCostPerTask must be finite and non-negative`)
    const optionalFields = ["provider", "reasoningEffort"] as const
    optionalFields.forEach(field => {
      if (model[field] !== undefined && (typeof model[field] !== "string" || !model[field]?.trim())) {
        throw new Error(`Model ${model.id}: ${field} must be a non-empty string`)
      }
    })
    const key = JSON.stringify([model.id, model.reasoningEffort ?? "default"])
    if (identities.has(key)) throw new Error(`Duplicate model/reasoning effort: ${key}`)
    identities.add(key)
  })
}

function provider(model: RoutingModel): string {
  return model.provider ?? model.id.split("/")[0] ?? model.id
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// Deterministic ties: cost, stronger intelligence, then code-point identity.
function compareCost(a: RoutingModel, b: RoutingModel): number {
  return a.averageCostPerTask - b.averageCostPerTask || b.intelligenceScore - a.intelligenceScore ||
    compareText(a.id, b.id) || compareText(a.reasoningEffort ?? "default", b.reasoningEffort ?? "default")
}

function availableModels(models: readonly RoutingModel[]): RoutingModel[] {
  validateModelRoutingConfig({ beta: 0.35, models: [...models] })
  const available = models.filter(model => model.available)
  if (!available.length) throw new Error("Model routing requires at least one available model")
  return available
}

/** Select the cheapest sufficient candidate, or the strongest available candidate. */
export function selectModelForIntelligence(input: { models: readonly RoutingModel[]; requiredIntelligence: number }): ModelSelection {
  if (!Number.isFinite(input.requiredIntelligence)) throw new Error("requiredIntelligence must be finite")
  const available = availableModels(input.models)
  const sufficient = available.filter(model => model.intelligenceScore >= input.requiredIntelligence).sort(compareCost)
  const ranked = sufficient.length ? sufficient : [...available].sort((a, b) => b.intelligenceScore - a.intelligenceScore || compareCost(a, b))
  const selected = ranked[0]
  if (!selected) throw new Error("Model routing requires at least one available model")
  // In degraded mode never advertise a weaker fallback as sufficient.
  const alternatives = ranked.slice(1).filter(model => sufficient.length || model.intelligenceScore === selected.intelligenceScore)
  const fallback = alternatives.find(model => provider(model) !== provider(selected)) ?? alternatives[0] ?? null
  const choice = `${selected.id} (${selected.reasoningEffort ?? "default"}), intelligence ${selected.intelligenceScore}, cost ${selected.averageCostPerTask}`
  const explanation = sufficient.length
    ? `Selected ${choice}: cheapest available candidate meeting required intelligence ${input.requiredIntelligence}.`
    : `No available candidate meets required intelligence ${input.requiredIntelligence}; selected strongest available ${choice}.`
  const fallbackReason = fallback
    ? ` Fallback: ${fallback.id} (${fallback.reasoningEffort ?? "default"})${provider(fallback) !== provider(selected) ? " from a different provider" : " from the same provider (no different-provider alternative)"}.`
    : " No eligible fallback."
  return { selected, fallback, reason: explanation + fallbackReason }
}

/** Route solely by supplied scores, catalogue intelligence and comparable costs. */
export function routeModel(input: { complexity: number; risk: number; models: readonly RoutingModel[]; beta?: number }): ModelRoute {
  validateTaskRoutingScores({ complexity: input.complexity, risk: input.risk })
  return routeNormalizedModel({ ...input, complexity: input.complexity / 100, risk: input.risk / 100 })
}

/** Route native 0..1 classification scores without a 0..100 round-trip. */
export function routeNormalizedModel(input: { complexity: number; risk: number; models: readonly RoutingModel[]; beta?: number }): ModelRoute {
  Object.entries({ complexity: input.complexity, risk: input.risk }).forEach(([dimension, score]) => {
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`${dimension} must be a finite normalized score from 0 to 1`)
    }
  })
  const beta = input.beta ?? 0.35
  validateModelRoutingConfig({ beta, models: [...input.models] })
  const available = availableModels(input.models)
  const minI = Math.min(...available.map(model => model.intelligenceScore))
  const maxI = Math.max(...available.map(model => model.intelligenceScore))
  const c = input.complexity
  const r = input.risk
  const demand = c + beta * r * (1 - c)
  // Clamp arithmetic round-off at the endpoints, not the catalogue's scale.
  const requiredIntelligence = Math.min(maxI, Math.max(minI, minI + demand * (maxI - minI)))
  return {
    ...selectModelForIntelligence({ models: available, requiredIntelligence }),
    demand,
    requiredIntelligence,
  }
}
