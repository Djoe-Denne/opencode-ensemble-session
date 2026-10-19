import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseMissionCommand, registerMissionCommands, type MissionCommandDefinition, type MissionCommandInvocation } from "../src/mission-commands"
import { setupDeps } from "./helpers"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function commandFixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-mission-command-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { beta: 0.35, models: [
    { id: "fixture/light", intelligenceScore: 10, averageCostPerTask: 0, available: true },
    { id: "fixture/strong", reasoningEffort: "high", intelligenceScore: 30, averageCostPerTask: 1, available: true },
  ] } }
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
  test("registers one public command and returns its disposable registration", async () => {
    const f = commandFixture()
    const registration = await registerMissionCommands(f.host, f.deps, f.models)
    expect(f.commands.map(command => command.name)).toEqual(["ensemble-mission"])
    await registration?.dispose()
    expect(f.disposed()).toBe(true)
    expect(await registerMissionCommands({ session: f.host.session }, f.deps, f.models)).toBeUndefined()
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
