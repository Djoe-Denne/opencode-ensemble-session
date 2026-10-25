import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionPolicy } from "../src/execution-policy"
import { parseMissionCommand, registerMissionCommands, type MissionCommandDefinition, type MissionCommandInvocation } from "../src/mission-commands"
import { approveMission, prepareMission } from "../src/mission-policy"
import { admitPreparationAgent, ENSEMBLE_PM_AGENT, preparationBusinessProfiles, PreparationAdmissionError } from "../src/preparation-admission"
import { parsePreparationDocument } from "../src/preparation-document"
import { PREPARATION_JSON_FALLBACK, PREPARATION_PM_INSTRUCTIONS } from "../src/preparation-instructions"
import { executePreparation, preparationContextText, preparationSessionReference, selectPreparationModel, type PreparationPort, type PreparationPromptCall } from "../src/preparation-runtime"
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
    version: 2,
    readiness: { status: "ready", reasons: [], missingInformation: [] },
    tooling: { catalogue: "verified", unavailable: [] },
    context: "Shared context for the bounded preparation run.",
    openQuestions: [{ id: "q1", question: "Which boundary owns the schema?", audience: "supervisor", blocking: false }],
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
function runtimeFixture(replies: string[], hooksReady = true, sessionId = "pm-session") {
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
    assertCapabilities: async () => undefined,
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
      return { id: sessionId }
    },
    replacePermissions: async input => { calls.push({ method: "replacePermissions", args: input }) },
    switchAgent: async input => { calls.push({ method: "switchAgent", args: input }) },
    switchModel: async input => { calls.push({ method: "switchModel", args: input }) },
    prompt: async input => {
      calls.push({ method: "prompt", args: input })
      prompts.push(input)
      const row = deps.db.query("SELECT session_id FROM preparation_run").get() as { session_id: string | null }
      if (row?.session_id !== sessionId) throw new Error("prompt ran before preparation tracking")
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

function commandFixture(replies: string[], sessionId = "pm-session") {
  const f = runtimeFixture(replies, true, sessionId)
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

function leadText(entry: unknown): string {
  return (entry as { text?: string }).text ?? ""
}

const NATIVE_PM_SESSION = "ses_e92b9c673ffeSBVgmNz1tVkES4"

function hasAutonomousSessionInline(text: string, sessionId: string): boolean {
  return text.split("\n").some(line => line.trim() === `\`${sessionId}\``)
}

function buttonSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1] ?? "")
}

