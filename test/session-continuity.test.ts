import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { executeTeamSpawn, spawnFailures } from "../src/tools/team-spawn"
import { executeTeamHandoff } from "../src/tools/team-handoff"
import { recoverSessionContinuity, resolveSpawnContext } from "../src/session-continuity"
import { insertMember, insertTeam, setupDeps } from "./helpers"
import type { SpawnContext } from "../src/types"
import { rehydrateRegistry } from "../src/recovery"
import { MemberRegistry } from "../src/state"
import { shouldNudgeIdleMember } from "../src/hooks"

describe("Ensemble session continuity", () => {
  let deps: ReturnType<typeof setupDeps>
  let calls: string[]
  let fail: string | undefined
  let counter: number
  let agents: Map<string, string>
  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "continuity", "continuity", "ses_lead")
    insertMember(deps.db, "continuity", "scout", "ses_scout")
    calls = []
    fail = undefined
    counter = 0
    agents = new Map([["ses_scout", "explore"], ["ses_lead", "build"]])
    spawnFailures.clear()
    const step = (name: string) => { calls.push(name); if (fail === name) throw new Error(`${name} failed`) }
    deps.client.continuity = {
      fork: async ({ sessionID, before }) => { step(`fork:${sessionID}:${before ?? "all"}`); const id = `ses_child${++counter}`; agents.set(id, "explore"); return { id } },
      switchAgent: async ({ sessionID, agent }) => { step("switchAgent"); if (agent === "unknown") throw new Error("Unknown agent"); agents.set(sessionID, agent) },
      move: async () => { step("move") },
      compact: async () => { step("compact") },
      remove: async ({ sessionID }) => { step("remove"); agents.delete(sessionID) },
    }
    deps.client.session.get = async ({ sessionID }) => {
      if (!agents.has(sessionID)) throw new Error("Session not found")
      return { data: { id: sessionID, agent: agents.get(sessionID), location: { directory: deps.directory } } }
    }
  })
  afterEach(() => deps.db.close())

  const spawn = (context?: SpawnContext, extra: Record<string, unknown> = {}) => executeTeamSpawn(deps, {
    name: "builder", agent: "build", prompt: "Implement just the parser", context, ...extra,
  } as Parameters<typeof executeTeamSpawn>[1], "ses_lead")

  test("omitted and explicit fresh context retain session.create", async () => {
    await spawn()
    await spawn({ mode: "fresh" }, { name: "reviewer", agent: "explore" })
    expect(calls).toEqual([])
    expect(deps.client.calls.filter(c => c.method === "session.create")).toHaveLength(2)
  })
  test("fork from scout switches agent, moves, persists provenance and sends only task delta", async () => {
    await spawn({ mode: "fork", from: "scout" })
    expect(calls).toEqual(["fork:ses_scout:all", "move", "switchAgent"])
    const member = deps.db.query("SELECT * FROM team_member WHERE name = 'builder'").get()
    expect(member).toMatchObject({ session_id: "ses_child1", source_session_id: "ses_scout", context_mode: "fork", spawn_pending: 0 })
    expect(deps.client.calls.some(c => c.method === "session.create")).toBe(false)
    const prompt = deps.client.calls.find(c => c.method === "session.promptAsync")?.args[0]
    expect(JSON.stringify(prompt)).toContain("Implement just the parser")
    expect(JSON.stringify(prompt)).toContain("inherited")
  })
  test("checkpoint passes the exclusive native message boundary", async () => {
    await spawn({ mode: "checkpoint", from: "scout", messageID: "msg_C" })
    expect(calls[0]).toBe("fork:ses_scout:msg_C")
  })
  test("restricted forks and handoffs do not reinstate Ensemble tool grants", async () => {
    const permissions: unknown[] = []
    const switchAgent = deps.client.continuity!.switchAgent
    deps.client.continuity!.switchAgent = async (options, signal) => {
      permissions.push(options.permission)
      await switchAgent(options, signal)
    }
    await spawn({ mode: "fork", from: "scout" }, { report_mode: "final_response", worktree: false })
    expect(permissions).toEqual([[]])
    await executeTeamHandoff(deps, { agent: "qa" }, "ses_child1")
    expect(permissions).toEqual([[], []])
  })
  test("compact_fork completes compaction before forking an idle member", async () => {
    await spawn({ mode: "compact_fork", from: "scout" })
    expect(calls.slice(0, 2)).toEqual(["compact", "fork:ses_scout:all"])
  })
  test("compact_fork refuses its own active tool session rather than deadlocking", async () => {
    await expect(spawn({ mode: "compact_fork" })).rejects.toThrow("current")
    expect(calls).toHaveLength(0)
  })
  test("source member may be finished but its native session must still exist", async () => {
    deps.db.run("UPDATE team_member SET status = 'shutdown' WHERE name = 'scout'")
    await spawn({ mode: "fork", from: "scout" })
    expect(calls[0]).toBe("fork:ses_scout:all")
  })
  test("three forks retain unique native identities", async () => {
    for (const name of ["parser", "renderer", "tests"]) await spawn({ mode: "fork", from: "scout" }, { name })
    expect(new Set((deps.db.query("SELECT session_id FROM team_member WHERE name != 'scout'").all() as Array<{ session_id: string }>).map(m => m.session_id)).size).toBe(3)
  })
  test.each(["fork:ses_scout:all", "switchAgent", "move"])("rolls back on %s failure", async (failure) => {
    fail = failure
    await expect(spawn({ mode: "fork", from: "scout" })).rejects.toThrow("failed")
    expect(deps.db.query("SELECT name FROM team_member WHERE name = 'builder'").get()).toBeNull()
    expect(agents.size).toBe(2)
    expect(deps.client.calls.some(c => c.method === "session.promptAsync")).toBe(false)
  })
  test("worktree failure after fork fails closed and removes the child", async () => {
    deps.client.worktree.create = async () => { throw new Error("worktree failed") }
    await expect(spawn({ mode: "fork", from: "scout" })).rejects.toThrow("worktree failed")
    expect(agents.size).toBe(2)
    expect(calls).toContain("remove")
  })
  test("compaction failure creates no child or worktree", async () => {
    fail = "compact"
    await expect(spawn({ mode: "compact_fork", from: "scout" })).rejects.toThrow("compact failed")
    expect(counter).toBe(0)
    expect(deps.client.calls.some(c => c.method === "worktree.create")).toBe(false)
  })
  test("unknown agent rolls back the fork", async () => {
    await expect(spawn({ mode: "fork", from: "scout" }, { agent: "unknown" })).rejects.toThrow("Unknown agent")
    expect(agents.size).toBe(2)
  })
  test("missing native source is rejected", async () => {
    agents.delete("ses_scout")
    await expect(spawn({ mode: "fork", from: "scout" })).rejects.toThrow("Session not found")
    expect(counter).toBe(0)
  })
  test.each([
    { mode: "checkpoint" }, { mode: "fork", messageID: "msg_C" },
    { mode: "fresh", from: "scout" }, { mode: "fork", from: "missing" },
    { mode: "fork", from: "ses_unrelated" }, { mode: "wrong" },
  ])("rejects invalid or cross-team context %j", context => {
    expect(() => resolveSpawnContext(deps, context as SpawnContext, "continuity", "ses_lead")).toThrow()
  })
  test("V1 refuses inheritance explicitly without creating a fresh replacement", async () => {
    delete deps.client.continuity
    await expect(spawn({ mode: "fork" })).rejects.toThrow("V2")
    expect(deps.client.calls).toHaveLength(0)
  })
  test("initial prompt failure removes inherited session, worktree and member", async () => {
    deps.client.session.promptAsync = async () => { throw new Error("admission failed") }
    await spawn({ mode: "fork", from: "scout" })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(agents.size).toBe(2)
    expect(deps.db.query("SELECT name FROM team_member WHERE name = 'builder'").get()).toBeNull()
    expect(deps.client.calls.some(c => c.method === "worktree.remove")).toBe(true)
  })
  test("same-session handoff persists target agent without spawn/prompt/interrupt", async () => {
    const result = await executeTeamHandoff(deps, { agent: "architect" }, "ses_scout")
    expect(result).toContain("ses_scout")
    expect(calls).toEqual(["switchAgent"])
    expect(deps.db.query("SELECT agent FROM team_member WHERE name = 'scout'").get()).toEqual({ agent: "architect" })
    expect(deps.client.calls).toHaveLength(0)
  })
  test.each(["ses_lead", "ses_scout"])("overlapping handoffs in %s cannot overwrite the pending role", async sessionID => {
    const gate = Promise.withResolvers<void>()
    const switchAgent = deps.client.continuity!.switchAgent
    deps.client.continuity!.switchAgent = async (input, signal) => {
      await gate.promise
      return switchAgent(input, signal)
    }
    const first = executeTeamHandoff(deps, { agent: "architect" }, sessionID)
    try {
      const second = executeTeamHandoff(deps, { agent: "reviewer" }, sessionID)
      gate.resolve()
      await expect(second).rejects.toThrow("handoff is already pending")
    } finally {
      gate.resolve()
      await first
    }
    expect(agents.get(sessionID)).toBe("architect")
  })
  test("fork model rotation counts existing members just like fresh spawn", async () => {
    deps.config.modelAssignment = "rotate"
    deps.config.modelPool = ["fixture/first", "fixture/second", "fixture/third"]
    await spawn({ mode: "fork", from: "scout" })
    expect(deps.db.query("SELECT model FROM team_member WHERE name = 'builder'").get()).toEqual({ model: "fixture/second" })
  })
  test.each([1, 2])("source still being initialized in phase %i cannot be forked", async phase => {
    deps.db.run("UPDATE team_member SET spawn_pending = ? WHERE name = 'scout'", [phase])
    await expect(spawn({ mode: "fork", from: "scout" })).rejects.toThrow("initializing")
    expect(counter).toBe(0)
  })
  test("failed handoff keeps the actual agent", async () => {
    fail = "switchAgent"
    await expect(executeTeamHandoff(deps, { agent: "architect" }, "ses_scout")).rejects.toThrow("switchAgent failed")
    expect(agents.get("ses_scout")).toBe("explore")
  })
  test("interrupted handoff reconciles native truth after the switch committed", async () => {
    deps.client.continuity!.switchAgent = async ({ sessionID, agent }) => { agents.set(sessionID, agent); throw new Error("Interrupted") }
    await expect(executeTeamHandoff(deps, { agent: "architect" }, "ses_scout")).rejects.toThrow("Interrupted")
    expect(deps.db.query("SELECT agent FROM team_member WHERE name = 'scout'").get()).toEqual({ agent: "architect" })
  })
  test("recovery removes pending forks and preserves completed provenance", async () => {
    await spawn({ mode: "fork", from: "scout" })
    await recoverSessionContinuity(deps)
    expect(deps.db.query("SELECT context_mode FROM team_member WHERE name = 'builder'").get()).toEqual({ context_mode: "fork" })
    deps.db.run("UPDATE team_member SET spawn_pending = 1 WHERE name = 'builder'")
    await recoverSessionContinuity(deps)
    expect(deps.db.query("SELECT name FROM team_member WHERE name = 'builder'").get()).toBeNull()
    expect(agents.size).toBe(2)
  })
  test("worktree plugin activation cannot wake a fork before task admission", async () => {
    await spawn({ mode: "fork", from: "scout" })
    deps.db.run("UPDATE team_member SET spawn_pending = 1, status = 'ready' WHERE name = 'builder'")
    const newInstance = new MemberRegistry()
    rehydrateRegistry(deps.db, newInstance)
    expect(newInstance.getBySession("ses_child1")).toBeUndefined()
    expect(shouldNudgeIdleMember(deps.db, "continuity", "builder")).toBe(false)
  })
  test("fresh rollback preserves a worktree branch before abort", async () => {
    deps.preserveBranch = async () => { calls.push("preserve"); return true }
    deps.client.session.abort = async () => { calls.push("abort") }
    deps.client.session.promptAsync = async () => { throw new Error("admission failed") }
    await spawn()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toEqual(["preserve", "abort"])
  })
  test("failed cleanup keeps native resource references for the next recovery", async () => {
    await spawn({ mode: "fork", from: "scout" })
    deps.db.run("UPDATE team_member SET spawn_pending = 1 WHERE name = 'builder'")
    fail = "remove"
    await recoverSessionContinuity(deps)
    expect(deps.db.query("SELECT status, spawn_pending, session_id FROM team_member WHERE name = 'builder'").get()).toEqual({ status: "error", spawn_pending: 1, session_id: "ses_child1" })
    fail = undefined
    await recoverSessionContinuity(deps)
    expect(deps.db.query("SELECT name FROM team_member WHERE name = 'builder'").get()).toBeNull()
  })
  test("recovery adopts a native prompt admitted just before a crash instead of deleting its work", async () => {
    await spawn({ mode: "fork", from: "scout" })
    const prompt = deps.client.calls.find(call => call.method === "session.promptAsync")!.args[0] as { metadata?: unknown }
    expect(prompt.metadata).toBeDefined()
    deps.db.run("UPDATE team_member SET spawn_pending = 1 WHERE name = 'builder'")
    deps.client.session.messages = async () => ({ data: [{ metadata: prompt.metadata }] as never })
    await recoverSessionContinuity(deps)
    expect(deps.db.query("SELECT spawn_pending FROM team_member WHERE name = 'builder'").get()).toEqual({ spawn_pending: 0 })
    expect(agents.has("ses_child1")).toBe(true)
  })
  test("forks do not unblock a task with unfinished dependencies", async () => {
    deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, depends_on, time_created, time_updated) VALUES ('blocked', 'continuity', 'wait', 'blocked', 'medium', '[\"upstream\"]', 0, 0)")
    await expect(spawn({ mode: "fork", from: "scout" }, { claim_task: "blocked" })).rejects.toThrow("claim")
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'blocked'").get()).toEqual({ status: "blocked", assignee: null })
    expect(deps.db.query("SELECT name FROM team_member WHERE name = 'builder'").get()).toBeNull()
  })
  test("handoff without a team or V2 capability fails explicitly", async () => {
    await expect(executeTeamHandoff(deps, { agent: "build" }, "ses_outside")).rejects.toThrow("team")
    delete deps.client.continuity
    await expect(executeTeamHandoff(deps, { agent: "build" }, "ses_scout")).rejects.toThrow("V2")
  })
})
