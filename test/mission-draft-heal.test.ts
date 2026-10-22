import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupDeps, historicalModelPolicy, prepareHistoricalMission as prepareMission } from "./helpers"
import { approveMission, openMissionConfiguration } from "../src/mission-policy"
import { applyMissionClassification } from "../src/mission-classification"
import type { MissionCommandDefinition, MissionCommandInvocation } from "../src/mission-commands"

const fixtures: string[] = []

afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function fixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-mission-draft-heal-"))
  fixtures.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { beta: 0.35, models: [
    { id: "allowed/light", intelligenceScore: 10, averageCostPerTask: 0.1, available: true },
    { id: "allowed/standard", reasoningEffort: "medium", intelligenceScore: 20, averageCostPerTask: 0.2, available: true },
    { id: "other/strong", reasoningEffort: "high", intelligenceScore: 30, averageCostPerTask: 1, available: true },
  ] } }
  deps.config.missionPolicy = historicalModelPolicy(deps)
  return deps
}

function junkDraft(mission: { policyPath: string }, classification: unknown): void {
  const seeded = JSON.parse(readFileSync(mission.policyPath, "utf8"))
  seeded.classification = classification
  seeded.foo = "junk"
  writeFileSync(mission.policyPath, JSON.stringify(seeded, null, 2))
}