async function waitForLead(prompts: unknown[], includes: string): Promise<void> {
  const deadline = Date.now() + 1000
  while (!prompts.some(entry => leadText(entry).includes(includes))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for deferred preparation delivery: ${includes}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe("preparation command parsing", () => {
  test("preserves multiline mandates and parses explicit preparation context options", () => {
    expect(parseMissionCommand('prepare --pm pm --preplan "docs/pre plan.md" --history checkpoint --before msg_boundary First line\n\nSecond line')).toEqual({
      action: "prepare", text: "First line\n\nSecond line",
      preparation: { kind: "pm", pm: "pm", preplan: "docs/pre plan.md", history: "checkpoint", before: "msg_boundary" },
    })
    expect(() => parseMissionCommand("prepare --history checkpoint Goal")).toThrow("--before")
    expect(() => parseMissionCommand("prepare --before msg_boundary Goal")).toThrow("checkpoint")
    expect(() => parseMissionCommand("prepare --unknown Goal")).toThrow("Unknown")
    expect(() => parseMissionCommand("prepare --pm pm --pm other Goal")).toThrow("Duplicate")
    expect(() => parseMissionCommand("prepare --history fork --accept {} ")).toThrow("exclusive")
  })
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

  test("rejects mixed accept or pm flags", () => {
    expect(() => parseMissionCommand("prepare --pm")).toThrow(/agent/)
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

  test("QA: gives the PM a complete example, the task types, and splitting rules", () => {
    for (const type of ["implementation", "architecture", "documentation", "research", "review", "qa"]) {
      expect(PREPARATION_PM_INSTRUCTIONS).toContain(type)
    }
    for (const field of ["acceptanceCriteria", "dependsOn", "verification", "handoff"]) {
      expect(PREPARATION_PM_INSTRUCTIONS).toContain(field)
    }
    expect(PREPARATION_PM_INSTRUCTIONS).toContain("Do not group a task with its dependency")
    expect(PREPARATION_PM_INSTRUCTIONS).toContain("The plugin imports real task ids")
    expect(PREPARATION_PM_INSTRUCTIONS).not.toContain("supervisor imports")
    const match = PREPARATION_PM_INSTRUCTIONS.match(/```json\n([\s\S]*?)\n```/)
    if (!match?.[1]) throw new Error("missing complete preparation example")
    const parsed = parsePreparationDocument(JSON.parse(match[1]))
    expect(parsed.version).toBe(2)
    expect(parsed.readiness?.status).toBe("ready")
    expect(PREPARATION_PM_INSTRUCTIONS).toContain("effective catalogue")
    expect(PREPARATION_PM_INSTRUCTIONS).toContain("blocked")
    expect(parsed.tasks.map(task => task.type)).toEqual(["research", "implementation"])
    expect(parsed.parallelGroups[0]?.integrationNotes).toContain("Reconcile")
    expect(parsed.parallelGroups[0]?.isolation).toBe("separate-worktrees")
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
  test.each([39999, 40000])("accepts a preparation mandate of %i characters without truncation", async length => {
    const f = runtimeFixture([JSON.stringify(document())])
    const text = "m".repeat(length)
    const result = await executePreparation(f.deps, "lead", { kind: "pm", text, history: "fork" }, f.port)
    expect(result.status).toBe("imported")
    expect(f.prompts[0]?.text).toContain(text)
    expect(f.deps.db.query("SELECT mandate FROM preparation_run").get()).toEqual({ mandate: text })
  })

  test("transmits a 27073-character stored objective alongside a short supplemental mandate", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    const objective = "o".repeat(27073)
    await prepareMission(f.deps, "lead", objective)
    await executePreparation(f.deps, "lead", { kind: "pm", text: "Review the stored mission" }, f.port)
    expect(f.prompts[0]?.text).toContain(objective)
    expect(f.prompts[0]?.text).toContain("Review the stored mission")
    expect(f.deps.db.query("SELECT objective FROM mission_policy").get()).toEqual({ objective })
  })

  test("distinguishes overlong explicit mandates from stored objectives at the 40000-character boundary", async () => {
    const explicit = runtimeFixture([])
    await expect(executePreparation(explicit.deps, "lead", { kind: "pm", text: "m".repeat(40001) }, explicit.port)).rejects.toThrow(/Preparation mandate.*Ensemble.*40000.*40001/)
    expect(explicit.calls.some(call => call.method === "create")).toBe(false)
    const stored = runtimeFixture([])
    await prepareMission(stored.deps, "lead", "o".repeat(40001))
    await expect(executePreparation(stored.deps, "lead", { kind: "pm", text: "Short mandate" }, stored.port)).rejects.toThrow(/Stored mission objective.*Ensemble.*40000.*40001/)
    expect(stored.calls.some(call => call.method === "create")).toBe(false)
  })

  test("accepts a 40000-character multibyte preplan without truncation and still bounds larger files", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    const content = "あ".repeat(40000)
    writeFileSync(join(f.deps.directory, "preplan.md"), content)
    await executePreparation(f.deps, "lead", { kind: "pm", text: "Objective", preplan: "preplan.md" }, f.port)
    expect(f.prompts[0]?.text).toContain(content)
    const row = f.deps.db.query("SELECT dossier_json FROM preparation_run").get() as { dossier_json: string }
    expect(JSON.parse(row.dossier_json).preplan.content).toBe(content)
    for (const [size, message] of [[40001, /40000.*40001/], [160001, /160000 bytes/]] as const) {
      const rejected = runtimeFixture([])
      writeFileSync(join(rejected.deps.directory, "preplan.md"), "p".repeat(size))
      await expect(executePreparation(rejected.deps, "lead", { kind: "pm", text: "Objective", preplan: "preplan.md" }, rejected.port)).rejects.toThrow(message)
      expect(rejected.calls.some(call => call.method === "create")).toBe(false)
    }
  })

  test("applies the same explicit 40000-character limit to resume clarifications", async () => {
    const blocked = { ...document(), readiness: { status: "blocked", reasons: ["Need clarification"], missingInformation: [] }, tasks: [], parallelGroups: [] }
    const f = runtimeFixture([JSON.stringify(blocked), JSON.stringify(document())])
    await executePreparation(f.deps, "lead", { kind: "pm", text: "Objective" }, f.port)
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "r".repeat(40001), resume: true }, f.port)).rejects.toThrow(/Resume clarification.*Ensemble.*40000.*40001/)
    expect(f.prompts).toHaveLength(1)
    const clarification = "r".repeat(40000)
    const resumed = await executePreparation(f.deps, "lead", { kind: "pm", text: clarification, resume: true }, f.port)
    expect(resumed.status).toBe("imported")
    expect(f.prompts[1]?.text).toContain(clarification)
  })
  test("retains blocked preparation without importing tasks or spending correction attempts", async () => {
    const blocked = { ...document(), version: 2, readiness: { status: "blocked", reasons: ["Functional objective is missing"], missingInformation: ["Supervisor contract"] }, tooling: { catalogue: "unverified", unavailable: ["serena"] }, tasks: [], parallelGroups: [] }
    const f = runtimeFixture([JSON.stringify(blocked), JSON.stringify(document())])
    const first = await executePreparation(f.deps, "lead", { kind: "pm", text: "Objective" }, f.port)
    expect(first.status).toBe("blocked")
    expect(() => approveMission(f.deps, first.teamId, "lead")).toThrow(/preparation/i)
    expect(f.prompts).toHaveLength(1)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 0 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
    expect(f.deps.db.query("SELECT attempts, readiness, candidate_json FROM preparation_run").get()).toMatchObject({ attempts: 0, readiness: "blocked", candidate_json: JSON.stringify(blocked) })
    const replay = await executePreparation(f.deps, "lead", { kind: "pm", text: "" }, f.port)
    expect(replay.status).toBe("blocked")
    expect(f.prompts).toHaveLength(1)
    const resumed = await executePreparation(f.deps, "lead", { kind: "pm", text: "Contract now available", resume: true }, f.port)
    expect(resumed.status).toBe("imported")
    expect(f.prompts).toHaveLength(2)
    expect(f.prompts[1]?.text).toContain("Contract now available")
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
    expect(f.calls.filter(call => call.method === "replacePermissions")).toHaveLength(2)
  })

  test("resumes valid blocked candidates without replaying resolved schema errors", async () => {
    const invalid = document()
    for (const task of invalid.tasks as Array<Record<string, unknown>>) delete (task.planning as Record<string, unknown>).reason
    const blocked = { ...document(), readiness: { status: "blocked", reasons: ["Need the current contract"], missingInformation: ["Contract"] } }
    const incomplete = { ...document(), readiness: { status: "incomplete", reasons: ["Need acceptance evidence"], missingInformation: ["Evidence"] } }
    const f = runtimeFixture([invalid, blocked, incomplete, invalid, document()].map(value => JSON.stringify(value)))
    const first = await executePreparation(f.deps, "lead", { kind: "pm", text: "Objective", history: "fork" }, f.port)
    expect(first.status).toBe("blocked")
    expect(f.prompts[1]?.text).toContain("planning.reason must be a string")
    const history = f.deps.db.query("SELECT attempts, errors_json FROM preparation_run").get()
    expect(history).toMatchObject({ attempts: 1 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 0 })
    const second = await executePreparation(f.deps, "lead", { kind: "pm", text: "The contract is now available", resume: true }, f.port)
    expect(second.status).toBe("incomplete")
    expect(f.prompts[2]?.text).not.toContain("The previous preparation document was rejected.")
    expect(f.prompts[2]?.text).not.toContain("planning.reason must be a string")
    expect(f.prompts[2]?.text).toContain(JSON.stringify(blocked))
    expect(f.prompts[2]?.text).toContain("The contract is now available")
    expect(f.deps.db.query("SELECT attempts, errors_json FROM preparation_run").get()).toEqual(history)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
    const third = await executePreparation(f.deps, "lead", { kind: "pm", text: "Acceptance evidence supplied", resume: true }, f.port)
    expect(third.status).toBe("imported")
    expect(f.prompts[3]?.text).not.toContain("The previous preparation document was rejected.")
    expect(f.prompts[3]?.text).toContain(JSON.stringify(incomplete))
    expect(f.prompts[3]?.text).toContain("The contract is now available")
    expect(f.prompts[3]?.text).toContain("Acceptance evidence supplied")
    expect(f.prompts[4]?.text).toContain("The previous preparation document was rejected.")
    expect(f.prompts[4]?.text).toContain("planning.reason must be a string")
    expect(f.deps.db.query("SELECT attempts FROM preparation_run").get()).toEqual({ attempts: 2 })
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
    expect(f.calls.find(call => call.method === "create")?.args).toMatchObject({ history: "fork" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 1 })
  })

  test("keeps the schema correction budget across a valid blocked pause", async () => {
    const invalid = document()
    for (const task of invalid.tasks as Array<Record<string, unknown>>) delete (task.planning as Record<string, unknown>).reason
    const blocked = { ...document(), readiness: { status: "blocked", reasons: ["Need contract"], missingInformation: [] } }
    const f = runtimeFixture([invalid, blocked, ...Array.from({ length: 5 }, () => invalid)].map(value => JSON.stringify(value)))
    await executePreparation(f.deps, "lead", { kind: "pm", text: "Objective" }, f.port)
    const result = await executePreparation(f.deps, "lead", { kind: "pm", text: "Contract supplied", resume: true }, f.port)
    expect(result.status).toBe("exhausted")
    expect(f.prompts[2]?.text).not.toContain("The previous preparation document was rejected.")
    expect(f.prompts).toHaveLength(7)
    expect(f.deps.db.query("SELECT attempts, status FROM preparation_run").get()).toEqual({ attempts: 6, status: "exhausted" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 0 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
  })

  test("rejects a ready candidate with blocking questions or unverified tooling", async () => {
    for (const invalid of [
      { ...document(), openQuestions: [{ id: "q", question: "Need objective", audience: "supervisor", blocking: true }] },
      { ...document(), tooling: { catalogue: "unverified", unavailable: [] } },
    ]) {
      expect(() => parsePreparationDocument(invalid)).toThrow(/ready/)
    }
  })

  test("a new legacy v1 candidate is incomplete rather than silently ready", async () => {
    const legacy: Record<string, unknown> = { ...document(), version: 1 }
    delete legacy.readiness
    delete legacy.tooling
    legacy.openQuestions = []
    const f = runtimeFixture([JSON.stringify(legacy)])
    const result = await executePreparation(f.deps, "lead", { kind: "pm", text: "Objective" }, f.port)
    expect(result.status).toBe("incomplete")
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 0 })
  })
  test("reads fresh business associations for admission without replacing the setup config", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    f.deps.loadPreparationProfiles = () => ({ extensions: {}, byAgent: { "fresh-pm": "pm" } })
    const result = await executePreparation(f.deps, "lead", { kind: "pm", text: "Objective", pm: "fresh-pm" }, f.port)
    expect(result.agent).toBe("fresh-pm")
    expect(f.deps.config.businessProfiles.byAgent).not.toHaveProperty("fresh-pm")
    const row = f.deps.db.query("SELECT dossier_json FROM preparation_run").get() as { dossier_json: string }
    expect(JSON.parse(row.dossier_json).businessProfilesHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test("a failed fresh mapping read blocks admission before creating a session", async () => {
    const f = runtimeFixture([])
    f.deps.loadPreparationProfiles = () => { throw new Error("Invalid businessProfiles at project root") }
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Objective" }, f.port)).rejects.toThrow("Invalid businessProfiles")
    expect(f.calls.some(call => call.method === "create")).toBe(false)
  })
  test("freezes the objective and preplan in an inspectable dossier before the first prompt", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    writeFileSync(join(f.deps.directory, "preplan.md"), "# Preplan\n\nPreserve this layout.")
    await prepareMission(f.deps, "lead", "Actual mission objective")
    await executePreparation(f.deps, "lead", { kind: "pm", text: "Investigate risks", preplan: "preplan.md" }, f.port)
    expect(f.prompts[0]?.text).toContain("# Preplan\n\nPreserve this layout.")
    const row = f.deps.db.query("SELECT * FROM preparation_run").get() as Record<string, unknown>
    expect(row.dossier_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(String(row.dossier_json))).toMatchObject({ objective: "Actual mission objective", instructions: "Investigate risks", supervisorSessionID: "lead", preplan: { content: "# Preplan\n\nPreserve this layout." } })
    const context = preparationContextText(f.deps.db, "lead")
    expect(context).toContain(String(row.dossier_hash))
    expect(context).toContain("Preserve this layout.")
    expect(context).toContain("effectiveCatalogue")
  })

  test("passes explicit history to native creation before replacing PM rules and prompting", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    await executePreparation(f.deps, "lead", { kind: "pm", text: "Objective", history: "fork" }, f.port)
    expect(f.calls.find(call => call.method === "create")?.args).toMatchObject({ parentID: "lead", history: "fork" })
    expect(f.calls.findIndex(call => call.method === "replacePermissions")).toBeLessThan(f.calls.findIndex(call => call.method === "prompt"))
  })

  test("refuses changing a frozen mandate and retains explicit resume notes across interruptions", async () => {
    const blocked = { ...document(), readiness: { status: "incomplete", reasons: ["Need contract"], missingInformation: [] }, tasks: [], parallelGroups: [] }
    const f = runtimeFixture([JSON.stringify(blocked), JSON.stringify(document())])
    await executePreparation(f.deps, "lead", { kind: "pm", text: "Objective" }, f.port)
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Silently changed objective" }, f.port)).rejects.toThrow(/frozen/)
    let fail = true
    const port = { ...f.port, prompt: async (input: PreparationPromptCall) => {
      if (fail) { fail = false; throw new Error("transport offline") }
      await f.port.prompt(input)
    } }
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Clarification to preserve", resume: true }, port)).rejects.toThrow(/offline/)
    const result = await executePreparation(f.deps, "lead", { kind: "pm", text: "" }, port)
    expect(result.status).toBe("imported")
    expect(f.prompts.at(-1)?.text).toContain("Clarification to preserve")
  })

  test("refuses missing or outside-project preplans before creating any native session", async () => {
    for (const preplan of ["missing.md", "../outside.md"]) {
      const f = runtimeFixture([JSON.stringify(document())])
      await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Objective", preplan }, f.port)).rejects.toThrow(/preplan/i)
      expect(f.calls.some(call => call.method === "create")).toBe(false)
      expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_run").get()).toEqual({ c: 0 })
    }
  })
  test("registers the preparation run migration", () => {
    expect(MIGRATIONS).toHaveLength(26)
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
    expect(f.calls.find(call => call.method === "create")?.args).toEqual({
      title: "Ensemble preparation PM",
      directory: f.deps.directory,
      parentID: "lead",
      agent: ENSEMBLE_PM_AGENT,
    })
    expect(f.calls.find(call => call.method === "switchAgent")?.args).toEqual({ sessionID: "pm-session", agent: ENSEMBLE_PM_AGENT })
    expect(f.calls.find(call => call.method === "switchModel")?.args).toEqual({ sessionID: "pm-session", providerID: "fixture", modelID: "a" })
    expect(preparationContextText(f.deps.db, "pm-session")).toContain("GrepAI")
    expect(preparationContextText(f.deps.db, "lead")).toContain("q1")
    const again = await executePreparation(f.deps, "lead", { kind: "pm", text: "Again" }, f.port)
    expect(again.status).toBe("imported")
    expect(again.mapping).toEqual(result.mapping)
    expect(again.parallelGroups).toEqual(result.parallelGroups)
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

    const active = runtimeFixture([JSON.stringify(document())])
    const mission = await prepareMission(active.deps, "lead", "Stored objective")
    active.deps.db.run(
      "INSERT INTO preparation_run (id, team_id, session_id, agent, model_id, mandate, status, attempts, supervisor_used, time_created, time_updated) VALUES ('run-1', ?, 'pm-session', 'ensemble-pm', 'fixture/a', 'mandate', 'running', 0, 0, 1, 1)",
      [mission.teamId],
    )
    const resumed = await executePreparation(active.deps, "lead", { kind: "pm", text: "Decompose" }, active.port)
    expect(resumed.status).toBe("imported")
    expect(active.calls.filter(call => call.method === "create")).toHaveLength(0)
    expect(active.deps.db.query("SELECT COUNT(*) AS c FROM preparation_run").get()).toEqual({ c: 1 })
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
    expect(f.prompts[0]?.text).toContain("Stored objective")
    expect(f.prompts[0]?.text).toContain("Decompose the stored objective")
  })
})

describe("preparation command", () => {
  test("reports preplan and fresh-configuration validation failures to the supervisor", async () => {
    const f = commandFixture([])
    await registerMissionCommands(f.host, f.deps, async () => nativeCatalogue(), f.port)
    await expect(f.invoke("prepare --preplan missing.md Objective")).resolves.toBeUndefined()
    expect(f.leadPrompts.some(entry => leadText(entry).includes("preplan"))).toBe(true)
    expect(f.calls.some(call => call.method === "create")).toBe(false)
    f.deps.loadPreparationProfiles = () => { throw new Error("Invalid project businessProfiles") }
    await expect(f.invoke("prepare Objective")).resolves.toBeUndefined()
    expect(f.leadPrompts.some(entry => leadText(entry).includes("Invalid project businessProfiles"))).toBe(true)
  })

  test("reports native preparation initialization refusal without an unhandled command error", async () => {
    const f = commandFixture([])
    f.port.createSession = async () => { throw new Error("Preparation checkpoint boundary is absent") }
    await registerMissionCommands(f.host, f.deps, async () => nativeCatalogue(), f.port)
    await expect(f.invoke("prepare --history checkpoint --before msg_missing Objective")).resolves.toBeUndefined()
    expect(f.leadPrompts.some(entry => leadText(entry).includes("checkpoint boundary"))).toBe(true)
    expect(f.prompts).toHaveLength(0)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_run").get()).toEqual({ c: 0 })
  })
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

  test("returns while the PM is still working and a second prepare does not duplicate it", async () => {
    const f = commandFixture([JSON.stringify(document())])
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f.port.wait = async () => { await gate }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }], f.port)
    const pending = f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const winner = await Promise.race([
      pending.then(() => "returned" as const),
      new Promise<"blocked">(resolve => { setTimeout(() => resolve("blocked"), 300) }),
    ])
    try {
      expect(winner).toBe("returned")
      const ack = (f.leadPrompts.at(-1) as { text: string }).text
      expect(ack).toContain("pm-session")
      expect(ack).toContain("Ensemble preparation PM")
      expect(ack).not.toContain("Which boundary owns the schema?")
      expect(f.deps.db.query("SELECT status FROM preparation_run").get()).toEqual({ status: "running" })
      expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_member").get()).toEqual({ c: 0 })
      await f.invoke("prepare --pm ensemble-pm")
      expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
      expect(f.calls.filter(call => call.method === "prompt")).toHaveLength(1)
      expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_run").get()).toEqual({ c: 1 })
    } finally {
      release()
      await pending
    }
  })

  test("deferred success arrives once after prepare has returned", async () => {
    const f = commandFixture([JSON.stringify(document())])
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f.port.wait = async () => { await gate }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }], f.port)
    const pending = f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const winner = await Promise.race([
      pending.then(() => "returned" as const),
      new Promise<"blocked">(resolve => { setTimeout(() => resolve("blocked"), 300) }),
    ])
    expect(winner).toBe("returned")
    expect(f.leadPrompts.some(entry => leadText(entry).includes("Which boundary owns the schema?"))).toBe(false)
    release()
    await waitForLead(f.leadPrompts, "Which boundary owns the schema?")
    await new Promise(resolve => setTimeout(resolve, 20))
    const results = f.leadPrompts.filter(entry => leadText(entry).includes("Which boundary owns the schema?"))
    expect(results).toHaveLength(1)
    expect(f.deps.db.query("SELECT status FROM preparation_run").get()).toEqual({ status: "imported" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    expect(f.leadPrompts.some(entry => leadText(entry).toLowerCase().includes("rollback"))).toBe(false)
    await pending
  })

  test("deferred PM error arrives after prepare has returned", async () => {
    const f = commandFixture([JSON.stringify(document())])
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f.port.wait = async () => {
      await gate
      throw new Error("provider unavailable")
    }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }], f.port)
    const pending = f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const winner = await Promise.race([
      pending.then(() => "returned" as const),
      new Promise<"blocked">(resolve => { setTimeout(() => resolve("blocked"), 300) }),
    ])
    expect(winner).toBe("returned")
    expect(f.leadPrompts.some(entry => leadText(entry).includes("provider unavailable"))).toBe(false)
    release()
    await waitForLead(f.leadPrompts, "provider unavailable")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.leadPrompts.filter(entry => leadText(entry).includes("provider unavailable"))).toHaveLength(1)
    expect(f.deps.db.query("SELECT status FROM preparation_run").get()).toEqual({ status: "running" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
    expect(f.leadPrompts.some(entry => leadText(entry).toLowerCase().includes("rollback"))).toBe(false)
    await pending
  })

  test("deferred ack rejection still delivers the PM result once", async () => {
    const f = commandFixture([JSON.stringify(document())])
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f.port.wait = async () => { await gate }
    f.host.session.prompt = async (input: unknown) => {
      f.leadPrompts.push(input)
      if (leadText(input).includes("will be delivered to this supervisor session")) throw new Error("ack rejected")
    }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }], f.port)
    const pending = f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const winner = await Promise.race([
      pending.then(() => "returned" as const, error => error),
      new Promise<"blocked">(resolve => { setTimeout(() => resolve("blocked"), 300) }),
    ])
    expect(winner).toBeInstanceOf(Error)
    expect((winner as Error).message).toMatch(/ack rejected/)
    expect((winner as Error).message.toLowerCase()).not.toContain("rollback")
    expect(f.leadPrompts.some(entry => leadText(entry).includes("Which boundary owns the schema?"))).toBe(false)
    expect(f.deps.db.query("SELECT status FROM preparation_run").get()).toEqual({ status: "running" })
    release()
    await waitForLead(f.leadPrompts, "Which boundary owns the schema?")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.leadPrompts.filter(entry => leadText(entry).includes("Which boundary owns the schema?"))).toHaveLength(1)
    expect(f.deps.db.query("SELECT status FROM preparation_run").get()).toEqual({ status: "imported" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    expect(f.leadPrompts.some(entry => leadText(entry).toLowerCase().includes("rollback"))).toBe(false)
  })

  test("deferred ack rejection still delivers the PM error", async () => {
    const f = commandFixture([JSON.stringify(document())])
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f.port.wait = async () => {
      await gate
      throw new Error("provider unavailable")
    }
    f.host.session.prompt = async (input: unknown) => {
      f.leadPrompts.push(input)
      if (leadText(input).includes("will be delivered to this supervisor session")) throw new Error("ack rejected")
    }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }], f.port)
    const pending = f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const winner = await Promise.race([
      pending.then(() => "returned" as const, error => error),
      new Promise<"blocked">(resolve => { setTimeout(() => resolve("blocked"), 300) }),
    ])
    expect(winner).toBeInstanceOf(Error)
    expect((winner as Error).message).toMatch(/ack rejected/)
    expect((winner as Error).message.toLowerCase()).not.toContain("rollback")
    expect(f.leadPrompts.some(entry => leadText(entry).includes("provider unavailable"))).toBe(false)
    release()
    await waitForLead(f.leadPrompts, "provider unavailable")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.leadPrompts.filter(entry => leadText(entry).includes("provider unavailable"))).toHaveLength(1)
    expect(f.deps.db.query("SELECT status FROM preparation_run").get()).toEqual({ status: "running" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
    expect(f.leadPrompts.some(entry => leadText(entry).toLowerCase().includes("rollback"))).toBe(false)
  })

  test("deferred final delivery failure keeps the import recoverable", async () => {
    const f = commandFixture([JSON.stringify(document())])
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f.port.wait = async () => { await gate }
    f.host.session.prompt = async (input: unknown) => {
      f.leadPrompts.push(input)
      if (leadText(input).includes("Preparation imported")) throw new Error("socket closed")
    }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }], f.port)
    const pending = f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const winner = await Promise.race([
      pending.then(() => "returned" as const),
      new Promise<"blocked">(resolve => { setTimeout(() => resolve("blocked"), 300) }),
    ])
    expect(winner).toBe("returned")
    release()
    await waitForLead(f.leadPrompts, "Preparation imported")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.leadPrompts.some(entry => leadText(entry).toLowerCase().includes("rollback"))).toBe(false)
    expect(f.deps.db.query("SELECT status FROM preparation_run").get()).toEqual({ status: "imported" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 1 })
    f.host.session.prompt = async (input: unknown) => { f.leadPrompts.push(input) }
    await f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const recovered = leadText(f.leadPrompts.at(-1))
    expect(recovered).toContain("Which boundary owns the schema?")
    expect(recovered).toContain("code")
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 1 })
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
    await pending
  })
})

