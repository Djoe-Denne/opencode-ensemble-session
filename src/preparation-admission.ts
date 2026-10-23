import type { BusinessProfilesConfig } from "./business-profiles"
import { resolveBusinessProfilesConfig } from "./business-profiles"
import { composeIntervention, pmDiscoveryContract, PM_INTERVENTION_CATEGORY, type ComposedIntervention } from "./intervention-contract"
import { PREPARATION_PM_INSTRUCTIONS } from "./preparation-instructions"

/**
 * Name a project may map to category pm.
 * The plugin does not register or install this agent.
 */
export const ENSEMBLE_PM_AGENT = "ensemble-pm"

/** Public V2 session.prompt fields. Structured output is not one of them. */
export const PUBLIC_PREPARATION_PROMPT_KEYS = ["sessionID", "text", "delivery", "metadata", "files", "agents", "skills", "resume", "id"] as const

const ZERO_PM = "No admissible PM is configured for this project. Categorize the existing native PM as pm in businessProfiles.byAgent, then run /ensemble-mission prepare or /ensemble-mission prepare --pm <agent>. Ensemble does not install a native agent."

/** Admission failure that must not be collapsed into a generic unavailable agent. */
export class PreparationAdmissionError extends Error {
  readonly code: "category" | "unavailable" | "unverified" | "transport" | "model" | "hooks" | "lead" | "approved" | "exhausted" | "imported" | "running" | "accept" | "selection"

  constructor(code: PreparationAdmissionError["code"], message: string) {
    super(message)
    this.name = "PreparationAdmissionError"
    this.code = code
  }
}

/** Copy project mappings. A missing PM is not filled with a synthetic native agent. */
export function preparationBusinessProfiles(config: BusinessProfilesConfig): BusinessProfilesConfig {
  return resolveBusinessProfilesConfig({
    extensions: config.extensions,
    byAgent: { ...config.byAgent },
  })
}

/** Native agents the project has already declared in category pm, in stable order. */
export function declaredPreparationAgents(profiles: BusinessProfilesConfig): string[] {
  return Object.entries(preparationBusinessProfiles(profiles).byAgent)
    .filter(([, category]) => category === PM_INTERVENTION_CATEGORY)
    .map(([agent]) => agent)
    .toSorted((left, right) => left.localeCompare(right))
}

/**
 * Choose an explicit PM or the single admissible one.
 * Zero or several available PMs ask the supervisor to select or configure one.
 */
export function resolvePreparationAgent(input: {
  requested?: string
  profiles: BusinessProfilesConfig
  nativeAgents?: readonly string[]
}): string {
  const requested = input.requested?.trim()
  if (requested) {
    if (input.nativeAgents === undefined) {
      throw new PreparationAdmissionError("unverified", `Native availability for ${JSON.stringify(requested)} is unverified. No permission was added.`)
    }
    if (!input.nativeAgents.includes(requested)) {
      throw new PreparationAdmissionError("unavailable", `Native agent ${JSON.stringify(requested)} is unavailable. No permission was added.`)
    }
    return requested
  }
  const declared = declaredPreparationAgents(input.profiles)
  if (declared.length === 0) throw new PreparationAdmissionError("selection", ZERO_PM)
  if (input.nativeAgents === undefined) {
    throw new PreparationAdmissionError("unverified", "Native availability of the declared PM is unverified. No permission was added.")
  }
  const available = declared.filter(agent => input.nativeAgents?.includes(agent))
  if (available.length === 0) {
    throw new PreparationAdmissionError("unavailable", `Declared PM agents are unavailable: ${declared.join(", ")}. No permission was added.`)
  }
  if (available.length > 1) {
    throw new PreparationAdmissionError("selection", `Several admissible PMs are available: ${available.join(", ")}. Run /ensemble-mission prepare --pm <agent> to select one. Ensemble does not install a native agent.`)
  }
  const agent = available[0]
  if (!agent) throw new PreparationAdmissionError("selection", ZERO_PM)
  return agent
}

/** Admit one native PM. Category and availability are mechanical; permissions are copied. */
export function admitPreparationAgent(input: {
  requested?: string
  profiles: BusinessProfilesConfig
  nativeAgents?: readonly string[]
  readOnly: boolean
  permissions: readonly string[]
}): ComposedIntervention {
  const agent = resolvePreparationAgent(input)
  const profiles = preparationBusinessProfiles(input.profiles)
  const declaredProfile = Object.hasOwn(profiles.byAgent, agent) ? profiles.byAgent[agent] ?? null : null
  const composed = composeIntervention(pmDiscoveryContract({
    objective: "Prepare the mission",
    instructions: PREPARATION_PM_INSTRUCTIONS,
  }), {
    agent,
    declaredProfile,
    readOnly: input.readOnly,
    nativeAvailability: "available",
    permissions: input.permissions,
  })
  if (!composed.accepted || !composed.prompt) {
    throw new PreparationAdmissionError("category", composed.refusal ?? "Category lock rejected the PM. No permission was added.")
  }
  return composed
}
