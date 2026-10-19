import { readFileSync } from "node:fs"
import path from "node:path"
import { validateModelRoutingConfig, type ModelRoutingConfig } from "./model-router"
import { validateMissionClassificationConfig, type MissionClassificationConfig } from "./mission-classification"
import { validateMissionModelPolicy, type MissionModelPolicy } from "./mission-model-policy"

/** Plugin configuration shape. All fields optional — defaults applied. */
export interface EnsembleConfig {
  /** Auto-merge worktree branches on cleanup (default: true) */
  mergeOnCleanup?: boolean
  /** Stall detection threshold in ms (default: 180000 = 3 min, 0 to disable) */
  stallThresholdMs?: number
  /** Min steps before token-based stall check (default: 3) */
  stallMinSteps?: number
  /** Output token threshold for stall detection (default: 500) */
  stallTokenThreshold?: number
  /** Hard timeout for busy members in ms (default: 1800000 = 30 min, 0 to disable) */
  timeoutMs?: number
  /** Rate limit capacity (default: 10, 0 to disable) */
  rateLimitCapacity?: number
  /** Dashboard server port (default: 4747, 0 to disable) */
  dashboardPort?: number
  /** Max peer messages per agent per window before nudge (default: 5, 0 to disable) */
  peerMessageLimit?: number
  /** Time window for peer message rate limiting in ms (default: 300000 = 5 min) */
  peerMessageWindowMs?: number
  /** Default model for all agents (e.g. "opencode/zen-sonnet-4-6") */
  defaultModel?: string
  /** Pool of models for rotation/random assignment */
  modelPool?: string[]
  /** Map agent type to specific model e.g. {"build": "anthropic/claude-opus-4-6"} */
  modelsByAgent?: Record<string, string>
  /** How to assign models: "default" | "rotate" | "random" (default: "default") */
  modelAssignment?: "default" | "rotate" | "random"
  /** Lead asks user about model preferences before spawning (default: false) */
  promptForModels?: boolean
  /** Same-server public V2 API URL, needed when Plugin.Context omits native fork. */
  v2ApiUrl?: string
  /** Max members per team in non-terminal status (default: 0 = unlimited) */
  maxActiveMembers?: number
  /** Push the next eligible board task to a member on busy→ready (default: false) */
  autoDispatch?: boolean
  /** Spawn pool workers to fill the cap while unassigned work remains (default: false) */
  autoScale?: boolean
  /** Deterministic complexity/risk routing (empty catalogue disables it). */
  modelRouting?: ModelRoutingConfig
  /** Automatic JEV discovery; helper model is explicitly user-selected. */
  classification?: MissionClassificationConfig
  /** Default explicit policy for command-prepared missions; null seeds a draft from the catalogue. */
  missionPolicy?: MissionModelPolicy | null
}

/** Default configuration values. */
export const DEFAULT_CONFIG: Required<EnsembleConfig> = {
  mergeOnCleanup: true,
  stallThresholdMs: 300_000,
  stallMinSteps: 5,
  stallTokenThreshold: 200,
  timeoutMs: 30 * 60 * 1000,
  rateLimitCapacity: 10,
  dashboardPort: 4747,
  peerMessageLimit: 5,
  peerMessageWindowMs: 300_000,
  defaultModel: "",
  modelPool: [],
  modelsByAgent: {},
  modelAssignment: "default",
  promptForModels: false,
  v2ApiUrl: "",
  maxActiveMembers: 0,
  autoDispatch: false,
  autoScale: false,
  modelRouting: { beta: 0.35, models: [] },
  missionPolicy: null,
  classification: { mode: "auto", helperModel: "", helperVariant: "", toolId: "", timeoutMs: 30_000,
    missionMode: "supervised", generalModel: "", generalVariant: "", specialized: false, x86ToolId: "", fallbacks: [], limits: {} },
}

type ConfigFile = Omit<Partial<EnsembleConfig>, "modelRouting" | "classification"> & { modelRouting?: Partial<ModelRoutingConfig>; classification?: Partial<MissionClassificationConfig> }

