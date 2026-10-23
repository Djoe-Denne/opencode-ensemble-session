import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionPolicy } from "../src/execution-policy"
import { parseMissionCommand, registerMissionCommands, type MissionCommandDefinition, type MissionCommandInvocation } from "../src/mission-commands"
import { prepareMission } from "../src/mission-policy"
import { admitPreparationAgent, ENSEMBLE_PM_AGENT, preparationBusinessProfiles, PreparationAdmissionError } from "../src/preparation-admission"
import { PREPARATION_JSON_FALLBACK, PREPARATION_PM_INSTRUCTIONS } from "../src/preparation-instructions"
import { executePreparation, preparationContextText, selectPreparationModel, type PreparationPort, type PreparationPromptCall } from "../src/preparation-runtime"
import { MIGRATIONS } from "../src/schema"
import { claimTask } from "../src/tools/team-claim"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import type { ToolDeps } from "../src/types"
import { createPreparationPort } from "../src/v2-preparation"
import { historicalModelPolicy, insertMember, setupDeps } from "./helpers"

const directories: string[] = []
afterEach(() => {
  directories.splice(0).forEach(path => { rmSync(path, { recursive: true, force: true }) })
})

function document(tasks?: Array<Record<string, unknown>>): Record<string, unknown> {
  const task = (id: string, type: string, planning: boolean): Record<string, unknown> => ({
    id, title: `Title ${id}`, type, goal: `Goal ${id}`, dependsOn: [],
    planning: { required: planning, reason: planning ? `Plan ${id} before editing.` : `Direct ${id} stays inside the cited file.` },
    acceptanceCriteria: [`Accepted ${id} when the cited behavior holds.`],
    verification: [`Verify ${id} with its focused test.`],
    handoff: { document: `Findings for ${id} stay in this handoff.`, sources: [{ path: `src/${id}.ts`, note: `Owns ${id}.` }] },
  })
  return {
    version: 1,
    context: "Shared context for the bounded preparation run.",
    openQuestions: [{ id: "q1", question: "Which boundary owns the schema?", audience: "supervisor" }],
    tasks: tasks ?? [task("code", "implementation", true), task("docs", "documentation", false)],
    parallelGroups: [{
      taskIds: ["code", "docs"],
      reason: "The tasks do not share files.",
      integrationNotes: "Reconcile on the lead branch after each isolated worktree lands.",
      isolation: "separate-worktrees",
    }],
  }
}

function nativeCatalogue() {
  return [{ id: "fixture/a" }, { id: "fixture/b", variant: "high" }, { id: "supervisor/hidden" }]
}
function runtimeFixture(replies: string[], hooksReady = true) {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-preparation-"))
  directories.push(deps.directory)
  deps.config = {
    ...deps.config,
    missionPolicy: null,
    startingIntelligence: 20,
    planningIntelligenceRange: null,
    businessProfiles: { extensions: {}, byAgent: { [ENSEMBLE_PM_AGENT]: "pm" } },
    modelRouting: { beta: 0.35, models: [
      { id: "fixture/b", reasoningEffort: "high", intelligenceScore: 40, averageCostPerTask: 1, available: true },
      { id: "fixture/a", intelligenceScore: 30, averageCostPerTask: 0, available: true },
      { id: "fixture/low", intelligenceScore: 5, averageCostPerTask: 0, available: true },
    ] },
  }
  const prompts: PreparationPromptCall[] = []
  const calls: Array<{ method: string; args: unknown }> = []
  const queue = [...replies]
  const port: PreparationPort = {
    hooksReady,
    probeAgent: async agent => {
      calls.push({ method: "probe", args: agent })
      if (agent === "offline") throw new Error("401 unauthorized")
      if (agent === "missing") return "unavailable"
      return "available"
    },
    describeAgent: async () => ({ readOnly: true, permissions: ["edit"] }),
    nativeModels: async () => nativeCatalogue(),
    createSession: async input => {
      calls.push({ method: "create", args: input })
      return { id: "pm-session" }
    },
    switchAgent: async input => { calls.push({ method: "switchAgent", args: input }) },
    switchModel: async input => { calls.push({ method: "switchModel", args: input }) },
    prompt: async input => {
      calls.push({ method: "prompt", args: input })
      prompts.push(input)
      const row = deps.db.query("SELECT session_id FROM preparation_run").get() as { session_id: string | null }
      if (row?.session_id !== "pm-session") throw new Error("prompt ran before preparation tracking")
    },
    wait: async () => { calls.push({ method: "wait", args: null }) },
    readAssistant: async () => {
      const next = queue.shift()
      if (next === undefined) throw new Error("unexpected model call")
      return next
    },
    abort: async input => { calls.push({ method: "abort", args: input }) },
  }
  return { deps, port, prompts, calls }
}

