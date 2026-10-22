import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupDeps, insertMember, prepareHistoricalMission as prepareMission } from "./helpers"
import { openMissionConfiguration, approveMission, routeMissionTask } from "../src/mission-policy"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { claimTask, executeTeamClaim } from "../src/tools/team-claim"
import { dispatchNextTask } from "../src/dispatch"
import { getMemberPromptModel } from "../src/member-model"
import { executeTeamMessage } from "../src/tools/team-message"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

async function approvedMission() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-mission-routing-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { beta: 0.35, models: [
    { id: "fixture/light", intelligenceScore: 10, averageCostPerTask: 0.1, available: true },
    { id: "fixture/standard", reasoningEffort: "medium", intelligenceScore: 20, averageCostPerTask: 0.2, available: true },
    { id: "fixture/strong", reasoningEffort: "high", intelligenceScore: 30, averageCostPerTask: 1, available: true },
  ] } }
  const mission = await prepareMission(deps, "lead", "Cache reliability")
  openMissionConfiguration(deps, mission.teamId, "lead")
  approveMission(deps, mission.teamId, "lead")
  return { deps, ...mission }
}

function addTask(deps: ReturnType<typeof setupDeps>, teamId: string, id: string, complexity: number | null, risk: number | null) {
  deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, complexity, risk, time_created, time_updated) VALUES (?, ?, ?, 'pending', 'medium', ?, ?, ?, ?)",
    [id, teamId, id, complexity, risk, Date.now(), Date.now()])
}

