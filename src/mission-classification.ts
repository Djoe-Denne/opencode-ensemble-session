import type { ToolDeps } from "./types"
import type { Database } from "./db"
import type { NativeClassificationRequest, NativeGeneralClassificationRequest } from "./v2-classification"
import type { ClassifierTool } from "./classification-protocol"
import { discoverJevTool, CLASSIFICATION_PROTOCOL } from "./classification-protocol"
import { parseModelId } from "./member-model"
import { sendMessage } from "./messaging"

/** Authorized general/JEV alternatives; never activates a provider or changes worker models. */
export interface ClassificationFallback {
  method: "jev" | "general"
  model: string
  variant?: string
  toolId?: string
}

/** Hard count/time/volume budgets; monetary spend cannot be guaranteed by these limits. */
export interface ClassificationLimits {
  retries?: number
  retryDelayMs?: number
  maxAttempts?: number
  maxCalls?: number
  maxDurationMs?: number
  maxInputBytes?: number
  concurrency?: number
  circuitThreshold?: number
  circuitCooldownMs?: number
  maxCircuitRechecks?: number
}

/** Declarative defaults/mission overrides; no helper model is chosen implicitly. */
export interface MissionClassificationConfig {
  mode: "off" | "auto" | "jev" | "general" | "x86"
  helperModel: string
  helperVariant: string
  toolId: string
  timeoutMs: number
  missionMode?: "supervised" | "long_run"
  generalModel?: string
  generalVariant?: string
  specialized?: boolean
  x86ToolId?: string
  fallbacks?: ClassificationFallback[]
  limits?: ClassificationLimits
}

/** Frozen capability decision stored on the team, independent of later config edits. */
export interface MissionClassificationPolicy {
  version: 1
  method: "manual" | "jev" | "general" | "x86"
  helperModel: string
  helperVariant: string
  toolId: string
  timeoutMs: number
  reason: string
  missionMode?: "supervised" | "long_run"
  generalModel?: string
  generalVariant?: string
  x86ToolId?: string
  specialized?: boolean
  fallbacks?: ClassificationFallback[]
  limits?: ClassificationLimits
  mode?: MissionClassificationConfig["mode"]
  protocol?: string
}

/** Public host bridge, injected instead of reaching into plugin internals. */
export interface ClassificationPort {
  list(): Promise<readonly ClassifierTool[]>
  invoke(request: NativeClassificationRequest): Promise<unknown>
  general?(request: NativeGeneralClassificationRequest): Promise<unknown>
  removeHelper?(sessionID: string): Promise<unknown>
}

