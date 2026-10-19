import { describe, expect, spyOn, test } from "bun:test"
import {
  type MissionModelPolicy,
  type MissionPolicyModel,
  type MissionPolicyRoute,
  routeMissionModel,
  validateMissionModelPolicy,
} from "../src/mission-model-policy"

function policyFixture(): MissionModelPolicy {
  const matrix = [
    ["r0c0", "r0c1", "r0c2"],
    ["r1c0", "r1c1", "r1c2"],
    ["r2c0", "r2c1", "r2c2"],
  ]
  return {
    version: 1,
    providers: ["private", "mirror"],
    assessment: {
      complexity: ["Number of interacting components", "Uncertainty in the implementation"],
      risk: ["Impact of a failure", "Difficulty of rollback"],
    },
    complexityBands: [0, 34, 67, 101],
    riskBands: [0, 34, 67, 101],
    groups: Object.fromEntries(matrix.flat().map((group) => [group, [
      { id: `private/model-${group}`, variant: "precise" },
      { id: `mirror/namespace/model-${group}` },
      { id: `private/model-${group}`, variant: "fast" },
    ]])),
    matrix,
  }
}

function freezeDeep(value: unknown): void {
  if (typeof value !== "object" || value === null) return
  Object.values(value).forEach(freezeDeep)
  Object.freeze(value)
}

