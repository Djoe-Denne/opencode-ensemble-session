import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import catalogue from "../examples/ensemble.model-routing.json"
import { routeModel, validateModelRoutingConfig } from "../src/model-router"

describe("supplied model catalogue", () => {
  test("keeps all 17 user-supplied model/effort/cost combinations", () => {
    expect(() => validateModelRoutingConfig(catalogue.modelRouting)).not.toThrow()
    expect(catalogue.modelRouting.models).toHaveLength(17)
    expect(new Set(catalogue.modelRouting.models.map(model => model.provider)).size).toBe(5)
    expect(catalogue.modelRouting.models.find(model => model.id === "cursor/claude-opus-5-5")).toMatchObject({
      reasoningEffort: "medium", intelligenceScore: 51, averageCostPerTask: 1.34, cursorBenchCostPerTask: 2.91,
    })
  })

  test("uses comparable AA cost, picks a free sufficient model and the maximum at complexity 100", () => {
    const { models, beta } = catalogue.modelRouting
    expect(routeModel({ complexity: 0, risk: 0, models, beta }).selected.id).toBe("opencode/step-5-preview-free")
    expect(routeModel({ complexity: 100, risk: 0, models, beta }).selected).toMatchObject({ id: "opencode/claude-opus-5-5", reasoningEffort: "high", intelligenceScore: 54 })
    expect(routeModel({ complexity: 0, risk: 0, models, beta }).fallback?.id).toBe("opencode-go/gpt-6-luna")
  })

  test("maintenance skill is opt-in and synchronized with the distribution copy", () => {
    const root = join(import.meta.dir, "..")
    const canonical = readFileSync(join(root, "skills/ensemble-model-catalogue/SKILL.md"), "utf8")
    const distribution = readFileSync(join(root, "agent/skills/ensemble-model-catalogue/SKILL.md"), "utf8")
    expect(canonical).toEqual(distribution)
    expect(canonical).toContain("disable-model-invocation: true")
    expect(canonical).toContain("Missing cost is not zero")
    expect(canonical).toContain("ask approval")
    expect(canonical.split("\n").length).toBeLessThan(500)
    for (const file of ["references/maintenance-state.md", "evals/evals.json"]) {
      expect(readFileSync(join(root, "skills/ensemble-model-catalogue", file), "utf8"))
        .toEqual(readFileSync(join(root, "agent/skills/ensemble-model-catalogue", file), "utf8"))
    }
  })

  test("refresh separates active-only reevaluation from dated discovery and opt-in activation", () => {
    const skill = readFileSync(join(import.meta.dir, "../skills/ensemble-model-catalogue/SKILL.md"), "utf8")
    expect(skill).toContain("Reevaluate only activated models")
    expect(skill).toContain("lastEvaluatedAt")
    expect(skill).toContain("lastSyncedAt")
    expect(skill).toContain("dated web research")
    expect(skill).toContain("explicit activation approval")
    expect(skill).toContain("No new candidate becomes available automatically")
    expect(skill).toContain("references/maintenance-state.md")
  })

  test("maintenance dates are not invented from seed import or a partial refresh", () => {
    const skill = readFileSync(join(import.meta.dir, "../skills/ensemble-model-catalogue/SKILL.md"), "utf8")
    expect(skill).toContain("No date means unknown")
    expect(skill).toContain("do not advance a success timestamp")
    expect(skill).toContain("Preserve declined and pending candidates")
  })
})
