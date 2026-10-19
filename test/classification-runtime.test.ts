import { expect, test } from "bun:test"
import { setupDeps } from "./helpers"
import { createDb } from "../src/db"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { executeTeamCreate } from "../src/tools/team-create"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { classifyBoardTasks } from "../src/board-classification"
import { resolveMissionClassification, type ClassificationPort } from "../src/mission-classification"
import { getMissionClassification } from "../src/mission-classification"
import { claimTask } from "../src/tools/team-claim"
import { pickNextTask } from "../src/dispatch"

function fixture() {
  const deps = setupDeps()
  const calls: string[] = []
  const tools = [{ id: "jev_ask", input: { type: "object", properties: { state: {}, questions: {} }, required: ["state", "questions"] } }, { id: "classify_x86", input: { type: "object", properties: { assembly: {}, architecture: {} }, required: ["assembly", "architecture"] } }]
  deps.classifier = {
    list: async () => tools,
    invoke: async request => { calls.push(request.toolId); return request.toolId === "classify_x86" ? { complexity: 42, uncertainty: 23 } : { answers: { complexity: { type: "score", score: 0.4 }, risk: { type: "score", score: 0.2 } } } },
    general: async request => { calls.push(request.model); return { complexity: 0.3, risk: 0.1 } },
  } as ClassificationPort
  deps.config.classification = { ...deps.config.classification, helperModel: "fixture/helper" }
  return { deps, calls }
}