/** Read a JSON config file, returning an empty object on missing/invalid. */
function readConfigFile(filePath: string): ConfigFile {
  try {
    const text = readFileSync(filePath, "utf-8")
    const raw = JSON.parse(text) as Record<string, unknown>
    // Validate types — only accept numbers for numeric fields, booleans for boolean fields
    const result: ConfigFile = {}
    if (typeof raw.mergeOnCleanup === "boolean") result.mergeOnCleanup = raw.mergeOnCleanup
    if (typeof raw.stallThresholdMs === "number") result.stallThresholdMs = raw.stallThresholdMs
    if (typeof raw.stallMinSteps === "number") result.stallMinSteps = raw.stallMinSteps
    if (typeof raw.stallTokenThreshold === "number") result.stallTokenThreshold = raw.stallTokenThreshold
    if (typeof raw.timeoutMs === "number") result.timeoutMs = raw.timeoutMs
    if (typeof raw.rateLimitCapacity === "number") result.rateLimitCapacity = raw.rateLimitCapacity
    if (typeof raw.dashboardPort === "number") result.dashboardPort = raw.dashboardPort
    if (typeof raw.peerMessageLimit === "number") result.peerMessageLimit = raw.peerMessageLimit
    if (typeof raw.peerMessageWindowMs === "number") result.peerMessageWindowMs = raw.peerMessageWindowMs
    if (typeof raw.defaultModel === "string") result.defaultModel = raw.defaultModel
    if (Array.isArray(raw.modelPool) && raw.modelPool.every((m: unknown) => typeof m === "string")) result.modelPool = raw.modelPool as string[]
    if (typeof raw.modelsByAgent === "object" && raw.modelsByAgent !== null && !Array.isArray(raw.modelsByAgent)) {
      const valid = Object.entries(raw.modelsByAgent as Record<string, unknown>).every(([, v]) => typeof v === "string")
      if (valid) result.modelsByAgent = raw.modelsByAgent as Record<string, string>
    }
    if (typeof raw.modelAssignment === "string" && ["default", "rotate", "random"].includes(raw.modelAssignment)) result.modelAssignment = raw.modelAssignment as "default" | "rotate" | "random"
    if (typeof raw.promptForModels === "boolean") result.promptForModels = raw.promptForModels
    if (typeof raw.v2ApiUrl === "string") result.v2ApiUrl = raw.v2ApiUrl
    if (typeof raw.maxActiveMembers === "number") result.maxActiveMembers = raw.maxActiveMembers
    if (typeof raw.autoDispatch === "boolean") result.autoDispatch = raw.autoDispatch
    if (typeof raw.autoScale === "boolean") result.autoScale = raw.autoScale
    // Validate after merging, outside this reader's compatibility fallback: an
    // invalid explicit mission policy must never silently become a looser one.
    if (raw.missionPolicy !== undefined) result.missionPolicy = raw.missionPolicy as MissionModelPolicy | null
    if (raw.classification !== undefined) {
      try {
        if (!raw.classification || typeof raw.classification !== "object" || Array.isArray(raw.classification)) throw new Error("classification must be an object")
        const classification = raw.classification as Partial<MissionClassificationConfig>
        validateMissionClassificationConfig({ ...DEFAULT_CONFIG.classification, ...classification })
        result.classification = Object.fromEntries(Object.entries(classification).filter(([key]) => key in DEFAULT_CONFIG.classification))
      } catch (error) {
        console.warn(`[ensemble] Invalid classification at ${filePath}: ${String(error)}; keeping inherited settings`)
      }
    }
    if (raw.modelRouting !== undefined) {
      try {
        if (!raw.modelRouting || typeof raw.modelRouting !== "object" || Array.isArray(raw.modelRouting)) throw new Error("modelRouting must be an object")
        const routing = raw.modelRouting as Partial<ModelRoutingConfig>
        validateModelRoutingConfig({ ...DEFAULT_CONFIG.modelRouting, ...routing })
        result.modelRouting = {
          ...(routing.beta !== undefined ? { beta: routing.beta } : {}),
          ...(routing.models !== undefined ? { models: routing.models } : {}),
        }
      } catch (error) {
        console.warn(`[ensemble] Invalid modelRouting at ${filePath}: ${error instanceof Error ? error.message : String(error)}; keeping inherited routing configuration`)
      }
    }
    return result
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {}
    console.warn(`[ensemble] Invalid config at ${filePath}, using defaults`)
    return {}
  }
}

/**
 * Load plugin configuration. Merges global → project → env vars.
 * Missing files are silently skipped. Invalid JSON logs a warning.
 */
export function loadConfig(projectDir: string): Required<EnsembleConfig> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const globalPath = path.join(homeDir, ".config", "opencode", "ensemble.json")
  const projectPath = path.join(projectDir, ".opencode", "ensemble.json")

  const global = readConfigFile(globalPath)
  const project = readConfigFile(projectPath)
  const merged = {
    ...DEFAULT_CONFIG, ...global, ...project,
    modelRouting: { ...DEFAULT_CONFIG.modelRouting, ...global.modelRouting, ...project.modelRouting },
    classification: { ...DEFAULT_CONFIG.classification, ...global.classification, ...project.classification,
      limits: { ...global.classification?.limits, ...project.classification?.limits } },
  }
  if (merged.missionPolicy !== null) validateMissionModelPolicy(merged.missionPolicy)
  if (process.env.OPENCODE_ENSEMBLE_V2_API_URL !== undefined) merged.v2ApiUrl = process.env.OPENCODE_ENSEMBLE_V2_API_URL

  const maxMembers = process.env.OPENCODE_ENSEMBLE_MAX_MEMBERS
  if (maxMembers !== undefined) merged.maxActiveMembers = maxMembers === "0" ? 0 : (parseInt(maxMembers, 10) || merged.maxActiveMembers)

  // Env vars override everything
  const timeout = process.env.OPENCODE_ENSEMBLE_TIMEOUT
  if (timeout !== undefined) merged.timeoutMs = timeout === "0" ? 0 : (parseInt(timeout, 10) || merged.timeoutMs)

  const rateLimit = process.env.OPENCODE_ENSEMBLE_RATE_LIMIT
  if (rateLimit !== undefined) merged.rateLimitCapacity = rateLimit === "0" ? 0 : (parseInt(rateLimit, 10) || merged.rateLimitCapacity)

  const stall = process.env.STALL_THRESHOLD_MS
  if (stall !== undefined) merged.stallThresholdMs = stall === "0" ? 0 : (parseInt(stall, 10) || merged.stallThresholdMs)

  return merged
}