function commandFixture(replies: string[]) {
  const f = runtimeFixture(replies)
  f.deps.config.missionPolicy = historicalModelPolicy(f.deps)
  const commands: MissionCommandDefinition[] = []
  const prompts: unknown[] = []
  const host = {
    command: { transform: async (callback: (editor: { add(command: MissionCommandDefinition): void }) => void) => {
      callback({ add: command => { commands.push(command) } })
      return { dispose: async () => undefined }
    } },
    session: { prompt: async (input: unknown) => { prompts.push(input) } },
  }
  const invoke = async (text: string, sessionID = "lead") => {
    const command = commands[0]
    if (!command) throw new Error("Native mission command not registered")
    await command.execute({ sessionID: sessionID as MissionCommandInvocation["sessionID"], prompt: { text }, delivery: "queue" })
  }
  return { ...f, host, commands, leadPrompts: prompts, invoke }
}

describe("preparation command parsing", () => {
  test("keeps a bare objective on the simple prepare path", () => {
    expect(parseMissionCommand("  Ship the cache  ")).toEqual({ action: "prepare", text: "Ship the cache" })
  })

  test("parses an explicit PM mandate, the default PM, and one supervisor correction", () => {
    expect(parseMissionCommand("prepare --pm ensemble-pm Ship the cache")).toEqual({
      action: "prepare", text: "Ship the cache", preparation: { kind: "pm", pm: "ensemble-pm" },
    })
    expect(parseMissionCommand("prepare Decompose the cache")).toEqual({
      action: "prepare", text: "Decompose the cache", preparation: { kind: "pm" },
    })
    expect(parseMissionCommand('prepare --accept {"version":1}')).toEqual({
      action: "prepare", text: '{"version":1}', preparation: { kind: "accept" },
    })
  })

  test("rejects an empty mandate and mixed accept or pm flags", () => {
    expect(() => parseMissionCommand("prepare")).toThrow(/mandate/)
    expect(() => parseMissionCommand("prepare --pm ensemble-pm")).toThrow(/mandate/)
    expect(() => parseMissionCommand("prepare --pm ensemble-pm --accept {}")).toThrow(/exclusive/)
    expect(() => parseMissionCommand("prepare --accept")).toThrow(/accept/)
    expect(() => parseMissionCommand("prepare --accept --pm ensemble-pm {}")).toThrow(/exclusive/)
  })
})

describe("preparation instructions", () => {
  test("names the fields, the research tools, and the boundaries the PM must apply", () => {
    for (const phrase of [
      "GrepAI", "Serena", "Example:", "Counterexample:", "planning.required", "architecture",
      "openQuestions", "supervisor", "documentary handoff", "separate-worktrees",
    ]) expect(PREPARATION_PM_INSTRUCTIONS).toContain(phrase)
    expect(PREPARATION_PM_INSTRUCTIONS.toLowerCase()).toContain("do not include a model")
    expect(PREPARATION_JSON_FALLBACK.toLowerCase()).toContain("json")
    expect(PREPARATION_JSON_FALLBACK.toLowerCase()).not.toContain("structured output is available")
  })
})

