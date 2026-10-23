import { validateModelRoutingConfig, type RoutingModel } from "./model-router"
import type { MissionPolicyModel } from "./mission-model-policy"
import { createHash } from "node:crypto"
import type { MissionPolicyRoute } from "./mission-model-policy"
import { validateVerificationPolicy, type VerificationPolicy } from "./verification-policy"

/** A catalogue snapshot shared by default and explicitly classified execution. */
export interface ExecutionPolicy {
  version: 2
  providers: string[]
  startingIntelligence: number
  classificationBeta: number
  models: RoutingModel[]
  verification?: VerificationPolicy
}

/** A proposed task boundary; only the supervisor can authorize it before admission. */
export interface TaskExecutionDecision {
  mode: "planned" | "direct"
  kind: "documentation" | "research" | "code" | "mixed" | "unspecified"
  model?: string
  variant?: string
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
  if (authorization) validateTaskExecutionDecision(authorization)
  const direct = authorization?.mode === "direct"
  const starts = executionStarts(policy, direct ? "direct" : "planned").toSorted((a, b) => a.id.localeCompare(b.id) || (a.variant ?? "").localeCompare(b.variant ?? ""))
  const index = createHash("sha256").update(taskKey).digest().readUInt32BE(0) % starts.length
  const choice = direct && authorization.model ? { id: authorization.model, ...(authorization.variant ? { variant: authorization.variant } : {}) } : selected ?? starts[index]
  if (!choice) throw new Error("No initial execution candidate")
  if (!executionStarts(policy, "direct").some(model => model.id === choice.id && model.variant === choice.variant)) throw new Error("Task model/variant is outside the approved catalogue")
  return { group: "autonomous", selected: { ...choice }, alternatives: [], ...(authorization ? { authorization: structuredClone(authorization) } : {}),
    execution: { phase: direct ? "implementation" : "planning", ...(choice.variant ? { variant: choice.variant } : {}) } }
}

/** Build a policy from enabled catalogue entries, without evaluating any task. */
export function createExecutionPolicy(models: readonly RoutingModel[], startingIntelligence: number, classificationBeta = 0.35): ExecutionPolicy {
  const enabled = structuredClone(models.filter(model => model.available))
  const policy: ExecutionPolicy = { version: 2,
    providers: [...new Set(enabled.map(model => model.id.slice(0, model.id.indexOf("/"))))].sort(),
    models: enabled, startingIntelligence, classificationBeta, verification: { level: "proportionate" } }
  validateExecutionPolicy(policy)
  return policy
}

/** Return the admissible initial model/variant pairs. */
export function executionStarts(policy: ExecutionPolicy, mode: "planned" | "direct" = "planned"): MissionPolicyModel[] {
  return policy.models.filter(model => model.available && (mode === "direct" || model.intelligenceScore >= policy.startingIntelligence))
    .map(model => ({ id: model.id, ...(model.reasoningEffort && model.reasoningEffort !== "default" ? { variant: model.reasoningEffort } : {}) }))
}

/** Fail closed on ambiguous direct work or a model override disguised as a planned task. */
export function validateTaskExecutionDecision(value: unknown): asserts value is TaskExecutionDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task execution decision")
  const decision = value as TaskExecutionDecision
  if (Object.keys(value).some(key => !["mode", "kind", "model", "variant", "authorizedBy"].includes(key)) ||
    !["planned", "direct"].includes(decision.mode) || !["documentation", "research", "code", "mixed", "unspecified"].includes(decision.kind)) throw new Error("Invalid task execution mode or kind")
  if (decision.mode === "direct" && !["documentation", "research"].includes(decision.kind)) throw new Error("Direct execution is restricted to documentation or research; code, mixed and ambiguous work require planning")
  if (decision.mode === "planned" && (decision.model !== undefined || decision.variant !== undefined)) throw new Error("Planned execution cannot override the approved routing")
  if (decision.model !== undefined && (typeof decision.model !== "string" || !/^[^\s/#]+\/[^\s#]+$/u.test(decision.model))) throw new Error("Invalid direct task model")
  if (decision.variant !== undefined && (!decision.model || typeof decision.variant !== "string" || !decision.variant.trim())) throw new Error("A direct variant requires an explicit model and native variant")
}

/** Validate a persisted catalogue snapshot before approval or execution. */
export function validateExecutionPolicy(value: unknown): asserts value is ExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid execution policy")
  const policy = value as ExecutionPolicy
  if (policy.version !== 2 || Object.keys(policy).some(key => !["version", "providers", "models", "startingIntelligence", "classificationBeta", "verification"].includes(key))) throw new Error("Invalid execution policy fields")
  if (policy.verification !== undefined) validateVerificationPolicy(policy.verification)
  if (!Number.isFinite(policy.startingIntelligence) || policy.startingIntelligence < 0) throw new Error("Invalid starting intelligence threshold")
  validateModelRoutingConfig({ beta: policy.classificationBeta, models: policy.models })
  if (!Array.isArray(policy.providers) || !policy.providers.length || policy.providers.some(provider => typeof provider !== "string" || !provider)) throw new Error("Invalid execution providers")
  const unauthorized = policy.models.some(model => !model.available || !/^[^\s/#]+\/[^\s#]+$/u.test(model.id) || !policy.providers.includes(model.id.split("/")[0] ?? ""))
  if (unauthorized) throw new Error("Execution catalogue contains a disabled, invalid or unauthorized model")
  if (!executionStarts(policy).length) throw new Error("No enabled catalogue pair meets the starting intelligence threshold")
}