describe("validateMissionModelPolicy", () => {
  test("accepts the versioned rubric, authorized native models, and complete grid", () => {
    const policy: unknown = policyFixture()
    expect(() => validateMissionModelPolicy(policy)).not.toThrow()
    validateMissionModelPolicy(policy)
    const narrowed: MissionModelPolicy = policy
    expect(narrowed.version).toBe(1)
  })

  test("accepts both the minimum and maximum band counts", () => {
    const bandSets = [[0, 101], Array.from({ length: 102 }, (_, index) => index)]
    bandSets.forEach((bands) => {
      const policy = policyFixture()
      policy.complexityBands = bands
      policy.riskBands = bands
      policy.matrix = bands.slice(1).map(() => bands.slice(1).map(() => "r0c0"))
      expect(() => validateMissionModelPolicy(policy)).not.toThrow()
      expect(routeMissionModel(policy, { complexity: 100, risk: 100 }).group).toBe("r0c0")
    })
  })

  test.each(["complexity", "risk"] as const)("requires at least two criteria for %s assessment", (axis) => {
    const policy = policyFixture()
    policy.assessment[axis] = ["Only one criterion"]
    expect(() => validateMissionModelPolicy(policy)).toThrow(new RegExp(`assessment.${axis}.*at least (2|two)`, "i"))
  })

  test.each([
    ["null", null],
    ["array", []],
    ["string", "policy"],
    ["number", 1],
    ["undefined", undefined],
  ])("rejects a non-object policy: %s", (_label, value) => {
    expect(() => validateMissionModelPolicy(value)).toThrow(/policy.*object/i)
  })

  test.each([
    "version", "providers", "assessment", "complexityBands", "riskBands", "groups", "matrix",
  ])("rejects missing required field %s", (field) => {
    const policy: Record<string, unknown> = { ...policyFixture() }
    delete policy[field]
    expect(() => validateMissionModelPolicy(policy)).toThrow(new RegExp(field))
  })

  test.each([
    ["unsupported version", { version: 2 }, /version.*1/],
    ["string version", { version: "1" }, /version.*1/],
    ["extra field", { cost: 0 }, /cost|unknown|unexpected/i],
    ["providers missing", { providers: null }, /providers.*array/i],
    ["empty providers", { providers: [] }, /providers.*non.?empty/i],
    ["nonstring provider", { providers: [7] }, /providers\[0\]/],
    ["blank provider", { providers: [" "] }, /providers\[0\]/],
    ["slash in provider", { providers: ["private/model"] }, /providers\[0\].*slash|providers\[0\].*provider/i],
    ["provider whitespace", { providers: ["private "] }, /providers\[0\]/],
    ["missing assessment", { assessment: null }, /assessment.*object/i],
    ["array assessment", { assessment: [] }, /assessment.*object/i],
    ["empty complexity rubric", { assessment: { complexity: [], risk: ["Impact", "Rollback"] } }, /assessment.complexity/],
    ["blank complexity criterion", { assessment: { complexity: [" ", "Uncertainty"], risk: ["Impact", "Rollback"] } }, /assessment.complexity\[0\]/],
    ["empty risk rubric", { assessment: { complexity: ["Scope", "Uncertainty"], risk: [] } }, /assessment.risk/],
    ["nonstring risk criterion", { assessment: { complexity: ["Scope", "Uncertainty"], risk: [4, "Rollback"] } }, /assessment.risk\[0\]/],
    ["missing risk rubric", { assessment: { complexity: ["Scope", "Uncertainty"] } }, /assessment.risk/],
    ["unknown assessment field", { assessment: { complexity: ["Scope", "Uncertainty"], risk: ["Impact", "Rollback"], score: 50 } }, /score|unknown|unexpected/i],
    ["missing groups", { groups: null }, /groups.*object/i],
    ["array groups", { groups: [] }, /groups.*object/i],
    ["empty groups", { groups: {} }, /groups.*non.?empty/i],
    ["empty group name", { groups: { "": [{ id: "private/model" }] } }, /group.*non.?empty/i],
    ["blank group name", { groups: { " ": [{ id: "private/model" }] } }, /group.*non.?empty/i],
    ["empty candidates", { groups: { group: [] } }, /groups.*group.*non.?empty/i],
    ["non-array candidates", { groups: { group: {} } }, /groups.*group.*array/i],
  ] satisfies Array<[string, Record<string, unknown>, RegExp]>)("rejects invalid schema: %s", (_label, change, error) => {
    expect(() => validateMissionModelPolicy({ ...policyFixture(), ...change })).toThrow(error)
  })

  describe.each(["complexityBands", "riskBands"] as const)("%s", (field) => {
    test.each([
      ["not an array", null],
      ["no boundaries", []],
      ["one boundary", [0]],
      ["missing zero", [1, 34, 67, 101]],
      ["missing exclusive endpoint", [0, 34, 67, 100]],
      ["negative boundary", [0, -1, 67, 101]],
      ["out of range", [0, 34, 102, 101]],
      ["fractional boundary", [0, 33.5, 67, 101]],
      ["duplicate boundary", [0, 34, 34, 101]],
      ["reversed boundary", [0, 67, 34, 101]],
      ["string boundary", [0, "34", 67, 101]],
      ["NaN boundary", [0, Number.NaN, 67, 101]],
      ["infinite boundary", [0, 34, Number.POSITIVE_INFINITY, 101]],
      ["too many boundaries", Array.from({ length: 103 }, (_, index) => index)],
      ["sparse boundaries", Object.assign(new Array<number>(4), { 0: 0, 2: 67, 3: 101 })],
    ] satisfies Array<[string, unknown]>)("rejects %s", (_label, bands) => {
      expect(() => validateMissionModelPolicy({ ...policyFixture(), [field]: bands })).toThrow(new RegExp(field))
    })
  })

  test.each([
    ["non-object model", null],
    ["array model", []],
    ["missing ID", {}],
    ["numeric ID", { id: 1 }],
    ["empty ID", { id: "" }],
    ["no provider separator", { id: "model" }],
    ["empty provider", { id: "/model" }],
    ["empty model", { id: "private/" }],
    ["blank model", { id: "private/ " }],
    ["whitespace in ID", { id: "private/model name" }],
    ["embedded variant", { id: "private/model#precise" }],
    ["unauthorized provider", { id: "unapproved/model" }],
    ["empty variant", { id: "private/model", variant: "" }],
    ["blank variant", { id: "private/model", variant: " " }],
    ["numeric variant", { id: "private/model", variant: 3 }],
    ["null variant", { id: "private/model", variant: null }],
    ["unknown model field", { id: "private/model", cost: 0 }],
  ] satisfies Array<[string, unknown]>)("rejects invalid candidate: %s", (_label, candidate) => {
    const policy = policyFixture()
    expect(() => validateMissionModelPolicy({ ...policy, groups: { ...policy.groups, invalid: [candidate] } })).toThrow(/groups.*invalid.*\[0\]/)
  })

  test.each([
    [{ id: "private/model" }, { id: "private/model" }],
    [{ id: "private/model", variant: "precise" }, { id: "private/model", variant: "precise" }],
  ] satisfies MissionPolicyModel[][])("rejects duplicate exact identities", (...candidates) => {
    const policy = policyFixture()
    policy.groups.duplicate = candidates
    expect(() => validateMissionModelPolicy(policy)).toThrow(/groups.*duplicate.*duplicate/i)
  })

  test("allows the same model with distinct variants or in different groups", () => {
    const policy = policyFixture()
    const candidates = [{ id: "private/model" }, { id: "private/model", variant: "precise" }]
    policy.groups.first = candidates
    policy.groups.second = structuredClone(candidates)
    expect(() => validateMissionModelPolicy(policy)).not.toThrow()
  })

  test.each([
    ["missing matrix", undefined],
    ["non-array matrix", {}],
    ["empty matrix", []],
    ["too few rows", [["r0c0", "r0c1", "r0c2"]]],
    ["too many rows", Array.from({ length: 4 }, () => ["r0c0", "r0c1", "r0c2"])],
    ["non-array row", [null, ["r1c0", "r1c1", "r1c2"], ["r2c0", "r2c1", "r2c2"]]],
    ["too few columns", [["r0c0"], ["r1c0", "r1c1", "r1c2"], ["r2c0", "r2c1", "r2c2"]]],
    ["too many columns", [["r0c0", "r0c1", "r0c2", "r0c0"], ["r1c0", "r1c1", "r1c2"], ["r2c0", "r2c1", "r2c2"]]],
    ["unknown group", [["missing", "r0c1", "r0c2"], ["r1c0", "r1c1", "r1c2"], ["r2c0", "r2c1", "r2c2"]]],
    ["inherited group", [["toString", "r0c1", "r0c2"], ["r1c0", "r1c1", "r1c2"], ["r2c0", "r2c1", "r2c2"]]],
    ["nonstring group", [[5, "r0c1", "r0c2"], ["r1c0", "r1c1", "r1c2"], ["r2c0", "r2c1", "r2c2"]]],
    ["sparse row", [Object.assign(new Array<string>(3), { 1: "r0c1", 2: "r0c2" }), ["r1c0", "r1c1", "r1c2"], ["r2c0", "r2c1", "r2c2"]]],
  ] satisfies Array<[string, unknown]>)("rejects invalid matrix: %s", (_label, matrix) => {
    expect(() => validateMissionModelPolicy({ ...policyFixture(), matrix })).toThrow(/matrix/)
  })

  test("accepts explicitly declared prototype-like group names without modifying objects", () => {
    const policy = policyFixture()
    policy.groups = JSON.parse('{"__proto__":[{"id":"private/model"}]}')
    policy.matrix = policy.matrix.map((row) => row.map(() => "__proto__"))
    expect(() => validateMissionModelPolicy(policy)).not.toThrow()
    expect(routeMissionModel(policy, { complexity: 50, risk: 50 }).group).toBe("__proto__")
  })
})

