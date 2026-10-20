import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSkillDefinitions, registerPluginSkills, resolvePluginSkillsDir } from "../src/plugin-skills"

const fixtures: string[] = []
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function skillFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ensemble-plugin-skills-"))
  fixtures.push(root)
  mkdirSync(join(root, "skills", "ensemble-project-setup"), { recursive: true })
  writeFileSync(join(root, "skills", "ensemble-project-setup", "SKILL.md"), "---\nname: Ensemble Project Setup\ndescription: sentinel skill\n---\nSetup guidance.\n")
  mkdirSync(join(root, "skills", "demo-skill"), { recursive: true })
  writeFileSync(join(root, "skills", "demo-skill", "SKILL.md"), `---\nname: Demo Skill\ndescription: "Demonstration skill for tests."\n---\n\nBody text.\n`)
  return root
}

describe("plugin skill self-registration", () => {
  test("resolves the skills directory from the package root or a nested directory", () => {
    const root = skillFixture()
    expect(resolvePluginSkillsDir(root)).toBe(join(root, "skills"))
    expect(resolvePluginSkillsDir(join(root, "skills"))).toBe(join(root, "skills"))
  })

  test("returns undefined when the sentinel skill is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-plugin-skills-empty-"))
    fixtures.push(root)
    expect(resolvePluginSkillsDir(root)).toBeUndefined()
  })

  test("reads every skill definition with frontmatter identity", () => {
    const root = skillFixture()
    mkdirSync(join(root, "skills", "zz-second"), { recursive: true })
    writeFileSync(join(root, "skills", "zz-second", "SKILL.md"), "---\nname: Second\n---\nContent.\n")
    const definitions = readSkillDefinitions(join(root, "skills"))
    expect(definitions.map(definition => definition.id)).toEqual(["demo-skill", "ensemble-project-setup", "zz-second"])
    expect(definitions[0]).toMatchObject({ name: "Demo Skill", description: "Demonstration skill for tests." })
    expect(definitions[1]?.name).toBe("Ensemble Project Setup")
    expect(definitions[0]?.content).toContain("Body text.")
  })

  test("registers the definitions through the host transform", async () => {
    const root = skillFixture()
    const added: Array<Record<string, unknown>> = []
    const registered = await registerPluginSkills({
      skill: { transform: async (callback) => { callback({ add: definition => { added.push(definition as unknown as Record<string, unknown>) } }); return undefined } },
    }, join(root, "skills"))
    expect(registered).toBe(true)
    expect(added).toHaveLength(2)
    expect(added[0]).toMatchObject({ id: "demo-skill", name: "Demo Skill" })
  })

  test("skips silently without a skill host or without definitions", async () => {
    expect(await registerPluginSkills({}, join(tmpdir()))).toBe(false)
    const root = skillFixture()
    expect(await registerPluginSkills({
      skill: { transform: async () => { throw new Error("transform must not run") } },
    }, join(tmpdir()))).toBe(false)
  })
})
