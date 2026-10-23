import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveBusinessProfilesConfig } from "../src/business-profiles"

const root = join(import.meta.dir, "..")
const canonical = join(root, "skills/ensemble-project-setup")
const distributed = join(root, "agent/skills/ensemble-project-setup")
const read = (directory: string, file: string): string => readFileSync(join(directory, file), "utf8")

describe("setup business-profile contract", () => {
  test("makes categorization part of discovery, proposal, application and validation", () => {
    expect(read(canonical, "SKILL.md")).toContain("businessProfiles.byAgent")
    expect(read(canonical, "references/inventory.md")).toContain("businessProfiles")
    expect(read(canonical, "references/validation.md")).toContain("businessProfiles")
    const recipes = read(canonical, "references/patch-recipes.md")
    expect(recipes).toContain("## Business Profile Associations")
    expect(recipes).toContain("native availability")
    expect(recipes).toContain("permissions")
    expect(recipes).toContain("approval")
  })

  test("provides a recipe accepted by the shipped declarative configuration contract", () => {
    const recipes = read(canonical, "references/patch-recipes.md")
    const jsonBlocks = [...recipes.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map(match => JSON.parse(match[1] ?? "null") as { businessProfiles?: unknown })
    const recipe = jsonBlocks.find(block => Object.hasOwn(block, "businessProfiles"))
    expect(recipe).toBeDefined()
    const resolved = resolveBusinessProfilesConfig(recipe?.businessProfiles)
    expect(resolved.byAgent["api-specialist"]).toBe("developer")
    expect(resolved.byAgent["docs-reviewer"]).toBe("reviewer")
    expect(resolved.byAgent["security-reader"]).toBe("security-reviewer")
    expect(resolved.extensions["security-reviewer"]?.description).toBeTruthy()
    expect(resolveBusinessProfilesConfig(resolved, recipe?.businessProfiles)).toEqual(resolved)
  })

  test("includes bounded categorization and inherited no-op evaluation scenarios", () => {
    const evaluations = JSON.parse(read(canonical, "evals/evals.json")) as {
      evals: Array<{ name: string; expectations: string[] }>
    }
    expect(evaluations.evals.map(item => item.name)).toContain("business-profile-approved-creation-and-adaptation")
    expect(evaluations.evals.map(item => item.name)).toContain("business-profile-inherited-and-ambiguous")
  })

  test("ships the same categorization workflow and scenarios in the distribution copy", () => {
    const files = ["SKILL.md", "README.md", "references/inventory.md", "references/patch-recipes.md",
      "references/validation.md", "evals/evals.json", "evals/README.md"]
    files.forEach(file => {
      expect(read(distributed, file)).toBe(read(canonical, file))
    })
  })
})
