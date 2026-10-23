import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approveMission, openMissionConfiguration, prepareMission, routeMissionTask } from "../src/mission-policy"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { executeTeamTasksList } from "../src/tools/team-tasks-list"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { executeTeamClaim } from "../src/tools/team-claim"
import { executeTeamHandoff } from "../src/tools/team-handoff"
import { executeTeamCreate } from "../src/tools/team-create"
import { getMemberPromptModel } from "../src/member-model"
import { dispatchNextTask, pickNextTask } from "../src/dispatch"
import { taskExecutionInstructions } from "../src/task-execution"
import { insertMember, setupDeps } from "./helpers"
import type { TaskExecutionDecision } from "../src/execution-policy"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

const explicit: TaskExecutionDecision = { mode: "planned", kind: "code", model: "fixture/luna", variant: "low", reason: "User requested Luna for this trivial task" }

async function fixture(directTeam = false) {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-planning-selection-"))
  directories.push(deps.directory)
  Object.assign(deps.config, { planningIntelligenceRange: { min: 35, max: 70 }, modelRouting: { beta: 0.35, models: [
    { id: "fixture/luna", reasoningEffort: "low", intelligenceScore: 35, averageCostPerTask: 1, available: true },
    { id: "fixture/strong", reasoningEffort: "low", intelligenceScore: 20, averageCostPerTask: 1, available: true },
    { id: "fixture/strong", reasoningEffort: "high", intelligenceScore: 60, averageCostPerTask: 2, available: true },
    { id: "fixture/above", intelligenceScore: 90, averageCostPerTask: 3, available: true },
  ] } })
  deps.nativeModels = async () => [{ id: "fixture/luna", variant: "low" }, { id: "fixture/strong", variant: "low" }, { id: "fixture/strong", variant: "high" }, { id: "fixture/above" }]
  const nativeCalls: Array<{ operation: string; value: unknown }> = []
  deps.client.session.switchModel = async value => { nativeCalls.push({ operation: "model", value }) }
  deps.client.continuity = {
    fork: async () => { throw new Error("unused") }, move: async () => {}, compact: async () => {}, remove: async () => {},
    switchAgent: async value => { nativeCalls.push({ operation: "profile", value }) },
  }
  const mission = directTeam ? await (async () => {
    await executeTeamCreate(deps, { name: "selection" }, "lead")
    const team = deps.db.query("SELECT id FROM team").get() as { id: string }
    return { teamId: team.id, policyPath: "" }
  })() : await prepareMission(deps, "lead", "Small and large tasks")
  if (!directTeam) {
    openMissionConfiguration(deps, mission.teamId, "lead")
    approveMission(deps, mission.teamId, "lead")
  }
  insertMember(deps.db, mission.teamId, "worker", "worker-session")
  deps.registry.register(mission.teamId, "worker", "worker-session")
  return { deps, nativeCalls, ...mission }
}

async function add(deps: ReturnType<typeof setupDeps>, execution?: TaskExecutionDecision, session = "lead") {
  const result = await executeTeamTasksAdd(deps, { tasks: [{ content: "Small task", priority: "medium", ...(execution ? { execution } : {}) }] }, session)
  const id = result.match(/task_[\w]+/u)?.[0]
  if (!id) throw new Error(result)
  return id
}