describe("preparation admission", () => {
  test("does not invent a native PM when the project mapping is empty", () => {
    expect(preparationBusinessProfiles({ extensions: {}, byAgent: {} }).byAgent).toEqual({})
    expect(() => admitPreparationAgent({
      profiles: { extensions: {}, byAgent: {} },
      nativeAgents: [ENSEMBLE_PM_AGENT],
      readOnly: true,
      permissions: ["edit"],
    })).toThrow(PreparationAdmissionError)
    try {
      admitPreparationAgent({
        profiles: { extensions: {}, byAgent: {} },
        nativeAgents: [ENSEMBLE_PM_AGENT],
        readOnly: true,
        permissions: ["edit"],
      })
    } catch (error) {
      expect(error).toMatchObject({ code: "selection" })
      expect((error as Error).message).toMatch(/--pm/)
      expect((error as Error).message).toMatch(/native agent/i)
    }
  })

  test("admits the unique declared PM and copies its native permissions", () => {
    const admitted = admitPreparationAgent({
      profiles: { extensions: {}, byAgent: { "project-pm": "pm" } },
      nativeAgents: ["project-pm", ENSEMBLE_PM_AGENT],
      readOnly: true,
      permissions: ["edit"],
    })
    expect(admitted.accepted).toBe(true)
    expect(admitted.agent).toBe("project-pm")
    expect(admitted.effectiveCategory).toBe("pm")
    expect(admitted.permissions).toEqual(["edit"])
    expect(admitted.readOnly).toBe(true)
  })

  test("refuses a non-pm category, an unavailable agent, and unverified availability", () => {
    expect(() => admitPreparationAgent({
      requested: "architect", profiles: { extensions: {}, byAgent: { architect: "architect" } },
      nativeAgents: ["architect"], readOnly: true, permissions: ["edit"],
    })).toThrow(PreparationAdmissionError)
    try {
      admitPreparationAgent({
        requested: "architect", profiles: { extensions: {}, byAgent: { architect: "architect" } },
        nativeAgents: ["architect"], readOnly: true, permissions: ["edit"],
      })
    } catch (error) {
      expect(error).toMatchObject({ code: "category" })
      expect((error as Error).message).toContain("No permission was added")
    }
    expect(() => admitPreparationAgent({
      requested: "missing", profiles: { extensions: {}, byAgent: { missing: "pm" } },
      nativeAgents: [], readOnly: true, permissions: [],
    })).toThrow(/unavailable/)
    try {
      admitPreparationAgent({
        profiles: { extensions: {}, byAgent: { "project-pm": "pm" } },
        readOnly: true,
        permissions: [],
      })
      throw new Error("unverified availability was admitted")
    } catch (error) {
      expect(error).toMatchObject({ code: "unverified" })
    }
  })

  test("keeps an explicit project PM and does not recategorize another agent", () => {
    const project = admitPreparationAgent({
      requested: "project-pm", profiles: { extensions: {}, byAgent: { "project-pm": "pm", [ENSEMBLE_PM_AGENT]: "developer" } },
      nativeAgents: ["project-pm", ENSEMBLE_PM_AGENT], readOnly: false, permissions: ["edit"],
    })
    expect(project.agent).toBe("project-pm")
    expect(() => admitPreparationAgent({
      requested: ENSEMBLE_PM_AGENT,
      profiles: { extensions: {}, byAgent: { "project-pm": "pm", [ENSEMBLE_PM_AGENT]: "developer" } },
      nativeAgents: ["project-pm", ENSEMBLE_PM_AGENT], readOnly: false, permissions: ["edit"],
    })).toThrow(/category|developer|pm/i)
    expect(() => admitPreparationAgent({
      profiles: { extensions: {}, byAgent: { "project-pm": "pm", "other-pm": "pm" } },
      nativeAgents: ["project-pm", "other-pm"],
      readOnly: true,
      permissions: [],
    })).toThrow(/--pm/)
  })
})

describe("preparation model selection", () => {
  test("uses the first planned native pair in the envelope", () => {
    const policy = createExecutionPolicy([
      { id: "fixture/b", reasoningEffort: "high", intelligenceScore: 40, averageCostPerTask: 1, available: true },
      { id: "fixture/a", intelligenceScore: 30, averageCostPerTask: 0, available: true },
      { id: "fixture/low", intelligenceScore: 5, averageCostPerTask: 0, available: true },
    ], 20)
    expect(selectPreparationModel(policy, nativeCatalogue())).toEqual({ id: "fixture/a" })
  })

  test("keeps a version 3 planning range and refuses an empty envelope", () => {
    const policy = createExecutionPolicy([
      { id: "fixture/hot", intelligenceScore: 80, averageCostPerTask: 1, available: true },
      { id: "fixture/mid", intelligenceScore: 20, averageCostPerTask: 0, available: true },
      { id: "fixture/anchor", intelligenceScore: 50, averageCostPerTask: 2, available: true },
    ], 50, 0.35, { min: 10, max: 60 })
    expect(selectPreparationModel(policy, [{ id: "fixture/hot" }, { id: "fixture/mid" }])).toEqual({ id: "fixture/mid" })
    expect(() => selectPreparationModel(policy, [{ id: "supervisor/hidden" }])).toThrow(/envelope/)
  })
})

