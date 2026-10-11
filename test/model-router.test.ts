import { describe, expect, test } from "bun:test"
import { routeModel, selectModelForIntelligence, type RoutingModel } from "../src/model-router"

const models: RoutingModel[] = [
  { id: "a/small", intelligenceScore: 30, averageCostPerTask: 0.02, available: true },
  { id: "b/free", intelligenceScore: 38, averageCostPerTask: 0, available: true },
  { id: "c/medium", reasoningEffort: "medium", intelligenceScore: 46, averageCostPerTask: 0.13, available: true },
  { id: "d/strong", reasoningEffort: "high", intelligenceScore: 54, averageCostPerTask: 1.82, available: true },
]

describe("routeModel", () => {
  test("zero complexity/risk chooses the cheapest sufficient model, not the weakest", () => {
    const route = routeModel({ complexity: 0, risk: 0, models })
    expect(route.selected.id).toBe("b/free")
    expect(route.demand).toBe(0)
    expect(route.requiredIntelligence).toBe(30)
    expect(route.reason).toContain("cheapest")
  })

  test("maximum complexity requires maximum available intelligence regardless of risk", () => {
    for (const risk of [0, 50, 100]) {
      const route = routeModel({ complexity: 100, risk, models })
      expect(route.selected.id).toBe("d/strong")
      expect(route.requiredIntelligence).toBe(54)
      expect(route.demand).toBe(1)
    }
  })

  test("risk never decreases the complexity-imposed threshold for any integer inputs", () => {
    for (let complexity = 0; complexity <= 100; complexity++) {
      let previous = routeModel({ complexity, risk: 0, models }).requiredIntelligence
      for (let risk = 1; risk <= 100; risk++) {
        const route = routeModel({ complexity, risk, models })
        expect(route.requiredIntelligence).toBeGreaterThanOrEqual(previous)
        expect(route.demand).toBeGreaterThanOrEqual(complexity / 100)
        expect(route.demand).toBeLessThanOrEqual(1)
        previous = route.requiredIntelligence
      }
    }
  })

  test("prefers a more intelligent AND cheaper candidate", () => {
    const route = routeModel({ complexity: 40, risk: 0, models: [
      ...models,
      { id: "e/better", intelligenceScore: 50, averageCostPerTask: 0.01, available: true },
    ] })
    expect(route.selected.id).toBe("e/better")
  })

  test("unavailable models affect neither selection nor catalogue scale nor fallback", () => {
    const route = routeModel({ complexity: 100, risk: 0, models: [
      ...models,
      { id: "e/offline", intelligenceScore: 100, averageCostPerTask: 0, available: false },
    ] })
    expect(route.selected.id).toBe("d/strong")
    expect(route.requiredIntelligence).toBe(54)
    expect(route.fallback).toBeNull()
  })

  test("uses beta 0.35 by default and honors configurable beta including zero", () => {
    expect(routeModel({ complexity: 50, risk: 100, models }).demand).toBeCloseTo(0.675)
    expect(routeModel({ complexity: 50, risk: 100, models, beta: 0 }).demand).toBe(0.5)
    expect(routeModel({ complexity: 50, risk: 100, models, beta: 1 }).demand).toBe(1)
  })

  test("prefers the cheapest sufficient fallback from a different provider", () => {
    const catalogue: RoutingModel[] = [
      { id: "a/first", intelligenceScore: 50, averageCostPerTask: 0, available: true },
      { id: "a/second", intelligenceScore: 50, averageCostPerTask: 0.01, available: true },
      { id: "b/third", intelligenceScore: 50, averageCostPerTask: 0.02, available: true },
      { id: "c/fourth", intelligenceScore: 50, averageCostPerTask: 0.03, available: true },
    ]
    expect(routeModel({ complexity: 0, risk: 0, models: catalogue }).fallback?.id).toBe("b/third")
    expect(routeModel({ complexity: 0, risk: 0, models: catalogue.slice(0, 2) }).fallback?.id).toBe("a/second")
  })

  test("treats reasoning efforts of the same model as distinct candidates", () => {
    const catalogue: RoutingModel[] = [
      { id: "a/model", reasoningEffort: "medium", intelligenceScore: 40, averageCostPerTask: 0.2, available: true },
      { id: "a/model", reasoningEffort: "high", intelligenceScore: 50, averageCostPerTask: 0.5, available: true },
    ]
    expect(routeModel({ complexity: 0, risk: 0, models: catalogue }).selected.reasoningEffort).toBe("medium")
    expect(routeModel({ complexity: 100, risk: 0, models: catalogue }).selected.reasoningEffort).toBe("high")
  })

  test("ties are deterministic even if the catalogue order changes; inputs are not mutated", () => {
    const catalogue = [models[0]!, { ...models[0]!, id: "z/small" }, { ...models[0]!, id: "b/small", intelligenceScore: 31 }]
    const original = structuredClone(catalogue)
    const first = routeModel({ complexity: 0, risk: 0, models: catalogue })
    expect(routeModel({ complexity: 0, risk: 0, models: [...catalogue].reverse() })).toEqual(first)
    expect(first.selected.id).toBe("b/small")
    expect(catalogue).toEqual(original)
  })

  test("supports a single available model and a flat intelligence scale", () => {
    expect(routeModel({ complexity: 80, risk: 90, models: [models[0]!] }).fallback).toBeNull()
    expect(routeModel({ complexity: 80, risk: 90, models: [models[0]!] }).requiredIntelligence).toBe(30)
  })

  test("no sufficient candidate defensively selects the strongest available, cheapest on ties", () => {
    const selection = selectModelForIntelligence({ requiredIntelligence: 60, models: [
      ...models,
      { id: "e/strong-cheaper", intelligenceScore: 54, averageCostPerTask: 1, available: true },
    ] })
    expect(selection.selected.id).toBe("e/strong-cheaper")
    expect(selection.fallback?.id).toBe("d/strong")
    expect(selection.reason).toContain("No available candidate meets")
  })

  test("rejects an empty or wholly unavailable catalogue explicitly", () => {
    expect(() => routeModel({ complexity: 1, risk: 1, models: [] })).toThrow("available")
    expect(() => routeModel({ complexity: 1, risk: 1, models: models.map(m => ({ ...m, available: false })) })).toThrow("available")
  })

  test("rejects invalid scores, beta, costs and duplicate model/effort entries", () => {
    for (const complexity of [-1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => routeModel({ complexity, risk: 0, models })).toThrow("complexity")
      expect(() => routeModel({ complexity: 0, risk: complexity, models })).toThrow("risk")
    }
    for (const beta of [-1, 1.1, Number.NaN]) {
      expect(() => routeModel({ complexity: 0, risk: 0, models, beta })).toThrow("beta")
    }
    expect(() => routeModel({ complexity: 0, risk: 0, models: [{ ...models[0]!, averageCostPerTask: -1 }] })).toThrow("averageCostPerTask")
    expect(() => routeModel({ complexity: 0, risk: 0, models: [{ ...models[0]!, intelligenceScore: Number.NaN }] })).toThrow("intelligenceScore")
    expect(() => routeModel({ complexity: 0, risk: 0, models: [{ ...models[0]!, averageCostPerTask: Number.POSITIVE_INFINITY }] })).toThrow("averageCostPerTask")
    expect(() => routeModel({ complexity: 0, risk: 0, models: [models[0]!, models[0]!] })).toThrow("Duplicate")
  })
})
