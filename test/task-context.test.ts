import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { insertMember, insertTeam, setupDeps } from "./helpers"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { executeTeamTasksList } from "../src/tools/team-tasks-list"
import { executeTeamClaim } from "../src/tools/team-claim"
import { executeTeamSpawn, spawnFailures } from "../src/tools/team-spawn"
import { dispatchNextTask, pumpTeam } from "../src/dispatch"
import type { SpawnContext } from "../src/types"
import { Database } from "bun:sqlite"
import { applyMigrations, MIGRATIONS } from "../src/schema"

describe("task context admission", () => {
  let deps: ReturnType<typeof setupDeps>
  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "context-team", "context-team", "lead-session")
    insertMember(deps.db, "context-team", "old-worker", "old-session")
    deps.registry.register("context-team", "old-worker", "old-session")
    spawnFailures.clear()
  })
  afterEach(() => deps.db.close())

  async function add(context: unknown, agent = "build") {
    await executeTeamTasksAdd(deps, { tasks: [{ content: "Independent QA", priority: "high", agent, context }] } as Parameters<typeof executeTeamTasksAdd>[1], "lead-session")
    return (deps.db.query("SELECT id FROM team_task ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id
  }

  test("persists fresh before pumping and never dispatches it to the old worker", async () => {
    deps.config = { ...deps.config, autoDispatch: true }
    const id = await add({ mode: "fresh" })
    expect(deps.db.query("SELECT * FROM team_task WHERE id=?").get(id)).toMatchObject({ status: "pending", assignee: null, spawn_context: '{"mode":"fresh"}' })
    expect(dispatchNextTask(deps, "context-team", "old-worker")).toBeNull()
    expect(await executeTeamTasksList(deps, "lead-session")).toContain('[context:{"mode":"fresh"}]')
  })

  test("manual claims cannot bypass a task's new-session requirement", async () => {
    const id = await add({ mode: "fresh" })
    await expect(executeTeamClaim(deps, { task_id: id }, "old-session")).rejects.toThrow(/new session/i)
    await expect(executeTeamClaim(deps, { task_id: id }, "lead-session")).rejects.toThrow(/new session/i)
  })

  test("pool creates a new worker even when an idle matching worker exists", async () => {
    const id = await add({ mode: "fresh" })
    deps.config = { ...deps.config, autoDispatch: true, autoScale: true, maxActiveMembers: 2 }
    await pumpTeam(deps, "context-team")
    expect(deps.db.query("SELECT assignee FROM team_task WHERE id=?").get(id)).toEqual({ assignee: "pool-1" })
    expect(deps.client.calls.filter(call => call.method === "session.create")).toHaveLength(1)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync").some(call => (call.args[0] as { sessionID: string }).sessionID === "old-session")).toBe(false)
    deps.db.run("UPDATE team_task SET status='pending', assignee=NULL WHERE id=?", [id])
    const member = deps.db.query("SELECT session_id FROM team_member WHERE name='pool-1'").get() as { session_id: string }
    await expect(executeTeamClaim(deps, { task_id: id }, member.session_id)).rejects.toThrow(/new session/i)
  })

  test("cap or disabled scaling leaves fresh tasks pending without reusing anyone", async () => {
    const id = await add({ mode: "fresh" })
    deps.config = { ...deps.config, autoDispatch: true, autoScale: true, maxActiveMembers: 1 }
    await pumpTeam(deps, "context-team")
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id=?").get(id)).toEqual({ status: "pending", assignee: null })
    expect(deps.client.calls).toHaveLength(0)
  })

  test.each(["fork", "checkpoint", "compact_fork"] as const)("pool honors %s source and boundary", async mode => {
    const calls: Array<{ sessionID: string; before?: string }> = []
    let compactions = 0
    deps.client.continuity = {
      fork: async input => { calls.push(input); return { id: "inherited-child" } },
      move: async () => {}, switchAgent: async () => {}, remove: async () => {},
      compact: async () => { compactions++ },
    }
    deps.client.session.get = async ({ sessionID }) => ({ data: { id: sessionID, agent: "build", location: { directory: deps.directory } } })
    const context: SpawnContext = { mode, from: "old-worker", ...(mode === "checkpoint" ? { messageID: "msg_boundary" } : {}) }
    const id = await add(context)
    deps.config = { ...deps.config, autoDispatch: true, autoScale: true }
    await pumpTeam(deps, "context-team")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ sessionID: "old-session", ...(mode === "checkpoint" ? { before: "msg_boundary" } : {}) })
    expect(compactions).toBe(mode === "compact_fork" ? 1 : 0)
    expect(deps.db.query("SELECT assignee FROM team_task WHERE id=?").get(id)).toEqual({ assignee: "pool-1" })
    expect(deps.client.calls.some(call => call.method === "session.create")).toBe(false)
  })

  test("explicit spawn inherits the task contract and rejects context/profile overrides before allocation", async () => {
    const id = await add({ mode: "fresh" }, "general")
    await expect(executeTeamSpawn(deps, { name: "wrong", agent: "build", prompt: "QA", claim_task: id }, "lead-session")).rejects.toThrow(/profile/i)
    await expect(executeTeamSpawn(deps, { name: "wrong", agent: "general", prompt: "QA", claim_task: id, context: { mode: "fork", from: "old-worker" } }, "lead-session")).rejects.toThrow(/context/i)
    expect(deps.client.calls).toHaveLength(0)
    await executeTeamSpawn(deps, { name: "new-qa", prompt: "QA", claim_task: id, worktree: false }, "lead-session")
    expect(deps.db.query("SELECT agent FROM team_member WHERE name='new-qa'").get()).toEqual({ agent: "general" })
    expect(deps.db.query("SELECT assignee FROM team_task WHERE id=?").get(id)).toEqual({ assignee: "new-qa" })
  })

  test("unavailable inheritance never falls back to fresh or an old worker", async () => {
    const id = await add({ mode: "fork", from: "old-worker" })
    deps.config = { ...deps.config, autoDispatch: true, autoScale: true }
    await pumpTeam(deps, "context-team")
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id=?").get(id)).toEqual({ status: "pending", assignee: null })
    expect(deps.client.calls).toHaveLength(0)
  })

  test.each([null, { mode: "unknown" }, { mode: "checkpoint" }, { mode: "fresh", from: "lead" }, { mode: "fork", extra: true }])("invalid context %j rejects the whole batch", async context => {
    await expect(add(context)).rejects.toThrow(/context|checkpoint|fresh/i)
    expect(deps.db.query("SELECT COUNT(*) AS n FROM team_task").get()).toEqual({ n: 0 })
  })

  test("current is frozen to the creator rather than the future dispatcher", async () => {
    await executeTeamTasksAdd(deps, { tasks: [{ content: "Fork my work", priority: "medium", context: { mode: "fork" } }] } as Parameters<typeof executeTeamTasksAdd>[1], "old-session")
    expect(deps.db.query("SELECT * FROM team_task").get()).toMatchObject({ spawn_context: '{"mode":"fork","from":"old-session"}' })
  })

  test("a malformed later task rolls back the whole batch before dispatch", async () => {
    deps.config = { ...deps.config, autoDispatch: true }
    await expect(executeTeamTasksAdd(deps, { tasks: [
      { content: "valid", priority: "medium" },
      { content: "invalid", priority: "medium", context: { mode: "checkpoint" } },
    ] }, "lead-session")).rejects.toThrow(/checkpoint/)
    expect(deps.db.query("SELECT COUNT(*) AS n FROM team_task").get()).toEqual({ n: 0 })
    expect(deps.client.calls).toHaveLength(0)
  })

  test("competing fresh spawns admit only one session and never deliver unclaimed work", async () => {
    const id = await add({ mode: "fresh" })
    const results = await Promise.allSettled(["first", "second"].map(name => executeTeamSpawn(deps, { name, prompt: "QA", claim_task: id, worktree: false }, "lead-session")))
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
    expect(deps.db.query("SELECT COUNT(*) AS n FROM team_member WHERE name IN ('first','second')").get()).toEqual({ n: 1 })
  })

  test("migration preserves old tasks and sessions without inventing a context requirement", () => {
    const db = new Database(":memory:")
    try {
      MIGRATIONS.slice(0, 27).forEach(migration => db.exec(migration))
      db.exec("PRAGMA user_version=27")
      insertTeam(db, "old-team", "old-team", "old-lead")
      insertMember(db, "old-team", "worker", "old-member-session")
      db.run("INSERT INTO team_task (id,team_id,content,status,priority,time_created,time_updated) VALUES ('old-task','old-team','Existing work','pending','medium',1,1)")
      applyMigrations(db)
      applyMigrations(db)
      expect(db.query("SELECT id, content, spawn_context FROM team_task").get()).toEqual({ id: "old-task", content: "Existing work", spawn_context: null })
      expect(db.query("SELECT session_id, context_task_id FROM team_member").get()).toEqual({ session_id: "old-member-session", context_task_id: null })
    } finally { db.close() }
  })
})
