import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { setupDeps, insertMember, insertTeam } from "./helpers"
import { SupervisorRecovery } from "../src/supervisor-recovery"

const INTERVAL = 10 * 60 * 1000
const recoveries: SupervisorRecovery[] = []
afterEach(() => recoveries.splice(0).forEach(recovery => recovery.stop()))

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
