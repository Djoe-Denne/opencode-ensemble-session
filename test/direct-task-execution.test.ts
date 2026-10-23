import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approveMission, openMissionConfiguration, prepareMission, routeMissionTask } from "../src/mission-policy"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { claimTask, executeTeamClaim } from "../src/tools/team-claim"
import { dispatchNextTask, pickNextTask, pumpTeam } from "../src/dispatch"
import { executeTeamHandoff } from "../src/tools/team-handoff"
import { getMemberPromptModel } from "../src/member-model"
import { startTaskPlanning, taskExecutionInstructions } from "../src/task-execution"
import type { TaskExecutionDecision } from "../src/execution-policy"
import { insertMember, insertTeam, setupDeps } from "./helpers"
import { executeTeamTasksList } from "../src/tools/team-tasks-list"
import { classifyBoardTasks } from "../src/board-classification"
import { resolveMissionClassification } from "../src/mission-classification"
import { executeTeamCreate } from "../src/tools/team-create"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => { rmSync(directory, { recursive: true, force: true }) }))

async function fixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-direct-task-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { beta: 0.35, models: [
    { id: "fixture/worker", reasoningEffort: "low", intelligenceScore: 20, averageCostPerTask: 1, available: true },
    { id: "fixture/worker", reasoningEffort: "high", intelligenceScore: 60, averageCostPerTask: 2, available: true },
  ] } }
  deps.nativeModels = async () => [{ id: "fixture/worker", variant: "low" }, { id: "fixture/worker", variant: "high" }]
  const nativeCalls: Array<{ operation: string; value: unknown }> = []
  deps.client.session.switchModel = async value => { nativeCalls.push({ operation: "model", value }) }
  deps.client.continuity = {
    fork: async () => { throw new Error("unused") }, move: async () => {}, compact: async () => {}, remove: async () => {},
    switchAgent: async value => { nativeCalls.push({ operation: "profile", value }) },
  }
  const mission = await prepareMission(deps, "lead", "Documentation and code")
  openMissionConfiguration(deps, mission.teamId, "lead")
  approveMission(deps, mission.teamId, "lead")
  insertMember(deps.db, mission.teamId, "worker", "worker-session")
  deps.registry.register(mission.teamId, "worker", "worker-session")
  return { deps, nativeCalls, ...mission }
}

const direct = { mode: "direct", kind: "documentation", model: "fixture/worker", variant: "low" }

async function add(deps: ReturnType<typeof setupDeps>, execution = direct, sessionID = "lead") {
  const input = { tasks: [{ content: "Document the public API", priority: "medium", execution: execution as TaskExecutionDecision }] }
  const result = await executeTeamTasksAdd(deps, input, sessionID)
  const id = result.match(/task_[\w]+/u)?.[0]
  if (!id) throw new Error(`No task ID: ${result}`)
  return id
}

async function decide(deps: ReturnType<typeof setupDeps>, taskID: string, execution = direct, sessionID = "lead") {
  const input = { tasks: [], execution_decisions: [{ task_id: taskID, ...execution as TaskExecutionDecision }] }
  return executeTeamTasksAdd(deps, input, sessionID)
}

function stored(deps: ReturnType<typeof setupDeps>, taskID: string) {
  return deps.db.query("SELECT status, assignee, model_routing FROM team_task WHERE id=?").get(taskID) as { status: string; assignee: string | null; model_routing: string | null }
}

async function classifiedFixture() {
  const value = await fixture()
  const calls: unknown[] = []
  value.deps.classifier = {
    list: async () => [{ id: "router_jev_ask", input: { type: "object", properties: { state: {}, questions: {} }, required: ["state", "questions"] } }],
    invoke: async input => { calls.push(input); throw new Error("classifier unavailable") },
  }
  const policy = await resolveMissionClassification(value.deps, { mode: "jev", helperModel: "fixture/worker", limits: { retries: 0 } })
  value.deps.db.run("UPDATE team SET classification_policy=? WHERE id=?", [JSON.stringify(policy), value.teamId])
  return { ...value, calls }
}

