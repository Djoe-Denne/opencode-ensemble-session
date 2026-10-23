import { describe, expect, test } from "bun:test"
import { composeIntervention, pmDiscoveryContract, type InterventionTarget } from "../src/intervention-contract"

const mandate = { objective: "Decompose the mission", instructions: "Return every open question to the supervisor." }

function target(overrides: Partial<InterventionTarget> = {}): InterventionTarget {
  return {
    agent: "pm",
    declaredProfile: "pm",
    readOnly: true,
    nativeAvailability: "available",
    permissions: ["read"],
    ...overrides,
  }
}

describe("intervention contract", () => {
  test("composes a read-only pm without adding permissions", () => {
    const permissions = ["read"]
    const contract = pmDiscoveryContract(mandate)
    const result = composeIntervention(contract, target({ permissions }))

    expect(contract).toMatchObject({ version: 1, id: "pm-discovery", category: "pm", mandate })
    expect(result.accepted).toBe(true)
    expect(result.effectiveCategory).toBe("pm")
    expect(result.readOnly).toBe(true)
    expect(result.permissions).toEqual(["read"])
    expect(result.permissions).not.toBe(permissions)
    permissions.push("edit")
    expect(result.permissions).toEqual(["read"])
    expect(result.prompt).toContain(contract.ensemble)
    expect(result.prompt).toContain("Decompose the mission")
    expect(result.prompt).toMatch(/read-only/i)
    expect(result.prompt).toMatch(/no tool, permission, model, or reasoning effort is added/i)
    expect(result.prompt).not.toMatch(/team_spawn|promptAsync|session\.abort/)
  })

  test("keeps architect, qa, and other read-only agents available without the pm category", () => {
    const contract = pmDiscoveryContract(mandate)
    for (const declaredProfile of ["architect", "qa", null]) {
      const result = composeIntervention(contract, target({ agent: "explore", declaredProfile, permissions: ["read"] }))
      expect(result.accepted).toBe(false)
      expect(result.prompt).toBeUndefined()
      expect(result.permissions).toEqual(["read"])
      expect(result.refusal).toMatch(/not "pm"/)
      expect(result.refusal).toMatch(/No permission was added/)
    }
  })

  test("accepts another category only for its own declared profile", () => {
    const result = composeIntervention({
      version: 1,
      id: "architecture-review",
      category: "architect",
      mandate: { objective: "Review boundaries", instructions: "List the decisions already evidenced." },
      ensemble: "Keep native permissions.",
    }, target({ agent: "architect", declaredProfile: "architect", permissions: ["read"] }))

    expect(result.accepted).toBe(true)
    expect(result.effectiveCategory).toBe("architect")
    expect(result.permissions).toEqual(["read"])
  })

  test("refuses an unavailable native agent and reports unverified availability", () => {
    const contract = pmDiscoveryContract(mandate)
    const unavailable = composeIntervention(contract, target({ nativeAvailability: "unavailable" }))
    expect(unavailable.accepted).toBe(false)
    expect(unavailable.refusal).toMatch(/unavailable/i)
    expect(unavailable.permissions).toEqual(["read"])

    const unverified = composeIntervention(contract, target({ nativeAvailability: "unverified" }))
    expect(unverified.accepted).toBe(true)
    expect(unverified.prompt).toMatch(/unverified/i)
  })

  test("rejects contracts that try to carry tools or permissions", () => {
    const contract = pmDiscoveryContract(mandate)
    expect(() => composeIntervention({ ...contract, tool: "bash" } as typeof contract, target())).toThrow(/not supported/)
    expect(() => composeIntervention(contract, { ...target(), tools: ["write"] } as InterventionTarget)).toThrow(/not supported/)
    expect(() => pmDiscoveryContract({ objective: "  ", instructions: "Do the work." })).toThrow(/objective/)
  })
})
