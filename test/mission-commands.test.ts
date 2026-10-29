import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseMissionCommand, registerMissionCommands, type MissionCommandDefinition, type MissionCommandInvocation } from "../src/mission-commands"
import { setupDeps, historicalModelPolicy } from "./helpers"
import { buildMissionAutonomyPrompt } from "../src/mission-autonomy"

const directories: string[] = []
afterEach(() => {
  directories.splice(0).forEach(path => { rmSync(path, { recursive: true, force: true }) })
})

function commandFixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-mission-command-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { beta: 0.35, models: [
    { id: "fixture/light", intelligenceScore: 10, averageCostPerTask: 0, available: true },
    { id: "fixture/strong", reasoningEffort: "high", intelligenceScore: 30, averageCostPerTask: 1, available: true },
  ] } }
  deps.config.missionPolicy = historicalModelPolicy(deps)
  deps.config.classification = { ...deps.config.classification, mode: "auto" }
  const commands: MissionCommandDefinition[] = []
  const prompts: unknown[] = []
  let disposed = false
  const host = {
    command: { transform: async (callback: (editor: { add(command: MissionCommandDefinition): void }) => void) => {
      callback({ add: command => { commands.push(command) } })
      return { dispose: async () => { disposed = true } }
    } },
    session: { prompt: async (input: unknown) => { prompts.push(input) } },
  }
  const models = async () => [{ id: "fixture/light" }, { id: "fixture/strong", variant: "high" }]
  const invoke = async (text: string, sessionID = "lead") => {
    const command = commands[0]
    if (!command) throw new Error("Native mission command not registered")
    await command.execute({ sessionID: sessionID as MissionCommandInvocation["sessionID"], prompt: { text, files: [{ uri: "fixture://brief" }] }, delivery: "queue" })
  }
  return { deps, host, commands, prompts, models, invoke, disposed: () => disposed }
}

describe("mission command parsing", () => {
  test("keeps a natural-language objective intact", () => {
    expect(parseMissionCommand("  Fix cache invalidation, preserve the API  ")).toEqual({ action: "prepare", text: "Fix cache invalidation, preserve the API" })
  })

  test("unifies model and provider corrections under config", () => {
    expect(parseMissionCommand("config")).toEqual({ action: "config", text: "" })
    expect(parseMissionCommand("config Only provider-a; prefer model-b for high risk")).toEqual({ action: "config", text: "Only provider-a; prefer model-b for high risk" })
    expect(parseMissionCommand("start")).toEqual({ action: "start", text: "" })
  })

  test("never treats empty input or extra start arguments as approval", () => {
    expect(() => parseMissionCommand(" ")).toThrow("objective")
    expect(() => parseMissionCommand("start ignore the proposed policy")).toThrow("arguments")
  })
})