describe("direct tasks bypass classification only after supervisor authorization", () => {
  test("lead direct without scores never calls a failing classifier; planned work still does", async () => {
    const { deps, teamId, calls } = await classifiedFixture()
    const id = await add(deps)
    await classifyBoardTasks(deps, teamId)
    expect(calls).toHaveLength(0)
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
    await executeTeamTasksAdd(deps, { tasks: [{ content: "Code", priority: "medium" }] }, "lead")
    await classifyBoardTasks(deps, teamId)
    expect(calls).toHaveLength(1)
  })

  test.each(["pending", "running", "blocked"])("direct decision neutralizes %s classification without resetting budgets or critical state", async state => {
    const { deps, teamId, calls } = await classifiedFixture()
    deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated, classification_status, classification_token, classification_until, classification_error, classification_attempts) VALUES ('proposal', ?, 'Research', 'pending', 'medium', 1, 1, ?, 'old-token', 9999999999999, 'old-error', 2)", [teamId, state])
    deps.db.run("UPDATE team SET mission_state='critical', classification_runtime=? WHERE id=?", ['{"calls":3}', teamId])
    await decide(deps, "proposal")
    await classifyBoardTasks(deps, teamId)
    expect(deps.db.query("SELECT classification_status, classification_token, classification_until, classification_error, classification_attempts FROM team_task WHERE id='proposal'").get()).toEqual({ classification_status: "not_required", classification_token: null, classification_until: null, classification_error: null, classification_attempts: 2 })
    expect(calls).toHaveLength(0)
    expect(deps.db.query("SELECT mission_state, classification_runtime FROM team WHERE id=?").get(teamId)).toEqual({ mission_state: "critical", classification_runtime: '{"calls":3}' })
    expect(() => claimTask(deps.db, teamId, "proposal", "worker")).toThrow(/critical/)
  })

  test.each(["success", "error"])("late classifier %s cannot overwrite a direct authorization", async outcome => {
    const { deps, teamId } = await classifiedFixture()
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const started = new Promise<void>(resolve => { entered = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    if (!deps.classifier) throw new Error("Missing fixture classifier")
    deps.classifier.invoke = async () => {
      entered()
      await waiting
      if (outcome === "error") throw new Error("late failure")
      return { answers: { complexity: { type: "score", score: 0.5 }, risk: { type: "score", score: 0.5 } } }
    }
    const id = await add(deps, direct, "worker-session")
    await started
    await decide(deps, id)
    release()
    await classifyBoardTasks(deps, teamId)
    expect(deps.db.query("SELECT classification_status, classification_token, classification_result, classification_error FROM team_task WHERE id=?").get(id)).toEqual({ classification_status: "not_required", classification_token: null, classification_result: null, classification_error: null })
    expect(deps.db.query("SELECT mission_state FROM team WHERE id=?").get(teamId)).toEqual({ mission_state: "running" })
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
  })

  test("drain neutralizes direct classifications requeued by a policy revision", async () => {
    const { deps, teamId, calls } = await classifiedFixture()
    const id = await add(deps)
    await classifyBoardTasks(deps, teamId)
    calls.splice(0)
    deps.db.run("UPDATE team_task SET classification_status='pending', classification_token='stale' WHERE id=?", [id])
    await classifyBoardTasks(deps, teamId)
    expect(calls).toHaveLength(0)
    expect(deps.db.query("SELECT classification_status, classification_token FROM team_task WHERE id=?").get(id)).toEqual({ classification_status: "not_required", classification_token: null })
  })

  test("changing an unadmitted direct decision back to planned restores required classification", async () => {
    const { deps, teamId, calls } = await classifiedFixture()
    const id = await add(deps)
    await classifyBoardTasks(deps, teamId)
    await executeTeamTasksAdd(deps, { tasks: [], execution_decisions: [{ task_id: id, mode: "planned", kind: "mixed" }] }, "lead")
    await classifyBoardTasks(deps, teamId)
    expect(calls).toHaveLength(1)
    expect(deps.db.query("SELECT classification_status FROM team_task WHERE id=?").get(id)).toEqual({ classification_status: "blocked" })
    expect(() => claimTask(deps.db, teamId, id, "worker")).toThrow(/classification/)
  })

  test("a frozen-catalogue team can authorize direct work with an unconfigured classifier", async () => {
    const source = await classifiedFixture()
    const deps = setupDeps()
    deps.config = structuredClone(source.deps.config)
    deps.config.classification = { ...deps.config.classification, mode: "jev", helperModel: "" }
    deps.classifier = source.deps.classifier
    deps.nativeModels = source.deps.nativeModels
    deps.client.continuity = source.deps.client.continuity
    deps.client.session.switchModel = source.deps.client.session.switchModel
    await executeTeamCreate(deps, { name: "direct-no-helper" }, "lead")
    const id = await add(deps)
    const team = deps.db.query("SELECT id FROM team").get() as { id: string }
    await classifyBoardTasks(deps, team.id)
    expect(source.calls).toHaveLength(0)
    expect(routeMissionTask(deps.db, team.id, id)).toMatchObject({ execution: { phase: "implementation" } })
    await expect(executeTeamTasksAdd(deps, { tasks: [{ content: "Code", priority: "medium" }] }, "lead")).rejects.toThrow(/helperModel/)
  })
})

describe("supervisor-authorized direct documentation/research", () => {
  test.each(["documentation", "research"])("lead authorizes %s below the planning threshold without invented scores", async kind => {
    const { deps, teamId } = await fixture()
    const id = await add(deps, { ...direct, kind })
    expect(routeMissionTask(deps.db, teamId, id)).toMatchObject({ selected: { id: "fixture/worker", variant: "low" }, execution: { phase: "implementation" } })
    expect(routeMissionTask(deps.db, teamId, id)?.complexity).toBeUndefined()
  })

  test("members propose, but cannot authorize themselves through add, claim, dispatch or decisions", async () => {
    const { deps, teamId } = await fixture()
    const id = await add(deps, direct, "worker-session")
    expect(() => routeMissionTask(deps.db, teamId, id)).toThrow(/supervisor|decision/i)
    await expect(executeTeamClaim(deps, { task_id: id }, "worker-session")).rejects.toThrow(/supervisor|decision/i)
    await expect(decide(deps, id, direct, "worker-session")).rejects.toThrow(/lead|supervisor/i)
    expect(pickNextTask(deps.db, teamId, "build")).toEqual([])
    await decide(deps, id)
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
    expect(getMemberPromptModel(deps.db, teamId, "worker").variant).toBe("low")
  })

  test.each(["code", "mixed", "unspecified"])("%s cannot use direct mode and defaults to planning", async kind => {
    const { deps, teamId } = await fixture()
    await expect(add(deps, { ...direct, kind })).rejects.toThrow(/documentation|research/i)
    const input = { tasks: [{ content: "Code or ambiguous task", priority: "medium", task_type: kind }] }
    await executeTeamTasksAdd(deps, input, "lead")
    const row = deps.db.query("SELECT id FROM team_task").get() as { id: string }
    expect(routeMissionTask(deps.db, teamId, row.id)).toMatchObject({ selected: { variant: "high" }, execution: { phase: "planning" } })
  })

  test.each([{ model: "unapproved/model", variant: "low" }, { model: "fixture/worker", variant: "unknown" }])("rejects unapproved selection %p before persistence or native allocation", async selection => {
    const { deps } = await fixture()
    await expect(add(deps, { ...direct, ...selection })).rejects.toThrow(/catalogue|approved/i)
    expect(deps.db.query("SELECT id FROM team_task").get()).toBeNull()
    expect(deps.client.calls.filter(call => call.method === "session.create")).toEqual([])
  })

  test("spawn starts direct at the selected effort, keeps isolation, and restores only native profile permissions", async () => {
    const { deps, nativeCalls } = await fixture()
    const id = await add(deps)
    await executeTeamSpawn(deps, { name: "author", agent: "restricted-writer", prompt: "Documentation only", claim_task: id }, "lead")
    expect(deps.client.calls.some(call => call.method === "worktree.create")).toBe(true)
    expect(nativeCalls.at(-1)).toEqual({ operation: "profile", value: { sessionID: expect.any(String), agent: "restricted-writer" } })
    const prompt = deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]
    expect(prompt).toMatchObject({ variant: "low" })
    expect(JSON.stringify(prompt)).toContain("direct")
    expect(JSON.stringify(prompt)).not.toContain("Plan read-only first")
  })

  test("a proposal added while work runs can be decided without rewriting the active assignment", async () => {
    const { deps, teamId, policyPath } = await fixture()
    const first = await add(deps)
    await executeTeamClaim(deps, { task_id: first }, "worker-session")
    const admitted = stored(deps, first).model_routing
    const second = await add(deps, { ...direct, kind: "research" }, "worker-session")
    await expect(decide(deps, first)).rejects.toThrow(/admitted|pending|unassigned/i)
    await decide(deps, second, { ...direct, kind: "research" })
    openMissionConfiguration(deps, teamId, "lead")
    const policy = JSON.parse(readFileSync(policyPath, "utf8"))
    policy.startingIntelligence = 55
    writeFileSync(policyPath, JSON.stringify(policy))
    expect(getMemberPromptModel(deps.db, teamId, "worker").variant).toBe("low")
    openMissionConfiguration(deps, teamId, "lead")
    approveMission(deps, teamId, "lead")
    expect(stored(deps, first).model_routing).toBe(admitted)
    expect(routeMissionTask(deps.db, teamId, second)).toMatchObject({ policyRevision: 2, execution: { phase: "implementation" } })
    await startTaskPlanning(deps, teamId, "worker", "worker-session")
    expect(taskExecutionInstructions(deps, "worker-session")).toContain("Task phase: implementation")
  })

  test("direct dispatch restores the profile from previous planning and later code returns to planning", async () => {
    const { deps, nativeCalls, teamId } = await fixture()
    const id = await add(deps)
    deps.config.autoDispatch = true
    expect(dispatchNextTask(deps, teamId, "worker")).toBe(id)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(nativeCalls.at(-1)).toEqual({ operation: "profile", value: { sessionID: "worker-session", agent: "build" } })
    deps.db.run("UPDATE team_task SET status='completed' WHERE id=?", [id])
    await executeTeamTasksAdd(deps, { tasks: [{ content: "Implement code", priority: "medium" }] }, "lead")
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(nativeCalls.at(-1)?.value).toMatchObject({ permission: expect.arrayContaining([{ permission: "*", pattern: "*", action: "deny" }]) })
  })

  test("unavailable native direct variants fail closed and release claims without delivering work", async () => {
    const { deps, teamId, nativeCalls } = await fixture()
    const id = await add(deps)
    deps.nativeModels = async () => [{ id: "fixture/worker", variant: "high" }]
    await expect(executeTeamClaim(deps, { task_id: id }, "worker-session")).rejects.toThrow(/native.*unavailable/i)
    expect(stored(deps, id)).toMatchObject({ status: "pending", assignee: null })
    expect(nativeCalls).toEqual([])
    expect(deps.db.query("SELECT status FROM team_member WHERE team_id=? AND name='worker'").get(teamId)).toEqual({ status: "error" })
  })

  test("native permission failure stays pending and can only retry the admitted direct choice", async () => {
    const { deps, teamId } = await fixture()
    const id = await add(deps)
    claimTask(deps.db, teamId, id, "worker")
    if (!deps.client.continuity) throw new Error("Missing fixture continuity")
    deps.client.continuity.switchAgent = async () => { throw new Error("native permissions failed") }
    await expect(startTaskPlanning(deps, teamId, "worker", "worker-session")).rejects.toThrow("native permissions failed")
    expect(() => getMemberPromptModel(deps.db, teamId, "worker")).toThrow(/pending/)
    await expect(executeTeamHandoff(deps, { reasoning: "high" }, "worker-session")).rejects.toThrow(/same phase and reasoning/)
    deps.client.continuity.switchAgent = async () => {}
    await startTaskPlanning(deps, teamId, "worker", "worker-session")
    expect(getMemberPromptModel(deps.db, teamId, "worker").variant).toBe("low")
  })

  test("autoscale ignores proposals awaiting supervisor approval", async () => {
    const { deps, teamId } = await fixture()
    deps.config.autoScale = true
    await add(deps, direct, "worker-session")
    await pumpTeam(deps, teamId)
    expect(deps.client.calls.some(call => call.method === "session.create")).toBe(false)
  })

  test("a supervisor can refuse a direct proposal and require planning instead", async () => {
    const { deps, teamId } = await fixture()
    const id = await add(deps, direct, "worker-session")
    const input = { tasks: [], execution_decisions: [{ task_id: id, mode: "planned" as const, kind: "mixed" as const }] }
    await executeTeamTasksAdd(deps, input, "lead")
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
    expect(getMemberPromptModel(deps.db, teamId, "worker").variant).toBe("high")
    expect(taskExecutionInstructions(deps, "worker-session")).toContain("Plan read-only first")
  })

  test("a decision changed during spawn allocation cannot launch with stale permissions/model", async () => {
    const { deps } = await fixture()
    const id = await add(deps)
    const create = deps.client.session.create.bind(deps.client.session)
    deps.client.session.create = async input => {
      const result = await create(input)
      await decide(deps, id, { ...direct, variant: "high" })
      return result
    }
    await expect(executeTeamSpawn(deps, { name: "racing", prompt: "No stale admission", claim_task: id, worktree: false }, "lead")).rejects.toThrow(/changed during spawn/i)
    expect(deps.client.calls.some(call => call.method === "session.promptAsync")).toBe(false)
    expect(stored(deps, id)).toMatchObject({ status: "pending", assignee: null })
  })

  test("direct spawn native failure preserves its branch before abort and never prompts the worker", async () => {
    const { deps } = await fixture()
    const id = await add(deps)
    const events: string[] = []
    deps.preserveBranch = async () => { events.push("preserve"); return true }
    const abort = deps.client.session.abort.bind(deps.client.session)
    deps.client.session.abort = async input => { events.push("abort"); return abort(input) }
    deps.client.session.switchModel = async () => { throw new Error("native unavailable") }
    await expect(executeTeamSpawn(deps, { name: "failed-direct", prompt: "Documentation", claim_task: id }, "lead")).rejects.toThrow("native unavailable")
    expect(events).toEqual(["preserve", "abort"])
    expect(deps.client.calls.some(call => call.method === "session.promptAsync")).toBe(false)
    expect(stored(deps, id)).toMatchObject({ status: "pending", assignee: null })
  })

  test("the board exposes proposals and supervisor decisions without confusing them with admitted routes", async () => {
    const { deps } = await fixture()
    const id = await add(deps, direct, "worker-session")
    expect(await executeTeamTasksList(deps, "lead")).toContain("execution:proposed direct documentation fixture/worker#low")
    await decide(deps, id)
    expect(await executeTeamTasksList(deps, "lead")).toContain("execution:authorized direct documentation fixture/worker#low")
  })

  test("a legacy worker cannot turn an unsupported direct proposal into an admission", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "legacy", "legacy", "lead")
    insertMember(deps.db, "legacy", "worker", "worker-session")
    const input = { tasks: [{ content: "Research", priority: "medium", complexity: 0, risk: 0, execution: direct as TaskExecutionDecision }] }
    await executeTeamTasksAdd(deps, input, "worker-session")
    const task = deps.db.query("SELECT id FROM team_task").get() as { id: string }
    await expect(executeTeamClaim(deps, { task_id: task.id }, "worker-session")).rejects.toThrow(/supervisor|decision/i)
  })
})
