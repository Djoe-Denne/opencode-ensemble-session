/** A declarative business category, not a native agent or permission policy. */
export interface BusinessProfileDefinition {
  description: string
}

/** Project-owned additions and exact native-agent-to-principal-profile mappings. */
export interface BusinessProfilesConfig {
  extensions: Record<string, BusinessProfileDefinition>
  byAgent: Record<string, string>
}

/** Complete, independently obtained name inventories; omitted inventories are unverified. */
export interface BusinessProfileEvidence {
  diskAgents?: readonly string[]
  nativeAgents?: readonly string[]
}

/** Declaration is distinct from file presence and verified native availability. */
export interface BusinessProfileInspection {
  agent: string
  declaredProfile: string | null
  profile: (BusinessProfileDefinition & { id: string }) | null
  diskPresence: "present" | "absent" | "unverified"
  nativeAvailability: "available" | "unavailable" | "unverified"
}

/** Initial stable profile identities; extensions never replace these definitions. */
export const INITIAL_BUSINESS_PROFILES: Readonly<Record<string, Readonly<BusinessProfileDefinition>>> = Object.freeze({
  supervisor: Object.freeze({ description: "Mission coordination, scope arbitration, evidence tracking and presentation of user decisions." }),
  pm: Object.freeze({ description: "Requirements, priorities, work decomposition and progress tracking." }),
  architect: Object.freeze({ description: "Contracts, system boundaries and design decisions." }),
  developer: Object.freeze({ description: "Implementation and associated tests." }),
  qa: Object.freeze({ description: "Acceptance verification, reproduction and regression checks." }),
  reviewer: Object.freeze({ description: "Critical examination of changes, defects and risks." }),
  researcher: Object.freeze({ description: "Exploration, research and collection of sourced evidence." }),
  documentalist: Object.freeze({ description: "Structuring, integrating and maintaining documentation and knowledge." }),
})

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function validateFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected !== undefined) throw new Error(`${field}.${unexpected} is not supported`)
}

function readExtensions(value: unknown): BusinessProfilesConfig["extensions"] {
  if (value === undefined) return {}
  return Object.fromEntries(Object.entries(record(value, "businessProfiles.extensions")).map(([id, definition]) => {
    const field = `businessProfiles.extensions[${JSON.stringify(id)}]`
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`${field} must use a lower-kebab-case profile ID`)
    if (Object.hasOwn(INITIAL_BUSINESS_PROFILES, id)) throw new Error(`${field} cannot redefine an initial profile`)
    const raw = record(definition, field)
    validateFields(raw, ["description"], field)
    if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error(`${field}.description must be a non-empty string`)
    return [id, { description: raw.description }]
  }))
}

function readMappings(value: unknown): BusinessProfilesConfig["byAgent"] {
  if (value === undefined) return {}
  return Object.fromEntries(Object.entries(record(value, "businessProfiles.byAgent")).map(([agent, profile]) => {
    const field = `businessProfiles.byAgent[${JSON.stringify(agent)}]`
    if (!agent.trim()) throw new Error(`${field} must name a native agent`)
    if (typeof profile !== "string" || !profile.trim()) throw new Error(`${field} must reference one profile ID`)
    return [agent, profile]
  }))
}

/** Merge layers by exact key, then validate references against the complete initial and extension catalogue. */
export function resolveBusinessProfilesConfig(...layers: unknown[]): BusinessProfilesConfig {
  const merged = layers.reduce<BusinessProfilesConfig>((inherited, layer) => {
    if (layer === undefined) return inherited
    const raw = record(layer, "businessProfiles")
    validateFields(raw, ["extensions", "byAgent"], "businessProfiles")
    return {
      extensions: { ...inherited.extensions, ...readExtensions(raw.extensions) },
      byAgent: { ...inherited.byAgent, ...readMappings(raw.byAgent) },
    }
  }, { extensions: {}, byAgent: {} })
  Object.entries(merged.byAgent).forEach(([agent, profile]) => {
    if (Object.hasOwn(INITIAL_BUSINESS_PROFILES, profile) || Object.hasOwn(merged.extensions, profile)) return
    throw new Error(`businessProfiles.byAgent[${JSON.stringify(agent)}] references unknown profile ${JSON.stringify(profile)}`)
  })
  return merged
}

/** Inspect an exact native name using independent inventories, without I/O or changes to execution policy. */
export function inspectAgentBusinessProfile(
  config: BusinessProfilesConfig,
  agent: string,
  evidence: BusinessProfileEvidence = {},
): BusinessProfileInspection {
  const validated = resolveBusinessProfilesConfig(config)
  const declaredProfile = Object.hasOwn(validated.byAgent, agent) ? validated.byAgent[agent] ?? null : null
  const definition = declaredProfile === null ? undefined
    : Object.hasOwn(INITIAL_BUSINESS_PROFILES, declaredProfile) ? INITIAL_BUSINESS_PROFILES[declaredProfile] : validated.extensions[declaredProfile]
  return {
    agent,
    declaredProfile,
    profile: definition && declaredProfile !== null ? { id: declaredProfile, description: definition.description } : null,
    diskPresence: evidence.diskAgents === undefined ? "unverified" : evidence.diskAgents.includes(agent) ? "present" : "absent",
    nativeAvailability: evidence.nativeAgents === undefined ? "unverified" : evidence.nativeAgents.includes(agent) ? "available" : "unavailable",
  }
}