describe("preparation host adapter", () => {
  test("uses the declared permission action rather than the registered tool ID", async () => {
    const rules = [{ action: "*", resource: "*", effect: "deny" }, { action: "context_mode_ctx_execute_file", resource: "*", effect: "allow" }]
    const port = createPreparationPort({
      location: { directory: "/fixture" },
      agent: { get: async () => ({ permissions: rules }) },
      tool: { list: async () => [{ id: "context-mode_ctx_execute_file", options: { permission: "context_mode_ctx_execute_file" } }] },
      session: { create: async () => ({ id: "pm" }), prompt: async () => undefined, switchAgent: async () => undefined, switchModel: async () => undefined, get: async () => ({ permissions: rules }) },
    }, true, async () => [])
    const evidence = await port.inspectTools?.({ sessionID: "pm", agent: "pm" })
    expect(evidence?.registered[0]).toMatchObject({ id: "context-mode_ctx_execute_file", permission: "allow" })
  })
  test("distinguishes registered tools, denied actions, and disconnected MCPs without granting access", async () => {
    const base = {
      location: { directory: "/project" },
      agent: { get: async () => ({ permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "execute", resource: "*", effect: "allow" }] }) },
      tool: { list: async () => [{ id: "serena_lookup" }] },
      mcp: { list: async () => ({ data: [{ name: "serena", status: { status: "connected" } }, { name: "grepai", status: { status: "failed" } }] }) },
      session: {
        create: async () => ({ id: "pm" }), prompt: async () => undefined,
        switchAgent: async () => undefined, switchModel: async () => undefined,
        get: async () => ({ permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "execute", resource: "*", effect: "allow" }] }),
      },
    }
    const evidence = await createPreparationPort(base, true, async () => []).inspectTools?.({ sessionID: "pm", agent: "pm" })
    expect(evidence).toMatchObject({ effectiveCatalogue: "unverified", registered: [{ id: "serena_lookup", permission: "deny" }], servers: [{ name: "serena", status: "connected" }, { name: "grepai", status: "failed" }] })
    const unavailable = await createPreparationPort({ ...base, tool: undefined, mcp: undefined }, true, async () => []).inspectTools?.({ sessionID: "pm", agent: "pm" })
    expect(unavailable?.issues.join(" ")).toMatch(/catalogue|tool/i)
    const allowed = await createPreparationPort({ ...base, agent: { get: async () => ({ permissions: [{ action: "serena_lookup", resource: "*", effect: "allow" }] }) }, session: { ...base.session, get: async () => ({ permissions: [{ action: "serena_lookup", resource: "*", effect: "allow" }] }) } }, true, async () => []).inspectTools?.({ sessionID: "pm", agent: "pm" })
    expect(allowed?.registered).toEqual([{ id: "serena_lookup", action: "serena_lookup", permission: "allow" }])
    expect(allowed?.effectiveCatalogue).toBe("unverified")
  })
  test("inherits only on explicit request and validates checkpoint source before forking", async () => {
    const f = runtimeFixture([])
    const calls: unknown[] = []
    const host = {
      location: { directory: f.deps.directory },
      session: {
        create: async () => { calls.push("fresh"); return { id: "fresh" } },
        prompt: async () => undefined, switchAgent: async () => undefined, switchModel: async () => undefined,
        get: async () => ({ id: "lead", location: { directory: f.deps.directory } }),
        context: async () => [{ id: "msg_boundary", type: "user", content: "boundary" }],
      },
    }
    const port = createPreparationPort(host, true, async () => [], { fork: async input => { calls.push(input); return { id: "forked-pm" } } })
    const input = { title: "PM", directory: f.deps.directory, parentID: "lead", agent: "pm" }
    expect((await port.createSession(input)).id).toBe("fresh")
    expect((await port.createSession({ ...input, history: "checkpoint", before: "msg_boundary" })).id).toBe("forked-pm")
    expect(calls).toEqual(["fresh", { sessionID: "lead", before: "msg_boundary" }])
    await expect(port.createSession({ ...input, history: "checkpoint", before: "msg_missing" })).rejects.toThrow(/boundary/)
    const unavailable = createPreparationPort(host, true, async () => [])
    await expect(unavailable.createSession({ ...input, history: "fork" })).rejects.toThrow(/fork/)
    const wrongSource = createPreparationPort({ ...host, session: { ...host.session, get: async () => ({ id: "lead", location: { directory: "/other-project" } }) } }, true, async () => [], { fork: async () => { calls.push("unexpected fork"); return { id: "wrong" } } })
    await expect(wrongSource.createSession({ ...input, history: "fork" })).rejects.toThrow(/same project/)
    expect(calls).toHaveLength(2)
  })
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

  test("binds the preparatory PM as a child and replaces inherited permissions with the native rules", async () => {
    const root = join(import.meta.dir, "..")
    const f = runtimeFixture([])
    const calls: Array<{ method: string; input: unknown }> = []
    const messages: unknown[] = []
    const nativeRules = [
      { action: "edit", resource: "*", effect: "deny" as const },
      { action: "read", resource: "*", effect: "allow" as const },
    ]
    const port = createPreparationPort({
      location: { directory: root },
      agent: { get: async () => ({ permissions: nativeRules }) },
      session: {
        create: async input => { calls.push({ method: "create", input }); return { id: "pm-child" } },
        update: async input => { calls.push({ method: "update", input }); return {} },
        prompt: async () => {
          messages.push({ info: { role: "assistant", id: "reply" }, parts: [{ type: "text", text: JSON.stringify(document()) }] })
        },
        switchAgent: async () => undefined,
        switchModel: async () => undefined,
        get: async () => ({ outcome: "succeeded" }),
        wait: async () => undefined,
        context: async () => messages,
        interrupt: async input => { calls.push({ method: "interrupt", input }) },
      },
    }, true, async () => nativeCatalogue())
    const result = await executePreparation(f.deps, "ses_lead", { kind: "pm", text: "Ship the cache boundary" }, port)
    expect(result.status).toBe("imported")
    expect(calls[0]).toEqual({
      method: "create",
      input: { title: "Ensemble preparation PM", parentID: "ses_lead", location: { directory: root } },
    })
    expect(JSON.stringify(calls[0]?.input)).not.toContain("shell")
    expect(calls.find(call => call.method === "update")?.input).toEqual({ sessionID: "pm-child", permissions: nativeRules })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_member").get()).toEqual({ c: 0 })
  })

  test("interrupts a child session when inherited permissions cannot be replaced", async () => {
    const root = join(import.meta.dir, "..")
    const f = runtimeFixture([])
    const calls: Array<{ method: string; input: unknown }> = []
    const port = createPreparationPort({
      location: { directory: root },
      agent: { get: async () => ({ permissions: [{ action: "edit", effect: "deny" }] }) },
      session: {
        create: async input => { calls.push({ method: "create", input }); return { id: "pm-child" } },
        prompt: async () => undefined,
        switchAgent: async () => undefined,
        switchModel: async () => undefined,
        get: async () => ({ outcome: "succeeded" }),
        wait: async () => undefined,
        context: async () => [],
        interrupt: async input => { calls.push({ method: "interrupt", input }) },
      },
    }, true, async () => nativeCatalogue())
    await expect(executePreparation(f.deps, "ses_lead", { kind: "pm", text: "Ship the cache boundary" }, port)).rejects.toThrow(/session\.update/)
    expect(calls.map(call => call.method)).toEqual(["create", "interrupt"])
    expect(calls[0]?.input).not.toHaveProperty("permissions")
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_run").get()).toEqual({ c: 0 })
  })
})