/** Resolve a mission's capabilities once, with explicit overrides taking precedence. */
export async function resolveMissionClassification(deps: ToolDeps, override: Partial<MissionClassificationConfig> = {}): Promise<MissionClassificationPolicy> {
  const config = { ...deps.config.classification, ...override, limits: { ...deps.config.classification.limits, ...override.limits } }
  validateMissionClassificationConfig(config)
  const base = { version: 1 as const, protocol: CLASSIFICATION_PROTOCOL, mode: config.mode, helperModel: config.helperModel, helperVariant: config.helperVariant, timeoutMs: config.timeoutMs,
    missionMode: config.missionMode ?? "supervised", generalModel: config.generalModel ?? "", generalVariant: config.generalVariant ?? "",
    fallbacks: structuredClone(config.fallbacks ?? []), limits: { ...CLASSIFICATION_LIMITS, ...config.limits } }
  if (config.mode === "off") return { ...base, method: "manual", toolId: "", reason: "Classification explicitly disabled; default catalogue execution needs no scores. Manual scores remain available when requested." }
  if (!deps.classifier) {
    if (!["auto", "off"].includes(config.mode) || config.generalModel || config.fallbacks?.length) throw new Error("Native classification unavailable on this host")
    return { ...base, method: "manual", toolId: "", reason: "No native classification bridge; existing manual operation retained." }
  }
  const tools = await deps.classifier.list()
  const x86 = (config.mode === "auto" && config.specialized) || config.mode === "x86" ? tools.filter(tool => {
    const schema = tool.input as { properties?: Record<string, unknown>; required?: unknown[] } | null
    return (config.x86ToolId ? tool.id === config.x86ToolId : /(?:^|[_/.-])classify_x86$/.test(tool.id)) && schema?.properties?.assembly !== undefined && schema.properties.architecture !== undefined && schema.required?.includes("assembly") && schema.required.includes("architecture")
  }) : []
  if (x86.length > 1) throw new Error("Multiple x86 classifiers: configure x86ToolId")
  if ((config.mode === "x86" || (config.mode === "auto" && config.specialized && config.x86ToolId)) && x86.length === 0) throw new Error("Specialized x86 tool unavailable or incompatible")
  const tool = ["auto", "jev"].includes(config.mode) ? discoverJevTool(tools, config.toolId || undefined) : undefined
  const fallbacks = base.fallbacks.map(fallback => {
    if (fallback.method === "general") {
      if (!deps.classifier?.general) throw new Error("Embedded general classifier unavailable")
      return fallback
    }
    const jev = discoverJevTool(tools, fallback.toolId || tool?.id)
    if (!jev) throw new Error("Fallback JEV tool unavailable")
    return { ...fallback, toolId: jev.id }
  })
  const method = config.mode === "x86" ? "x86" : config.mode === "general" ? "general" : tool ? "jev" : config.generalModel ? "general" : "manual"
  if (config.mode === "jev" && !tool) throw new Error("Compatible JEV tool unavailable")
  if (method === "general" && (!config.generalModel || !deps.classifier.general)) throw new Error("General classification requires an explicitly chosen generalModel and a capable host")
  const specialized = config.mode === "auto" && config.specialized === true && x86.length === 1
  if (method === "manual" && specialized) {
    return { ...base, method: "manual", specialized: true, x86ToolId: x86[0]?.id, fallbacks, toolId: "", reason: "Specialized x86 protocol frozen; other task kinds retain manual operation." }
  }
  return { ...base, method, specialized, x86ToolId: x86[0]?.id ?? "", toolId: method === "x86" ? x86[0]?.id ?? "" : tool?.id ?? "", fallbacks,
    reason: method === "manual" ? "No compatible JEV tool or chosen general model; existing manual operation retained." : method === "jev" && !config.helperModel
      ? "JEV detected. Configure helperModel before automatic classification; no orchestration model is selected implicitly."
      : `${method} protocol frozen for this mission; scores stay in [0,1], fallbacks explicitly authorized: ${fallbacks.length}.` }
}

/** Validate a complete merged configuration before allocating a team or helper. */
export function validateMissionClassificationConfig(config: MissionClassificationConfig): void {
  if (!["off", "auto", "jev", "general", "x86"].includes(config.mode)) throw new Error("classification.mode must be off, auto, jev, general or x86")
  for (const field of ["helperModel", "helperVariant", "toolId"] as const) {
    if (typeof config[field] !== "string") throw new Error(`classification.${field} must be a string`)
  }
  if (config.helperModel && !parseModelId(config.helperModel)) throw new Error("classification.helperModel must be provider/model")
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 600_000) throw new Error("classification.timeoutMs must be an integer from 1 to 600000")
  if (config.missionMode !== undefined && !["supervised", "long_run"].includes(config.missionMode)) throw new Error("Invalid missionMode")
  for (const field of ["generalModel", "generalVariant", "x86ToolId"] as const) {
    if (config[field] !== undefined && typeof config[field] !== "string") throw new Error(`classification.${field} must be a string`)
  }
  if (config.generalModel && !parseModelId(config.generalModel)) throw new Error("classification.generalModel must be provider/model")
  if (config.specialized !== undefined && typeof config.specialized !== "boolean") throw new Error("classification.specialized must be boolean")
  if (config.fallbacks !== undefined) {
    if (!Array.isArray(config.fallbacks) || config.fallbacks.length > 8) throw new Error("classification.fallbacks must contain at most 8 explicitly authorized methods")
    config.fallbacks.forEach(fallback => {
      if (!fallback || !["jev", "general"].includes(fallback.method) || !parseModelId(fallback.model)) throw new Error("Invalid classification fallback method/model")
      if (fallback.variant !== undefined && typeof fallback.variant !== "string") throw new Error("Invalid fallback variant")
      if (fallback.toolId !== undefined && typeof fallback.toolId !== "string") throw new Error("Invalid fallback toolId")
    })
  }
  if (config.limits !== undefined) {
    if (!config.limits || typeof config.limits !== "object" || Array.isArray(config.limits)) throw new Error("classification.limits must be an object")
    Object.entries(config.limits).forEach(([key, value]) => {
      if (!(key in CLASSIFICATION_LIMITS) || !Number.isSafeInteger(value) || value < (["retries", "retryDelayMs", "maxCircuitRechecks"].includes(key) ? 0 : 1)) throw new Error(`Invalid classification.limits.${key}`)
    })
    if ((config.limits.concurrency ?? 1) > 16 || (config.limits.retries ?? 0) > 8 || (config.limits.maxAttempts ?? 3) > 32 || (config.limits.retryDelayMs ?? 100) > 5000) throw new Error("classification concurrency/retry settings exceed safe bounds")
  }
}

