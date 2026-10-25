/** Version of a generic intervention contract. */
export const INTERVENTION_CONTRACT_VERSION = 1

/** Business category mechanically required for PM discovery. */
export const PM_INTERVENTION_CATEGORY = "pm"

const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const AVAILABILITY = ["available", "unavailable", "unverified"] as const

const PM_ENSEMBLE_CONTRACT = "Apply only this Ensemble mandate and your native profile. No tool, permission, model, or reasoning effort is added. Team participation does not replace your native expertise. If you are read-only, stay read-only and return documentary handoffs in your result for plugin persistence instead of writing the worktree. Do not launch tasks or workers."

/** Work asked of an agent without changing its native profile. */
export interface InterventionMandate {
  objective: string
  instructions: string
}

/** Ensemble mandate composed beside a native profile, never instead of it. */
export interface InterventionContract {
  version: typeof INTERVENTION_CONTRACT_VERSION
  id: string
  category: string
  mandate: InterventionMandate
  ensemble: string
}

/** Native agent facts. Permissions are copied, not extended. */
export interface InterventionTarget {
  agent: string
  declaredProfile: string | null
  readOnly: boolean
  nativeAvailability: "available" | "unavailable" | "unverified"
  permissions: readonly string[]
}

/** Result of composing a contract with one native agent. */
export interface ComposedIntervention {
  contract: InterventionContract
  agent: string
  effectiveCategory: string | null
  readOnly: boolean
  permissions: readonly string[]
  nativeAvailability: InterventionTarget["nativeAvailability"]
  accepted: boolean
  refusal?: string
  prompt?: string
}

function asRecord(value: object, field: string): Record<string, unknown> {
  if (Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

function rejectUnknown(value: object, allowed: readonly string[], field: string): Record<string, unknown> {
  const record = asRecord(value, field)
  const unexpected = Object.keys(record).find(key => !allowed.includes(key))
  if (unexpected !== undefined) throw new Error(`${field}.${unexpected} is not supported`)
  return record
}

function requiredText(value: unknown, field: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function mandateOf(value: object): InterventionMandate {
  const record = rejectUnknown(value, ["objective", "instructions"], "mandate")
  return {
    objective: requiredText(record.objective, "mandate.objective"),
    instructions: requiredText(record.instructions, "mandate.instructions", 20000),
  }
}

function assertContract(contract: InterventionContract): InterventionContract {
  if (!contract || typeof contract !== "object") throw new Error("contract must be an object")
  rejectUnknown(contract, ["version", "id", "category", "mandate", "ensemble"], "contract")
  if (contract.version !== INTERVENTION_CONTRACT_VERSION) throw new Error("Unsupported intervention contract version")
  const id = requiredText(contract.id, "contract.id", 64)
  const category = requiredText(contract.category, "contract.category", 64)
  if (!IDENTIFIER.test(id) || !IDENTIFIER.test(category)) throw new Error("contract id and category must be lower-kebab-case identifiers")
  if (!contract.mandate || typeof contract.mandate !== "object") throw new Error("contract.mandate must be an object")
  return {
    version: INTERVENTION_CONTRACT_VERSION,
    id,
    category,
    mandate: mandateOf(contract.mandate),
    ensemble: requiredText(contract.ensemble, "contract.ensemble"),
  }
}

function permissionsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error("target.permissions must be an array of non-empty strings")
  }
  return value.map(item => item.trim())
}

function targetOf(target: InterventionTarget): InterventionTarget {
  if (!target || typeof target !== "object") throw new Error("target must be an object")
  const record = rejectUnknown(target, ["agent", "declaredProfile", "readOnly", "nativeAvailability", "permissions"], "target")
  const agent = requiredText(record.agent, "target.agent", 128)
  const declared = record.declaredProfile
  if (declared !== null && (typeof declared !== "string" || !declared.trim())) throw new Error("target.declaredProfile must be a profile id or null")
  if (typeof record.readOnly !== "boolean") throw new Error("target.readOnly must be a boolean")
  if (typeof record.nativeAvailability !== "string" || !AVAILABILITY.includes(record.nativeAvailability as typeof AVAILABILITY[number])) {
    throw new Error("target.nativeAvailability must be available, unavailable, or unverified")
  }
  return {
    agent,
    declaredProfile: declared === null ? null : declared.trim(),
    readOnly: record.readOnly,
    nativeAvailability: record.nativeAvailability as InterventionTarget["nativeAvailability"],
    permissions: permissionsOf(record.permissions),
  }
}

/**
 * Build the concrete PM discovery contract.
 * The contract carries no permissions, tools, or model.
 */
export function pmDiscoveryContract(mandate: InterventionMandate): InterventionContract {
  return {
    version: INTERVENTION_CONTRACT_VERSION,
    id: "pm-discovery",
    category: PM_INTERVENTION_CATEGORY,
    mandate: mandateOf(mandate),
    ensemble: PM_ENSEMBLE_CONTRACT,
  }
}

/**
 * Compose a contract with one native agent.
 * Native permissions and the read-only flag are copied. Category mismatch and native unavailability refuse composition.
 * Lot 2 enforces a refused PM composition at admission; this function does not spawn or change permissions.
 */
export function composeIntervention(contract: InterventionContract, target: InterventionTarget): ComposedIntervention {
  const validated = assertContract(contract)
  const native = targetOf(target)
  const permissions = [...native.permissions]
  const base = {
    contract: validated,
    agent: native.agent,
    effectiveCategory: native.declaredProfile,
    readOnly: native.readOnly,
    permissions,
    nativeAvailability: native.nativeAvailability,
  }
  if (native.declaredProfile !== validated.category) {
    return {
      ...base,
      accepted: false,
      refusal: `Category lock rejected agent ${JSON.stringify(native.agent)}: declared profile ${JSON.stringify(native.declaredProfile)} is not ${JSON.stringify(validated.category)}. Native permissions stay ${JSON.stringify(permissions)}. No permission was added. Read-only agents, architect, and qa remain available to the supervisor for their own categories.`,
    }
  }
  if (native.nativeAvailability === "unavailable") {
    return {
      ...base,
      accepted: false,
      refusal: `Native agent ${JSON.stringify(native.agent)} is unavailable; the ${validated.category} intervention was not composed. Native permissions stay ${JSON.stringify(permissions)}. No permission was added.`,
    }
  }
  const lines = [
    `You are ${JSON.stringify(native.agent)}. Native expertise remains your declared profile ${JSON.stringify(native.declaredProfile)}. Permissions preserved: ${permissions.join(", ") || "(none declared)"}.`,
    validated.ensemble,
    `Mandate objective: ${validated.mandate.objective}`,
    validated.mandate.instructions,
  ]
  if (native.readOnly) lines.push("You remain read-only. Do not write files or mutate the worktree. Put documentary handoffs in the result for plugin persistence.")
  if (native.nativeAvailability === "unverified") lines.push("Native availability is unverified; do not treat it as confirmed.")
  return { ...base, accepted: true, prompt: lines.join("\n\n") }
}
