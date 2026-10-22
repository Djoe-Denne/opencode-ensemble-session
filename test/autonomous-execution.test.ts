import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupDeps, insertMember } from "./helpers"
import { approveMission, openMissionConfiguration, prepareMission, routeMissionTask } from "../src/mission-policy"
import { claimTask } from "../src/tools/team-claim"
import { executeTeamHandoff } from "../src/tools/team-handoff"
import { getMemberPromptModel } from "../src/member-model"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { executeTeamClaim } from "../src/tools/team-claim"
import { dispatchNextTask } from "../src/dispatch"
import { executeTeamCreate } from "../src/tools/team-create"
import { executeTeamTasksComplete } from "../src/tools/team-tasks-complete"
import { buildTeammateSystemPrompt } from "../src/system-prompt"
import { startTaskPlanning } from "../src/task-execution"

const directories: string[] = []
afterEach(() => {
  directories.splice(0).forEach(directory => { rmSync(directory, { recursive: true, force: true }) })
})

async function fixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-autonomous-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { beta: 0.35, models: [
    { id: "fixture/worker", reasoningEffort: "low", intelligenceScore: 40, averageCostPerTask: 1, available: true },
    { id: "fixture/worker", reasoningEffort: "high", intelligenceScore: 55, averageCostPerTask: 2, available: true },
  ] } }
  deps.nativeModels = async () => [{ id: "fixture/worker", variant: "low" }, { id: "fixture/worker", variant: "high" }]
  const mission = await prepareMission(deps, "lead", "Implement a cache")
  openMissionConfiguration(deps, mission.teamId, "lead")
  approveMission(deps, mission.teamId, "lead")
  deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('task', ?, 'Cache', 'pending', 'medium', 1, 1)", [mission.teamId])
  return { deps, ...mission }
}

async function worker() {
  const value = await fixture()
  const { deps, teamId } = value
  insertMember(deps.db, teamId, "worker", "worker-session")
  deps.registry.register(teamId, "worker", "worker-session")
  claimTask(deps.db, teamId, "task", "worker")
  const calls: Array<{ operation: string; value: unknown }> = []
  deps.client.session.switchModel = async value => { calls.push({ operation: "model", value }) }
  deps.client.continuity = {
    fork: async () => { throw new Error("unused") }, move: async () => {}, compact: async () => {}, remove: async () => {},
    switchAgent: async value => { calls.push({ operation: "permissions", value }) },
  }
  return { ...value, calls }
}

