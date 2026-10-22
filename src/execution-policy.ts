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
  execution: { phase: "planning" | "implementation"; variant?: string; applying?: boolean }
}

/** Shared routing result, including previously approved classification grids. */
export type TaskModelRoute = MissionPolicyRoute | ExecutionRoute

/** Intersect the configured catalogue with exact enabled native identities; never invent variants. */
export function nativeExecutionCatalogue(models: readonly RoutingModel[], native: readonly MissionPolicyModel[]): RoutingModel[] {
  return models.filter(model => model.available && native.some(candidate => candidate.id === model.id && candidate.variant === (model.reasoningEffort === "default" ? undefined : model.reasoningEffort)))
}

/** Select once per task/revision, reproducibly across preview, spawn, claim and restart. */
export function routeExecution(policy: ExecutionPolicy, taskKey: string, selected?: MissionPolicyModel): ExecutionRoute {
  const starts = executionStarts(policy).toSorted((a, b) => a.id.localeCompare(b.id) || (a.variant ?? "").localeCompare(b.variant ?? ""))
  const index = createHash("sha256").update(taskKey).digest().readUInt32BE(0) % starts.length
  const choice = selected ?? starts[index]
  if (!choice) throw new Error("No initial execution candidate")
  return { group: "autonomous", selected: { ...choice }, alternatives: [], execution: { phase: "planning", ...(choice.variant ? { variant: choice.variant } : {}) } }
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
export function executionStarts(policy: ExecutionPolicy): MissionPolicyModel[] {
  return policy.models.filter(model => model.available && model.intelligenceScore >= policy.startingIntelligence)
    .map(model => ({ id: model.id, ...(model.reasoningEffort && model.reasoningEffort !== "default" ? { variant: model.reasoningEffort } : {}) }))
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
