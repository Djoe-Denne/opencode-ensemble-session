import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function project(missionPolicy: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-mission-config-"))
  directories.push(directory)
  mkdirSync(join(directory, ".opencode"))
  writeFileSync(join(directory, ".opencode", "ensemble.json"), JSON.stringify({ missionPolicy }))
  return directory
}

describe("mission policy defaults", () => {
  test("loads a complete explicit project policy without merging individual grid fragments", () => {
    const policy = { version: 1 as const, providers: ["fixture"], assessment: { complexity: ["Low", "High"], risk: ["Low", "High"] },
      complexityBands: [0, 101], riskBands: [0, 101], groups: { chosen: [{ id: "fixture/model" }] }, matrix: [["chosen"]] }
    expect(loadConfig(project(policy)).missionPolicy).toEqual(policy)
    expect(loadConfig(project(null)).missionPolicy).toBeNull()
  })

  test.each([false, { version: 99 }, { version: 1, providers: [] }])("invalid explicit default %p fails closed instead of reverting to catalogue routing", policy => {
    expect(() => loadConfig(project(policy))).toThrow("mission model policy")
  })
})