describe("mission draft self-healing", () => {
  test("config extracts a classification block, drops unknown fields, and rewrites the draft clean", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    junkDraft(mission, {
      mode: "general", generalModel: "openai/gpt-6.1-sol", generalVariant: "high",
      fallbacks: [], limits: { retries: 1, maxAttempts: 3, timeoutMs: 30000 },
    })
    deps.classifier = { list: async () => [], invoke: async () => { throw new Error("classifier must not run") }, general: async () => ({}) }

    const proposal = openMissionConfiguration(deps, mission.teamId, "lead")
    expect(proposal.warnings.some(warning => warning.includes("foo"))).toBe(true)
    expect(proposal.classificationOverride).toMatchObject({
      mode: "general", generalModel: "openai/gpt-6.1-sol", generalVariant: "high", timeoutMs: 30000,
    })
    const healed = JSON.parse(readFileSync(mission.policyPath, "utf8"))
    expect(healed.classification).toBeUndefined()
    expect(healed.foo).toBeUndefined()
    expect(healed.providers).toEqual(["allowed", "other"])

    const applied = await applyMissionClassification(deps, mission.teamId, proposal.classificationOverride!)
    expect(applied.method).toBe("general")
    const team = deps.db.query("SELECT classification_policy FROM team WHERE id = ?").get(mission.teamId) as { classification_policy: string }
    expect(JSON.parse(team.classification_policy)).toMatchObject({ method: "general", generalModel: "openai/gpt-6.1-sol" })
  })

  test("an invalid classification block downgrades to a warning and never bricks config", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    junkDraft(mission, { mode: "general" })
    deps.classifier = { list: async () => [], invoke: async () => { throw new Error("classifier must not run") }, general: async () => ({}) }

    const proposal = openMissionConfiguration(deps, mission.teamId, "lead")
    expect(proposal.classificationOverride).toMatchObject({ mode: "general" })
    await expect(applyMissionClassification(deps, mission.teamId, proposal.classificationOverride!)).rejects.toThrow(/generalModel/)
    const team = deps.db.query("SELECT classification_policy FROM team WHERE id = ?").get(mission.teamId) as { classification_policy: string }
    expect(JSON.parse(team.classification_policy).method).toBe("manual")
  })

  test("a frozen-shaped classification block normalizes its method into a mode", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    junkDraft(mission, { method: "general", generalModel: "openai/gpt-6.1-sol" })
    deps.classifier = { list: async () => [], invoke: async () => { throw new Error("classifier must not run") }, general: async () => ({}) }

    const proposal = openMissionConfiguration(deps, mission.teamId, "lead")
    expect(proposal.classificationOverride).toMatchObject({ mode: "general", generalModel: "openai/gpt-6.1-sol" })
  })

  test("a duplicated timeoutMs keeps the top-level value and drops the stray limits key", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    junkDraft(mission, { mode: "general", generalModel: "openai/gpt-6.1-sol", timeoutMs: 45000, limits: { retries: 1, maxAttempts: 3, timeoutMs: 30000 } })
    deps.classifier = { list: async () => [], invoke: async () => { throw new Error("classifier must not run") }, general: async () => ({}) }

    const proposal = openMissionConfiguration(deps, mission.teamId, "lead")
    expect(proposal.classificationOverride).toMatchObject({ timeoutMs: 45000 })
    expect(proposal.classificationOverride!.limits).not.toHaveProperty("timeoutMs")
    const applied = await applyMissionClassification(deps, mission.teamId, proposal.classificationOverride!)
    expect(applied.method).toBe("general")
  })

  test("a classification block re-added after presentation fails start explicitly instead of deferring", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    openMissionConfiguration(deps, mission.teamId, "lead")
    const seeded = JSON.parse(readFileSync(mission.policyPath, "utf8"))
    seeded.classification = { mode: "general", generalModel: "openai/gpt-6.1-sol" }
    writeFileSync(mission.policyPath, JSON.stringify(seeded, null, 2))
    const { getPresentedMission } = await import("../src/mission-policy")
    expect(() => getPresentedMission(deps, mission.teamId, "lead")).toThrow(/classification block/iu)
  })

  test("a draft re-junked after presentation still fails start with the change guard", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    openMissionConfiguration(deps, mission.teamId, "lead")
    const seeded = JSON.parse(readFileSync(mission.policyPath, "utf8"))
    seeded.groups.strong = [{ id: "allowed/light" }]
    writeFileSync(mission.policyPath, JSON.stringify(seeded, null, 2))
    expect(() => approveMission(deps, mission.teamId, "lead")).toThrow(/config again/)
  })

  test("the config command applies the draft classification block and reports the repair", async () => {
    const deps = fixture()
    const commands: MissionCommandDefinition[] = []
    const prompts: unknown[] = []
    const { registerMissionCommands } = await import("../src/mission-commands")
    await registerMissionCommands({
      command: { transform: async (callback) => { callback({ add: command => { commands.push(command) } }); return { dispose: async () => {} } } },
      session: { prompt: async (input) => { prompts.push(input) } },
    }, deps, async () => [{ id: "allowed/light" }, { id: "allowed/standard", variant: "medium" }, { id: "other/strong", variant: "high" }])
    deps.classifier = { list: async () => [], invoke: async () => { throw new Error("classifier must not run") }, general: async () => ({}) }
    const invoke = async (text: string): Promise<void> => { await commands[0]!.execute({ sessionID: "lead" as MissionCommandInvocation["sessionID"], prompt: { text, files: [{ uri: "fixture://brief" }] }, delivery: "queue" }) }

    await invoke("Implement cache")
    const teamId = (deps.db.query("SELECT id FROM team ORDER BY time_created DESC LIMIT 1").get() as { id: string }).id
    const policyPath = (deps.db.query("SELECT policy_path FROM mission_policy WHERE team_id = ?").get(teamId) as { policy_path: string }).policy_path
    const seeded = JSON.parse(readFileSync(policyPath, "utf8"))
    seeded.classification = { mode: "general", generalModel: "openai/gpt-6.1-sol" }
    writeFileSync(policyPath, JSON.stringify(seeded, null, 2))

    await invoke("config")

    const preview = JSON.stringify(prompts.at(-1))
    expect(preview).toContain("Draft classification applied")
    expect(JSON.parse(readFileSync(policyPath, "utf8")).classification).toBeUndefined()
    const team = deps.db.query("SELECT classification_policy FROM team WHERE id = ?").get(teamId) as { classification_policy: string }
    expect(JSON.parse(team.classification_policy)).toMatchObject({ method: "general", generalModel: "openai/gpt-6.1-sol" })
  })
})
