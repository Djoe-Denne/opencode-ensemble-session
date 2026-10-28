import { describe, expect, test } from "bun:test"
import { setupDeps } from "./helpers"
import { executeTeamCreate } from "../src/tools/team-create"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { claimTask } from "../src/tools/team-claim"
import { pickNextTask } from "../src/dispatch"
import { classifyBoardTasks } from "../src/board-classification"
import { getMissionClassification, resolveMissionClassification } from "../src/mission-classification"
import { executeTeamMessage } from "../src/tools/team-message"
import { executeTeamTasksList } from "../src/tools/team-tasks-list"
import { buildLeadSystemPrompt, buildTeamCompactionContext } from "../src/system-prompt"
import { insertMember } from "./helpers"
import { executeTeamStatus } from "../src/tools/team-status"

function fixture() {
  const deps = setupDeps()
  const invocations: unknown[] = []
  deps.classifier = {
    list: async () => [{ id: "router_jev_ask", input: { type: "object", properties: { state: {}, questions: {} }, required: ["state", "questions"] } }],
    invoke: async request => { invocations.push(request); return { model: "jev", answers: { complexity: { type: "score", score: 0.48123 }, risk: { type: "score", score: 0.97234 } } } },
  }
  deps.config.classification = { ...deps.config.classification, mode: "auto", helperModel: "fixture/flash" }
  return { deps, invocations }
}

async function team(f: ReturnType<typeof fixture>) {
  await executeTeamCreate(f.deps, { name: "classified" }, "lead")
  return (f.deps.db.query("SELECT id FROM team").get() as { id: string }).id
}