/** Read a frozen policy; permissive protocol reads are only for visibility/user-authorized updates, never evaluation. */
export function getMissionClassification(db: Database, teamId: string, allowUnsupportedProtocol = false): MissionClassificationPolicy | undefined {
  const row = db.query("SELECT classification_policy FROM team WHERE id = ?").get(teamId) as { classification_policy: string | null } | null
  if (!row?.classification_policy) return undefined
  const policy = JSON.parse(row.classification_policy) as MissionClassificationPolicy
  if (policy.version !== 1 || !["manual", "jev", "general", "x86"].includes(policy.method)) throw new Error("Unsupported mission classification policy")
  if (!allowUnsupportedProtocol && policy.protocol && policy.protocol !== CLASSIFICATION_PROTOCOL) throw new Error("Unsupported persisted classification protocol; an explicit user-approved policy update is required")
  validateMissionClassificationConfig({ ...policy, mode: policy.mode ?? (policy.method === "manual" ? "off" : policy.method) })
  return policy
}

/**
 * Apply an explicit classifier update through the legitimate resolution path:
 * inherit the frozen policy, resolve the override, then persist it atomically.
 * Shared by the team_message classification update and the mission config draft.
 */
export async function applyMissionClassification(deps: ToolDeps, teamId: string, override: Partial<MissionClassificationConfig>): Promise<MissionClassificationPolicy> {
  const frozen = getMissionClassification(deps.db, teamId, true)
  const inherited = frozen ? { ...frozen, mode: frozen.mode ?? (frozen.method === "manual" ? "off" as const : frozen.method) } : deps.config.classification
  const policy = await resolveMissionClassification({ ...deps, config: { ...deps.config, classification: inherited } }, override)
  deps.db.transaction(() => {
    deps.db.run("UPDATE team SET classification_policy = ?, mission_mode = ?, mission_state = 'running', time_updated = MAX(time_updated + 1, ?) WHERE id = ?", [JSON.stringify(policy), policy.missionMode ?? "supervised", Date.now(), teamId])
    deps.db.run("UPDATE team_task SET classification_status = CASE WHEN ? = 'manual' AND NOT (? = 1 AND task_type = 'x86') THEN 'not_required' ELSE 'pending' END, classification_result = NULL, classification_token = NULL, classification_until = NULL, classification_error = NULL, classification_attempts = 0 WHERE team_id = ? AND classification_status IN ('pending', 'running', 'blocked') AND status IN ('pending', 'blocked') AND assignee IS NULL", [policy.method, policy.specialized ? 1 : 0, teamId])
    sendMessage(deps.db, { teamId, from: "system", to: "lead", content: `Mission classification changed explicitly: ${policy.method}, tool=${policy.toolId || "none"}, helper=${policy.helperModel || "unset"}. ${policy.reason}` })
  })()
  return policy
}

/**
 * Decide whether a frozen policy may be approved.
 * Manual and explicitly disabled classification are ready. JEV and x86 need
 * `helperModel`; general needs `generalModel`. No model is chosen here.
 */
export function classificationReadiness(policy: MissionClassificationPolicy | undefined): { ready: boolean; reason: string } {
  if (!policy || policy.mode === "off" || policy.method === "manual") return { ready: true, reason: "" }
  const missingHelper = (policy.method === "jev" || policy.method === "x86") && !policy.helperModel
  const missingGeneral = policy.method === "general" && !policy.generalModel
  if (!missingHelper && !missingGeneral) return { ready: true, reason: "" }
  return { ready: false, reason: policy.reason || "Configure the classification model before start; no model is selected implicitly." }
}

/** Conservative limits independent of worker concurrency and review settings. */
export const CLASSIFICATION_LIMITS: Required<ClassificationLimits> = {
  retries: 1, retryDelayMs: 100, maxAttempts: 3, maxCalls: 1000,
  maxDurationMs: 30 * 60_000, maxInputBytes: 10_000_000, concurrency: 1,
  circuitThreshold: 3, circuitCooldownMs: 60_000, maxCircuitRechecks: 1,
}
