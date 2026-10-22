import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("ensemble project setup skill copy", () => {
  test("keeps the distribution copy equal to the canonical skill", () => {
    const root = join(import.meta.dir, "..")
    for (const file of [
      "SKILL.md",
      "references/patch-recipes.md",
      "references/teammate-profile.md",
      "references/profile-lint.md",
      "references/mission-verification.md",
    ]) {
      expect(readFileSync(join(root, "skills/ensemble-project-setup", file), "utf8"))
        .toEqual(readFileSync(join(root, "agent/skills/ensemble-project-setup", file), "utf8"))
    }
  })
})