describe("preparation QA blockers", () => {
  test("QA: retries an interrupted prompt on the same session", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    let failed = false
    const prompt = f.port.prompt
    f.port.prompt = async input => {
      if (!failed) {
        failed = true
        throw new Error("provider unavailable")
      }
      return prompt(input)
    }
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)).rejects.toThrow(/provider unavailable/)
    const resumed = await executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    expect(resumed.status).toBe("imported")
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_run").get()).toEqual({ c: 1 })
    expect(f.deps.db.query("SELECT status, attempts FROM preparation_run").get()).toEqual({ status: "imported", attempts: 0 })
  })

  test("QA: aborts a wait that has no deadline and stays resumable", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    f.port.wait = async input => {
      const signal = (input as { signal?: AbortSignal }).signal
      if (!signal) throw new Error("wait was not bounded by a signal")
      await new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("signal did not abort the wait")), 250)
        signal.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(new Error("Preparation wait timed out"))
        })
      })
    }
    ;(f.port as PreparationPort & { waitBoundMs?: number }).waitBoundMs = 30
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)).rejects.toThrow(/timed out|signal/)
    expect(f.calls.some(call => call.method === "abort")).toBe(true)
    expect(f.deps.db.query("SELECT status, attempts FROM preparation_run").get()).toEqual({ status: "running", attempts: 0 })
    f.port.wait = async () => undefined
    const resumed = await executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    expect(resumed.status).toBe("imported")
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
  })

  test("QA: restitutes an import that committed before the run status changed", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    const first = await executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    f.deps.db.run("UPDATE preparation_run SET status = 'running'")
    const again = await executePreparation(f.deps, "lead", { kind: "pm", text: "Again" }, f.port)
    expect(again.status).toBe("imported")
    expect(again.mapping).toEqual(first.mapping)
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 1 })
  })

  test("QA: does not import an unrelated object sliced from prose", async () => {
    const unrelated = JSON.stringify({ version: 1, context: "unrelated object", openQuestions: [], tasks: [], parallelGroups: [] })
    const fenced = "```json\n" + JSON.stringify(document()) + "\n```"
    const f = runtimeFixture([`prefix ${unrelated} suffix`, fenced])
    const result = await executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    expect(result.status).toBe("imported")
    expect(result.mapping?.map(item => item.pmId).sort()).toEqual(["code", "docs"])
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 1 })
    expect(f.deps.db.query("SELECT context FROM preparation_import").get()).toEqual({ context: "Shared context for the bounded preparation run." })
  })

  test("QA: sends the rejected candidate and the unsupported attribute back to the PM", async () => {
    const raw = document()
    const tasks = raw.tasks as Array<Record<string, unknown>>
    tasks[0] = { ...tasks[0], model: "fixture/smuggled" }
    const bad = JSON.stringify(raw)
    const f = runtimeFixture([bad, JSON.stringify(document())])
    const result = await executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    expect(result.status).toBe("imported")
    expect(f.prompts[1]?.text).toContain("tasks[0].model is not supported")
    expect(f.prompts[1]?.text).toContain("fixture/smuggled")
    const stored = f.deps.db.query("SELECT candidate_json, errors_json FROM preparation_run").get() as { candidate_json: string; errors_json: string }
    expect(stored.errors_json).toContain("tasks[0].model is not supported")
    expect(stored.candidate_json).toContain("fixture/smuggled")
    expect(stored.candidate_json).not.toBe(JSON.stringify({ id: "fixture/a" }))
    expect(preparationContextText(f.deps.db, "pm-session")).toContain("Ship the cache boundary")
    expect(preparationContextText(f.deps.db, "pm-session")).toContain("GrepAI")
  })

  test("QA: returns the last candidate and attribute issues when corrections are exhausted", async () => {
    const raw = document()
    const tasks = raw.tasks as Array<Record<string, unknown>>
    tasks[0] = { ...tasks[0], model: "fixture/smuggled" }
    const bad = JSON.stringify(raw)
    const f = commandFixture(Array.from({ length: 6 }, () => bad))
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/a", variant: "high" }], f.port)
    await f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const text = (f.leadPrompts.at(-1) as { text: string }).text
    expect(text).toContain("tasks[0].model is not supported")
    expect(text).toContain("fixture/smuggled")
    expect(text).toContain("prepare --accept")
  })

  test("QA: parses an empty mandate for later session resolution", () => {
    expect(parseMissionCommand("prepare")).toEqual({ action: "prepare", text: "", preparation: { kind: "pm" } })
    expect(parseMissionCommand("prepare --pm ensemble-pm")).toEqual({
      action: "prepare", text: "", preparation: { kind: "pm", pm: "ensemble-pm" },
    })
    expect(() => parseMissionCommand("prepare --pm")).toThrow(/agent/)
    expect(() => parseMissionCommand("prepare --pm --accept {}")).toThrow(/exclusive/)
  })

  test("QA: uses the stored objective when the mandate is omitted", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    await prepareMission(f.deps, "lead", "Stored objective")
    await executePreparation(f.deps, "lead", { kind: "pm", text: "" }, f.port)
    expect(f.prompts[0]?.text).toContain("Stored objective")
    expect(f.deps.db.query("SELECT objective FROM mission_policy").get()).toEqual({ objective: "Stored objective" })
    expect(f.deps.db.query("SELECT mandate FROM preparation_run").get()).toEqual({ mandate: "Stored objective" })
  })

  test("QA: refuses to open a draft when prepare has no mandate", async () => {
    const f = commandFixture([JSON.stringify(document())])
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/a" }], f.port)
    await f.invoke("prepare")
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(0)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team").get()).toEqual({ c: 0 })
    expect((f.leadPrompts.at(-1) as { text: string }).text).toMatch(/mandate/)
  })

  test("QA: prepare without a mandate deepens the stored objective", async () => {
    const f = commandFixture([JSON.stringify(document())])
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/a" }], f.port)
    await f.invoke("Keep the stored objective")
    await f.invoke("prepare --pm ensemble-pm")
    expect(f.deps.db.query("SELECT objective FROM mission_policy").get()).toEqual({ objective: "Keep the stored objective" })
    expect(f.prompts[0]?.text).toContain("Keep the stored objective")
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team").get()).toEqual({ c: 1 })
  })

  test("QA: returns dispositions, integration notes, and the exact variant", async () => {
    const raw = document([{
      id: "code", title: "Title code", type: "implementation", goal: "Goal code", dependsOn: [],
      planning: { required: false, reason: "Direct code stays inside the cited file." },
      acceptanceCriteria: ["Accepted code when the cited behavior holds."],
      verification: ["Verify code with its focused test."],
      handoff: { document: "Findings for code stay in this handoff.", sources: [{ path: "src/code.ts", note: "Owns code." }] },
    }])
    raw.parallelGroups = [{
      taskIds: ["code"],
      reason: "The task has no partner.",
      integrationNotes: "Reconcile the held task on the lead branch.",
      isolation: "separate-worktrees",
    }]
    const f = commandFixture([JSON.stringify(raw)])
    f.deps.config.modelRouting.models = [
      { id: "fixture/a", reasoningEffort: "xhigh", intelligenceScore: 40, averageCostPerTask: 0, available: true },
    ]
    f.port.nativeModels = async () => [{ id: "fixture/a", variant: "xhigh" }]
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/a", variant: "xhigh" }], f.port)
    await f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const text = (f.leadPrompts.at(-1) as { text: string }).text
    expect(text).toContain("fixture/a")
    expect(text).toContain("xhigh")
    expect(text).toContain("held")
    expect(text).toContain("version 2")
    expect(text).toContain("Reconcile the held task on the lead branch.")
    const repeated = await executePreparation(f.deps, "lead", { kind: "pm", text: "different mandate" }, f.port)
    expect(repeated.status).toBe("imported")
    expect(repeated.model).toEqual({ id: "fixture/a", variant: "xhigh" })
    expect(repeated.mapping?.[0]).toMatchObject({ pmId: "code", disposition: "held", mode: "direct", kind: "code" })
    expect(repeated.mapping?.[0]?.holdReason).toMatch(/version 2/i)
    expect(repeated.parallelGroups?.[0]?.integrationNotes).toBe("Reconcile the held task on the lead branch.")
    expect(f.deps.db.query("SELECT objective FROM mission_policy").get()).toEqual({ objective: "Ship the cache boundary" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 1 })
    const storedTask = f.deps.db.query("SELECT task_id, hold_reason FROM preparation_task").get() as { task_id: string; hold_reason: string }
    expect(text).toContain(storedTask.task_id)
    expect(text).toContain("The task has no partner.")
    expect(text).toContain("separate-worktrees")
    const context = preparationContextText(f.deps.db, "lead") ?? ""
    expect(context).toContain("Reconcile the held task on the lead branch.")
    expect(context).toContain("held")
    expect(context).toContain(storedTask.task_id)
    expect(context).toContain(storedTask.hold_reason)
    expect(context).toContain("The task has no partner.")
    expect(context).toContain("separate-worktrees")
  })

  test("QA: an invalid accept is returned without consuming the correction", async () => {
    const raw = document()
    const tasks = raw.tasks as Array<Record<string, unknown>>
    tasks[0] = { ...tasks[0], model: "fixture/smuggled" }
    const f = commandFixture(Array.from({ length: 6 }, () => JSON.stringify(raw)))
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/a" }], f.port)
    await f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    await f.invoke("prepare --accept {not json")
    expect((f.leadPrompts.at(-1) as { text: string }).text).toMatch(/JSON object/)
    expect(f.deps.db.query("SELECT status, supervisor_used FROM preparation_run").get()).toEqual({ status: "exhausted", supervisor_used: 0 })
    await f.invoke(`prepare --accept ${JSON.stringify(document())}`)
    expect(f.deps.db.query("SELECT status, supervisor_used FROM preparation_run").get()).toEqual({ status: "imported", supervisor_used: 1 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
  })

  test("QA: delivery failure after import keeps the mapping and does not claim rollback", async () => {
    const f = commandFixture([JSON.stringify(document())])
    f.host.session.prompt = async (input: unknown) => {
      f.leadPrompts.push(input)
      const text = (input as { text?: string }).text ?? ""
      if (text.includes("Preparation imported")) throw new Error("socket closed")
    }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/a" }], f.port)
    let caught: unknown
    try {
      await f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    } catch (error) {
      caught = error
    }
    const message = caught instanceof Error ? caught.message : ""
    expect(message).toMatch(/remains committed/)
    expect(message).toContain("code")
    expect(message).toContain("socket closed")
    expect(message.toLowerCase()).not.toContain("rollback")
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    f.host.session.prompt = async (input: unknown) => { f.leadPrompts.push(input) }
    await f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const text = (f.leadPrompts.at(-1) as { text: string }).text
    expect(text).toContain("code")
    expect(text).toContain("docs")
    expect(text).toContain("Reconcile on the lead branch")
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
  })

  test("QA: missing wait, context, or interrupt fails before a session", async () => {
    const root = join(import.meta.dir, "..")
    for (const absent of ["wait", "context", "interrupt"] as const) {
      const f = runtimeFixture([])
      let created = 0
      const session = {
        create: async () => { created += 1; return { id: "pm-native" } },
        prompt: async () => undefined,
        switchAgent: async () => undefined,
        switchModel: async () => undefined,
        wait: async () => undefined,
        context: async () => [],
        interrupt: async () => undefined,
      }
      delete session[absent]
      const port = createPreparationPort({
        location: { directory: root },
        agent: { get: async () => ({ metadata: { format: "json_schema" }, permissions: [{ action: "edit", effect: "deny" }, { action: "bash", effect: "deny" }] }) },
        session,
      }, true, async () => nativeCatalogue())
      await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, port)).rejects.toThrow(new RegExp(`session\\.${absent}`))
      expect(created).toBe(0)
      expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_run").get()).toEqual({ c: 0 })
    }
  })

  test("QA: an unchanged assistant cursor is not six invalid documents", async () => {
    const root = join(import.meta.dir, "..")
    const f = runtimeFixture([])
    const messages = [{ info: { role: "assistant", id: "old" }, parts: [{ type: "text", text: "old prose" }] }]
    const port = createPreparationPort({
      location: { directory: root },
      agent: { get: async () => ({ permissions: [{ action: "edit", effect: "deny" }] }) },
      session: {
        create: async () => ({ id: "pm-native" }),
        update: async () => undefined,
        prompt: async () => undefined,
        switchAgent: async () => undefined,
        switchModel: async () => undefined,
        get: async () => ({ outcome: "succeeded" }),
        wait: async () => undefined,
        context: async () => messages,
        interrupt: async () => undefined,
      },
    }, true, async () => nativeCatalogue())
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, port)).rejects.toThrow(/no new assistant reply/)
    expect(f.deps.db.query("SELECT status, attempts FROM preparation_run").get()).toEqual({ status: "running", attempts: 0 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 0 })
  })

  test("QA: public prompt ignores structured-output metadata", async () => {
    const root = join(import.meta.dir, "..")
    const f = runtimeFixture([])
    const messages = [{ info: { role: "assistant", id: "old" }, parts: [{ type: "text", text: "old prose" }] }]
    const prompts: Array<Record<string, unknown>> = []
    let created = 0
    const port = createPreparationPort({
      location: { directory: root },
      agent: { get: async () => ({ metadata: { structuredOutput: true, format: "json_schema" }, permissions: [{ action: "edit", effect: "deny" }] }) },
      session: {
        create: async () => { created += 1; return { id: "pm-native" } },
        update: async () => undefined,
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input)
          messages.push({ info: { role: "assistant", id: "new" }, parts: [{ type: "text", text: JSON.stringify(document()) }] })
        },
        switchAgent: async () => undefined,
        switchModel: async () => undefined,
        get: async () => ({ outcome: "succeeded" }),
        wait: async (_input: Record<string, unknown>, _options?: { signal?: AbortSignal }) => undefined,
        context: async () => messages,
        interrupt: async () => undefined,
      },
    }, true, async () => nativeCatalogue())
    const result = await executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, port)
    expect(result.status).toBe("imported")
    expect(result.mapping?.map(item => item.pmId).sort()).toEqual(["code", "docs"])
    expect(created).toBe(1)
    expect(prompts).toHaveLength(1)
    expect(prompts[0] && "format" in prompts[0]).toBe(false)
    expect(prompts[0] && "json_schema" in prompts[0]).toBe(false)
    expect(Object.keys(prompts[0] ?? {}).sort()).toEqual(["delivery", "sessionID", "text"])
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 1 })
    expect(f.deps.db.query("SELECT context FROM preparation_import").get()).not.toEqual({ context: "old prose" })
  })

  test("QA: native wait receives the abort signal as request options", async () => {
    const f = runtimeFixture([])
    const waits: Array<{ input: unknown; options?: { signal?: AbortSignal } }> = []
    const port = createPreparationPort({
      location: { directory: f.deps.directory },
      agent: { get: async () => ({ permissions: [{ action: "edit", effect: "deny" }] }) },
      session: {
        create: async () => ({ id: "pm-native" }),
        update: async () => undefined,
        prompt: async () => undefined,
        switchAgent: async () => undefined,
        switchModel: async () => undefined,
        get: async () => ({ outcome: "succeeded" }),
        wait: async (input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
          waits.push({ input, options })
          const signal = options?.signal
          if (!signal) throw new Error("AbortSignal missing from request options")
          await new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error("signal was not aborted")), 300)
            signal.addEventListener("abort", () => {
              clearTimeout(timer)
              reject(new Error("host wait aborted"))
            }, { once: true })
          })
        },
        context: async () => [],
        interrupt: async () => undefined,
      },
    }, true, async () => nativeCatalogue())
    port.waitBoundMs = 30
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, port)).rejects.toThrow(/timed out/)
    expect(waits).toHaveLength(1)
    expect(waits[0]?.input).toEqual({ sessionID: "pm-native" })
    expect(waits[0]?.options?.signal).toBeInstanceOf(AbortSignal)
    expect(waits[0]?.options?.signal?.aborted).toBe(true)
    expect(f.deps.db.query("SELECT status, attempts FROM preparation_run").get()).toEqual({ status: "running", attempts: 0 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 0 })
  })

  test("QA: a failed or interrupted native session is refused before import", async () => {
    for (const outcome of ["failed", "interrupted"] as const) {
      const f = runtimeFixture([])
      const gets: unknown[] = []
      const messages: unknown[] = []
      const port = createPreparationPort({
        location: { directory: f.deps.directory },
        agent: { get: async () => ({ permissions: [{ action: "edit", effect: "deny" }] }) },
        session: {
          create: async () => ({ id: "pm-native" }),
          update: async () => undefined,
          prompt: async () => {
            messages.push({ info: { role: "assistant", id: `reply-${outcome}` }, parts: [{ type: "text", text: JSON.stringify(document()) }] })
          },
          switchAgent: async () => undefined,
          switchModel: async () => undefined,
          get: async (input: { sessionID: string }) => {
            gets.push(input)
            return { outcome }
          },
          wait: async (_input: { sessionID: string }, _options?: { signal?: AbortSignal }) => undefined,
          context: async () => messages,
          interrupt: async () => undefined,
        },
      }, true, async () => nativeCatalogue())
      await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, port)).rejects.toThrow(new RegExp(outcome))
      expect(gets).toEqual([{ sessionID: "pm-native" }, { sessionID: "pm-native" }])
      expect(f.deps.db.query("SELECT status, attempts FROM preparation_run").get()).toEqual({ status: "running", attempts: 0 })
      expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 0 })
      expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
    }
  })

  test("QA: assistant cursors from two sessions do not consume each other", async () => {
    const contexts = new Map<string, unknown[]>([
      ["ses-a", [{ info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "stale-a" }] }]],
      ["ses-b", [{ info: { role: "assistant", id: "b1" }, parts: [{ type: "text", text: "stale-b" }] }]],
    ])
    const port = createPreparationPort({
      location: { directory: join(import.meta.dir, "..") },
      session: {
        create: async () => ({ id: "unused" }),
        prompt: async () => undefined,
        switchAgent: async () => undefined,
        switchModel: async () => undefined,
        get: async () => ({ outcome: "succeeded" }),
        wait: async () => undefined,
        context: async (input: Record<string, unknown>) => contexts.get(String(input.sessionID)) ?? [],
        interrupt: async () => undefined,
      },
    }, true, async () => [])
    await port.prompt({ sessionID: "ses-a", text: "a", delivery: "queue" })
    await port.prompt({ sessionID: "ses-b", text: "b", delivery: "queue" })
    await expect(port.readAssistant({ sessionID: "ses-a" })).rejects.toThrow(/no new assistant reply/)
    contexts.get("ses-b")?.push({ info: { role: "assistant", id: "b2" }, parts: [{ type: "text", text: "fresh-b" }] })
    await expect(port.readAssistant({ sessionID: "ses-b" })).resolves.toBe("fresh-b")
    await expect(port.readAssistant({ sessionID: "ses-a" })).rejects.toThrow(/no new assistant reply/)
  })

  test("QA: an active running loop rejects a second prepare and then resumes", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    let entered = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let started: () => void = () => undefined
    const ready = new Promise<void>(resolve => { started = resolve })
    const original = f.port.prompt
    f.port.prompt = async input => {
      entered += 1
      if (entered === 1) started()
      await gate
      return original(input)
    }
    const first = executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    const start = await Promise.race([
      ready.then(() => "ready" as const),
      new Promise<"timeout">(resolve => { setTimeout(() => resolve("timeout"), 1000) }),
    ])
    expect(start).toBe("ready")
    const second = executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    const secondResult = second.then(value => value, error => error)
    let secondError: unknown
    try {
      secondError = await Promise.race([
        secondResult,
        new Promise<string>(resolve => { setTimeout(() => resolve("overlapped"), 500) }),
      ])
    } finally {
      release()
    }
    await secondResult
    expect(secondError).toMatchObject({ code: "running" })
    expect(entered).toBe(1)
    await expect(first).resolves.toMatchObject({ status: "imported" })
    const replay = await executePreparation(f.deps, "lead", { kind: "pm", text: "Again" }, f.port)
    expect(replay.status).toBe("imported")
    expect(entered).toBe(1)
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
  })

  test("QA: replays a stored import after approval without host lookup", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    const first = await executePreparation(f.deps, "lead", { kind: "pm", text: "Ship the cache boundary" }, f.port)
    f.deps.db.run("UPDATE mission_policy SET approved_hash = 'locked', policy_path = ?", ["missing-preparation-policy.json"])
    f.port.hooksReady = false
    f.port.assertCapabilities = async () => { throw new Error("capabilities down") }
    f.port.probeAgent = async () => { throw new Error("agent down") }
    f.port.describeAgent = async () => { throw new Error("describe down") }
    f.port.nativeModels = async () => { throw new Error("models down") }
    const again = await executePreparation(f.deps, "lead", { kind: "pm", text: "Again" }, f.port)
    expect(again.status).toBe("imported")
    expect(again.mapping).toEqual(first.mapping)
    expect(again.parallelGroups).toEqual(first.parallelGroups)
    expect(again.model).toEqual(first.model)
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 2 })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 1 })
    expect(f.deps.db.query("SELECT approved_hash FROM mission_policy").get()).toEqual({ approved_hash: "locked" })
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM team_member").get()).toEqual({ c: 0 })
  })

  test("QA: an approved mission without an import does not resume or open a session", async () => {
    const f = runtimeFixture([JSON.stringify(document())])
    const mission = await prepareMission(f.deps, "lead", "Stored objective")
    f.deps.db.run(
      "INSERT INTO preparation_run (id, team_id, session_id, agent, model_id, mandate, status, attempts, supervisor_used, time_created, time_updated) VALUES ('run-approved', ?, 'pm-session', 'ensemble-pm', 'fixture/a', 'mandate', 'running', 0, 0, 1, 1)",
      [mission.teamId],
    )
    f.deps.db.run("UPDATE mission_policy SET approved_hash = 'locked'")
    await expect(executePreparation(f.deps, "lead", { kind: "pm", text: "Continue" }, f.port)).rejects.toMatchObject({ code: "approved" })
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(0)
    expect(f.calls.filter(call => call.method === "prompt")).toHaveLength(0)
    expect(f.deps.db.query("SELECT COUNT(*) AS c FROM preparation_import").get()).toEqual({ c: 0 })
  })
})

