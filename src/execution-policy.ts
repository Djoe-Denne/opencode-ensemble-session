import { validateModelRoutingConfig, type RoutingModel } from "./model-router"
import type { MissionPolicyModel } from "./mission-model-policy"
import { createHash } from "node:crypto"
import type { MissionPolicyRoute } from "./mission-model-policy"
import { validateVerificationPolicy, type VerificationPolicy } from "./verification-policy"

/** A catalogue snapshot shared by default and explicitly classified execution. */
export interface ExecutionPolicy {
  version: 2 | 3
  providers: string[]
  startingIntelligence: number
  classificationBeta: number
  models: RoutingModel[]
  verification?: VerificationPolicy
  planningIntelligenceRange?: PlanningIntelligenceRange
}

/** Approved planning bounds; omitted maximum leaves the upper end open. */
export interface PlanningIntelligenceRange {
  min: number
  max?: number
}

/** A proposed task boundary; only the supervisor can authorize it before admission. */
export interface TaskExecutionDecision {
  mode: "planned" | "direct"
  kind: "documentation" | "research" | "code" | "mixed" | "unspecified"
  model?: string
  variant?: string
  reason?: string
}

/** Durable supervisor provenance, copied into the immutable admitted assignment. */
export interface AuthorizedTaskExecution extends TaskExecutionDecision {
  authorizedBy: string
}

/** A task-bound assignment; the selected model never changes within the task. */
export interface ExecutionRoute {
  assignmentID?: string
  group: "autonomous"
  selected: MissionPolicyModel
  alternatives: MissionPolicyModel[]
  complexity?: number
  risk?: number
  complexityBand?: undefined
  riskBand?: undefined
  authorization?: AuthorizedTaskExecution
  execution: { phase: "planning" | "implementation"; variant?: string; applying?: boolean }
}

/** Shared routing result, including previously approved classification grids. */
export type TaskModelRoute = MissionPolicyRoute | ExecutionRoute

/** Intersect the configured catalogue with exact enabled native identities; never invent variants. */
export function nativeExecutionCatalogue(models: readonly RoutingModel[], native: readonly MissionPolicyModel[]): RoutingModel[] {
  return models.filter(model => model.available && native.some(candidate => candidate.id === model.id && candidate.variant === (model.reasoningEffort === "default" ? undefined : model.reasoningEffort)))
}

/** Select once per task/revision, reproducibly across preview, spawn, claim and restart. */
export function routeExecution(policy: ExecutionPolicy, taskKey: string, selected?: MissionPolicyModel, authorization?: AuthorizedTaskExecution): ExecutionRoute {
  if (authorization) validateTaskExecutionDecision(authorization, policy)
  const direct = authorization?.mode === "direct"
  const starts = executionStarts(policy, direct ? "direct" : "planned").toSorted((a, b) => a.id.localeCompare(b.id) || (a.variant ?? "").localeCompare(b.variant ?? ""))
  const index = createHash("sha256").update(taskKey).digest().readUInt32BE(0) % starts.length
  const choice = authorization?.model ? { id: authorization.model, ...(authorization.variant ? { variant: authorization.variant } : {}) } : selected ?? starts[index]
  if (!choice) throw new Error("No initial execution candidate")
  if (!executionStarts(policy, "direct").some(model => model.id === choice.id && model.variant === choice.variant)) throw new Error("Task model/variant is outside the approved catalogue")
  if (!direct && policy.version === 3 && !planningCatalogue(policy).some(model => model.id === choice.id && nativeVariant(model) === choice.variant)) throw new Error("Task model/variant is outside the approved planning range")
  return { group: "autonomous", selected: { ...choice }, alternatives: [], ...(authorization ? { authorization: structuredClone(authorization) } : {}),
    execution: { phase: direct ? "implementation" : "planning", ...(choice.variant ? { variant: choice.variant } : {}) } }
}

/** Build a policy from enabled catalogue entries, without evaluating any task. */
export function createExecutionPolicy(models: readonly RoutingModel[], startingIntelligence: number, classificationBeta = 0.35, planningIntelligenceRange?: PlanningIntelligenceRange | null): ExecutionPolicy {
  const enabled = structuredClone(models.filter(model => model.available))
  const policy: ExecutionPolicy = { version: planningIntelligenceRange == null ? 2 : 3,
    providers: [...new Set(enabled.map(model => model.id.slice(0, model.id.indexOf("/"))))].sort(),
    models: enabled, startingIntelligence, classificationBeta, verification: { level: "proportionate" },
    ...(planningIntelligenceRange == null ? {} : { planningIntelligenceRange: structuredClone(planningIntelligenceRange) }) }
  validateExecutionPolicy(policy)
  return policy
}