describe("autonomous task execution", () => {
  test("default mission uses a catalogue policy, without a classification grid or invented scores", async () => {
    const { deps, teamId, policyPath } = await fixture()
    const policy = JSON.parse(readFileSync(policyPath, "utf8"))
    expect(policy.version).toBe(2)
    expect(policy.matrix).toBeUndefined()
    expect(policy.startingIntelligence).toBe(50)
    const route = routeMissionTask(deps.db, teamId, "task")
    expect(route).toMatchObject({ selected: { id: "fixture/worker", variant: "high" }, execution: { phase: "planning" } })
    expect(route?.complexity).toBeUndefined()
    expect(routeMissionTask(deps.db, teamId, "task")).toEqual(route)
  })

  test("classification discovery is opt-in even if a classifier is available", async () => {
    const deps = setupDeps()
    let discovery = 0
    deps.classifier = { list: async () => { discovery++; return [] }, invoke: async () => ({}) }
    const { resolveMissionClassification } = await import("../src/mission-classification")
    expect((await resolveMissionClassification(deps)).method).toBe("manual")
    expect(discovery).toBe(0)
  })

  test("worker enters implementation with lower reasoning, then adjusts both ways without changing model", async () => {
    const { deps, calls } = await worker()
    await executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")
    expect(calls.map(call => call.operation)).toEqual(["model", "permissions"])
    expect(calls[0]?.value).toMatchObject({ sessionID: "worker-session", model: { providerID: "fixture", modelID: "worker" }, variant: "low" })
    expect(getMemberPromptModel(deps.db, (deps.db.query("SELECT id FROM team").get() as { id: string }).id, "worker").variant).toBe("low")
    await executeTeamHandoff(deps, { reasoning: "high" }, "worker-session")
    await executeTeamHandoff(deps, { reasoning: "low" }, "worker-session")
    const before = calls.length
    await executeTeamHandoff(deps, { reasoning: "low" }, "worker-session")
    expect(calls.length).toBe(before)
    expect(deps.db.query("SELECT model_variant FROM team_member WHERE name='worker'").get()).toEqual({ model_variant: "low" })
  })

  test("forbids disabled reasoning and profile changes from bypassing planning", async () => {
    const { deps, calls } = await worker()
    await expect(executeTeamHandoff(deps, { phase: "implementation", reasoning: "unknown" }, "worker-session")).rejects.toThrow(/catalogue/i)
    await expect(executeTeamHandoff(deps, { agent: "other" }, "worker-session")).rejects.toThrow(/task|profile/i)
    expect(calls).toHaveLength(0)
  })

  test("native failure is retained as pending rather than advertised as applied", async () => {
    const { deps, teamId } = await worker()
    deps.client.session.switchModel = async () => { throw new Error("native unavailable") }
    await expect(executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")).rejects.toThrow("native unavailable")
    expect(() => getMemberPromptModel(deps.db, teamId, "worker")).toThrow(/pending/i)
  })

  test("spawn enforces planning before first prompt and retains its worktree", async () => {
    const { deps, teamId } = await worker()
    deps.db.run("DELETE FROM team_member WHERE team_id = ?", [teamId])
    deps.registry.unregister("worker-session")
    deps.db.run("UPDATE team_task SET assignee = NULL, status = 'pending', model_routing = NULL")
    await executeTeamSpawn(deps, { name: "new", prompt: "Implement cache", claim_task: "task" }, "lead")
    expect(deps.client.calls.some(call => call.method === "worktree.create")).toBe(true)
    const creation = deps.client.calls.find(call => call.method === "session.create")?.args[0]
    expect(creation).toMatchObject({ permission: expect.arrayContaining([{ permission: "*", pattern: "*", action: "deny" }]) })
    const prompt = deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]
    expect(prompt).toMatchObject({ variant: "high" })
    expect(JSON.stringify(prompt)).toContain('phase: \\"implementation\\"')
  })

  test("direct claim resets an existing worker to strong read-only planning", async () => {
    const { deps, teamId, calls } = await worker()
    await executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")
    deps.db.run("UPDATE team_task SET status = 'completed'")
    deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('next', ?, 'Next', 'pending', 'medium', 2, 2)", [teamId])
    calls.splice(0)
    await executeTeamClaim(deps, { task_id: "next" }, "worker-session")
    expect(calls[0]?.value).toMatchObject({ variant: "high" })
    expect(calls.at(-1)?.value).toMatchObject({ permission: expect.arrayContaining([{ permission: "*", pattern: "*", action: "deny" }]) })
  })

  test("dispatch restores planning before delivering a reused worker's next task", async () => {
    const { deps, teamId, calls } = await worker()
    deps.config.autoDispatch = true
    await executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")
    deps.db.run("UPDATE team_task SET status = 'completed'")
    deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('next', ?, 'Next', 'pending', 'medium', 2, 2)", [teamId])
    calls.splice(0)
    expect(dispatchNextTask(deps, teamId, "worker")).toBe("next")
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.some(call => call.operation === "permissions")).toBe(true)
    expect(deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]).toMatchObject({ variant: "high" })
  })

  test("a direct V2 team also defaults to the same autonomous execution path", async () => {
    const { deps: source } = await worker()
    const deps = setupDeps()
    deps.config = structuredClone(source.config)
    deps.client.continuity = source.client.continuity
    deps.client.session.switchModel = source.client.session.switchModel
    deps.nativeModels = source.nativeModels
    await executeTeamCreate(deps, { name: "direct" }, "lead")
    const { id } = deps.db.query("SELECT id FROM team").get() as { id: string }
    deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('direct-task', ?, 'Work', 'pending', 'medium', 1, 1)", [id])
    expect(routeMissionTask(deps.db, id, "direct-task")).toMatchObject({ execution: { phase: "planning" }, selected: { variant: "high" } })
    await executeTeamSpawn(deps, { name: "direct-worker", prompt: "Work", claim_task: "direct-task", worktree: false }, "lead")
    expect(deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]).toMatchObject({ variant: "high" })
  })

  test("pending transitions cannot be hidden by completing the task", async () => {
    const { deps } = await worker()
    deps.client.session.switchModel = async () => { throw new Error("lost response") }
    await expect(executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")).rejects.toThrow("lost response")
    await expect(executeTeamTasksComplete(deps, { task_id: "task" }, "lead")).rejects.toThrow(/pending/i)
  })

  test("retries the same uncertain native choice and rejects overlapping transitions", async () => {
    const { deps, teamId } = await worker()
    deps.client.session.switchModel = async () => { throw new Error("lost response") }
    await expect(executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")).rejects.toThrow("lost response")
    let release: () => void = () => {}
    deps.client.session.switchModel = async () => new Promise<void>(resolve => { release = resolve })
    const retry = executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")
    await expect(executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")).rejects.toThrow(/pending/)
    release()
    await retry
    expect(getMemberPromptModel(deps.db, teamId, "worker").variant).toBe("low")
  })

  test("normal context retains the current phase and reasoning after a transition", async () => {
    const { deps, teamId } = await worker()
    await executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")
    expect(buildTeammateSystemPrompt(deps.db, teamId, "worker")).toContain("Task phase: implementation")
  })

  test("dispatch native failure releases the task and retires the uncertain worker", async () => {
    const { deps, teamId } = await worker()
    deps.config.autoDispatch = true
    deps.db.run("UPDATE team_task SET status = 'completed'")
    deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('next', ?, 'Next', 'pending', 'medium', 2, 2)", [teamId])
    deps.client.session.switchModel = async () => { throw new Error("native unavailable") }
    expect(dispatchNextTask(deps, teamId, "worker")).toBe("next")
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(deps.db.query("SELECT status FROM team_member WHERE name='worker'").get()).toEqual({ status: "error" })
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id='next'").get()).toEqual({ status: "pending", assignee: null })
  })

  test("an explicitly classified task chooses its initial effort, then uses the same execution path", async () => {
    const { deps, teamId } = await fixture()
    // Represents the already completed output of an explicitly requested classifier.
    deps.db.run("UPDATE team_task SET classification_status='completed', classification_result=? WHERE id='task'", [JSON.stringify({ complexity: 0, risk: 0 })])
    const route = routeMissionTask(deps.db, teamId, "task")
    expect(route).toMatchObject({ selected: { id: "fixture/worker", variant: "low" }, complexity: 0, risk: 0, execution: { phase: "planning" } })
  })

  test("a catalogue entry absent from the native host is rejected before switching", async () => {
    const { deps, calls } = await worker()
    deps.nativeModels = async () => [{ id: "fixture/worker", variant: "high" }]
    await expect(executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")).rejects.toThrow(/native.*unavailable/i)
    expect(calls).toHaveLength(0)
  })

  test("new proposals contain only enabled catalogue pairs supported by the native host", async () => {
    const { deps: source } = await fixture()
    const deps = setupDeps()
    deps.directory = source.directory
    deps.config = source.config
    deps.nativeModels = async () => [{ id: "fixture/worker", variant: "high" }]
    const mission = await prepareMission(deps, "lead", "Native intersection")
    const policy = JSON.parse(readFileSync(mission.policyPath, "utf8"))
    expect(policy.models.map((model: { reasoningEffort: string }) => model.reasoningEffort)).toEqual(["high"])
  })

  test("the lead can establish planning during inherited-spawn initialization, but the worker cannot transition yet", async () => {
    const { deps, teamId, calls } = await worker()
    deps.db.run("UPDATE team_member SET spawn_pending=1 WHERE name='worker'")
    await startTaskPlanning(deps, teamId, "worker", "worker-session")
    expect(calls.map(call => call.operation)).toEqual(["model", "permissions"])
    await expect(executeTeamHandoff(deps, { phase: "implementation" }, "worker-session")).rejects.toThrow(/lifecycle/)
  })

  test("reclaiming the same task preserves its selection but gets a fresh native-application identity", async () => {
    const { deps, teamId } = await worker()
    const read = () => JSON.parse((deps.db.query("SELECT model_routing FROM team_task WHERE id='task'").get() as { model_routing: string }).model_routing)
    const previous = read()
    deps.db.run("UPDATE team_task SET status='pending', assignee=NULL WHERE id='task'")
    claimTask(deps.db, teamId, "task", "worker")
    expect(read().selected).toEqual(previous.selected)
    expect(read().assignmentID).toBeString()
    expect(read().assignmentID).not.toBe(previous.assignmentID)
  })

  test("new missions persist and communicate proportionate verification by default", async () => {
    const { deps, teamId, policyPath } = await worker()
    expect(JSON.parse(readFileSync(policyPath, "utf8"))).toMatchObject({ verification: { level: "proportionate" } })
    expect(buildTeammateSystemPrompt(deps.db, teamId, "worker")).toContain("Mission QA: proportionate")
  })

  test("QA changes require approval and affect new admissions, not the running worker", async () => {
    const { deps, teamId, policyPath } = await worker()
    const policy = JSON.parse(readFileSync(policyPath, "utf8"))
    policy.verification = { level: "light", commands: ["targeted smoke"], acceptance: ["same session"] }
    writeFileSync(policyPath, JSON.stringify(policy))
    expect(() => approveMission(deps, teamId, "lead")).toThrow(/changed/)
    const preview = openMissionConfiguration(deps, teamId, "lead")
    expect(preview.policy).toMatchObject({ verification: policy.verification })
    approveMission(deps, teamId, "lead")
    expect(buildTeammateSystemPrompt(deps.db, teamId, "worker")).toContain("Mission QA: proportionate")
    deps.db.run("UPDATE team_task SET status='completed'")
    deps.db.run("INSERT INTO team_task (id,team_id,content,status,priority,time_created,time_updated) VALUES ('qa-next',?,'Next','pending','medium',3,3)",[teamId])
    claimTask(deps.db, teamId, "qa-next", "worker")
    const text = buildTeammateSystemPrompt(deps.db, teamId, "worker")
    expect(text).toContain("Mission QA: light")
    expect(text).toContain("targeted smoke")
  })
})
