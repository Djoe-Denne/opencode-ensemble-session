import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { closeMission } from "../src/mission-close"
import { SupervisorRecovery } from "../src/supervisor-recovery"

function fixture() {
  const deps = setupDeps()
  insertTeam(deps.db, "team", "done", "lead")
  deps.db.run("INSERT INTO mission_policy (team_id, objective, policy_path, approved_hash, approved_json, revision, time_updated) VALUES ('team', 'Deliver', 'unchanged.json', 'immutable-hash', '{}', 1, 1)")
  deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('task', 'team', 'Done', 'completed', 'medium', 1, 1)")
  insertMember(deps.db, "team", "worker", "worker-session", "shutdown", "completed")
  deps.registry.register("team", "worker", "worker-session")
  return deps
}

describe("conservative mission closure", () => {
  test("archives without touching dirty files, branches, tasks, members or policy", async () => {
    const deps = fixture()
    const dir = mkdtempSync(join(tmpdir(), "ensemble-close-preserve-"))
    try {
      const file = join(dir, "user-profile.md")
      writeFileSync(file, "uncommitted user content\n")
      deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = 'checkout', preserved_branch = 'safety' WHERE team_id = 'team'", [dir])
      const before = deps.db.query("SELECT * FROM team_member").all()
      const tasks = deps.db.query("SELECT * FROM team_task").all()
      const policy = deps.db.query("SELECT * FROM mission_policy").all()
      let restored = false
      deps.syncMissionPermissions = async (team, restore) => { expect(team).toBe("team"); expect(restore).toBe(true); restored = true }
      expect(await closeMission(deps, "lead")).toEqual({ teamId: "team", alreadyClosed: false })
      expect(deps.db.query("SELECT status FROM team").get()).toEqual({ status: "archived" })
      expect(deps.db.query("SELECT * FROM team_member").all()).toEqual(before)
      expect(deps.db.query("SELECT * FROM team_task").all()).toEqual(tasks)
      expect(deps.db.query("SELECT * FROM mission_policy").all()).toEqual(policy)
      expect(readFileSync(file, "utf8")).toBe("uncommitted user content\n")
      expect(restored).toBe(true)
      expect(deps.registry.getBySession("worker-session")).toBeUndefined()
      expect(deps.client.calls.map(call => call.method)).toEqual(["session.status"])
      expect(await closeMission(deps, "lead")).toEqual({ teamId: "team", alreadyClosed: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test.each(["pending", "blocked", "in_progress", "cancelled"])("refuses unfinished/unaccepted task %s", async status => {
    const deps = fixture()
    deps.db.run("UPDATE team_task SET status = ?", [status])
    await expect(closeMission(deps, "lead")).rejects.toThrow("completed")
    expect(deps.db.query("SELECT status FROM team").get()).toEqual({ status: "active" })
    expect(deps.client.calls).toHaveLength(0)
  })

  test.each(["ready", "busy", "shutdown_requested"])("refuses a %s member", async status => {
    const deps = fixture()
    deps.db.run("UPDATE team_member SET status = ?", [status])
    await expect(closeMission(deps, "lead")).rejects.toThrow("stopped")
  })

  test("refuses a pending admission, running execution or classifier helper", async () => {
    for (const update of [
      "UPDATE team_member SET spawn_pending = 1",
      "UPDATE team_member SET execution_status = 'running'",
      "INSERT INTO classification_helper (session_id, team_id, task_id, lease_until) VALUES ('helper', 'team', 'task', 1)",
    ]) {
      const deps = fixture()
      deps.db.run(update)
      await expect(closeMission(deps, "lead")).rejects.toThrow()
      expect(deps.db.query("SELECT status FROM team").get()).toEqual({ status: "active" })
    }
  })

  test("refuses nonlead, wrong project, unapproved mission and unknown native status", async () => {
    const deps = fixture()
    await expect(closeMission(deps, "worker-session")).rejects.toThrow("lead")
    deps.directory = "/unrelated"
    await expect(closeMission(deps, "lead")).rejects.toThrow("lead")
    deps.directory = "/tmp/test-project"
    deps.db.run("UPDATE mission_policy SET approved_hash = NULL")
    await expect(closeMission(deps, "lead")).rejects.toThrow("approved")
    deps.db.run("UPDATE mission_policy SET approved_hash = 'immutable-hash'")
    deps.client.session.status = async () => ({})
    await expect(closeMission(deps, "lead")).rejects.toThrow("native")
    expect(deps.db.query("SELECT status FROM team").get()).toEqual({ status: "active" })
  })

  test("refuses unfinished preparation and unread reviewer results without altering history", async () => {
    const deps = fixture()
    deps.db.run("INSERT INTO preparation_run (id, team_id, session_id, agent, model_id, mandate, status, attempts, time_created, time_updated) VALUES ('prep', 'team', 'pm-session', 'pm', 'fixture/model', 'Plan', 'running', 0, 1, 1)")
    await expect(closeMission(deps, "lead")).rejects.toThrow("Preparation")
    deps.db.run("UPDATE preparation_run SET status = 'imported'")
    deps.db.run("INSERT INTO member_result (id, team_id, member_name, session_id, native_message_id, task_ids, content, report_generation, time_created, read, superseded) VALUES ('review', 'team', 'worker', 'worker-session', 'message', '[]', 'Review me', 0, 1, 0, 0)")
    await expect(closeMission(deps, "lead")).rejects.toThrow("Unread")
    expect(deps.db.query("SELECT read FROM member_result").get()).toEqual({ read: 0 })
    expect(deps.db.query("SELECT status FROM team").get()).toEqual({ status: "active" })
  })

  test("ignores the executing lead but refuses an actually busy stopped member", async () => {
    const deps = fixture()
    deps.client.session.status = async () => ({ data: { lead: { type: "busy" }, "worker-session": { type: "busy" } } })
    await expect(closeMission(deps, "lead")).rejects.toThrow("native")
    deps.client.session.status = async () => ({ data: { lead: { type: "busy" } } })
    await expect(closeMission(deps, "lead")).resolves.toMatchObject({ alreadyClosed: false })
  })

  test("rechecks admission after the native await before committing", async () => {
    const deps = fixture()
    deps.client.session.status = async () => {
      deps.db.run("UPDATE team_task SET status = 'pending'")
      return { data: {} }
    }
    await expect(closeMission(deps, "lead")).rejects.toThrow("completed")
    expect(deps.db.query("SELECT status FROM team").get()).toEqual({ status: "active" })
  })

  test("permission restoration failure is reported and safely retryable after archive", async () => {
    const deps = fixture()
    deps.syncMissionPermissions = async () => { throw new Error("native write failed") }
    await expect(closeMission(deps, "lead")).rejects.toThrow("restoration")
    expect(deps.db.query("SELECT status FROM team").get()).toEqual({ status: "archived" })
    deps.syncMissionPermissions = async () => {}
    await expect(closeMission(deps, "lead")).resolves.toEqual({ teamId: "team", alreadyClosed: true })
  })

  test("stops supervisor recovery without resetting mission safety state", async () => {
    const deps = fixture()
    deps.db.run("UPDATE team SET mission_state = 'critical'")
    await closeMission(deps, "lead")
    const recovery = new SupervisorRecovery({ db: deps.db, client: deps.client, projectId: deps.directory })
    try { await recovery.check() } finally { recovery.stop() }
    expect(deps.db.query("SELECT mission_state FROM team").get()).toEqual({ mission_state: "critical" })
    expect(deps.client.calls.some(call => call.method === "session.promptAsync")).toBe(false)
  })
})