/** Return the admissible initial model/variant pairs. */
export function executionStarts(policy: ExecutionPolicy, mode: "planned" | "direct" = "planned"): MissionPolicyModel[] {
  return (mode === "direct" ? policy.models : planningCatalogue(policy)).filter(model => model.available && (mode === "direct" || model.intelligenceScore >= policy.startingIntelligence))
    .map(model => ({ id: model.id, ...(nativeVariant(model) ? { variant: nativeVariant(model) } : {}) }))
}

function nativeVariant(model: RoutingModel): string | undefined {
  return model.reasoningEffort === "default" ? undefined : model.reasoningEffort
}

/** Planning candidates for classification and explicit selection, not implementation effort. */
export function planningCatalogue(policy: ExecutionPolicy): RoutingModel[] {
  return policy.models.filter(model => model.available && (policy.version === 2 ||
    (model.intelligenceScore >= (policy.planningIntelligenceRange?.min ?? policy.startingIntelligence) &&
      model.intelligenceScore <= (policy.planningIntelligenceRange?.max ?? Number.POSITIVE_INFINITY))))
}

/** Validate approved bounds independently of catalogue availability. */
export function validatePlanningIntelligenceRange(value: unknown, startingIntelligence: number): asserts value is PlanningIntelligenceRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid planning intelligence range")
  const range = value as PlanningIntelligenceRange
  if (Object.keys(value).some(key => !["min", "max"].includes(key)) || !Number.isFinite(range.min) || range.min < 0 || range.min > startingIntelligence ||
    (range.max !== undefined && (!Number.isFinite(range.max) || range.max < startingIntelligence))) throw new Error("Invalid planning intelligence range bounds")
}

/** Validate task proposals structurally, and authorizations against their approved policy. */
export function validateTaskExecutionDecision(value: unknown, policy?: ExecutionPolicy): asserts value is TaskExecutionDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task execution decision")
  const decision = value as TaskExecutionDecision
  if (Object.keys(value).some(key => !["mode", "kind", "model", "variant", "reason", "authorizedBy"].includes(key)) ||
    !["planned", "direct"].includes(decision.mode) || !["documentation", "research", "code", "mixed", "unspecified"].includes(decision.kind)) throw new Error("Invalid task execution mode or kind")
  if (decision.mode === "direct" && (decision.kind === "unspecified" || (policy?.version === 2 && !["documentation", "research"].includes(decision.kind)))) throw new Error("Direct execution requires a qualified kind; version 2 is restricted to documentation or research")
  if (policy?.version === 2 && decision.mode === "planned" && (decision.model !== undefined || decision.variant !== undefined)) throw new Error("Planned execution cannot override the approved routing under version 2")
  if (decision.model !== undefined && (typeof decision.model !== "string" || !/^[^\s/#]+\/[^\s#]+$/u.test(decision.model))) throw new Error("Invalid task model")
  if (decision.variant !== undefined && (!decision.model || typeof decision.variant !== "string" || !decision.variant.trim())) throw new Error("A task variant requires an explicit model and native variant")
  if ((decision.reason !== undefined && (typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 2000)) ||
    (decision.mode === "planned" && decision.model !== undefined && !decision.reason)) throw new Error("Explicit planned selection requires a non-empty reason (at most 2000 characters)")
}

/** Validate a persisted catalogue snapshot before approval or execution. */
export function validateExecutionPolicy(value: unknown): asserts value is ExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid execution policy")
  const policy = value as ExecutionPolicy
  const fields = ["version", "providers", "models", "startingIntelligence", "classificationBeta", "verification", ...(policy.version === 3 ? ["planningIntelligenceRange"] : [])]
  if (![2, 3].includes(policy.version) || Object.keys(policy).some(key => !fields.includes(key))) throw new Error("Invalid execution policy fields")
  if (policy.verification !== undefined) validateVerificationPolicy(policy.verification)
  if (!Number.isFinite(policy.startingIntelligence) || policy.startingIntelligence < 0) throw new Error("Invalid starting intelligence threshold")
  if (policy.version === 3) validatePlanningIntelligenceRange(policy.planningIntelligenceRange, policy.startingIntelligence)
  validateModelRoutingConfig({ beta: policy.classificationBeta, models: policy.models })
  if (!Array.isArray(policy.providers) || !policy.providers.length || policy.providers.some(provider => typeof provider !== "string" || !provider)) throw new Error("Invalid execution providers")
  const unauthorized = policy.models.some(model => !model.available || !/^[^\s/#]+\/[^\s#]+$/u.test(model.id) || !policy.providers.includes(model.id.split("/")[0] ?? ""))
  if (unauthorized) throw new Error("Execution catalogue contains a disabled, invalid or unauthorized model")
  if (!executionStarts(policy).length) throw new Error("No enabled catalogue pair meets the starting intelligence threshold")
}
