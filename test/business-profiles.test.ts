import { describe, expect, test } from "bun:test"
import {
  INITIAL_BUSINESS_PROFILES,
  inspectAgentBusinessProfile,
  resolveBusinessProfilesConfig,
} from "../src/business-profiles"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { insertTeam, setupDeps } from "./helpers"

describe("declarative business profiles", () => {
  test("provides the eight stable initial identities and immutable descriptions", () => {
    expect(Object.keys(INITIAL_BUSINESS_PROFILES)).toEqual([
      "supervisor", "pm", "architect", "developer", "qa", "reviewer", "researcher", "documentalist",
    ])
    expect(Object.isFrozen(INITIAL_BUSINESS_PROFILES)).toBe(true)
    Object.values(INITIAL_BUSINESS_PROFILES).forEach(profile => {
      expect(profile.description.trim().length).toBeGreaterThan(0)
      expect(Object.isFrozen(profile)).toBe(true)
    })
  })

  test("missing mappings never infer a business profile from a native name", () => {
    const config = resolveBusinessProfilesConfig()
    expect(config).toEqual({ extensions: {}, byAgent: {} })
    Object.keys(INITIAL_BUSINESS_PROFILES).forEach(agent => {
      expect(inspectAgentBusinessProfile(config, agent)).toEqual({
        agent, declaredProfile: null, profile: null,
        diskPresence: "unverified", nativeAvailability: "unverified",
      })
    })
  })

  test("resolves explicit many-to-one mappings without normalizing native names", () => {
    const config = resolveBusinessProfilesConfig({ byAgent: {
      implementer: "developer", "second-builder": "developer", "Code-Reviewer": "reviewer",
      " implementer ": "architect", orchestrator: "supervisor",
    } })
    expect(inspectAgentBusinessProfile(config, "implementer").profile?.id).toBe("developer")
    expect(inspectAgentBusinessProfile(config, "second-builder").profile?.id).toBe("developer")
    expect(inspectAgentBusinessProfile(config, "Code-Reviewer").profile?.id).toBe("reviewer")
    expect(inspectAgentBusinessProfile(config, "code-reviewer").profile).toBeNull()
    expect(inspectAgentBusinessProfile(config, " implementer ").profile?.id).toBe("architect")
    expect(inspectAgentBusinessProfile(config, "orchestrator").profile?.id).toBe("supervisor")
  })

  test("merges extensions and mappings by key, validating references after all layers", () => {
    const config = resolveBusinessProfilesConfig(
      { extensions: { security: { description: "Initial security review" } }, byAgent: {
        first: "security", second: "researcher", projectOnly: "domain-expert",
      } },
      { extensions: { security: { description: "Project security review" }, "domain-expert": { description: "Domain evidence" } },
        byAgent: { second: "documentalist", third: "security" } },
    )
    expect(config.byAgent).toEqual({ first: "security", second: "documentalist", projectOnly: "domain-expert", third: "security" })
    expect(inspectAgentBusinessProfile(config, "first").profile).toEqual({ id: "security", description: "Project security review" })
    expect(inspectAgentBusinessProfile(config, "projectOnly").profile?.id).toBe("domain-expert")
  })

  test.each([
    [null, "businessProfiles"],
    [[], "businessProfiles"],
    [{ extensions: [] }, "extensions"],
    [{ byAgent: [] }, "byAgent"],
    [{ byAgent: { implementer: ["developer", "qa"] } }, "implementer"],
    [{ byAgent: { " ": "developer" } }, "byAgent"],
    [{ byAgent: { implementer: "" } }, "implementer"],
    [{ byAgent: { implementer: "Developer" } }, "Developer"],
    [{ byAgent: { implementer: " developer " } }, " developer "],
    [{ byAgent: { implementer: "missing" } }, "missing"],
    [{ extensions: { Developer: { description: "Bad ID" } } }, "Developer"],
    [{ extensions: { "bad--id": { description: "Bad ID" } } }, "bad--id"],
    [{ extensions: { developer: { description: "Cannot redefine a built-in" } } }, "developer"],
    [{ extensions: { security: null } }, "security"],
    [{ extensions: { security: { description: " " } } }, "description"],
    [{ extensions: { security: { description: "Review", permissions: [] } } }, "permissions"],
    [{ byAgent: {}, model: "provider/model" }, "model"],
  ])("rejects invalid declarations with a field-specific diagnostic: %j", (raw, diagnostic) => {
    expect(() => resolveBusinessProfilesConfig(raw)).toThrow(String(diagnostic))
  })

  test("an invalid override cannot silently restore an inherited mapping", () => {
    expect(() => resolveBusinessProfilesConfig(
      { byAgent: { implementer: "developer" } }, { byAgent: { implementer: "typo" } },
    )).toThrow(/byAgent.*implementer.*typo/)
  })

  test("prototype property names are not implicit declarations or reserved profile IDs", () => {
    const config = resolveBusinessProfilesConfig({
      extensions: { constructor: { description: "Explicit custom category" } },
      byAgent: JSON.parse('{"__proto__":"constructor"}'),
    })
    expect(inspectAgentBusinessProfile(config, "toString").declaredProfile).toBeNull()
    expect(inspectAgentBusinessProfile(config, "__proto__").profile?.id).toBe("constructor")
    expect(() => resolveBusinessProfilesConfig({ byAgent: { native: "toString" } })).toThrow("toString")
  })

  test("declaration, disk presence and native availability are independent evidence", () => {
    const config = resolveBusinessProfilesConfig({ byAgent: { implementer: "developer" } })
    expect(inspectAgentBusinessProfile(config, "implementer")).toMatchObject({
      declaredProfile: "developer", diskPresence: "unverified", nativeAvailability: "unverified",
    })
    expect(inspectAgentBusinessProfile(config, "implementer", { diskAgents: ["implementer"] })).toMatchObject({
      diskPresence: "present", nativeAvailability: "unverified",
    })
    expect(inspectAgentBusinessProfile(config, "implementer", { diskAgents: ["implementer"], nativeAgents: [] })).toMatchObject({
      diskPresence: "present", nativeAvailability: "unavailable",
    })
    expect(inspectAgentBusinessProfile(config, "implementer", { diskAgents: [], nativeAgents: ["implementer"] })).toMatchObject({
      diskPresence: "absent", nativeAvailability: "available",
    })
    expect(inspectAgentBusinessProfile(config, "build", { nativeAgents: ["build"] })).toMatchObject({
      declaredProfile: null, diskPresence: "unverified", nativeAvailability: "available",
    })
    expect(inspectAgentBusinessProfile(config, "implementer", { nativeAgents: ["Implementer"] }).nativeAvailability).toBe("unavailable")
  })

  test("resolution and inspection never mutate input, evidence or the shared catalogue", () => {
    const raw = Object.freeze({
      extensions: Object.freeze({ security: Object.freeze({ description: "Security evidence" }) }),
      byAgent: Object.freeze({ expert: "security", implementer: "developer" }),
    })
    const evidence = Object.freeze({ diskAgents: Object.freeze(["expert"]), nativeAgents: Object.freeze(["expert"]) })
    const config = resolveBusinessProfilesConfig(raw)
    const before = JSON.stringify(config)
    const inspected = inspectAgentBusinessProfile(config, "expert", evidence)
    if (inspected.profile) inspected.profile.description = "Caller-local change"
    expect(JSON.stringify(config)).toBe(before)
    expect(inspectAgentBusinessProfile(config, "expert", evidence).profile?.description).toBe("Security evidence")
    const builtin = inspectAgentBusinessProfile(config, "implementer")
    if (builtin.profile) builtin.profile.description = "Not the canonical description"
    expect(inspectAgentBusinessProfile(config, "implementer").profile?.description).toBe(INITIAL_BUSINESS_PROFILES.developer?.description)
    config.byAgent.extra = "pm"
    if (config.extensions.security) config.extensions.security.description = "Another caller-local change"
    expect(resolveBusinessProfilesConfig(raw).byAgent).toEqual(raw.byAgent)
    expect(resolveBusinessProfilesConfig(raw).extensions).toEqual(raw.extensions)
    expect(resolveBusinessProfilesConfig()).toEqual({ extensions: {}, byAgent: {} })
  })

  test("declared business profiles cannot rename natives, choose models, change permissions or grant lead authority", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "profiles-team", "profiles", "profiles-lead")
    deps.config.modelsByAgent = { implementer: "native/chosen", supervisor: "wrong/business-profile" }
    try {
      await executeTeamSpawn(deps, { name: "baseline", agent: "implementer", prompt: "Bounded work", worktree: false }, "profiles-lead")
      const baselineCreate = deps.client.calls.find(call => call.method === "session.create")?.args[0]
      const baselinePermission = typeof baselineCreate === "object" && baselineCreate !== null && "permission" in baselineCreate ? baselineCreate.permission : undefined
      expect(baselinePermission).toBeDefined()
      deps.client.calls.length = 0
      deps.config.businessProfiles = resolveBusinessProfilesConfig({ byAgent: { implementer: "supervisor" } })
      await executeTeamSpawn(deps, { name: "worker", agent: "implementer", prompt: "Bounded work", worktree: false }, "profiles-lead")
      const create = deps.client.calls.find(call => call.method === "session.create")?.args[0]
      const delivery = deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]
      expect(delivery).toMatchObject({ agent: "implementer", model: { providerID: "native", modelID: "chosen" } })
      expect(create).toHaveProperty("permission", baselinePermission)
      const member = deps.db.query("SELECT session_id, agent FROM team_member WHERE name = 'worker'").get() as { session_id: string; agent: string }
      expect(member.agent).toBe("implementer")
      const team = deps.db.query("SELECT lead_session_id FROM team WHERE id = 'profiles-team'").get() as { lead_session_id: string }
      expect(team.lead_session_id).toBe("profiles-lead")
      await expect(executeTeamSpawn(deps, { name: "unauthorized", prompt: "Do not admit", worktree: false }, member.session_id)).rejects.toThrow(/lead/i)
    } finally {
      deps.db.close()
    }
  })
})
