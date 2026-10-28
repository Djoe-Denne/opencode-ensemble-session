import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setupDeps, insertMember } from "./helpers"
import { parsePreparationDocument } from "../src/preparation-document"
import { importPreparationDocument } from "../src/preparation-import"
import { prepareMission, openMissionConfiguration, approveMission } from "../src/mission-policy"
import { pumpTeam, pickNextTask } from "../src/dispatch"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { claimTask } from "../src/tools/team-claim"
import { executeTeamHandoff } from "../src/tools/team-handoff"
import { recoverFinalResponse } from "../src/member-report"
import { executeTeamResults } from "../src/tools/team-results"
import { executeTeamTasksComplete } from "../src/tools/team-tasks-complete"
import { executeTeamTasksList } from "../src/tools/team-tasks-list"
import { Database } from "bun:sqlite"
import { MIGRATIONS, applyMigrations } from "../src/schema"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function task(overrides: Record<string, unknown> = {}) {
  return { id: "qa", title: "Qualify restrictive QA", type: "research", goal: "Read the local contract and return the QA plan.", dependsOn: [],
    planning: { required: true, reason: "Establish the verification plan before authors." },
    acceptanceCriteria: ["A local read and a received final candidate are observed."], verification: ["Inspect the native session and result."],
    handoff: { document: "Read contract.md; do not write or run commands.", sources: [{ path: "contract.md", note: "Accepted contract." }] },
    agent: "qa-planner", context: { mode: "fresh" }, complexity: 66, risk: 76, worktree: false, report_mode: "final_response", ...overrides }
}

function document(tasks = [task()]) {
  return { version: 2, readiness: { status: "ready", reasons: [], missingInformation: [] }, tooling: { catalogue: "verified", unavailable: [] },
    context: "The QA candidate must be accepted before authors start.", openQuestions: [], tasks, parallelGroups: [] }
}

async function fixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-admission-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, autoDispatch: true, autoScale: true, modelRouting: { beta: 0.35, models: [
    { id: "fixture/worker", reasoningEffort: "high", intelligenceScore: 55, averageCostPerTask: 2, available: true },
  ] } }
  deps.nativeModels = async () => [{ id: "fixture/worker", variant: "high" }]
  const transitions: unknown[] = []
  deps.client.session.switchModel = async value => { transitions.push(value) }
  deps.client.continuity = { fork: async () => { throw new Error("unused") }, move: async () => {}, compact: async () => {}, remove: async () => {},
    switchAgent: async value => { transitions.push(value) } }
  const mission = await prepareMission(deps, "lead", "Prepared OpenGL access")
  return { deps, transitions, ...mission }
}