describe("approved mission routing integration", () => {
  test("high risk independently selects the approved strong group and persists exact provenance", async () => {
    const { deps, teamId } = await approvedMission()
    addTask(deps, teamId, "risky", 10, 90)
    await executeTeamSpawn(deps, { name: "author", prompt: "Fix risky cache", claim_task: "risky", worktree: false }, "lead")
    const prompt = deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]
    expect(prompt).toMatchObject({ model: { providerID: "fixture", modelID: "strong" }, variant: "high" })
    const task = deps.db.query("SELECT model_routing FROM team_task WHERE id = 'risky'").get() as { model_routing: string }
    expect(JSON.parse(task.model_routing)).toMatchObject({ group: "strong", complexity: 10, risk: 90, policyRevision: 1, selected: { id: "fixture/strong", variant: "high" } })
  })

  test("an omitted spawn variant sends the approved cell and a different variant is refused", async () => {
    const { deps, teamId } = await approvedMission()
    addTask(deps, teamId, "risky", 10, 90)
    await expect(executeTeamSpawn(deps, { name: "other-variant", prompt: "Different variant", claim_task: "risky", variant: "low", worktree: false }, "lead")).rejects.toThrow("cannot override")
    await executeTeamSpawn(deps, { name: "author", prompt: "Fix risky cache", claim_task: "risky", worktree: false }, "lead")
    expect(deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]).toMatchObject({ model: { providerID: "fixture", modelID: "strong" }, variant: "high" })
    type SpawnArgs = Parameters<typeof executeTeamSpawn>[1]
    const profileIsAbsent: "profile" extends keyof SpawnArgs ? false : true = true
    expect(profileIsAbsent).toBe(true)
  })

  test("explicit model and score overrides cannot bypass the task's approved cell", async () => {
    const { deps, teamId } = await approvedMission()
    addTask(deps, teamId, "risky", 10, 90)
    await expect(executeTeamSpawn(deps, { name: "override", prompt: "Bypass", claim_task: "risky", model: "fixture/light", worktree: false }, "lead")).rejects.toThrow("mission policy")
    await expect(executeTeamSpawn(deps, { name: "scores", prompt: "Bypass", claim_task: "risky", complexity: 0, risk: 0, worktree: false }, "lead")).rejects.toThrow("recorded task scores")
    expect(deps.client.calls).toHaveLength(0)
  })

  test("missing dimensions remain unclaimable rather than becoming zero", async () => {
    const { deps, teamId } = await approvedMission()
    addTask(deps, teamId, "partial", 10, null)
    expect(() => claimTask(deps.db, teamId, "partial", "worker")).toThrow("both complexity and risk")
    await expect(executeTeamSpawn(deps, { name: "partial", prompt: "Incomplete", complexity: 10, worktree: false }, "lead")).rejects.toThrow("both complexity and risk")
    expect(deps.client.calls).toHaveLength(0)
  })

  test("a reused worker is rerouted at each claim and receives the new native variant", async () => {
    const { deps, teamId } = await approvedMission()
    insertMember(deps.db, teamId, "worker", "worker-session")
    deps.registry.register(teamId, "worker", "worker-session")
    addTask(deps, teamId, "light", 0, 0)
    claimTask(deps.db, teamId, "light", "worker")
    expect(deps.db.query("SELECT model, model_variant FROM team_member WHERE name = 'worker'").get()).toEqual({ model: "fixture/light", model_variant: null })
    deps.db.run("UPDATE team_task SET status = 'completed' WHERE id = 'light'")
    addTask(deps, teamId, "risky", 10, 90)
    deps.config = { ...deps.config, autoDispatch: true }
    expect(dispatchNextTask(deps, teamId, "worker")).toBe("risky")
    expect(deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]).toMatchObject({ model: { providerID: "fixture", modelID: "strong" }, variant: "high" })
  })

  test("later catalogue and assignment changes cannot rewrite an approved mission", async () => {
    const { deps, teamId } = await approvedMission()
    deps.config = { ...deps.config, defaultModel: "unapproved/default", modelPool: ["unapproved/pool"], modelAssignment: "random",
      modelRouting: { beta: 0, models: [{ id: "unapproved/free", intelligenceScore: 1000, averageCostPerTask: 0, available: true }] } }
    addTask(deps, teamId, "light", 0, 0)
    await executeTeamSpawn(deps, { name: "stable", prompt: "Keep approved policy", claim_task: "light", worktree: false }, "lead")
    expect(deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]).toMatchObject({ model: { providerID: "fixture", modelID: "light" } })
  })

  test("revoking approval during session allocation rolls back instead of launching an unclaimed worker", async () => {
    const { deps, teamId } = await approvedMission()
    addTask(deps, teamId, "risky", 10, 90)
    const create = deps.client.session.create.bind(deps.client.session)
    let release: () => void = () => {}
    const allocation = new Promise<void>(resolve => { release = resolve })
    deps.client.session.create = async input => {
      const result = await create(input)
      await allocation
      return result
    }
    const spawning = executeTeamSpawn(deps, { name: "revoked", prompt: "Must not start", claim_task: "risky", worktree: false }, "lead")
    await Promise.resolve()
    openMissionConfiguration(deps, teamId, "lead")
    release()
    await expect(spawning).rejects.toThrow("approved")
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(1)
    expect(deps.db.query("SELECT name FROM team_member WHERE name = 'revoked'").get()).toBeNull()
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'risky'").get()).toEqual({ status: "pending", assignee: null })
  })

  test("already-claimed tasks are rejected before allocating governed workers", async () => {
    const { deps, teamId } = await approvedMission()
    addTask(deps, teamId, "taken", 10, 90)
    deps.db.run("UPDATE team_task SET status = 'in_progress', assignee = 'someone' WHERE id = 'taken'")
    await expect(executeTeamSpawn(deps, { name: "duplicate", prompt: "Must not start", claim_task: "taken", worktree: false }, "lead")).rejects.toThrow("claim")
    expect(deps.client.calls).toHaveLength(0)
  })

  test("a worker cannot switch its routing by claiming a second simultaneous task", async () => {
    const { deps, teamId } = await approvedMission()
    insertMember(deps.db, teamId, "worker", "worker-session")
    addTask(deps, teamId, "first", 0, 0)
    addTask(deps, teamId, "second", 10, 90)
    claimTask(deps.db, teamId, "first", "worker")
    expect(() => claimTask(deps.db, teamId, "second", "worker")).toThrow("in-progress")
    expect(deps.db.query("SELECT model FROM team_member WHERE name = 'worker'").get()).toEqual({ model: "fixture/light" })
  })

  test("deliveries refuse corrupted model provenance instead of falling back to native defaults", async () => {
    const { deps, teamId } = await approvedMission()
    insertMember(deps.db, teamId, "worker", "worker-session")
    addTask(deps, teamId, "risky", 10, 90)
    claimTask(deps.db, teamId, "risky", "worker")
    // Pausing a future revision must not interrupt the already-admitted task.
    openMissionConfiguration(deps, teamId, "lead")
    expect(getMemberPromptModel(deps.db, teamId, "worker")).toMatchObject({ model: { providerID: "fixture", modelID: "strong" }, variant: "high" })
    deps.db.run("UPDATE team_member SET model = 'unauthorized/model' WHERE name = 'worker'")
    expect(() => getMemberPromptModel(deps.db, teamId, "worker")).toThrow("provenance")
    deps.db.run("UPDATE team_member SET model = NULL WHERE name = 'worker'")
    expect(() => getMemberPromptModel(deps.db, teamId, "worker")).toThrow("provenance")
  })

  test("worker reports still reach the native supervisor outside worker model policy", async () => {
    const { deps, teamId } = await approvedMission()
    insertMember(deps.db, teamId, "worker", "worker-session")
    deps.registry.register(teamId, "worker", "worker-session")
    addTask(deps, teamId, "first", 0, 0)
    claimTask(deps.db, teamId, "first", "worker")
    await executeTeamMessage(deps, { to: "lead", text: "Cache implementation complete" }, "worker-session")
    expect(deps.client.calls.find(call => call.method === "session.promptAsync")?.args[0]).toMatchObject({ sessionID: "lead" })
  })

  test.each([null, "0.9", -0.001])("rejects a corrupt normalized classifier score %p rather than coercing it to a valid band", async score => {
    const { deps, teamId } = await approvedMission()
    addTask(deps, teamId, "corrupt", null, null)
    deps.db.run("UPDATE team_task SET classification_status = 'completed', classification_result = ? WHERE id = 'corrupt'", [JSON.stringify({ complexity: score, risk: 0.9 })])
    expect(() => claimTask(deps.db, teamId, "corrupt", "worker")).toThrow("normalized")
  })

  test.each([true, false])("rollback preserves an allocated branch before abort (preservation succeeds: %p)", async preserved => {
    const { deps, teamId } = await approvedMission()
    addTask(deps, teamId, "risky", 10, 90)
    const events: string[] = []
    deps.preserveBranch = async () => { events.push("preserve"); return preserved }
    const abort = deps.client.session.abort.bind(deps.client.session)
    deps.client.session.abort = async input => { events.push("abort"); return abort(input) }
    const create = deps.client.session.create.bind(deps.client.session)
    let enter: () => void = () => {}
    let release: () => void = () => {}
    const entered = new Promise<void>(resolve => { enter = resolve })
    const allocation = new Promise<void>(resolve => { release = resolve })
    deps.client.session.create = async input => {
      const result = await create(input)
      enter()
      await allocation
      return result
    }
    const spawning = executeTeamSpawn(deps, { name: "branch-owner", prompt: "Must not run", claim_task: "risky", worktree: true }, "lead")
    await entered
    openMissionConfiguration(deps, teamId, "lead")
    release()
    await expect(spawning).rejects.toThrow(preserved ? "approved" : "cleanup pending")
    expect(events).toEqual(preserved ? ["preserve", "abort"] : ["preserve"])
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync" && (call.args[0] as { sessionID: string }).sessionID !== "lead")).toHaveLength(0)
    const member = deps.db.query("SELECT status, worktree_branch FROM team_member WHERE name = 'branch-owner'").get()
    if (preserved) expect(member).toBeNull()
    else expect(member).toMatchObject({ status: "error", worktree_branch: expect.any(String) })
  })

  test("direct worker claims await native model pinning before returning the task", async () => {
    const { deps, teamId } = await approvedMission()
    insertMember(deps.db, teamId, "worker", "worker-session")
    deps.registry.register(teamId, "worker", "worker-session")
    addTask(deps, teamId, "risky", 10, 90)
    let release: () => void = () => {}
    const switched = new Promise<void>(resolve => { release = resolve })
    const selections: unknown[] = []
    deps.client.session.switchModel = async input => { selections.push(input); await switched }
    let returned = false
    const claiming = executeTeamClaim(deps, { task_id: "risky" }, "worker-session").then(result => { returned = true; return result })
    await Promise.resolve()
    try {
      expect(selections).toEqual([{ sessionID: "worker-session", model: { providerID: "fixture", modelID: "strong" }, variant: "high" }])
      expect(returned).toBe(false)
    } finally { release(); await claiming }
    expect(returned).toBe(true)
  })

  test("a failed native pin releases the claim and quarantines the worker rather than running on its old model", async () => {
    const { deps, teamId } = await approvedMission()
    insertMember(deps.db, teamId, "worker", "worker-session")
    deps.registry.register(teamId, "worker", "worker-session")
    addTask(deps, teamId, "risky", 10, 90)
    deps.client.session.switchModel = async () => { throw new Error("native selection failed") }
    await expect(executeTeamClaim(deps, { task_id: "risky" }, "worker-session")).rejects.toThrow("native")
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'risky'").get()).toEqual({ status: "pending", assignee: null })
    expect(deps.db.query("SELECT status FROM team_member WHERE name = 'worker'").get()).toEqual({ status: "error" })
  })

  test("unsupported hosts cannot pretend that updating a stored model switches an executing worker", async () => {
    const { deps, teamId } = await approvedMission()
    insertMember(deps.db, teamId, "worker", "worker-session")
    deps.registry.register(teamId, "worker", "worker-session")
    addTask(deps, teamId, "risky", 10, 90)
    await expect(executeTeamClaim(deps, { task_id: "risky" }, "worker-session")).rejects.toThrow("native model")
    expect(deps.db.query("SELECT status FROM team_task WHERE id = 'risky'").get()).toEqual({ status: "pending" })
  })

  test.each([[0.14, 14], [0.28, 28], [0.56, 56], [0.280001, 29], [0.00000000000001, 1]])("normalized %p stays equivalent to manual %p at an adjacent model boundary", async (normalized, manual) => {
    const { deps, teamId, policyPath } = await approvedMission()
    const policy = JSON.parse(readFileSync(policyPath, "utf8"))
    policy.complexityBands = [0, manual + 1, 67, 101]
    writeFileSync(policyPath, JSON.stringify(policy))
    openMissionConfiguration(deps, teamId, "lead")
    approveMission(deps, teamId, "lead")
    addTask(deps, teamId, "manual", manual, 0)
    addTask(deps, teamId, "normalized", null, null)
    deps.db.run("UPDATE team_task SET classification_status = 'completed', classification_result = ? WHERE id = 'normalized'", [JSON.stringify({ complexity: normalized, risk: 0 })])
    const expected = routeMissionTask(deps.db, teamId, "manual")
    const actual = routeMissionTask(deps.db, teamId, "normalized")
    expect(actual?.complexity).toBe(manual)
    expect(actual?.selected).toEqual(expected?.selected)
    expect(actual?.group).toBe(expected?.group)
  })
})