describe("approved version 3 model choices", () => {
  test.each([false, true])("freezes an opt-in version 3 policy (direct team: %p)", async directTeam => {
    const { deps, teamId } = await fixture(directTeam)
    const row = deps.db.query("SELECT policy_json FROM mission_policy_revision WHERE team_id=?").get(teamId) as { policy_json: string }
    expect(JSON.parse(row.policy_json)).toMatchObject({ version: 3, startingIntelligence: 50, planningIntelligenceRange: { min: 35, max: 70 } })
    const id = await add(deps, explicit)
    expect(routeMissionTask(deps.db, teamId, id)).toMatchObject({ selected: { id: "fixture/luna", variant: "low" }, authorization: { ...explicit, authorizedBy: "lead" }, execution: { phase: "planning" } })
    const automatic = await add(deps)
    expect(routeMissionTask(deps.db, teamId, automatic)?.selected).toEqual({ id: "fixture/strong", variant: "high" })
  })

  test("claims and hands off the explicit model without broadening planning permissions", async () => {
    const { deps, teamId, nativeCalls } = await fixture()
    const id = await add(deps, explicit)
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
    expect(getMemberPromptModel(deps.db, teamId, "worker")).toMatchObject({ model: { providerID: "fixture", modelID: "luna" }, variant: "low" })
    expect(nativeCalls.at(-1)?.value).toMatchObject({ permission: expect.arrayContaining([{ permission: "*", pattern: "*", action: "deny" }]) })
    expect(taskExecutionInstructions(deps, "worker-session")).toContain("planning")
    expect(taskExecutionInstructions(deps, "worker-session")).toContain(explicit.reason ?? "missing reason")
    expect(await executeTeamTasksList(deps, "lead")).toContain(explicit.reason ?? "missing reason")
    await executeTeamHandoff(deps, { phase: "implementation" }, "worker-session")
    expect(getMemberPromptModel(deps.db, teamId, "worker").model?.modelID).toBe("luna")
    expect(nativeCalls.at(-1)?.value).not.toHaveProperty("permission")
  })

  test("spawn and reused-worker dispatch use the same decision", async () => {
    const { deps, teamId } = await fixture()
    const id = await add(deps, explicit)
    await executeTeamSpawn(deps, { name: "new", agent: "build", prompt: "Small task", claim_task: id }, "lead")
    expect(deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]).toMatchObject({ model: { providerID: "fixture", modelID: "luna" }, variant: "low" })
    const next = await add(deps)
    deps.config.autoDispatch = true
    expect(dispatchNextTask(deps, teamId, "worker")).toBe(next)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getMemberPromptModel(deps.db, teamId, "worker").model?.modelID).toBe("strong")
  })

  test("members propose but only the lead authorizes and admitted decisions are immutable", async () => {
    const { deps, teamId } = await fixture()
    const id = await add(deps, explicit, "worker-session")
    expect(pickNextTask(deps.db, teamId, "build")).toEqual([])
    const args = { tasks: [], execution_decisions: [{ task_id: id, ...explicit }] }
    await expect(executeTeamTasksAdd(deps, args, "worker-session")).rejects.toThrow(/lead|supervisor/i)
    await executeTeamTasksAdd(deps, args, "lead")
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
    await expect(executeTeamTasksAdd(deps, args, "lead")).rejects.toThrow(/admitted|unassigned/i)
    deps.db.run("UPDATE team_task SET status='pending', assignee=NULL WHERE id=?", [id])
    await expect(executeTeamTasksAdd(deps, args, "lead")).rejects.toThrow(/admitted|unassigned/i)
  })

  test.each(["code", "mixed", "documentation", "research"] as const)("supervisor may authorize direct %s outside the planning range", async kind => {
    const { deps, teamId, nativeCalls } = await fixture()
    const id = await add(deps, { mode: "direct", kind, model: "fixture/strong", variant: "low" })
    expect(routeMissionTask(deps.db, teamId, id)).toMatchObject({ selected: { id: "fixture/strong", variant: "low" }, execution: { phase: "implementation" } })
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
    expect(nativeCalls.at(-1)?.value).not.toHaveProperty("permission")
  })

  test.each([{ model: "fixture/strong", variant: "low" }, { model: "fixture/above", variant: undefined }, { model: "unapproved/model", variant: undefined }])("rejects unauthorized pair %p atomically", async selection => {
    const { deps } = await fixture()
    await expect(add(deps, { ...explicit, ...selection })).rejects.toThrow(/range|catalogue/i)
    expect(deps.db.query("SELECT id FROM team_task").get()).toBeNull()
  })

  test("checks exact native availability before persisting a decision", async () => {
    const { deps } = await fixture()
    deps.nativeModels = async () => [{ id: "fixture/strong", variant: "high" }]
    await expect(add(deps, explicit)).rejects.toThrow(/native|unavailable/i)
    expect(deps.db.query("SELECT id FROM team_task").get()).toBeNull()
  })

  test("revoking approval during native discovery prevents persistence", async () => {
    const { deps, teamId } = await fixture()
    const native = deps.nativeModels
    deps.nativeModels = async () => {
      const result = native ? await native() : []
      openMissionConfiguration(deps, teamId, "lead")
      return result
    }
    await expect(add(deps, explicit)).rejects.toThrow(/approval|approved/i)
    expect(deps.db.query("SELECT id FROM team_task").get()).toBeNull()
  })

  test("classification stays within the range, explicit choice wins without changing recorded scores", async () => {
    const { deps, teamId } = await fixture()
    const id = await add(deps)
    deps.db.run("UPDATE team_task SET complexity=100, risk=100 WHERE id=?", [id])
    expect(routeMissionTask(deps.db, teamId, id)?.selected.id).toBe("fixture/strong")
    await executeTeamTasksAdd(deps, { tasks: [], execution_decisions: [{ task_id: id, ...explicit }] }, "lead")
    expect(routeMissionTask(deps.db, teamId, id)).toMatchObject({ selected: { id: "fixture/luna" }, complexity: 100, risk: 100 })
    deps.db.run("UPDATE team SET mission_state='critical' WHERE id=?", [teamId])
    await expect(executeTeamClaim(deps, { task_id: id }, "worker-session")).rejects.toThrow(/critical/i)
  })

  test("range changes need another preview and approval; running work keeps its admitted revision", async () => {
    const { deps, teamId, policyPath } = await fixture()
    const id = await add(deps, explicit)
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
    openMissionConfiguration(deps, teamId, "lead")
    const policy = JSON.parse(readFileSync(policyPath, "utf8"))
    policy.planningIntelligenceRange = { min: 50, max: 70 }
    writeFileSync(policyPath, JSON.stringify(policy))
    expect(() => approveMission(deps, teamId, "lead")).toThrow(/present|changed|config/i)
    const preview = openMissionConfiguration(deps, teamId, "lead")
    expect(preview.policy).toHaveProperty("planningIntelligenceRange", { min: 50, max: 70 })
    approveMission(deps, teamId, "lead")
    expect(getMemberPromptModel(deps.db, teamId, "worker").model?.modelID).toBe("luna")
    const next = await add(deps)
    expect(routeMissionTask(deps.db, teamId, next)?.policyRevision).toBe(2)
    await expect(add(deps, explicit)).rejects.toThrow(/range/i)
  })

  test("native switch failure never delivers work on another model and retains the choice for recovery", async () => {
    const { deps, teamId } = await fixture()
    const id = await add(deps, explicit)
    deps.client.session.switchModel = async () => { throw new Error("native unavailable") }
    await expect(executeTeamClaim(deps, { task_id: id }, "worker-session")).rejects.toThrow(/native unavailable/i)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync" && (call.args[0] as { sessionID: string }).sessionID === "worker-session")).toHaveLength(0)
    const row = deps.db.query("SELECT status, assignee, model_routing FROM team_task WHERE id=?").get(id) as { status: string; assignee: string | null; model_routing: string }
    expect(row).toMatchObject({ status: "pending", assignee: null })
    expect(JSON.parse(row.model_routing).authorization).toMatchObject(explicit)
    expect(() => getMemberPromptModel(deps.db, teamId, "worker")).toThrow(/pending/i)
  })

  test("a native discovery race cannot rewrite a newly admitted task", async () => {
    const { deps } = await fixture()
    const id = await add(deps, explicit)
    const native = deps.nativeModels
    deps.nativeModels = async () => {
      const result = native ? await native() : []
      deps.db.run("UPDATE team_task SET status='in_progress', assignee='worker', model_routing='admitted' WHERE id=?", [id])
      return result
    }
    await expect(executeTeamTasksAdd(deps, { tasks: [], execution_decisions: [{ ...explicit, task_id: id, reason: "Changed during discovery" }] }, "lead")).rejects.toThrow(/admitted/i)
    const row = deps.db.query("SELECT execution_decision FROM team_task WHERE id=?").get(id) as { execution_decision: string }
    expect(JSON.parse(row.execution_decision).reason).toBe(explicit.reason)
  })

  test("reused worker returns to the automatic default on its next task", async () => {
    const { deps, teamId } = await fixture()
    const first = await add(deps, explicit)
    await executeTeamClaim(deps, { task_id: first }, "worker-session")
    await executeTeamHandoff(deps, { phase: "implementation" }, "worker-session")
    deps.db.run("UPDATE team_task SET status='completed' WHERE id=?", [first])
    const next = await add(deps)
    deps.config.autoDispatch = true
    expect(dispatchNextTask(deps, teamId, "worker")).toBe(next)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getMemberPromptModel(deps.db, teamId, "worker")).toMatchObject({ model: { modelID: "strong" }, variant: "high" })
    expect(taskExecutionInstructions(deps, "worker-session")).toContain("Task phase: planning")
  })

  test("implementation reasoning may fall below the planning range on the same model", async () => {
    const { deps, teamId } = await fixture()
    const id = await add(deps)
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
    await executeTeamHandoff(deps, { phase: "implementation", reasoning: "low" }, "worker-session")
    expect(getMemberPromptModel(deps.db, teamId, "worker")).toMatchObject({ model: { modelID: "strong" }, variant: "low" })
  })

  test.each(["range", "author", "selection"])("delivery refuses corrupt version 3 %s provenance", async corruption => {
    const { deps, teamId } = await fixture()
    const id = await add(deps, explicit)
    await executeTeamClaim(deps, { task_id: id }, "worker-session")
    const row = deps.db.query("SELECT model_routing FROM team_member WHERE team_id=? AND name='worker'").get(teamId) as { model_routing: string }
    const route = JSON.parse(row.model_routing)
    if (corruption === "author") route.authorization.authorizedBy = "not-the-lead"
    if (corruption === "selection") route.selected.variant = undefined
    if (corruption === "range") {
      route.selected = { id: "fixture/strong", variant: "low" }
      route.authorization = undefined
      route.execution.variant = "low"
      deps.db.run("UPDATE team_member SET model='fixture/strong', model_variant='low' WHERE team_id=? AND name='worker'", [teamId])
    }
    deps.db.run("UPDATE team_member SET model_routing=? WHERE team_id=? AND name='worker'", [JSON.stringify(route), teamId])
    expect(() => getMemberPromptModel(deps.db, teamId, "worker")).toThrow(/provenance/i)
  })
})