describe("routeMissionModel", () => {
  const boundaries = [[0, 0], [33, 0], [34, 1], [66, 1], [67, 2], [100, 2]] as const
  boundaries.forEach(([complexity, complexityBand]) => {
    test.each(boundaries)(`routes complexity ${complexity} and risk %i to the left-inclusive band`, (risk, riskBand) => {
      const route: MissionPolicyRoute = routeMissionModel(policyFixture(), { complexity, risk })
      expect(route).toEqual({
        group: `r${riskBand}c${complexityBand}`,
        selected: { id: `private/model-r${riskBand}c${complexityBand}`, variant: "precise" },
        alternatives: [
          { id: `mirror/namespace/model-r${riskBand}c${complexityBand}` },
          { id: `private/model-r${riskBand}c${complexityBand}`, variant: "fast" },
        ],
        complexity,
        risk,
        complexityBand,
        riskBand,
      })
    })
  })

  test("covers all 10,201 integer score pairs without gaps or ambiguous cells", () => {
    const policy = policyFixture()
    const scores = Array.from({ length: 101 }, (_, score) => score)
    const band = (score: number) => score <= 33 ? 0 : score <= 66 ? 1 : 2
    scores.forEach((complexity) => {
      scores.forEach((risk) => {
        expect(routeMissionModel(policy, { complexity, risk }).group).toBe(`r${band(risk)}c${band(complexity)}`)
      })
    })
  })

  test("uses risk rows and complexity columns with different axis dimensions", () => {
    const policy = policyFixture()
    policy.complexityBands = [0, 51, 101]
    policy.riskBands = [0, 1, 100, 101]
    policy.matrix = [["r0c0", "r0c1"], ["r1c0", "r1c1"], ["r2c0", "r2c1"]]
    expect(routeMissionModel(policy, { complexity: 51, risk: 0 }).group).toBe("r0c1")
    expect(routeMissionModel(policy, { complexity: 50, risk: 1 }).group).toBe("r1c0")
    expect(routeMissionModel(policy, { complexity: 100, risk: 99 }).group).toBe("r1c1")
    expect(routeMissionModel(policy, { complexity: 0, risk: 100 }).group).toBe("r2c0")
  })

  test("preserves ordered equivalent fallbacks regardless of provider list order", () => {
    const policy = policyFixture()
    policy.providers.reverse()
    policy.groups.r0c0 = [
      { id: "private/equivalent", variant: "high" },
      { id: "mirror/equivalent", variant: "high" },
      { id: "private/equivalent" },
    ]
    const route = routeMissionModel(policy, { complexity: 0, risk: 0 })
    expect([route.selected, ...route.alternatives]).toEqual(policy.groups.r0c0)
    expect(route.selected.id).toBe("private/equivalent")
  })

  test("routes arbitrary authorized models and variants independently of catalogue or randomness", () => {
    const policy = policyFixture()
    policy.providers = ["future-connection", "offline-connection"]
    policy.groups = {
      chosen: [
        { id: "future-connection/unreleased-model", variant: "future-variant" },
        { id: "offline-connection/namespace/equivalent-model" },
      ],
    }
    policy.matrix = policy.matrix.map((row) => row.map(() => "chosen"))
    const random = spyOn(Math, "random").mockImplementation(() => { throw new Error("random routing") })
    try {
      const route = routeMissionModel(policy, { complexity: 100, risk: 100 })
      expect(route.selected).toEqual({ id: "future-connection/unreleased-model", variant: "future-variant" })
      expect(route.alternatives).toEqual([{ id: "offline-connection/namespace/equivalent-model" }])
      expect(routeMissionModel(structuredClone(policy), { complexity: 100, risk: 100 })).toEqual(route)
      expect(random).not.toHaveBeenCalled()
    } finally {
      random.mockRestore()
    }
  })

  test("returns an empty alternatives array for a single candidate", () => {
    const policy = policyFixture()
    policy.groups.r0c0 = [{ id: "private/only" }]
    expect(routeMissionModel(policy, { complexity: 0, risk: 0 }).alternatives).toEqual([])
  })

  describe.each(["complexity", "risk"] as const)("%s score", (field) => {
    test.each([
      ["missing", undefined], ["null", null], ["string", "50"], ["boolean", true],
      ["negative", -1], ["too large", 101], ["fraction", 33.5],
      ["NaN", Number.NaN], ["infinity", Number.POSITIVE_INFINITY],
    ] satisfies Array<[string, unknown]>)("rejects %s without supplying a default", (_label, value) => {
      const scores = { complexity: 50, risk: 50, [field]: value } as { complexity: number; risk: number }
      expect(() => routeMissionModel(policyFixture(), scores)).toThrow(new RegExp(`${field}.*integer.*0.*100`, "i"))
    })
  })

  test.each([
    ["missing", undefined], ["null", null], ["array", []], ["string", "50"],
  ] satisfies Array<[string, unknown]>)("rejects a non-object scores argument: %s", (_label, scores) => {
    expect(() => routeMissionModel(policyFixture(), scores as unknown as { complexity: number; risk: number })).toThrow(/scores.*object/i)
  })

  test("validates policies at routing time, including unselected groups", () => {
    const policy = policyFixture()
    policy.groups.r2c2 = [{ id: "unauthorized/model" }]
    expect(() => routeMissionModel(policy, { complexity: 0, risk: 0 })).toThrow(/groups.*r2c2/)
  })

  test("does not mutate inputs and returns detached candidate objects", () => {
    const policy = policyFixture()
    const scores = { complexity: 34, risk: 67 }
    const original = structuredClone(policy)
    freezeDeep(policy)
    freezeDeep(scores)
    validateMissionModelPolicy(policy)
    const route = routeMissionModel(policy, scores)
    route.selected.id = "modified/primary"
    const fallback = route.alternatives[0]
    if (fallback) fallback.id = "modified/fallback"
    route.alternatives.reverse()
    route.alternatives.push({ id: "modified/new" })
    expect(policy).toEqual(original)
    expect(scores).toEqual({ complexity: 34, risk: 67 })
    expect(routeMissionModel(policy, scores).selected.id).toBe("private/model-r2c1")
  })
})