async function run(f: ReturnType<typeof fixture>, tasks = [{ content: "task", priority: "medium" }]) {
  await executeTeamCreate(f.deps, { name: "mission" }, "lead")
  const id = (f.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  await executeTeamTasksAdd(f.deps, { tasks }, "lead")
  await classifyBoardTasks(f.deps, id)
  return id
}

test("authorized fallback is systematic and records an incident instead of silently changing method", async () => {
  const f = fixture()
  f.deps.config.classification.fallbacks = [{ method: "general", model: "chosen/flash", variant: "medium" }]
  f.deps.config.classification.limits = { retries: 0 }
  f.deps.classifier!.invoke = async () => { f.calls.push("jev_ask"); throw new Error("offline") }
  const id = await run(f)
  expect(f.calls).toEqual(["jev_ask", "chosen/flash"])
  expect(f.deps.db.query("SELECT classification_status FROM team_task").get()).toMatchObject({ classification_status: "completed" })
  expect(f.deps.db.query("SELECT kind FROM classification_incident WHERE team_id = ? AND kind = 'fallback'").all(id)).toHaveLength(1)
})

test("no JEV uses the explicitly chosen general model; missing model is never auto-filled", async () => {
  const f = fixture()
  f.deps.classifier!.list = async () => []
  f.deps.config.classification.generalModel = "chosen/flash"
  expect(await resolveMissionClassification(f.deps)).toMatchObject({ method: "general", generalModel: "chosen/flash" })
  const id = await run(f)
  expect(f.calls).toEqual(["chosen/flash"])
  expect(f.deps.db.query("SELECT mission_state FROM team WHERE id = ?").get(id)).toMatchObject({ mission_state: "running" })
})

test("specialized x86 tasks use the fixed specialized tool and preserve user dimensions", async () => {
  const f = fixture()
  f.deps.config.classification.specialized = true
  await executeTeamCreate(f.deps, { name: "mission" }, "lead")
  const id = (f.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  await executeTeamTasksAdd(f.deps, { tasks: [{ content: "reconstruct", priority: "medium", task_type: "x86", classification_input: { assembly: "ret", architecture: "x86-64" }, risk: 0 }] }, "lead")
  await classifyBoardTasks(f.deps, id)
  expect(f.calls).toEqual(["classify_x86"])
  const row = f.deps.db.query("SELECT classification_result FROM team_task").get() as { classification_result: string }
  expect(JSON.parse(row.classification_result)).toMatchObject({ complexity: 0.42, risk: 0 })
})

test("explicitly imposed JEV method overrides specialized preference", async () => {
  const f = fixture()
  f.deps.config.classification = { ...f.deps.config.classification, mode: "jev", specialized: true }
  await executeTeamCreate(f.deps, { name: "mission" }, "lead")
  const id = (f.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  await executeTeamTasksAdd(f.deps, { tasks: [{ content: "reconstruct", priority: "medium", task_type: "x86", classification_input: { assembly: "ret", architecture: "x86-64" } }] }, "lead")
  await classifyBoardTasks(f.deps, id)
  expect(f.calls).toEqual(["jev_ask"])
})

test("missing x86 assembly blocks without sending invented input to any classifier", async () => {
  const f = fixture()
  f.deps.config.classification.specialized = true
  await executeTeamCreate(f.deps, { name: "mission" }, "lead")
  const id = (f.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  await executeTeamTasksAdd(f.deps, { tasks: [{ content: "reconstruct", priority: "medium", task_type: "x86" }] }, "lead")
  await classifyBoardTasks(f.deps, id)
  expect(f.calls).toHaveLength(0)
  expect(f.deps.db.query("SELECT classification_status FROM team_task").get()).toMatchObject({ classification_status: "blocked" })
})

test("retries are bounded and budgets persist across task drains", async () => {
  const f = fixture()
  f.deps.config.classification.limits = { retries: 1, retryDelayMs: 1, maxAttempts: 2, maxCalls: 2 }
  f.deps.classifier!.invoke = async () => { f.calls.push("jev_ask"); throw new Error("Provider timeout") }
  const id = await run(f, [{ content: "first", priority: "medium" }, { content: "second", priority: "medium" }])
  expect(f.calls).toHaveLength(2)
  const row = f.deps.db.query("SELECT classification_runtime, mission_state FROM team WHERE id = ?").get(id) as { classification_runtime: string; mission_state: string }
  expect(JSON.parse(row.classification_runtime).calls).toBe(2)
  expect(row.mission_state).toBe("attention")
})

test("long_run isolates a failed task but marks mission critical when a hard budget is exhausted", async () => {
  const f = fixture()
  f.deps.config.classification = { ...f.deps.config.classification, missionMode: "long_run", limits: { maxCalls: 1 } }
  await run(f, [{ content: "first", priority: "medium" }, { content: "second", priority: "medium" }])
  expect(f.calls).toHaveLength(1)
  expect(f.deps.db.query("SELECT mission_mode, mission_state FROM team").get()).toMatchObject({ mission_mode: "long_run", mission_state: "critical" })
  expect(f.deps.db.query("SELECT COUNT(*) AS count FROM team_task WHERE classification_status = 'completed'").get()).toMatchObject({ count: 1 })
  const row = f.deps.db.query("SELECT id, team_id FROM team_task WHERE classification_status = 'completed'").get() as { id: string; team_id: string }
  expect(() => claimTask(f.deps.db, row.team_id, row.id, "worker")).toThrow("critical")
  expect(pickNextTask(f.deps.db, row.team_id, "build")).toHaveLength(0)
})

test("classification concurrency is separately bounded across missions and failures release the slot", async () => {
  const a = fixture()
  const b = fixture()
  let active = 0
  let peak = 0
  const invoke = async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => { setTimeout(resolve, 5) })
    active--
    return { answers: { complexity: { type: "score", score: 0.4 }, risk: { type: "score", score: 0.2 } } }
  }
  a.deps.classifier!.invoke = invoke
  b.deps.classifier!.invoke = invoke
  await Promise.all([run(a), run(b)])
  expect(peak).toBe(1)
  expect(active).toBe(0)
})
test("a queued classification cannot call a provider after losing its admission token", async () => {
  const a = fixture()
  const b = fixture()
  b.deps.config.classification = { ...b.deps.config.classification, missionMode: "long_run", limits: { maxCalls: 1 } }
  let release: (value: unknown) => void = () => {}
  a.deps.classifier!.invoke = async () => new Promise(resolve => { release = resolve })
  await executeTeamCreate(a.deps, { name: "mission" }, "lead")
  await executeTeamTasksAdd(a.deps, { tasks: [{ content: "hold slot", priority: "medium" }] }, "lead")
  await Promise.resolve()
  await executeTeamCreate(b.deps, { name: "mission" }, "lead")
  await executeTeamTasksAdd(b.deps, { tasks: [{ content: "queued", priority: "medium" }] }, "lead")
  await Promise.resolve()
  b.deps.db.run("UPDATE team_task SET classification_token = 'new-owner'")
  b.deps.db.run("UPDATE team SET classification_runtime = ?", [JSON.stringify({ calls: 1, bytes: 0, started: Date.now(), methods: {} })])
  release({ answers: { complexity: { type: "score", score: 0.4 }, risk: { type: "score", score: 0.2 } } })
  const idA = (a.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  const idB = (b.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  await Promise.all([classifyBoardTasks(a.deps, idA), classifyBoardTasks(b.deps, idB)])
  expect(b.calls).toHaveLength(0)
  expect(b.deps.db.query("SELECT mission_state FROM team").get()).toMatchObject({ mission_state: "running" })
})

test("recorded stale helpers are removed before any new classification admission", async () => {
  const f = fixture()
  await executeTeamCreate(f.deps, { name: "mission" }, "lead")
  const id = (f.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  f.deps.db.run("INSERT INTO classification_helper (session_id, team_id, task_id, lease_until) VALUES ('old-helper', ?, 'old-task', 0)", [id])
  f.deps.classifier!.removeHelper = async sessionID => { f.calls.push(sessionID) }
  await executeTeamTasksAdd(f.deps, { tasks: [{ content: "task", priority: "medium" }] }, "lead")
  await classifyBoardTasks(f.deps, id)
  expect(f.calls).toEqual(["old-helper", "jev_ask"])
  expect(f.deps.db.query("SELECT * FROM classification_helper").all()).toHaveLength(0)
})

test("failed helper cleanup is critical and never allocates another helper", async () => {
  const f = fixture()
  await executeTeamCreate(f.deps, { name: "mission" }, "lead")
  const id = (f.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  f.deps.db.run("INSERT INTO classification_helper (session_id, team_id, task_id, lease_until) VALUES ('old-helper', ?, 'old-task', 0)", [id])
  f.deps.classifier!.removeHelper = async () => { throw new Error("offline") }
  await executeTeamTasksAdd(f.deps, { tasks: [{ content: "task", priority: "medium" }] }, "lead")
  await classifyBoardTasks(f.deps, id)
  expect(f.calls).toHaveLength(0)
  expect(f.deps.db.query("SELECT mission_state FROM team").get()).toMatchObject({ mission_state: "critical" })
})

test("method and budget settings are deep-frozen and invalid configuration fails before mission creation", async () => {
  const f = fixture()
  f.deps.config.classification.fallbacks = [{ method: "general", model: "chosen/flash" }]
  f.deps.config.classification.limits = { maxCalls: 10 }
  const policy = await resolveMissionClassification(f.deps)
  f.deps.config.classification.fallbacks[0]!.model = "other/model"
  f.deps.config.classification.limits.maxCalls = 20
  expect(policy.fallbacks?.[0]?.model).toBe("chosen/flash")
  expect(policy.limits?.maxCalls).toBe(10)
  expect(policy.limits?.maxAttempts).toBe(3)
  expect(policy.limits?.circuitCooldownMs).toBe(60_000)
  await expect(resolveMissionClassification(f.deps, { limits: { concurrency: 17 } })).rejects.toThrow("bounds")
  await expect(resolveMissionClassification(f.deps, { generalModel: "not-provider-qualified" })).rejects.toThrow("generalModel")
})

test("SQLite policy, classification provenance and budget counters survive a database reopen", async () => {
  const f = fixture()
  const tempRoot = process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? tmpdir(), "Temp", "opencode") : tmpdir()
  const directory = mkdtempSync(join(tempRoot, "ensemble-classification-db-"))
  const filename = join(directory, "mission.sqlite")
  const original = f.deps.db
  f.deps.db = createDb(filename)
  try {
    const id = await run(f)
    f.deps.db.close()
    f.deps.db = createDb(filename)
    expect(getMissionClassification(f.deps.db, id)).toMatchObject({ method: "jev", protocol: "ensemble-task-v1", helperModel: "fixture/helper" })
    const row = f.deps.db.query("SELECT classification_runtime FROM team WHERE id = ?").get(id) as { classification_runtime: string }
    expect(JSON.parse(row.classification_runtime).calls).toBe(1)
    const task = f.deps.db.query("SELECT classification_status, classification_result FROM team_task").get() as { classification_status: string; classification_result: string }
    expect(task.classification_status).toBe("completed")
    expect(JSON.parse(task.classification_result)).toMatchObject({ complexity: 0.4, risk: 0.2, method: "jev" })
    await classifyBoardTasks(f.deps, id)
    expect(f.calls).toHaveLength(1)
  } finally { f.deps.db.close(); original.close(); rmSync(directory, { recursive: true, force: true }) }
})

test("a transient timeout is retried once by default and then succeeds", async () => {
  const f = fixture()
  f.deps.classifier!.invoke = async () => {
    f.calls.push("jev_ask")
    if (f.calls.length === 1) throw new Error("Classifier timeout")
    return { answers: { complexity: { type: "score", score: 0.4 }, risk: { type: "score", score: 0.2 } } }
  }
  const id = await run(f)
  expect(f.calls).toEqual(["jev_ask", "jev_ask"])
  expect(getMissionClassification(f.deps.db, id)?.limits?.retries).toBe(1)
  expect(f.deps.db.query("SELECT classification_status FROM team_task").get()).toMatchObject({ classification_status: "completed" })
})

test("an already frozen policy keeps retries 0 until an explicit update", async () => {
  const f = fixture()
  await executeTeamCreate(f.deps, { name: "mission" }, "lead")
  const id = (f.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  const policy = getMissionClassification(f.deps.db, id)
  f.deps.db.run("UPDATE team SET classification_policy = ? WHERE id = ?", [JSON.stringify({ ...policy, limits: { ...policy?.limits, retries: 0 } }), id])
  f.deps.classifier!.invoke = async () => { f.calls.push("jev_ask"); throw new Error("Classifier timeout") }
  await executeTeamTasksAdd(f.deps, { tasks: [{ content: "task", priority: "medium" }] }, "lead")
  await classifyBoardTasks(f.deps, id)
  expect(f.calls).toEqual(["jev_ask"])
  expect(getMissionClassification(f.deps.db, id)?.limits?.retries).toBe(0)
})

test("an empty helper is never invoked and a terminal tool violation is not retried", async () => {
  const missing = fixture()
  missing.deps.config.classification.helperModel = ""
  await executeTeamCreate(missing.deps, { name: "mission" }, "lead")
  const missingId = (missing.deps.db.query("SELECT id FROM team").get() as { id: string }).id
  missing.deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, classification_status, time_created, time_updated) VALUES ('pending-task', ?, 'task', 'pending', 'medium', 'pending', ?, ?)", [missingId, Date.now(), Date.now()])
  await classifyBoardTasks(missing.deps, missingId)
  expect(missing.calls).toHaveLength(0)
  expect(missing.deps.db.query("SELECT classification_status, classification_error FROM team_task").get()).toMatchObject({ classification_status: "blocked", classification_error: expect.stringContaining("helperModel") })
  const violated = fixture()
  violated.deps.config.classification.limits = { retries: 1, retryDelayMs: 1 }
  violated.deps.classifier!.invoke = async () => { violated.calls.push("jev_ask"); throw new Error("Classifier cannot change the approved tool input") }
  await run(violated)
  expect(violated.calls).toEqual(["jev_ask"])
})

test("a legacy team without a mission refuses unscored tasks while the required helper is unset", async () => {
  const f = fixture()
  f.deps.config.classification.helperModel = ""
  await executeTeamCreate(f.deps, { name: "mission" }, "lead")
  await expect(executeTeamTasksAdd(f.deps, { tasks: [{ content: "unscored", priority: "medium" }] }, "lead")).rejects.toThrow("Configure helperModel")
  expect(f.deps.db.query("SELECT id, classification_status FROM team_task").all()).toHaveLength(0)
  expect(f.calls).toHaveLength(0)
  await executeTeamTasksAdd(f.deps, { tasks: [{ content: "scored", priority: "medium", complexity: 10, risk: 20 }] }, "lead")
  expect(f.deps.db.query("SELECT classification_status FROM team_task").get()).toMatchObject({ classification_status: "not_required" })
  expect(f.calls).toHaveLength(0)
})

test("duration and serialized-volume budgets refuse new calls before spending a reservation", async () => {
  for (const limit of ["time", "bytes"]) {
    const f = fixture()
    f.deps.config.classification.limits = limit === "time" ? { maxDurationMs: 1 } : { maxInputBytes: 1 }
    await executeTeamCreate(f.deps, { name: "mission" }, "lead")
    const id = (f.deps.db.query("SELECT id FROM team").get() as { id: string }).id
    if (limit === "time") f.deps.db.run("UPDATE team SET classification_runtime = ? WHERE id = ?", [JSON.stringify({ calls: 0, bytes: 0, started: Date.now() - 1000, methods: {} }), id])
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "task", priority: "medium" }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(f.calls).toHaveLength(0)
    expect(f.deps.db.query("SELECT mission_state FROM team").get()).toMatchObject({ mission_state: "attention" })
  }
})

test("circuit breaker avoids repeated outages, and explicit bounded rechecks happen after cooldown", async () => {
  const f = fixture()
  f.deps.config.classification.limits = { circuitThreshold: 1, circuitCooldownMs: 100_000, maxCircuitRechecks: 1 }
  f.deps.classifier!.invoke = async () => { f.calls.push("jev_ask"); throw new Error("offline") }
  const id = await run(f, [{ content: "first", priority: "medium" }, { content: "second", priority: "medium" }])
  expect(f.calls).toHaveLength(1)
  const row = f.deps.db.query("SELECT classification_runtime FROM team WHERE id = ?").get(id) as { classification_runtime: string }
  const runtime = JSON.parse(row.classification_runtime) as { methods: Record<string, { openUntil: number }> }
  Object.values(runtime.methods).forEach(method => { method.openUntil = 0 })
  f.deps.db.run("UPDATE team SET classification_runtime = ? WHERE id = ?", [JSON.stringify(runtime), id])
  await executeTeamTasksAdd(f.deps, { tasks: [{ content: "third", priority: "medium" }] }, "lead")
  await classifyBoardTasks(f.deps, id)
  expect(f.calls).toHaveLength(2)
})