describe("mission classification and board admission", () => {
  test("a deferred task is not sent to a classifier until the lead publishes it", async () => {
    const f = fixture()
    const id = await team(f)
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "Private audit", priority: "medium", publication: "deferred" }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(f.invocations).toHaveLength(0)
    const task = f.deps.db.query("SELECT id FROM team_task").get() as { id: string }
    await executeTeamTasksAdd(f.deps, { tasks: [], task_controls: [{ task_id: task.id, publication: "published", reason: "Independent audit prepared" }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(f.invocations).toHaveLength(1)
    f.deps.db.close()
  })

  test("capabilities are resolved once and frozen independently of global config changes", async () => {
    const f = fixture()
    const id = await team(f)
    f.deps.config.classification.helperModel = "different/model"
    expect(getMissionClassification(f.deps.db, id)).toMatchObject({ method: "jev", helperModel: "fixture/flash", toolId: "router_jev_ask" })
  })
  test("no host/tool preserves legacy manual operation; explicit unavailable JEV rejects", async () => {
    const f = fixture()
    f.deps.classifier = undefined
    expect(await resolveMissionClassification(f.deps)).toMatchObject({ method: "manual" })
    await expect(resolveMissionClassification(f.deps, { mode: "jev" })).rejects.toThrow("unavailable")
    await expect(resolveMissionClassification(fixture().deps, { timeoutMs: 0 })).rejects.toThrow("timeoutMs")
  })
  test("unclassified tasks are gated atomically until their native normalized scores are saved", async () => {
    const f = fixture()
    const id = await team(f)
    let release: (value: unknown) => void = () => {}
    f.deps.classifier!.invoke = async () => new Promise(resolve => { release = resolve })
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "work", priority: "medium" }] }, "lead")
    const task = f.deps.db.query("SELECT id FROM team_task").get() as { id: string }
    expect(() => claimTask(f.deps.db, id, task.id, "worker")).toThrow("classification")
    expect(pickNextTask(f.deps.db, id, "build")).toHaveLength(0)
    await Promise.resolve()
    release({ answers: { complexity: { type: "score", score: 0.48123 }, risk: { type: "score", score: 0.97234 } } })
    await classifyBoardTasks(f.deps, id)
    const row = f.deps.db.query("SELECT * FROM team_task").get() as Record<string, unknown>
    expect(row.classification_status).toBe("completed")
    expect(JSON.parse(row.classification_result as string)).toMatchObject({ complexity: 0.48123, risk: 0.97234 })
    expect(row.complexity).toBeNull()
    expect(pickNextTask(f.deps.db, id, "build")).toHaveLength(1)
  })
  test("manual scores bypass classification and a partial manual dimension is preserved", async () => {
    const f = fixture()
    const id = await team(f)
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "manual", priority: "medium", complexity: 10, risk: 0 }, { content: "partial", priority: "medium", risk: 0 }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(f.invocations).toHaveLength(1)
    const row = f.deps.db.query("SELECT classification_result FROM team_task WHERE content = 'partial'").get() as { classification_result: string }
    expect(JSON.parse(row.classification_result)).toMatchObject({ complexity: 0.48123, risk: 0 })
  })
  test("an unavailable classifier blocks only the task and reports why", async () => {
    const f = fixture()
    const id = await team(f)
    f.deps.classifier!.invoke = async () => { throw new Error("JEV model disappeared") }
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "blocked", priority: "medium" }, { content: "manual", priority: "medium", complexity: 0, risk: 0 }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    const row = f.deps.db.query("SELECT classification_status, classification_error FROM team_task WHERE content = 'blocked'").get()
    expect(row).toMatchObject({ classification_status: "blocked", classification_error: "JEV model disappeared" })
    expect(pickNextTask(f.deps.db, id, "build")).toHaveLength(1)
    expect(f.deps.db.query("SELECT content FROM team_message WHERE to_name = 'lead'").all().some(row => (row as { content: string }).content.includes("disappeared"))).toBe(true)
  })
  test("concurrent pumps share one admission and do not reclassify completed tasks", async () => {
    const f = fixture()
    const id = await team(f)
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "once", priority: "medium" }] }, "lead")
    await Promise.all([classifyBoardTasks(f.deps, id), classifyBoardTasks(f.deps, id)])
    await classifyBoardTasks(f.deps, id)
    expect(f.invocations).toHaveLength(1)
  })
  test("a lead-only explicit policy update retries blocked tasks and survives compaction", async () => {
    const f = fixture()
    f.deps.config.classification.helperModel = ""
    const id = await team(f)
    await expect(executeTeamTasksAdd(f.deps, { tasks: [{ content: "blocked", priority: "medium" }] }, "lead")).rejects.toThrow("Configure helperModel")
    expect(f.deps.db.query("SELECT id FROM team_task").all()).toHaveLength(0)
    f.deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, classification_status, time_created, time_updated) VALUES ('blocked-task', ?, 'blocked', 'pending', 'medium', 'pending', ?, ?)", [id, Date.now(), Date.now()])
    await classifyBoardTasks(f.deps, id)
    expect(await executeTeamTasksList(f.deps, "lead")).toContain("classification:blocked")
    insertMember(f.deps.db, id, "worker", "worker-session")
    await expect(executeTeamMessage(f.deps, { to: "lead", classification: { helperModel: "fixture/flash" } }, "worker-session")).rejects.toThrow("Only the lead")
    await executeTeamMessage(f.deps, { to: "lead", classification: { helperModel: "fixture/flash" } }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(f.deps.db.query("SELECT classification_status FROM team_task").get()).toMatchObject({ classification_status: "completed" })
    expect(buildLeadSystemPrompt(f.deps.db, id)).toContain("router_jev_ask")
    expect(buildTeamCompactionContext(f.deps.db, id, "lead")).toContain("fixture/flash")
  })
  test("classification progress, precision and mission modes are visible in board/status/lead context", async () => {
    const f = fixture()
    const id = await team(f)
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "work", priority: "medium" }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(await executeTeamTasksList(f.deps, "lead")).toContain("0.48123")
    expect(await executeTeamStatus(f.deps, "lead")).toContain("supervised")
    expect(buildLeadSystemPrompt(f.deps.db, id)).toContain("explicit user")
  })
  test("an unsupported stored rubric blocks evaluation but can be explicitly replaced by the user", async () => {
    const f = fixture()
    const id = await team(f)
    const frozen = getMissionClassification(f.deps.db, id)!
    f.deps.db.run("UPDATE team SET classification_policy = ? WHERE id = ?", [JSON.stringify({ ...frozen, protocol: "unknown-protocol" }), id])
    expect(() => getMissionClassification(f.deps.db, id)).toThrow("protocol")
    expect(buildLeadSystemPrompt(f.deps.db, id)).toContain("unknown-protocol")
    await executeTeamMessage(f.deps, { to: "lead", classification: { mode: "off" } }, "lead")
    expect(getMissionClassification(f.deps.db, id)?.protocol).toBe("ensemble-task-v1")
  })
  test("expired admission leases resume and malformed classifier results remain unclaimable", async () => {
    const f = fixture()
    const id = await team(f)
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "retry", priority: "medium" }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    f.deps.db.run("UPDATE team_task SET classification_status = 'running', classification_until = 0, classification_token = 'old'")
    f.deps.classifier!.invoke = async () => ({ answers: {} })
    await classifyBoardTasks(f.deps, id)
    expect(f.deps.db.query("SELECT classification_status FROM team_task").get()).toMatchObject({ classification_status: "blocked" })
    expect(pickNextTask(f.deps.db, id, "build")).toHaveLength(0)
  })
  test("a result for changed task data is discarded and the current task is re-evaluated", async () => {
    const f = fixture()
    const id = await team(f)
    let count = 0
    f.deps.classifier!.invoke = async () => {
      count++
      if (count === 1) f.deps.db.run("UPDATE team_task SET content = 'updated'")
      return { answers: { complexity: { type: "score", score: count === 1 ? 0.9 : 0.1 }, risk: { type: "score", score: 0.2 } } }
    }
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "old", priority: "medium" }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(count).toBe(2)
    const row = f.deps.db.query("SELECT classification_result FROM team_task").get() as { classification_result: string }
    expect(JSON.parse(row.classification_result)).toMatchObject({ complexity: 0.1 })
  })
  test("stale failures do not block updated task data", async () => {
    const f = fixture()
    const id = await team(f)
    let count = 0
    f.deps.classifier!.invoke = async () => {
      count++
      if (count === 1) { f.deps.db.run("UPDATE team_task SET content = 'updated'"); throw new Error("old input failed") }
      return { answers: { complexity: { type: "score", score: 0.1 }, risk: { type: "score", score: 0.2 } } }
    }
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "old", priority: "medium" }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(f.deps.db.query("SELECT classification_status FROM team_task").get()).toMatchObject({ classification_status: "completed" })
    expect(count).toBe(2)
  })
  test("large finite boards drain fully rather than stopping silently at 100 tasks", async () => {
    const f = fixture()
    const id = await team(f)
    await executeTeamTasksAdd(f.deps, { tasks: Array.from({ length: 101 }, (_, i) => ({ content: `task-${i}`, priority: "medium" })) }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(f.invocations).toHaveLength(101)
  })
  test("an archived mission cannot accept a late classification result", async () => {
    const f = fixture()
    const id = await team(f)
    f.deps.classifier!.invoke = async () => {
      f.deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", [id])
      return { answers: { complexity: { type: "score", score: 0.1 }, risk: { type: "score", score: 0.2 } } }
    }
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "old", priority: "medium" }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    expect(f.deps.db.query("SELECT classification_result FROM team_task").get()).toMatchObject({ classification_result: null })
  })
  test("scored task spawn uses normalized precision and rejects an unclassified claim before allocation", async () => {
    const f = fixture()
    const id = await team(f)
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "scored", priority: "medium" }] }, "lead")
    await classifyBoardTasks(f.deps, id)
    f.deps.config.modelRouting = { beta: 0.35, models: [{ id: "a/weak", intelligenceScore: 30, averageCostPerTask: 0, available: true }, { id: "b/strong", intelligenceScore: 54, averageCostPerTask: 1, available: true }] }
    const task = f.deps.db.query("SELECT id FROM team_task").get() as { id: string }
    await executeTeamSpawn(f.deps, { name: "worker", prompt: "work", worktree: false, claim_task: task.id }, "lead")
    const member = f.deps.db.query("SELECT model_routing FROM team_member").get() as { model_routing: string }
    expect(JSON.parse(member.model_routing).demand).toBe(0.48123 + 0.35 * 0.97234 * (1 - 0.48123))
    f.deps.db.run("UPDATE team_task SET status = 'pending', assignee = NULL, classification_status = 'pending' WHERE id = ?", [task.id])
    f.deps.client.calls.length = 0
    await expect(executeTeamSpawn(f.deps, { name: "second", prompt: "work", worktree: false, claim_task: task.id }, "lead")).rejects.toThrow("classification")
    expect(f.deps.client.calls).toHaveLength(0)
  })
})
