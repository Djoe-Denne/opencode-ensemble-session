import { describe, expect, test } from "bun:test"
import { createExecutionPolicy, executionStarts } from "../src/execution-policy"
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
