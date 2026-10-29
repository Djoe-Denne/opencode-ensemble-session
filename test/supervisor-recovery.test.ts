import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { setupDeps, insertMember, insertTeam } from "./helpers"
import { SupervisorRecovery } from "../src/supervisor-recovery"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { approveMission, openMissionConfiguration, prepareMission } from "../src/mission-policy"

const INTERVAL = 10 * 60 * 1000
const recoveries: SupervisorRecovery[] = []
const directories: string[] = []
afterEach(() => {
  recoveries.splice(0).forEach(recovery => recovery.stop())
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

async function longRunFixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-recovery-longrun-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { ...deps.config.modelRouting,
    models: [{ id: "fixture/worker", intelligenceScore: 60, averageCostPerTask: 1, available: true }] } }
  const mission = await prepareMission(deps, "lead", "Complete the approved long-run mission")
  const policy = JSON.parse(readFileSync(mission.policyPath, "utf8"))
  policy.autonomy = { mode: "long_run", instructions: ["Decide and continue autonomously."] }
  writeFileSync(mission.policyPath, JSON.stringify(policy))
  openMissionConfiguration(deps, mission.teamId, "lead")
  approveMission(deps, mission.teamId, "lead")
  deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('task', ?, 'Unfinished', 'pending', 'medium', 1, 1)", [mission.teamId])
  deps.client.session.status = async () => ({ data: {} })
  const recovery = new SupervisorRecovery({ db: deps.db, client: deps.client, projectId: deps.directory })
  recoveries.push(recovery)
  return { ...mission, deps, recovery, policy, wakes: () => deps.client.calls.filter(call => call.method === "session.promptAsync") }
}

function fixture() {
  const deps = setupDeps()
  insertTeam(deps.db, "team", "mission", "lead")
  deps.db.run("UPDATE team SET time_created = 1, time_updated = 1 WHERE id = 'team'")
  deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('task', 'team', 'Implement', 'pending', 'medium', 1, 1)")
  let time = INTERVAL + 10
  let native: Record<string, { type: string }> = {}
  deps.client.session.status = async () => ({ data: native })
  const make = () => {
    const recovery = new SupervisorRecovery({ db: deps.db, client: deps.client, projectId: "/tmp/test-project", now: () => time })
    recoveries.push(recovery)
    return recovery
  }
  const wakes = () => deps.client.calls.filter(call => call.method === "session.promptAsync")
  const messages = () => deps.db.query("SELECT content FROM team_message WHERE team_id = 'team' AND from_name = 'system' AND to_name = 'lead'").all() as Array<{ content: string }>
  return { deps, make, wakes, messages, advance: () => { time += INTERVAL + 1 }, active: (value: typeof native) => { native = value } }
}