describe("preparation runtime", () => {
  test("registers the preparation run migration", () => {
    expect(MIGRATIONS).toHaveLength(25)
    const { deps } = runtimeFixture([])
    expect(deps.db.query("SELECT name FROM sqlite_master WHERE name = 'preparation_run'").get()).toEqual({ name: "preparation_run" })
  })

  test("imports a valid JSON reply once, without a writer or a model in the decision", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    const result = await executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    expect(result.status).toBe("imported")
    expect(result.agent).toBe(ENSEMBLE_PM_AGENT)
    expect(result.model).toEqual({ id: "fixture/a" })
    expect(result.questions).toEqual([{ id: "q1", question: "Which boundary owns the schema?" }])
    expect(result.mapping?.map(item => item.pmId).sort()).toEqual(["code", "docs"])
    for (const item of result.mapping ?? []) expect(item.taskId).not.toBe(item.pmId)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_member").get()).toEqual({ c: 0 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    const decisions = f.deps.db.query("SELECT decision_json, disposition FROM preparation_task ORDER BY position").all() as Array<{ decision_json: string; disposition: string }>
    expect(decisions.map(row => JSON.parse(row.decision_json))).toEqual([
      { mode: "planned", kind: "code" },
      { mode: "direct", kind: "documentation" },
    ])
    expect(f.prompts).toHaveLength(1)
    expect(Object.keys(f.prompts[0] ?? {}).sort()).toEqual(["delivery", "sessionID", "text"])
    expect(f.prompts[0]?.text).toContain(PREPARATION_PM_INSTRUCTIONS.slice(0, 40))
    expect(f.prompts[0]?.text).toContain(PREPARATION_JSON_FALLBACK)
    expect(f.prompts[0]?.text.toLowerCase()).toContain("read-only")
    expect(f.calls.find(call => call.method === "create")?.args).toEqual({ title: expect.any(String), directory: f.deps.directory })
    expect(f.calls.find(call => call.method === "switchAgent")?.args).toEqual({ sessionID: "pm-session", agent: ENSEMBLE_PM_AGENT })
    expect(f.calls.find(call => call.method === "switchModel")?.args).toEqual({ sessionID: "pm-session", providerID: "fixture", modelID: "a" })
    expect(preparationContextText(f.deps.db, "pm-session")).toContain("GrepAI")
    expect(preparationContextText(f.deps.db, "lead")).toContain("q1")
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Again" }, f.port)).rejects.toMatchObject({ code: "imported" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    expect(f.prompts).toHaveLength(1)
    const taskId = result.mapping?.[0]?.taskId
    if (!taskId) throw new Error("missing imported task")
    expect(() => claimTask(f.deps.db, result.teamId, taskId, "lead")).toThrow(/approved/)
    await expect(executeTeamSpawn(f.deps, { name: "writer", prompt: "implement the cache", agent: "implementer" }, "lead")).rejects.toThrow(/approved/)
    expect(f.deps.client.calls.filter(call => call.method === "session.create")).toHaveLength(0)
  })

  test("stops after the initial reply and five PM corrections, then accepts one supervisor JSON", async () => {
    const f = runtimeFixture(Array.from({ length: 6 }, () => "{\"version\":9}"))
    const exhausted = await executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    expect(exhausted.status).toBe("exhausted")
    expect(f.prompts).toHaveLength(6)
    expect(f.prompts[5]?.text).toContain("version must be 1")
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "try again" }, f.port)).rejects.toMatchObject({ code: "exhausted" })
    expect(f.prompts).toHaveLength(6)
    const accepted = await executePreparation(f.deps, "lead", { kind: "accept", text: JSON.stringify(document()) }, f.port)
    expect(accepted.status).toBe("imported")
    expect(accepted.mapping).toHaveLength(2)
    expect(f.prompts).toHaveLength(6)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 1 })
    await expect(executePreparation(f.deps, "lead", { kind: "accept", text: JSON.stringify(document()) }, f.port)).rejects.toMatchObject({ code: "accept" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
  })

  test("does not import a late reply after approval and does not admit another run early", async () => {
    const blocked = runtimeFixture([], false)
    await expect(executePreparation(blocked.deps, "lead", { kind: "pm", text: "Ship it" }, blocked.port)).rejects.toMatchObject({ code: "hooks" })
    expect(blocked.calls.filter(call => call.method === "create")).toHaveLength(0)

    const offline = runtimeFixture([JSON.stringify(document())])
    await expect(executePreparation(offline.deps, "lead", { kind: "pm", pm: "offline", text: "Ship it" }, offline.port)).rejects.toMatchObject({ code: "transport" })
    expect(offline.calls.filter(call => call.method === "create")).toHaveLength(0)

    const missing = runtimeFixture([JSON.stringify(document())])
    await expect(executePreparation(missing.deps, "lead", { kind: "pm", pm: "missing", text: "Ship it" }, missing.port)).rejects.toMatchObject({ code: "unavailable" })

    const category = runtimeFixture([JSON.stringify(document())])
    category.deps.config.businessProfiles = { extensions: {}, byAgent: { architect: "architect" } }
    await expect(executePreparation(category.deps, "lead", { kind: "pm", pm: "architect", text: "Ship it" }, category.port)).rejects.toMatchObject({ code: "category" })
    expect(category.calls.filter(call => call.method === "create")).toHaveLength(0)

    const none = runtimeFixture([JSON.stringify(document())])
    none.deps.config.businessProfiles = { extensions: {}, byAgent: {} }
    await expect(executePreparation(none.deps, "lead", { kind: "pm", text: "Ship it" }, none.port)).rejects.toMatchObject({ code: "selection" })
    expect(none.calls.filter(call => call.method === "create")).toHaveLength(0)

    const many = runtimeFixture([])
    many.deps.config.businessProfiles = { extensions: {}, byAgent: { "ensemble-pm": "pm", "project-pm": "pm" } }
    await expect(executePreparation(many.deps, "lead", { kind: "pm", text: "Ship it" }, many.port)).rejects.toMatchObject({ code: "selection" })
    expect(many.calls.filter(call => call.method === "create")).toHaveLength(0)

    const race = runtimeFixture([])
    race.port.readAssistant = async () => {
      race.deps.db.run("UPDATE mission_policy SET approved_hash = 'locked'")
      return JSON.stringify(document())
    }
    const cancelled = await executePreparation(race.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, race.port)
    expect(cancelled.status).toBe("cancelled")
    expect(race.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
    expect(race.deps.db.query("SELECT approved_hash FROM mission_policy").get()).toEqual({ approved_hash: "locked" })
    expect(race.calls.some(call => call.method === "abort")).toBe(true)
    expect(preparationContextText(race.deps.db, "pm-session")).toBeUndefined()

    const active = runtimeFixture([])
    const mission = await prepareMission(active.deps, "lead", "Stored objective")
    active.deps.db.run(
      "INSERT INTO preparation_run (id, team_id, session_id, agent, model_id, mandate, status, attempts, supervisor_used, time_created, time_updated) VALUES ('run-1', ?, 'pm-old', 'ensemble-pm', 'fixture/a', 'mandate', 'running', 1, 0, 1, 1)",
      [mission.teamId],
    )
    await expect(executePreparation(active.deps, "lead", { kind: "pm", text: "Decompose" }, active.port)).rejects.toMatchObject({ code: "running" })
    expect(active.deps.db.query("SELECT objective FROM mission_policy").get()).toEqual({ objective: "Stored objective" })
  })

  test("deepens an existing draft without replacing its objective", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    f.deps.config.businessProfiles = { extensions: {}, byAgent: { "project-pm": "pm" } }
    await prepareMission(f.deps, "lead", "Stored objective")
    const result = await executePreparation(f.deps, "lead", { kind: "pm", pm: "project-pm", text: "Decompose the stored objective" }, {
      ...f.port,
      probeAgent: async () => "available",
    })
    expect(result.status).toBe("imported")
    expect(result.agent).toBe("project-pm")
    expect(f.deps.db.query("SELECT objective FROM mission_policy").get()).toEqual({ objective: "Stored objective" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team").get()).toEqual({ c: 1 })
  })
})