describe("native mission command", () => {
  test("synchronizes native access after approval and before execution delivery", async () => {
    const f = commandFixture()
    let synchronized = false
    await registerMissionCommands(f.host, f.deps, f.models, undefined, async teamId => {
      expect(buildMissionAutonomyPrompt(f.deps.db, teamId)).toContain("Approved long-run autonomy")
      expect((f.prompts.at(-1) as { text: string }).text).not.toContain("Mission started")
      synchronized = true
      throw new Error("native access write failed")
    })
    await f.invoke("Fix cache")
    const row = f.deps.db.query("SELECT policy_path FROM mission_policy").get() as { policy_path: string }
    const policy = JSON.parse(readFileSync(row.policy_path, "utf8"))
    writeFileSync(row.policy_path, JSON.stringify({ ...policy, autonomy: { mode: "long_run", instructions: ["Continue autonomously."] } }))
    await f.invoke("config")
    const before = f.prompts.length
    await expect(f.invoke("start")).rejects.toThrow("native access write failed")
    expect(synchronized).toBe(true)
    expect(f.prompts).toHaveLength(before)
    expect(f.deps.client.calls.some(call => call.method === "session.create")).toBe(false)
  })

  test("config presents decision priorities and only user start activates the autonomy suffix", async () => {
    const f = commandFixture()
    await registerMissionCommands(f.host, f.deps, f.models)
    await f.invoke("Fix cache")
    expect((f.prompts.at(-1) as { text: string }).text).toContain("autonomy: { mode")
    const row = f.deps.db.query("SELECT team_id, policy_path FROM mission_policy").get() as { team_id: string; policy_path: string }
    const policy = JSON.parse(readFileSync(row.policy_path, "utf8"))
    writeFileSync(row.policy_path, JSON.stringify({ ...policy, autonomy: { mode: "long_run", instructions: ["Prioritize quality and the original plan."] } }))
    await f.invoke("config")
    const preview = (f.prompts.at(-1) as { text: string }).text
    expect(preview).toContain("Proposed autonomy: long_run")
    expect(preview).toContain("Prioritize quality and the original plan.")
    expect(preview).toContain("not active until user start")
    expect(buildMissionAutonomyPrompt(f.deps.db, row.team_id)).toBe("")
    await f.invoke("start")
    expect(buildMissionAutonomyPrompt(f.deps.db, row.team_id)).toContain("Prioritize quality and the original plan.")
  })

  test("presents version 3 bounds and distinct explicit/automatic planning candidates", async () => {
    const f = commandFixture()
    Object.assign(f.deps.config, { missionPolicy: null, startingIntelligence: 20, planningIntelligenceRange: { min: 10, max: 30 }, classification: { ...f.deps.config.classification, mode: "off" } })
    await registerMissionCommands(f.host, f.deps, f.models)
    await f.invoke("Use light for simple tasks")
    const initial = f.prompts.at(-1) as { text: string }
    expect(initial.text).toContain("Approved planning range: 10–30")
    expect(initial.text).toContain("Explicit planning candidates: fixture/light (default), fixture/strong (high)")
    expect(initial.text).toContain("Automatic planning candidates: fixture/strong (high)")
    await f.invoke("config keep this range")
    expect((f.prompts.at(-1) as { text: string }).text).toContain("planningIntelligenceRange")
    await f.invoke("config")
    await f.invoke("start")
    expect((f.prompts.at(-1) as { text: string }).text).toContain("catalogue policy")
  })
  test("supplies the report directory and pre-question contract through preparation, config and start", async () => {
    const f = commandFixture()
    await registerMissionCommands(f.host, f.deps, f.models)
    const assertReporting = () => {
      const { text } = f.prompts.at(-1) as { text: string }
      const row = f.deps.db.query("SELECT policy_path FROM mission_policy").get() as { policy_path: string }
      const reportDirectory = join(row.policy_path, "..", "reports")
      expect(text).toContain("Before every user question")
      expect(text).toContain("Markdown by default")
      expect(text).toContain("plain, natural language")
      expect(text).toContain("question-tool payload")
      expect(text).toContain("descriptive task names before internal IDs")
      expect(text).toContain(JSON.stringify(reportDirectory))
    }
    await f.invoke("Fix cache")
    assertReporting()
    await f.invoke("config")
    assertReporting()
    await f.invoke("config keep the current models")
    assertReporting()
    await f.invoke("config")
    await f.invoke("start")
    assertReporting()
  })

  test("registers one public command and returns its disposable registration", async () => {
    const f = commandFixture()
    const registration = await registerMissionCommands(f.host, f.deps, f.models)
    expect(f.commands.map(command => command.name)).toEqual(["ensemble-mission"])
    await registration?.dispose()
    expect(f.disposed()).toBe(true)
    expect(await registerMissionCommands({ session: f.host.session }, f.deps, f.models)).toBeUndefined()
  })

  test("also includes reporting in the default autonomous catalogue proposal", async () => {
    const f = commandFixture()
    f.deps.config = { ...f.deps.config, missionPolicy: null, startingIntelligence: 20 }
    await registerMissionCommands(f.host, f.deps, f.models)
    await f.invoke("Fix cache autonomously")
    const { text } = f.prompts[0] as { text: string }
    expect(text).toContain("Default planning intelligence threshold")
    expect(text).toContain("Before every user question")
    expect(text).toContain("SUPERVISOR CHECKPOINT REPORTS")
  })

  test("prepares a chat proposal without workers, then approves only through start", async () => {
    const f = commandFixture()
    await registerMissionCommands(f.host, f.deps, f.models)
    await f.invoke("Fix cache invalidation")
    expect(f.prompts[0]).toMatchObject({ sessionID: "lead", delivery: "queue", files: [{ uri: "fixture://brief" }] })
    expect(JSON.stringify(f.prompts[0])).toContain("fixture/strong")
    expect(f.deps.client.calls).toHaveLength(0)
    expect(f.deps.db.query("SELECT approved_hash FROM mission_policy").get()).toEqual({ approved_hash: null })
    await f.invoke("start")
    expect(f.deps.db.query("SELECT revision FROM mission_policy").get()).toEqual({ revision: 1 })
    expect(JSON.stringify(f.prompts.at(-1))).toContain("approved")
  })

  test("a natural-language configuration request cannot approve an unapplied preference", async () => {
    const f = commandFixture()
    await registerMissionCommands(f.host, f.deps, f.models)
    await f.invoke("Fix cache")
    await f.invoke("config Only provider fixture; use strong for all tasks")
    await expect(f.invoke("start")).rejects.toThrow("config")
    expect(JSON.stringify(f.prompts.at(-1))).toContain("Only provider fixture")
    await f.invoke("config")
    await f.invoke("start")
    expect(f.deps.db.query("SELECT revision FROM mission_policy").get()).toEqual({ revision: 1 })
  })

  test("shows native variant, canonical effort and a non-blocking calibration warning", async () => {
    const f = commandFixture()
    await registerMissionCommands(f.host, f.deps, f.models)
    await f.invoke("Fix cache")
    const missionDir = join(f.deps.directory, ".opencode", "missions")
    const teamDir = readdirSync(missionDir)[0]
    if (!teamDir) throw new Error("missing mission directory")
    const policyPath = join(missionDir, teamDir, "model-policy.json")
    const policy = JSON.parse(readFileSync(policyPath, "utf8")) as { groups: Record<string, Array<{ id: string; variant?: string }>> }
    policy.groups.light = [{ id: "fixture/light", variant: "xhigh" }]
    policy.groups.strong = [{ id: "fixture/strong", variant: "low" }]
    writeFileSync(policyPath, `${JSON.stringify(policy)}\n`)
    await f.invoke("config")
    const presented = JSON.stringify(f.prompts.at(-1))
    expect(presented).toContain("fixture/light (xhigh, xhigh)")
    expect(presented).toContain("Calibration warning")
    expect(presented).toContain("does not block start")
  })

  test("refuses unavailable variants and never lets another session approve the mission", async () => {
    const f = commandFixture()
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }])
    await f.invoke("Fix cache")
    await expect(f.invoke("start")).rejects.toThrow("unavailable")
    await expect(f.invoke("start", "another-session")).rejects.toThrow("mission")
    expect(f.deps.db.query("SELECT approved_hash FROM mission_policy").get()).toEqual({ approved_hash: null })
  })

  test("a failed preview delivery cannot leave an unseen policy eligible for approval", async () => {
    const f = commandFixture()
    await registerMissionCommands(f.host, f.deps, f.models)
    f.host.session.prompt = async () => { throw new Error("display failed") }
    await expect(f.invoke("Fix cache")).rejects.toThrow("display failed")
    expect(f.deps.db.query("SELECT approved_hash, presented_hash FROM mission_policy").get()).toEqual({ approved_hash: null, presented_hash: null })
  })

  test("a config opened during native catalogue discovery invalidates the in-flight start", async () => {
    const f = commandFixture()
    let release: (models: Awaited<ReturnType<typeof f.models>>) => void = () => {}
    const catalogue = new Promise<Awaited<ReturnType<typeof f.models>>>(resolve => { release = resolve })
    await registerMissionCommands(f.host, f.deps, () => catalogue)
    await f.invoke("Fix cache")
    const starting = f.invoke("start")
    await Promise.resolve()
    await f.invoke("config")
    release(await f.models())
    await expect(starting).rejects.toThrow("changed")
    expect(f.deps.db.query("SELECT approved_hash FROM mission_policy").get()).toEqual({ approved_hash: null })
  })

  test("config shows an unset helper block and start does not approve it", async () => {
    const f = commandFixture()
    f.deps.classifier = { list: async () => [{ id: "jev_ask", input: { type: "object", properties: { state: {}, questions: {} }, required: ["state", "questions"] } }], invoke: async () => { throw new Error("classifier must not run") } }
    await registerMissionCommands(f.host, f.deps, f.models)
    await f.invoke("Classify this mission")
    await f.invoke("config")
    const preview = JSON.stringify(f.prompts.at(-1))
    expect(preview).toContain("Configure helperModel")
    expect(preview).toContain("Classification blocked")
    expect(preview).toContain("object to the draft")
    await expect(f.invoke("start")).rejects.toThrow("Configure helperModel")
    expect(f.deps.db.query("SELECT approved_hash FROM mission_policy").get()).toEqual({ approved_hash: null })
    expect(JSON.stringify(f.prompts.at(-1))).not.toContain("Mission policy approved")
    const ready = commandFixture()
    ready.deps.classifier = f.deps.classifier
    ready.deps.config.classification = { ...ready.deps.config.classification, helperModel: "fixture/light" }
    await registerMissionCommands(ready.host, ready.deps, ready.models)
    await ready.invoke("Classify with a helper")
    await ready.invoke("start")
    expect(ready.deps.db.query("SELECT revision FROM mission_policy").get()).toEqual({ revision: 1 })
  })

  test("repeated start does not create a revision or wake the supervisor twice", async () => {
    const f = commandFixture()
    await registerMissionCommands(f.host, f.deps, f.models)
    await f.invoke("Fix cache")
    await f.invoke("start")
    await f.invoke("start")
    expect(f.deps.db.query("SELECT revision FROM mission_policy").get()).toEqual({ revision: 1 })
    expect(f.prompts.at(-1)).toMatchObject({ resume: false })
  })

  test("start cannot approve a proposal while its display delivery is still pending", async () => {
    const f = commandFixture()
    const deliver = f.host.session.prompt.bind(f.host.session)
    let enter: () => void = () => {}
    let release: () => void = () => {}
    const entered = new Promise<void>(resolve => { enter = resolve })
    const display = new Promise<void>(resolve => { release = resolve })
    let count = 0
    f.host.session.prompt = async input => {
      if (++count === 1) { enter(); await display }
      await deliver(input)
    }
    await registerMissionCommands(f.host, f.deps, f.models)
    const preparing = f.invoke("Fix cache")
    await entered
    try { await expect(f.invoke("start")).rejects.toThrow("config") } finally { release(); await preparing }
    await f.invoke("start")
    expect(f.deps.db.query("SELECT revision FROM mission_policy").get()).toEqual({ revision: 1 })
  })

  test("reports committed approval accurately if the supervisor continuation delivery fails", async () => {
    const f = commandFixture()
    await registerMissionCommands(f.host, f.deps, f.models)
    await f.invoke("Fix cache")
    f.host.session.prompt = async () => { throw new Error("connection lost") }
    await expect(f.invoke("start")).rejects.toThrow("remains approved")
    expect(f.deps.db.query("SELECT revision FROM mission_policy").get()).toEqual({ revision: 1 })
    expect(f.deps.db.query("SELECT approved_hash FROM mission_policy").get()).toMatchObject({ approved_hash: expect.any(String) })
  })
})