describe("prepared task admission contract", () => {
  test("imports deferred audit and lead acceptance without publishing or admitting them", async () => {
    const { deps, teamId } = await fixture()
    const raw = document([task({ publication: "deferred", completion_policy: "lead" })])
    expect(parsePreparationDocument(raw).tasks[0]).toMatchObject({ publication: "deferred", completion_policy: "lead" })
    const result = importPreparationDocument(deps.db, teamId, raw)
    expect(deps.db.query("SELECT publication,completion_policy FROM team_task WHERE id=?").get(result.mapping[0]!.taskId)).toEqual({ publication: "deferred", completion_policy: "lead" })
    expect(importPreparationDocument(deps.db, teamId, raw).mapping).toEqual(result.mapping)
    openMissionConfiguration(deps, teamId, "lead")
    approveMission(deps, teamId, "lead")
    await pumpTeam(deps, teamId)
    expect(deps.client.calls.filter(call => call.method === "session.create")).toHaveLength(0)
    deps.config = { ...deps.config, autoScale: false, autoDispatch: false }
    await executeTeamTasksAdd(deps, { tasks: [], task_controls: [{ task_id: result.mapping[0]!.taskId, publication: "published", reason: "Release prepared audit" }] }, "lead")
    expect(importPreparationDocument(deps.db, teamId, raw).mapping).toEqual(result.mapping)
    expect(deps.db.query("SELECT publication FROM team_task WHERE id=?").get(result.mapping[0]!.taskId)).toEqual({ publication: "published" })
  })

  test.each([{ publication: "cancelled" }, { completion_policy: "anyone" }])("rejects malformed preparation publication: %j", override => {
    expect(() => parsePreparationDocument(document([task(override)]))).toThrow()
  })

  test("publishing an independent audit preserves its fresh native reporting contract", async () => {
    const { deps, teamId } = await fixture()
    deps.config = { ...deps.config, autoScale: false, autoDispatch: false }
    const imported = importPreparationDocument(deps.db, teamId, document([task({ publication: "deferred", completion_policy: "lead" })]))
    await executeTeamTasksAdd(deps, { tasks: [], task_controls: [{ task_id: imported.mapping[0]!.taskId, publication: "published", reason: "Independent briefing qualified" }] }, "lead")
    deps.config = { ...deps.config, autoScale: true }
    await pumpTeam(deps, teamId)
    expect(deps.client.calls.filter(call => call.method === "session.create")).toHaveLength(0)
    openMissionConfiguration(deps, teamId, "lead")
    approveMission(deps, teamId, "lead")
    await pumpTeam(deps, teamId)
    expect(deps.db.query("SELECT agent,context_mode,report_mode,worktree_dir FROM team_member WHERE team_id=?").get(teamId)).toEqual({
      agent: "qa-planner", context_mode: "fresh", report_mode: "final_response", worktree_dir: null,
    })
    expect(deps.client.calls.find(call => call.method === "session.create")!.args[0]).toHaveProperty("permission", [])
  })

  test("parses scores, isolation and reporting, preserving explicit false", () => {
    expect(parsePreparationDocument(document()).tasks[0]).toMatchObject({ complexity: 66, risk: 76, worktree: false, report_mode: "final_response" })
  })

  test("migration 29 preserves existing rows and leaves legacy defaults unset", () => {
    const db = new Database(":memory:")
    MIGRATIONS.slice(0, 28).forEach(sql => db.exec(sql))
    db.exec("PRAGMA user_version=28")
    db.run("INSERT INTO team (id,name,lead_session_id,time_created,time_updated) VALUES ('old','old','lead',1,1)")
    db.run("INSERT INTO team_task (id,team_id,content,status,complexity,risk,time_created,time_updated) VALUES ('old-task','old','Keep me','pending',70,80,1,1)")
    applyMigrations(db)
    applyMigrations(db)
    expect(db.query("SELECT id,content,complexity,risk,spawn_options FROM team_task").get()).toEqual({ id: "old-task", content: "Keep me", complexity: 70, risk: 80, spawn_options: null })
    db.close()
  })

  test("a separate-worktrees group cannot include worktree:false", () => {
    const raw = { ...document(), parallelGroups: [{ taskIds: ["qa"], reason: "Read independently", integrationNotes: "Review findings", isolation: "separate-worktrees" }] }
    expect(() => parsePreparationDocument(raw)).toThrow(/worktree/)
  })

  test.each([{ complexity: -1 }, { risk: 1.5 }, { complexity: 101 }, { worktree: "false" }, { report_mode: "other" }])("rejects malformed admission fields atomically: %j", async override => {
    const { deps, teamId } = await fixture()
    expect(() => importPreparationDocument(deps.db, teamId, document([task(override)]))).toThrow()
    expect(deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
  })

  test("persists scores and spawn options before start, with canonical replay and no admission", async () => {
    const { deps, teamId } = await fixture()
    const raw = document()
    const result = importPreparationDocument(deps.db, teamId, raw)
    expect(deps.db.query("SELECT complexity,risk,spawn_options,spawn_context,agent FROM team_task WHERE id=?").get(result.mapping[0]!.taskId)).toEqual({
      complexity: 66, risk: 76, spawn_options: '{"worktree":false,"report_mode":"final_response"}', spawn_context: '{"mode":"fresh"}', agent: "qa-planner",
    })
    expect(importPreparationDocument(deps.db, teamId, raw).mapping).toEqual(result.mapping)
    await pumpTeam(deps, teamId)
    expect(deps.client.calls).toHaveLength(0)
    expect(() => importPreparationDocument(deps.db, teamId, document([task({ risk: 77 })]))).toThrow()
  })

  test("auto-scale preserves native restrictive permissions and recovers a candidate without releasing authors", async () => {
    const { deps, teamId, transitions } = await fixture()
    const raw = document([task(), task({ id: "author", title: "Author", type: "implementation", agent: "build", dependsOn: ["qa"], worktree: true, report_mode: "team_message", complexity: 75 })])
    const imported = importPreparationDocument(deps.db, teamId, raw)
    openMissionConfiguration(deps, teamId, "lead")
    approveMission(deps, teamId, "lead")
    await pumpTeam(deps, teamId)
    const member = deps.db.query("SELECT name,session_id,report_mode,worktree_dir,model_routing FROM team_member WHERE team_id=?").get(teamId) as { name: string; session_id: string; report_mode: string; worktree_dir: string | null; model_routing: string }
    expect(member).toMatchObject({ report_mode: "final_response", worktree_dir: null })
    expect(JSON.parse(member.model_routing)).toMatchObject({ complexity: 66, risk: 76 })
    expect(deps.client.calls.filter(call => call.method === "worktree.create")).toHaveLength(0)
    // An explicit empty override prevents inheriting the supervisor's grants.
    expect(deps.client.calls.find(call => call.method === "session.create")!.args[0]).toHaveProperty("permission", [])
    expect(JSON.stringify(transitions)).not.toContain('"permission"')
    const prompt = JSON.stringify(deps.client.calls.find(call => call.method === "session.promptAsync")!.args[0])
    expect(prompt).toContain("final response")
    expect(prompt).not.toContain('team_handoff({')
    expect(prompt).not.toContain("mark it complete with team_tasks_complete")
    deps.db.run("UPDATE team_member SET status='ready',spawn_pending=0 WHERE session_id=?", [member.session_id])
    deps.client.session.messages = async () => ({ data: [{ info: { id: "native-qa", role: "assistant", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 } }, parts: [{ type: "text", text: "Local contract read; QA plan for lead review." }] }] })
    expect(await recoverFinalResponse(deps.db, deps.client, teamId, member.name)).toBe(true)
    await executeTeamResults(deps, { from: member.name }, "lead")
    const authorId = imported.mapping[1]!.taskId
    expect(deps.db.query("SELECT status FROM team_task WHERE id=?").get(authorId)).toEqual({ status: "blocked" })
    await expect(executeTeamTasksComplete(deps, { task_id: imported.mapping[0]!.taskId }, member.session_id)).rejects.toThrow("lead")
    await executeTeamTasksComplete(deps, { task_id: imported.mapping[0]!.taskId }, "lead")
    expect(deps.db.query("SELECT status FROM team_task WHERE id=?").get(authorId)).not.toEqual({ status: "blocked" })
  })

  test("manual spawn cannot override recorded isolation or reporting before allocation", async () => {
    const { deps, teamId } = await fixture()
    const imported = importPreparationDocument(deps.db, teamId, document())
    openMissionConfiguration(deps, teamId, "lead")
    approveMission(deps, teamId, "lead")
    for (const override of [{ worktree: true }, { report_mode: "team_message" as const }]) {
      await expect(executeTeamSpawn(deps, { name: "conflict", prompt: "QA", claim_task: imported.mapping[0]!.taskId, ...override }, "lead")).rejects.toThrow(/contract|conflict/i)
    }
    expect(deps.client.calls).toHaveLength(0)
  })

  test("a changed admission contract during allocation rolls back before the first prompt", async () => {
    const { deps, teamId } = await fixture()
    const imported = importPreparationDocument(deps.db, teamId, document())
    const taskId = imported.mapping[0]!.taskId
    openMissionConfiguration(deps, teamId, "lead")
    approveMission(deps, teamId, "lead")
    const create = deps.client.session.create.bind(deps.client.session)
    deps.client.session.create = async input => {
      const result = await create(input)
      deps.db.run("UPDATE team_task SET spawn_options=? WHERE id=?", ['{"worktree":true,"report_mode":"final_response"}', taskId])
      return result
    }
    await expect(executeTeamSpawn(deps, { name: "raced", prompt: "QA", claim_task: taskId }, "lead")).rejects.toThrow(/contract changed/)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(1)
    expect(deps.db.query("SELECT status,assignee FROM team_task WHERE id=?").get(taskId)).toEqual({ status: "pending", assignee: null })
  })

  test("board options without explicit context still require a new matching session", async () => {
    const { deps, teamId } = await fixture()
    deps.config.autoScale = false
    await executeTeamTasksAdd(deps, { tasks: [{ content: "Native QA", priority: "medium", agent: "qa-planner", worktree: false, report_mode: "final_response", complexity: 66, risk: 76 }] }, "lead")
    const row = deps.db.query("SELECT id,spawn_options FROM team_task").get() as { id: string; spawn_options: string }
    expect(JSON.parse(row.spawn_options)).toEqual({ worktree: false, report_mode: "final_response" })
    expect(await executeTeamTasksList(deps, "lead")).toContain('[admission:{"worktree":false,"report_mode":"final_response"}]')
    openMissionConfiguration(deps, teamId, "lead")
    approveMission(deps, teamId, "lead")
    insertMember(deps.db, teamId, "old", "old-session")
    deps.db.run("UPDATE team_member SET agent='qa-planner' WHERE name='old'")
    expect(pickNextTask(deps.db, teamId, "qa-planner")).toHaveLength(0)
    expect(() => claimTask(deps.db, teamId, row.id, "old")).toThrow(/new session/)
    await executeTeamSpawn(deps, { name: "new", prompt: "Read and report", claim_task: row.id }, "lead")
    expect(deps.db.query("SELECT agent,report_mode,worktree_dir FROM team_member WHERE name='new'").get()).toEqual({ agent: "qa-planner", report_mode: "final_response", worktree_dir: null })
    await expect(executeTeamHandoff(deps, { phase: "implementation", reasoning: "high" }, (deps.db.query("SELECT session_id FROM team_member WHERE name='new'").get() as { session_id: string }).session_id)).rejects.toThrow(/final.response|candidate/i)
  })

  test("rejects invalid board options before writing any task", async () => {
    const { deps } = await fixture()
    await expect(executeTeamTasksAdd(deps, { tasks: [{ content: "Invalid", priority: "medium", worktree: "false" as unknown as boolean }] }, "lead")).rejects.toThrow(/worktree/)
    expect(deps.db.query("SELECT COUNT(*) AS c FROM team_task").get()).toEqual({ c: 0 })
  })
})
