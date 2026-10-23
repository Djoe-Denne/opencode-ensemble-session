import { describe, expect, test } from "bun:test"
import { createExecutionPolicy, executionStarts, routeExecution, validateExecutionPolicy, validateTaskExecutionDecision } from "../src/execution-policy"
import type { RoutingModel } from "../src/model-router"

const models: RoutingModel[] = [
  { id: "openai/a", reasoningEffort: "low", intelligenceScore: 40, averageCostPerTask: 1, available: true },
  { id: "openai/a", reasoningEffort: "high", intelligenceScore: 52, averageCostPerTask: 2, available: true },
  { id: "other/b", reasoningEffort: "max", intelligenceScore: 55, averageCostPerTask: 3, available: false },
]

describe("catalogue execution policy", () => {
  test("starts strongly but retains enabled lower reasoning for the same model", () => {
    const input = structuredClone(models)
    const policy = createExecutionPolicy(input, 50)
    expect(executionStarts(policy)).toEqual([{ id: "openai/a", variant: "high" }])
    expect(policy.models.map(model => model.reasoningEffort)).toEqual(["low", "high"])
    expect(policy.providers).toEqual(["openai"])
    const first = input[0]
    if (!first) throw new Error("Expected a fixture model")
    first.intelligenceScore = 41
    expect(policy.models[0]?.intelligenceScore).toBe(40)
  })

  test("never silently lowers a threshold with no eligible candidate", () => {
    expect(() => createExecutionPolicy(models, 60)).toThrow(/threshold/i)
  })

  test("rejects invalid thresholds", () => {
    expect(() => createExecutionPolicy(models, Number.NaN)).toThrow(/threshold/i)
  })

  test("retains the configured classification coefficient for explicit classification", () => {
    expect(createExecutionPolicy(models, 50, 0.8)).toMatchObject({ classificationBeta: 0.8 })
  })
})

describe("version 3 planning selection", () => {
  function policy(range: unknown = { min: 35, max: 60 }) {
    const value: unknown = { ...createExecutionPolicy(models, 50), version: 3, planningIntelligenceRange: range }
    validateExecutionPolicy(value)
    return value
  }

  test("keeps automatic starts strong while admitting an explicit lower planning pair", () => {
    const value = policy()
    expect(executionStarts(value)).toEqual([{ id: "openai/a", variant: "high" }])
    const decision = { mode: "planned" as const, kind: "code" as const, model: "openai/a", variant: "low", reason: "User requested this pair for a trivial task", authorizedBy: "lead" }
    expect(routeExecution(value, "task:revision", undefined, decision)).toMatchObject({
      selected: { id: "openai/a", variant: "low" }, authorization: decision, execution: { phase: "planning" },
    })
    expect(routeExecution(value, "task:revision").selected.variant).toBe("high")
    expect(routeExecution(value, "task:revision")).toEqual(routeExecution(value, "task:revision"))
  })

  test("optional maximum does not cap intelligence at 100", () => {
    const high = models[1]
    if (!high) throw new Error("Expected a high reasoning fixture")
    const value: unknown = { ...createExecutionPolicy([{ ...high, intelligenceScore: 120 }], 100), version: 3, planningIntelligenceRange: { min: 35 } }
    validateExecutionPolicy(value)
    expect(executionStarts(value)).toEqual([{ id: "openai/a", variant: "high" }])
  })

  test.each([null, {}, { min: -1 }, { min: 51 }, { min: 35, max: 49 }, { min: 35, max: Number.POSITIVE_INFINITY }, { min: Number.NaN }, { min: 35, extra: true }])("rejects invalid approved range %p", range => {
    expect(() => policy(range)).toThrow(/range/i)
  })

  test("does not silently remove an approved maximum or use it on direct work", () => {
    const value = policy({ min: 50, max: 52 })
    expect(() => routeExecution(value, "task", { id: "openai/a", variant: "low" })).toThrow(/range/i)
    expect(routeExecution(value, "task", undefined, { mode: "direct", kind: "code", model: "openai/a", variant: "low", authorizedBy: "lead" })).toMatchObject({ selected: { variant: "low" }, execution: { phase: "implementation" } })
  })

  test("planned explicit selection needs a reason and an approved exact native pair", () => {
    const value = policy()
    expect(() => routeExecution(value, "task", undefined, { mode: "planned", kind: "code", model: "openai/a", variant: "low", authorizedBy: "lead" })).toThrow(/reason/i)
    expect(() => routeExecution(value, "task", undefined, { mode: "planned", kind: "code", model: "other/unapproved", reason: "Explicit request", authorizedBy: "lead" })).toThrow(/catalogue/i)
    expect(() => validateTaskExecutionDecision({ mode: "planned", kind: "code", variant: "low", reason: "Explicit request" })).toThrow(/model/i)
  })

  test("a range is not accepted under version 2 or an unknown policy version", () => {
    const base = { ...createExecutionPolicy(models, 50), planningIntelligenceRange: { min: 35 } }
    expect(() => validateExecutionPolicy(base)).toThrow()
    expect(() => validateExecutionPolicy({ ...base, version: 4 })).toThrow()
  })

  test("version 2 selection and classification behavior remain unchanged", () => {
    const value = createExecutionPolicy(models, 50)
    expect(routeExecution(value, "classified", { id: "openai/a", variant: "low" }).selected.variant).toBe("low")
    expect(() => routeExecution(value, "task", undefined, { mode: "direct", kind: "code", authorizedBy: "lead" })).toThrow(/documentation|research/i)
    expect(() => routeExecution(value, "task", undefined, { mode: "planned", kind: "code", model: "openai/a", authorizedBy: "lead" })).toThrow(/routing/i)
  })
})
