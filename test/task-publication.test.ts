import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { setupDeps, insertMember, insertTeam } from "./helpers"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { executeTeamTasksList } from "../src/tools/team-tasks-list"
import { executeTeamTasksComplete } from "../src/tools/team-tasks-complete"
import { claimTask } from "../src/tools/team-claim"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { dispatchNextTask, pickNextTask, pumpTeam } from "../src/dispatch"
import { buildTeamCompactionContext } from "../src/system-prompt"
import { executeTeamStatus, lastCallTime, lastKnownState } from "../src/tools/team-status"
import { Database } from "bun:sqlite"
import { applyMigrations, MIGRATIONS } from "../src/schema"

describe("task publication and integration gates", () => {
  let deps: ReturnType<typeof setupDeps>
  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t", "publication", "lead")
    insertMember(deps.db, "t", "alice", "worker")
    deps.registry.register("t", "alice", "worker")
    lastCallTime.clear()
    lastKnownState.clear()
  })
  afterEach(() => { deps.db.close() })

  const add = async (content: string, extra: Record<string, unknown> = {}) => {
    const args = { tasks: [{ content, priority: "medium" as const, ...extra }] }
    await executeTeamTasksAdd(deps, args, "lead")
    return (deps.db.query("SELECT id FROM team_task WHERE content=?").get(content) as { id: string }).id
  }
  const control = (taskId: string, fields: Record<string, unknown>, session = "lead") => {
    const args = { tasks: [], task_controls: [{ task_id: taskId, reason: "Reviewed publication boundary", ...fields }] }
    return executeTeamTasksAdd(deps, args, session)
  }

  test("deferred audit stays private and cannot be dispatched, claimed, spawned or completed", async () => {
    const id = await add("SECRET independent audit", { publication: "deferred", context: { mode: "fresh" }, report_mode: "final_response", worktree: false })
    expect(await executeTeamTasksList(deps, "lead")).toContain("[publication:deferred]")
    expect(await executeTeamTasksList(deps, "worker")).not.toContain("SECRET")
    expect(pickNextTask(deps.db, "t", "build")).toEqual([])
    expect(() => claimTask(deps.db, "t", id, "alice")).toThrow(/unavailable|deferred|not found/)
    await expect(executeTeamTasksComplete(deps, { task_id: id }, "lead")).rejects.toThrow(/deferred|publish/)
    await expect(executeTeamTasksComplete(deps, { task_id: id }, "worker")).rejects.toThrow(/unavailable|not found/)
    await expect(executeTeamSpawn(deps, { name: "audit", prompt: "audit", claim_task: id, worktree: false }, "lead")).rejects.toThrow(/deferred|publish/)
    deps.config = { ...deps.config, autoScale: true }
    await pumpTeam(deps, "t")
    expect(deps.client.calls.filter(call => call.method === "session.create")).toHaveLength(0)
    expect(buildTeamCompactionContext(deps.db, "t", "member", "alice")).toContain("0 pending")
    expect(await executeTeamStatus(deps, "worker")).not.toContain("1 pending")
  })

  test("deferral is reversible, preserves dependencies and never cancels or completes work", async () => {
    const producer = await add("Producer")
    const consumer = await add("Consumer", { depends_on: [producer] })
    await control(producer, { publication: "deferred" })
    expect(await executeTeamTasksList(deps, "worker")).not.toContain("Producer")
    expect(deps.db.query("SELECT status,depends_on FROM team_task WHERE id=?").get(consumer)).toEqual({ status: "blocked", depends_on: JSON.stringify([producer]) })
    await control(producer, { publication: "published" })
    expect(pickNextTask(deps.db, "t", "build").map(task => task.id)).toContain(producer)
    expect(deps.db.query("SELECT status FROM team_task WHERE id=?").get(consumer)).toEqual({ status: "blocked" })
    expect(deps.db.query("SELECT COUNT(*) AS n FROM task_control_event WHERE task_id=?").get(producer)).toEqual({ n: 2 })
  })

  test("lead completion policy prevents the author from releasing consumers", async () => {
    const producer = await add("Integration-gated producer", { completion_policy: "lead" })
    const consumer = await add("After integration", { depends_on: [producer] })
    claimTask(deps.db, "t", producer, "alice")
    await expect(executeTeamTasksComplete(deps, { task_id: producer }, "worker")).rejects.toThrow(/lead/)
    expect(deps.db.query("SELECT status FROM team_task WHERE id=?").get(consumer)).toEqual({ status: "blocked" })
    await executeTeamTasksComplete(deps, { task_id: producer }, "lead")
    expect(deps.db.query("SELECT status FROM team_task WHERE id=?").get(consumer)).toEqual({ status: "pending" })
  })

  test("only the lead can defer or set completion gates, including at creation", async () => {
    const id = await add("Visible")
    await expect(control(id, { publication: "deferred" }, "worker")).rejects.toThrow(/lead/)
    const args = { tasks: [{ content: "Private", priority: "medium" as const, publication: "deferred" as const }] }
    await expect(executeTeamTasksAdd(deps, args, "worker")).rejects.toThrow(/lead/)
  })

  test("controls reject admitted and classifying tasks without partially changing the board", async () => {
    const first = await add("First")
    const admitted = await add("Admitted")
    claimTask(deps.db, "t", admitted, "alice")
    const args = { tasks: [{ content: "Must not be added", priority: "medium" as const }], task_controls: [
      { task_id: first, publication: "deferred" as const, reason: "Hold" },
      { task_id: admitted, publication: "deferred" as const, reason: "Hold" },
    ] }
    await expect(executeTeamTasksAdd(deps, args, "lead")).rejects.toThrow(/admi|assign/)
    expect(await executeTeamTasksList(deps, "worker")).toContain("First")
    expect(await executeTeamTasksList(deps, "lead")).not.toContain("Must not be added")
    expect(deps.db.query("SELECT COUNT(*) AS n FROM task_control_event").get()).toEqual({ n: 0 })
    deps.db.run("UPDATE team_task SET status='pending',assignee=NULL WHERE id=?", [admitted])
    await expect(control(admitted, { publication: "deferred" })).rejects.toThrow(/admi/)
    deps.db.run("UPDATE team_task SET classification_status='running' WHERE id=?", [first])
    await expect(control(first, { publication: "deferred" })).rejects.toThrow(/classif/)
  })

  test("migration 30 preserves old tasks and records known prior admission without opting into gates", () => {
    const db = new Database(":memory:")
    try {
      MIGRATIONS.slice(0, 29).forEach(sql => db.exec(sql))
      db.exec("PRAGMA user_version=29")
      insertTeam(db, "old", "old", "old-lead")
      db.run("INSERT INTO team_task (id,team_id,content,status,assignee,time_created,time_updated) VALUES ('waiting','old','Keep waiting','pending',NULL,1,2),('working','old','Keep working','in_progress','author',1,3)")
      applyMigrations(db)
      applyMigrations(db)
      expect(db.query("SELECT id,content,status,publication,completion_policy,admitted_at FROM team_task ORDER BY id").all()).toEqual([
        { id: "waiting", content: "Keep waiting", status: "pending", publication: "published", completion_policy: "assignee", admitted_at: null },
        { id: "working", content: "Keep working", status: "in_progress", publication: "published", completion_policy: "assignee", admitted_at: 3 },
      ])
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      expect(() => db.run("UPDATE team_task SET publication='cancelled'")).toThrow()
    } finally { db.close() }
  })

  test("hidden task IDs cannot be used by a member as dependency existence probes", async () => {
    const secret = await add("Hidden", { publication: "deferred" })
    await expect(executeTeamTasksAdd(deps, { tasks: [{ content: "Probe", priority: "medium", depends_on: [secret] }] }, "worker")).rejects.toThrow(/Unknown/)
    expect(deps.db.query("SELECT COUNT(*) AS n FROM team_task WHERE content='Probe'").get()).toEqual({ n: 0 })
  })

  test("lead and member status reads do not share visibility-sensitive throttle state", async () => {
    await add("Private status", { publication: "deferred" })
    expect(await executeTeamStatus(deps, "lead")).toContain("1 total")
    const member = await executeTeamStatus(deps, "worker")
    expect(member).toContain("you are the member")
    expect(member).not.toContain("1 total")
  })

  test("deferred consumers remain private even after their producer is accepted", async () => {
    const producer = await add("Accepted producer", { completion_policy: "lead" })
    const consumer = await add("Hidden consumer", { publication: "deferred", depends_on: [producer] })
    await executeTeamTasksComplete(deps, { task_id: producer }, "lead")
    expect(deps.db.query("SELECT status,publication FROM team_task WHERE id=?").get(consumer)).toEqual({ status: "pending", publication: "deferred" })
    expect(pickNextTask(deps.db, "t", "build")).toEqual([])
    expect(await executeTeamTasksList(deps, "worker")).not.toContain("Hidden consumer")
    await control(consumer, { publication: "published" })
    expect(pickNextTask(deps.db, "t", "build").map(task => task.id)).toEqual([consumer])
  })

  test("an author's completion response does not reveal deferred consumer counts", async () => {
    const producer = await add("Public producer")
    const consumer = await add("Private downstream", { publication: "deferred", depends_on: [producer] })
    claimTask(deps.db, "t", producer, "alice")
    const result = await executeTeamTasksComplete(deps, { task_id: producer }, "worker")
    expect(result).not.toContain("Unblocked")
    expect(deps.db.query("SELECT status,publication FROM team_task WHERE id=?").get(consumer)).toEqual({ status: "pending", publication: "deferred" })
  })

  test("a deferral during spawn allocation rolls back before any prompt", async () => {
    const id = await add("Allocation race")
    const create = deps.client.session.create
    deps.client.session.create = async options => {
      await control(id, { publication: "deferred" })
      return create(options)
    }
    await expect(executeTeamSpawn(deps, { name: "racer", prompt: "do not deliver", claim_task: id, worktree: false }, "lead")).rejects.toThrow(/changed|deferred/)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
    expect(deps.db.query("SELECT status,assignee FROM team_task WHERE id=?").get(id)).toEqual({ status: "pending", assignee: null })
  })

  test("a legacy read-only spawn cannot leave a dispatched task eligible for deferral", async () => {
    const id = await add("Read-only dispatch")
    await executeTeamSpawn(deps, { name: "reader", agent: "explore", prompt: "Read independently", claim_task: id }, "lead")
    await expect(control(id, { publication: "deferred" })).rejects.toThrow(/admi/)
  })

  test("auto-dispatch and spawn tell gated authors to report, not complete their task", async () => {
    const id = await add("Gated dispatch", { completion_policy: "lead" })
    deps.config = { ...deps.config, autoDispatch: true }
    expect(dispatchNextTask(deps, "t", "alice")).toBe(id)
    const dispatched = JSON.stringify(deps.client.calls.find(call => call.method === "session.promptAsync")?.args)
    expect(dispatched).not.toContain("When done, mark it complete")
    expect(dispatched).toContain("lead")
    deps.config = { ...deps.config, autoDispatch: false }
    const spawned = await add("Gated spawn", { completion_policy: "lead" })
    await executeTeamSpawn(deps, { name: "writer", prompt: "work", claim_task: spawned, worktree: false }, "lead")
    const prompt = JSON.stringify(deps.client.calls.filter(call => call.method === "session.promptAsync").at(-1)?.args)
    expect(prompt).not.toContain("mark it complete using team_tasks_complete")
  })

  test("rejects malformed or empty controls, duplicate IDs and missing justification", async () => {
    const id = await add("Validation")
    for (const fields of [{ publication: "cancelled" }, { completion_policy: "anyone" }, {}, { publication: "deferred", reason: "" }]) {
      await expect(control(id, fields)).rejects.toThrow()
    }
    const args = { tasks: [], task_controls: [
      { task_id: id, publication: "deferred" as const, reason: "Hold" },
      { task_id: id, publication: "published" as const, reason: "Release" },
    ] }
    await expect(executeTeamTasksAdd(deps, args, "lead")).rejects.toThrow(/Duplicate/)
  })
})