describe("preparation command", () => {
  test("simple prepare does not open a PM session", async () => {
    const f = commandFixture([JSON.stringify(document())])
    await registerMissionCommands(f.host, f.deps, async () => nativeCatalogue(), f.port)
    await f.invoke("Ship the cache")
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(0)
    expect(f.leadPrompts.at(-1)).toMatchObject({ text: expect.stringContaining("No particular planner profile") })
  })

  test("explicit prepare returns supervisor questions and real task ids", async () => {
    const f = commandFixture([JSON.stringify(document())])
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }, { id: "fixture/strong", variant: "high" }], f.port)
    await f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const text = (f.leadPrompts.at(-1) as { text: string }).text
    expect(text).toContain("Which boundary owns the schema?")
    expect(text).toContain("code")
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_member").get()).toEqual({ c: 0 })
    expect(f.calls.find(call => call.method === "switchAgent")?.args).toEqual({ sessionID: "pm-session", agent: "ensemble-pm" })
  })

  test("keeps the stored objective and an approval that wins the race", async () => {
    const f = commandFixture([JSON.stringify(document())])
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }, { id: "fixture/strong", variant: "high" }], f.port)
    await f.invoke("Keep the stored objective")
    await f.invoke("prepare Decompose the stored work")
    expect(f.deps.db.query("SELECT objective FROM mission_policy").get()).toEqual({ objective: "Keep the stored objective" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team").get()).toEqual({ c: 1 })

    const race = commandFixture([])
    race.port.readAssistant = async () => {
      race.deps.db.run("UPDATE mission_policy SET approved_hash = 'locked', presented_hash = 'locked'")
      return JSON.stringify(document())
    }
    await registerMissionCommands(race.host, race.deps, async () => [{ id: "fixture/light" }, { id: "fixture/strong", variant: "high" }], race.port)
    await race.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    expect(race.deps.db.query("SELECT approved_hash FROM mission_policy").get()).toEqual({ approved_hash: "locked" })
    expect(race.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
    expect((race.leadPrompts.at(-1) as { text: string }).text).toContain("already approved")
  })

  test("asks the supervisor to select a PM instead of inventing one", async () => {
    const none = commandFixture([JSON.stringify(document())])
    none.deps.config.businessProfiles = { extensions: {}, byAgent: {} }
    await registerMissionCommands(none.host, none.deps, async () => [{ id: "fixture/light" }], none.port)
    await none.invoke("prepare Decompose the cache")
    expect(none.calls.filter(call => call.method === "create")).toHaveLength(0)
    expect((none.leadPrompts.at(-1) as { text: string }).text).toMatch(/--pm/)
    expect((none.leadPrompts.at(-1) as { text: string }).text).toMatch(/native agent/i)

    const many = commandFixture([])
    many.deps.config.businessProfiles = { extensions: {}, byAgent: { "ensemble-pm": "pm", "project-pm": "pm" } }
    await registerMissionCommands(many.host, many.deps, async () => [{ id: "fixture/light" }], many.port)
    await many.invoke("prepare Decompose the cache")
    expect(many.calls.filter(call => call.method === "create")).toHaveLength(0)
    const text = (many.leadPrompts.at(-1) as { text: string }).text
    expect(text).toContain("ensemble-pm")
    expect(text).toContain("project-pm")
    expect(text).toContain("--pm")
  })
})

describe("preparation host adapter", () => {
  test("probes native availability without turning transport failures into unavailable", async () => {
    const root = join(import.meta.dir, "..")
    const denied = createPreparationPort({
      location: { directory: root },
      agent: { get: async () => { throw new Error("401 unauthorized") } },
      session: { create: async () => ({ id: "s" }), prompt: async () => ({}), switchAgent: async () => undefined, switchModel: async () => undefined },
    }, true, async () => [])
    await expect(denied.probeAgent("ensemble-pm")).rejects.toThrow(/401 unauthorized/)
    const session = {
      create: async () => ({ id: "s" }),
      prompt: async () => ({}),
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
    }
    const missing = createPreparationPort({
      location: { directory: root },
      agent: { get: async () => { throw new Error("agent not found") } },
      session,
    }, true, async () => [])
    await expect(missing.probeAgent("ensemble-pm")).resolves.toBe("unavailable")
  })
})