describe("supervisor liveness recovery", () => {
  test("records skipped and attempted checks without changing mission progress", async () => {
    const f = await longRunFixture()
    const progress = f.deps.db.query("SELECT time_updated FROM team WHERE id = ?").get(f.teamId)
    f.deps.client.session.status = async () => ({ data: { lead: { type: "busy" } } })
    await f.recovery.check()
    const observation = () => f.deps.db.query("SELECT outcome, reason, checked_at FROM supervisor_recovery_observation WHERE team_id = ?").get(f.teamId)
    expect(observation()).toMatchObject({ outcome: "skipped", reason: "native_session_active" })
    f.deps.client.session.status = async () => ({ data: {} })
    await f.recovery.check()
    expect(observation()).toMatchObject({ outcome: "wake_attempted", reason: "idle_approved_long_run" })
    await f.recovery.check()
    expect(observation()).toMatchObject({ outcome: "skipped", reason: "wake_cooldown" })
    expect(f.deps.db.query("SELECT time_updated FROM team WHERE id = ?").get(f.teamId)).toEqual(progress)
  })

  test("startup uses approved autonomy even when the legacy mode disagrees", async () => {
    const f = await longRunFixture()
    f.deps.db.run("UPDATE team SET mission_mode = 'supervised' WHERE id = ?", [f.teamId])
    f.recovery.start()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.wakes()).toHaveLength(1)
  })

  test("invalid approved integrity cannot activate long-run recovery", async () => {
    const f = await longRunFixture()
    f.deps.db.run("UPDATE mission_policy_revision SET policy_hash = 'invalid' WHERE team_id = ?", [f.teamId])
    await f.recovery.check()
    expect(f.wakes()).toHaveLength(0)
    expect(f.deps.db.query("SELECT reason FROM supervisor_recovery_observation WHERE team_id = ?").get(f.teamId)).toEqual({ reason: "approved_policy_invalid" })
  })

  test("legacy classification mode alone does not enable long-run exclusions", async () => {
    const f = fixture()
    f.deps.db.run("UPDATE team SET mission_mode = 'long_run'")
    f.deps.db.run("UPDATE team_task SET status = 'blocked'")
    await f.make().check()
    expect(f.wakes()).toHaveLength(0)
  })

  test.each(["blocked", "attention", "critical", "completed-board", "empty-board", "stale-spawn", "draft-changed", "recent"])("approved long run wakes an idle unfinished mission despite %s", async scenario => {
    const f = await longRunFixture()
    if (scenario === "blocked") f.deps.db.run("UPDATE team_task SET status = 'blocked' WHERE team_id = ?", [f.teamId])
    if (scenario === "attention" || scenario === "critical") f.deps.db.run("UPDATE team SET mission_state = ? WHERE id = ?", [scenario, f.teamId])
    if (scenario === "completed-board") f.deps.db.run("UPDATE team_task SET status = 'completed' WHERE team_id = ?", [f.teamId])
    if (scenario === "empty-board") f.deps.db.run("DELETE FROM team_task WHERE team_id = ?", [f.teamId])
    if (scenario === "stale-spawn") {
      insertMember(f.deps.db, f.teamId, "worker", "worker-session")
      f.deps.db.run("UPDATE team_member SET spawn_pending = 1 WHERE team_id = ?", [f.teamId])
    }
    if (scenario === "draft-changed") writeFileSync(f.policyPath, JSON.stringify({ ...f.policy, startingIntelligence: 55 }))
    await f.recovery.check()
    expect(f.wakes()).toHaveLength(1)
    expect(f.deps.client.calls.some(call => call.method === "session.create" || call.method === "session.abort")).toBe(false)
    expect(f.deps.db.query("SELECT mission_state FROM team WHERE id = ?").get(f.teamId)).toEqual({ mission_state: scenario === "attention" || scenario === "critical" ? scenario : "running" })
  })

  test("long-run pending permission does not suppress supervisor diagnosis", async () => {
    const f = await longRunFixture()
    const recovery = new SupervisorRecovery({ db: f.deps.db, client: f.deps.client, projectId: f.deps.directory, hasPendingPermission: async () => true })
    recoveries.push(recovery)
    await recovery.check()
    expect(f.wakes()).toHaveLength(1)
  })

  test("long-run permission inspection failure does not suppress an otherwise safe wake", async () => {
    const f = await longRunFixture()
    const recovery = new SupervisorRecovery({ db: f.deps.db, client: f.deps.client, projectId: f.deps.directory, hasPendingPermission: async () => { throw new Error("permission lookup failed") } })
    recoveries.push(recovery)
    await recovery.check()
    expect(f.wakes()).toHaveLength(1)
  })

  test("long run still respects active workers and archived projects or teams", async () => {
    const f = await longRunFixture()
    f.deps.client.session.status = async () => ({ data: { lead: { type: "busy" } } })
    await f.recovery.check()
    expect(f.wakes()).toHaveLength(0)
    f.deps.client.session.status = async () => ({ data: {} })
    f.deps.db.run("UPDATE project SET status = 'archived' WHERE id = ?", [f.deps.directory])
    await f.recovery.check()
    expect(f.wakes()).toHaveLength(0)
    f.deps.db.run("UPDATE project SET status = 'active' WHERE id = ?", [f.deps.directory])
    f.deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", [f.teamId])
    await f.recovery.check()
    expect(f.wakes()).toHaveLength(0)
  })

  test("persists one diagnostic and wakes the idle lead when no worker is active", async () => {
    const f = fixture()
    await f.make().check()
    expect(f.messages()).toHaveLength(1)
    expect(f.messages()[0]!.content).toContain("No worker or supervisor is active")
    expect(f.messages()[0]!.content).toContain("Do not bypass")
    expect(f.wakes()).toHaveLength(1)
    expect(f.wakes()[0]!.args[0]).toMatchObject({ sessionID: "lead", synthetic: true })
    expect(f.deps.db.query("SELECT status FROM team_task WHERE id = 'task'").get()).toEqual({ status: "pending" })
    expect(f.deps.client.calls.some(call => call.method === "session.abort" || call.method === "session.create")).toBe(false)
  })

  test.each(["busy", "retry", "unknown"])("does nothing if the lead is %s", async type => {
    const f = fixture()
    f.active({ lead: { type } })
    await f.make().check()
    expect(f.wakes()).toHaveLength(0)
    expect(f.messages()).toHaveLength(0)
  })

  test("native worker activity wins over stale idle database state", async () => {
    const f = fixture()
    insertMember(f.deps.db, "team", "worker", "worker-session")
    f.deps.db.run("UPDATE team_member SET status = 'ready', time_updated = 1")
    f.active({ "worker-session": { type: "busy" } })
    await f.make().check()
    expect(f.wakes()).toHaveLength(0)
  })

  test("stale database busy state does not hide a truly inactive worker", async () => {
    const f = fixture()
    insertMember(f.deps.db, "team", "worker", "worker-session")
    f.deps.db.run("UPDATE team_member SET status = 'busy', time_updated = 1, time_created = 1, report_started_at = 1")
    await f.make().check()
    expect(f.wakes()).toHaveLength(1)
  })

  test("a native classification helper or a worker being initialized prevents recovery", async () => {
    const f = fixture()
    f.deps.db.run("INSERT INTO classification_helper (session_id, team_id, task_id, lease_until) VALUES ('helper', 'team', 'task', ?)", [10 * INTERVAL])
    f.active({ helper: { type: "busy" } })
    await f.make().check()
    expect(f.wakes()).toHaveLength(0)
    f.active({})
    insertMember(f.deps.db, "team", "worker", "worker-session")
    f.deps.db.run("UPDATE team_member SET spawn_pending = 1, time_updated = 1")
    await f.make().check()
    expect(f.wakes()).toHaveLength(0)
  })

  test.each(["archived", "critical", "attention", "draft", "completed", "blocked", "recent", "other-project"])("skips %s missions", async state => {
    const f = fixture()
    if (state === "archived") f.deps.db.run("UPDATE team SET status = 'archived'")
    if (state === "critical" || state === "attention") f.deps.db.run("UPDATE team SET mission_state = ?", [state])
    if (state === "draft") f.deps.db.run("INSERT INTO mission_policy (team_id, objective, policy_path, time_updated) VALUES ('team', 'Implement', 'unused.json', 1)")
    if (state === "completed" || state === "blocked") f.deps.db.run("UPDATE team_task SET status = ?", [state])
    if (state === "recent") f.deps.db.run("UPDATE team_task SET time_updated = ?", [INTERVAL])
    if (state === "other-project") {
      f.deps.db.run("INSERT INTO project (id, name, path, time_created, time_updated) VALUES ('other', 'Other', '/other', 1, 1)")
      f.deps.db.run("UPDATE team SET project_id = 'other'")
    }
    await f.make().check()
    expect(f.wakes()).toHaveLength(0)
  })

  test("an unread worker report still needs lead review even when board tasks are completed", async () => {
    const f = fixture()
    f.deps.db.run("UPDATE team_task SET status = 'completed'")
    f.deps.db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES ('report', 'team', 'worker', 'lead', 'Result to review', 0, 1)")
    await f.make().check()
    expect(f.wakes()).toHaveLength(1)
  })

  test("deduplicates diagnostics across instances but retries a still-idle supervisor on the next ten-minute tick", async () => {
    const f = fixture()
    const a = f.make()
    const b = f.make()
    await Promise.all([a.check(), a.check(), b.check()])
    f.advance()
    await f.make().check()
    expect(f.messages()).toHaveLength(1)
    expect(f.wakes()).toHaveLength(2)
    f.deps.db.run("UPDATE team_task SET content = 'New work', time_updated = time_updated + 1")
    f.advance()
    await b.check()
    expect(f.messages()).toHaveLength(2)
    expect(f.wakes()).toHaveLength(3)
  })

  test("a failed wake is retried after ten minutes without duplicating the diagnostic", async () => {
    const f = fixture()
    let attempts = 0
    f.deps.client.session.promptAsync = async () => { attempts++; if (attempts === 1) throw new Error("temporary transport failure"); return {} }
    const recovery = f.make()
    await recovery.check()
    await recovery.check()
    expect(attempts).toBe(1)
    f.advance()
    await f.make().check()
    expect(attempts).toBe(2)
    expect(f.messages()).toHaveLength(1)
  })

  test("never waits for promptAsync delivery", async () => {
    const f = fixture()
    f.deps.client.session.promptAsync = () => new Promise(() => {})
    await f.make().check()
    expect(f.messages()).toHaveLength(1)
  })

  test("unknown or failed native status is not evidence of an idle team", async () => {
    const f = fixture()
    f.deps.client.session.status = async () => ({})
    await f.make().check()
    expect(f.wakes()).toHaveLength(0)
    f.deps.client.session.status = async () => { throw new Error("native status unavailable") }
    await f.make().check()
    expect(f.wakes()).toHaveLength(0)
  })

  test.each(["pending", "unavailable"])("does not wake past a %s native permission check", async state => {
    const f = fixture()
    const recovery = new SupervisorRecovery({ db: f.deps.db, client: f.deps.client, projectId: "/tmp/test-project", now: () => INTERVAL + 10,
      hasPendingPermission: async sessions => {
        expect(sessions).toContain("lead")
        if (state === "unavailable") throw new Error("permission service unavailable")
        return true
      } })
    recoveries.push(recovery)
    await recovery.check()
    expect(f.wakes()).toHaveLength(0)
  })

  test("rechecks native activity immediately before waking to avoid racing a resumed lead", async () => {
    const f = fixture()
    let reads = 0
    f.deps.client.session.status = async () => {
      const data: Record<string, { type: string }> = ++reads === 1 ? {} : { lead: { type: "busy" } }
      return { data }
    }
    await f.make().check()
    expect(reads).toBe(2)
    expect(f.wakes()).toHaveLength(0)
  })

  test("stopping during a status lookup prevents a later wake", async () => {
    const f = fixture()
    let resolve!: (value: { data: Record<string, { type: string }> }) => void
    f.deps.client.session.status = () => new Promise(done => { resolve = done })
    const recovery = f.make()
    const checking = recovery.check()
    recovery.stop()
    resolve({ data: {} })
    await checking
    expect(f.wakes()).toHaveLength(0)
  })

  test("starts one ten-minute timer and stops it cleanly", () => {
    const f = fixture()
    const interval = spyOn(globalThis, "setInterval")
    const clear = spyOn(globalThis, "clearInterval")
    try {
      const recovery = f.make()
      recovery.start()
      recovery.start()
      expect(interval).toHaveBeenCalledTimes(1)
      expect(interval.mock.calls[0]![1]).toBe(INTERVAL)
      recovery.stop()
      expect(clear).toHaveBeenCalledTimes(1)
    } finally {
      interval.mockRestore()
      clear.mockRestore()
    }
  })
})