describe("preparation PM session restitution", () => {
  test("returns autonomous inline code only for an exact native session id", () => {
    const text = preparationSessionReference(NATIVE_PM_SESSION) ?? ""
    expect(hasAutonomousSessionInline(text, NATIVE_PM_SESSION)).toBe(true)
    expect(text).toContain("current reply")
    expect(text).toContain("inline code")
    expect(text.toLowerCase()).not.toContain("child")
    expect(text).not.toMatch(/\bis running\b/)
    expect(text).not.toMatch(/https?:|opencode:|file:/)
  })

  test("does not promote fixture or near-miss ids into a session button", () => {
    const unsafe = `ses_${"a".repeat(27)}`
    for (const id of ["pm-session", "fixturefake", `ses_${"b".repeat(25)}`, unsafe, `SES_${"c".repeat(26)}`, `ses_${"d".repeat(25)}_`]) {
      const text = preparationSessionReference(id) ?? ""
      expect(buttonSpans(text).some(span => /^ses_[0-9A-Za-z]{26}$/.test(span))).toBe(false)
      expect(buttonSpans(text)).not.toContain(id)
      if (/ses_[0-9A-Za-z]{26}/.test(id)) expect(text).not.toMatch(/ses_[0-9A-Za-z]{26}/)
    }
    expect(preparationSessionReference(undefined)).toBeUndefined()
    expect(preparationSessionReference(null)).toBeUndefined()
    expect(preparationSessionReference("")).toBeUndefined()
  })

  test("shows the native id in the queued ack, active resume, and lead context without extra host calls", async () => {
    const f = commandFixture([JSON.stringify(document())], NATIVE_PM_SESSION)
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f.port.wait = async () => { await gate }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }], f.port)
    const pending = f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const winner = await Promise.race([
      pending.then(() => "returned" as const),
      new Promise<"blocked">(resolve => { setTimeout(() => resolve("blocked"), 300) }),
    ])
    try {
      expect(winner).toBe("returned")
      const ack = leadText(f.leadPrompts.at(-1))
      expect(hasAutonomousSessionInline(ack, NATIVE_PM_SESSION)).toBe(true)
      expect(ack).toContain("current reply")
      expect(ack).toContain("will be delivered to this supervisor session")
      expect(ack.toLowerCase()).not.toContain("child")
      expect(ack).not.toMatch(/\bis running\b/)
      expect(ack).not.toMatch(/https?:|opencode:|file:/)
      expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
      expect(f.calls.filter(call => call.method === "prompt")).toHaveLength(1)
      expect(f.calls.filter(call => call.method === "switchModel")).toHaveLength(1)
      const context = preparationContextText(f.deps.db, "lead") ?? ""
      expect(hasAutonomousSessionInline(context, NATIVE_PM_SESSION)).toBe(true)
      expect(context.toLowerCase()).not.toContain("child")
      expect(context).not.toMatch(/\bis running\b/)
      const pm = preparationContextText(f.deps.db, NATIVE_PM_SESSION) ?? ""
      expect(pm).toContain("GrepAI")
      expect(pm).not.toContain("current reply")
      await f.invoke("prepare --pm ensemble-pm")
      const resumed = leadText(f.leadPrompts.at(-1))
      expect(hasAutonomousSessionInline(resumed, NATIVE_PM_SESSION)).toBe(true)
      expect(resumed).not.toMatch(/\bis running\b/)
      expect(resumed.toLowerCase()).not.toContain("child")
      expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
      expect(f.calls.filter(call => call.method === "prompt")).toHaveLength(1)
      expect(f.calls.filter(call => call.method === "switchModel")).toHaveLength(1)
    } finally {
      release()
      await pending
    }
  })

  test("keeps the native id on the result, replay, and exhausted error while preserving mapping", async () => {
    const f = commandFixture([JSON.stringify(document())], NATIVE_PM_SESSION)
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/a" }], f.port)
    await f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const imported = f.leadPrompts.filter(entry => leadText(entry).includes("Which boundary owns the schema?"))
    expect(imported.length).toBeGreaterThan(0)
    for (const entry of imported) {
      const text = leadText(entry)
      expect(hasAutonomousSessionInline(text, NATIVE_PM_SESSION)).toBe(true)
      expect(text).toContain("Reconcile on the lead branch after each isolated worktree lands.")
    }
    const context = preparationContextText(f.deps.db, "lead") ?? ""
    expect(hasAutonomousSessionInline(context, NATIVE_PM_SESSION)).toBe(true)
    expect(context).toContain("Which boundary owns the schema?")
    expect(context).toContain("Reconcile on the lead branch after each isolated worktree lands.")
    await f.invoke("prepare --pm ensemble-pm Again")
    const replay = leadText(f.leadPrompts.at(-1))
    expect(hasAutonomousSessionInline(replay, NATIVE_PM_SESSION)).toBe(true)
    expect(replay).toContain("code")
    expect(replay).toContain("docs")
    expect(replay).toContain("Reconcile on the lead branch after each isolated worktree lands.")
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
    expect(f.calls.filter(call => call.method === "prompt")).toHaveLength(1)
    expect(f.calls.filter(call => call.method === "switchModel")).toHaveLength(1)

    const exhausted = commandFixture(Array.from({ length: 6 }, () => "not a document"), NATIVE_PM_SESSION)
    await registerMissionCommands(exhausted.host, exhausted.deps, async () => [{ id: "fixture/a" }], exhausted.port)
    await exhausted.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const failure = leadText(exhausted.leadPrompts.find(entry => leadText(entry).includes("five corrections")))
    expect(hasAutonomousSessionInline(failure, NATIVE_PM_SESSION)).toBe(true)
    expect(exhausted.calls.filter(call => call.method === "create")).toHaveLength(1)
    expect(exhausted.calls.filter(call => call.method === "prompt")).toHaveLength(6)
    expect(exhausted.calls.filter(call => call.method === "switchModel")).toHaveLength(1)
    const exhaustedContext = preparationContextText(exhausted.deps.db, "lead") ?? ""
    expect(hasAutonomousSessionInline(exhaustedContext, NATIVE_PM_SESSION)).toBe(true)
  })

  test("keeps the native id on a delivered PM error without another create, prompt, or model call", async () => {
    const f = commandFixture([JSON.stringify(document())], NATIVE_PM_SESSION)
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f.port.wait = async () => {
      await gate
      throw new Error("provider unavailable")
    }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }], f.port)
    const pending = f.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    const winner = await Promise.race([
      pending.then(() => "returned" as const),
      new Promise<"blocked">(resolve => { setTimeout(() => resolve("blocked"), 300) }),
    ])
    expect(winner).toBe("returned")
    release()
    await waitForLead(f.leadPrompts, "provider unavailable")
    const error = f.leadPrompts.filter(entry => leadText(entry).includes("provider unavailable"))
    expect(error).toHaveLength(1)
    expect(hasAutonomousSessionInline(leadText(error[0]), NATIVE_PM_SESSION)).toBe(true)
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(1)
    expect(f.calls.filter(call => call.method === "prompt")).toHaveLength(1)
    expect(f.calls.filter(call => call.method === "switchModel")).toHaveLength(1)
    await pending
  })

  test("leaves fixture ids visible and keeps an overlong id out of the button pattern", async () => {
    const fixture = commandFixture([JSON.stringify(document())], "fixturefake")
    let releaseFixture: () => void = () => undefined
    const fixtureGate = new Promise<void>(resolve => { releaseFixture = resolve })
    fixture.port.wait = async () => { await fixtureGate }
    await registerMissionCommands(fixture.host, fixture.deps, async () => [{ id: "fixture/light" }], fixture.port)
    const fixturePending = fixture.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    await Promise.race([
      fixturePending.then(() => undefined),
      new Promise(resolve => { setTimeout(resolve, 300) }),
    ])
    try {
      const ack = leadText(fixture.leadPrompts.at(-1))
      expect(ack).toContain("fixturefake")
      expect(ack).not.toMatch(/ses_[0-9A-Za-z]{26}/)
      expect(buttonSpans(ack).some(span => /^ses_[0-9A-Za-z]{26}$/.test(span))).toBe(false)
      expect(buttonSpans(ack)).not.toContain("fixturefake")
      expect(fixture.calls.filter(call => call.method === "create")).toHaveLength(1)
      expect(fixture.calls.filter(call => call.method === "prompt")).toHaveLength(1)
      expect(fixture.calls.filter(call => call.method === "switchModel")).toHaveLength(1)
    } finally {
      releaseFixture()
      await fixturePending
    }

    const overlong = `ses_${"a".repeat(27)}`
    const unsafe = commandFixture([JSON.stringify(document())], overlong)
    let releaseUnsafe: () => void = () => undefined
    const unsafeGate = new Promise<void>(resolve => { releaseUnsafe = resolve })
    unsafe.port.wait = async () => { await unsafeGate }
    await registerMissionCommands(unsafe.host, unsafe.deps, async () => [{ id: "fixture/light" }], unsafe.port)
    const unsafePending = unsafe.invoke("prepare --pm ensemble-pm Ship the cache boundary")
    await Promise.race([
      unsafePending.then(() => undefined),
      new Promise(resolve => { setTimeout(resolve, 300) }),
    ])
    try {
      const ack = leadText(unsafe.leadPrompts.at(-1))
      expect(ack).not.toMatch(/ses_[0-9A-Za-z]{26}/)
      expect(ack).not.toContain(overlong)
      expect(unsafe.calls.filter(call => call.method === "create")).toHaveLength(1)
      expect(unsafe.calls.filter(call => call.method === "prompt")).toHaveLength(1)
    } finally {
      releaseUnsafe()
      await unsafePending
    }
  })

  test("does not restitute a PM id before a session exists", async () => {
    const f = commandFixture([])
    f.deps.config.businessProfiles = { extensions: {}, byAgent: {} }
    await registerMissionCommands(f.host, f.deps, async () => [{ id: "fixture/light" }], f.port)
    await f.invoke("prepare Decompose the cache")
    const text = leadText(f.leadPrompts.at(-1))
    expect(f.calls.filter(call => call.method === "create")).toHaveLength(0)
    expect(text).not.toMatch(/ses_[0-9A-Za-z]{26}/)
    expect(text).not.toContain("Preparation PM session id")
    expect(preparationContextText(f.deps.db, "lead")).toBeUndefined()

    const stored = runtimeFixture([])
    const mission = await prepareMission(stored.deps, "lead", "Stored objective")
    stored.deps.db.run(
      "INSERT INTO preparation_run (id, team_id, session_id, agent, model_id, mandate, status, attempts, supervisor_used, time_created, time_updated) VALUES ('run-unborn', ?, NULL, 'ensemble-pm', 'fixture/a', 'mandate', 'running', 0, 0, 1, 1)",
      [mission.teamId],
    )
    expect(preparationContextText(stored.deps.db, "lead")).toBeUndefined()
  })
})
