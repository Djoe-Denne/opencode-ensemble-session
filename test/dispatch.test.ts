import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, setupDb } from "./helpers"
import type { ToolDeps } from "../src/types"
import { pickNextTask, dispatchNextTask } from "../src/dispatch"

/** Insert a member with a specific agent type. */
function insertAgentMember(db: ReturnType<typeof setupDb>, teamId: string, name: string, sessionId: string, agent: string, status = "ready") {
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, spawn_pending, time_created, time_updated) VALUES (?, ?, ?, ?, ?, 'idle', 0, ?, ?)",
    [teamId, name, sessionId, agent, status, Date.now(), Date.now()]
  )
}

/** Insert a task row directly with full control over board fields. */
function insertTask(db: ReturnType<typeof setupDb>, teamId: string, id: string, opts: { priority?: string; agent?: string | null; status?: string; assignee?: string | null } = {}) {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, agent, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, teamId, `content of ${id}`, opts.status ?? "pending", opts.priority ?? "medium", opts.assignee ?? null, opts.agent ?? null, Date.now(), Date.now()]
  )
}

describe("pickNextTask", () => {
  let db: ReturnType<typeof setupDb>

  beforeEach(() => {
    db = setupDb()
    insertTeam(db, "t1", "my-team", "lead-sess")
  })

  test("returns only pending unassigned tasks", () => {
    insertTask(db, "t1", "task_1")
    insertTask(db, "t1", "task_2", { status: "in_progress", assignee: "alice" })
    insertTask(db, "t1", "task_3", { status: "completed" })
    insertTask(db, "t1", "task_4", { status: "blocked" })

    expect(pickNextTask(db, "t1", "build")).toEqual([{ id: "task_1", content: "content of task_1" }])
  })

  test("prefers exact agent affinity over unassigned tasks", () => {
    insertTask(db, "t1", "task_any", { priority: "high" })
    insertTask(db, "t1", "task_build", { priority: "low", agent: "build" })

    const picked = pickNextTask(db, "t1", "build")
    expect(picked[0]!.id).toBe("task_build")
  })

  test("never returns tasks reserved for another agent type", () => {
    insertTask(db, "t1", "task_plan", { agent: "plan" })
    expect(pickNextTask(db, "t1", "build")).toEqual([])
  })

  test("orders by priority, then FIFO", () => {
    insertTask(db, "t1", "task_low1", { priority: "low" })
    insertTask(db, "t1", "task_high", { priority: "high" })
    insertTask(db, "t1", "task_med", { priority: "medium" })
    insertTask(db, "t1", "task_low2", { priority: "low" })

    expect(pickNextTask(db, "t1", "build").map(t => t.id)).toEqual([
      "task_high", "task_med", "task_low1", "task_low2",
    ])
  })
})

describe("dispatchNextTask", () => {
  let deps: ToolDeps & { client: { calls: Array<{ method: string; args: unknown[] }> } }

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertAgentMember(deps.db, "t1", "alice", "sess-alice", "build")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("is a no-op when autoDispatch is off (default)", () => {
    insertTask(deps.db, "t1", "task_1")
    expect(dispatchNextTask(deps, "t1", "alice")).toBeNull()
    expect(deps.client.calls).toHaveLength(0)
    const row = deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task_1'").get() as { status: string; assignee: string | null }
    expect(row.status).toBe("pending")
    expect(row.assignee).toBeNull()
  })

  test("claims and delivers the next task to an idle member", () => {
    deps.config = { ...deps.config, autoDispatch: true }
    insertTask(deps.db, "t1", "task_1")

    expect(dispatchNextTask(deps, "t1", "alice")).toBe("task_1")

    const row = deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task_1'").get() as { status: string; assignee: string | null }
    expect(row.status).toBe("in_progress")
    expect(row.assignee).toBe("alice")

    const delivery = deps.client.calls.find((c: { method: string; args: unknown[] }) => c.method === "session.promptAsync")
    expect(delivery).toBeTruthy()
    const args = delivery!.args[0] as { sessionID: string; parts: Array<{ text: string }> }
    expect(args.sessionID).toBe("sess-alice")
    expect(args.parts[0]!.text).toContain("task_1")
    expect(args.parts[0]!.text).toContain("content of task_1")
  })

  test("skips a candidate lost to a race and claims the next one", () => {
    deps.config = { ...deps.config, autoDispatch: true }
    insertTask(deps.db, "t1", "task_1", { priority: "high" })
    insertTask(deps.db, "t1", "task_2", { priority: "medium" })
    // Simulate a concurrent claim of the highest-priority candidate.
    deps.db.run("UPDATE team_task SET status = 'in_progress', assignee = 'bob' WHERE id = 'task_1'")

    expect(dispatchNextTask(deps, "t1", "alice")).toBe("task_2")
  })

  test("releases the claim when delivery fails", async () => {
    deps.config = { ...deps.config, autoDispatch: true }
    insertTask(deps.db, "t1", "task_1")
    const depsWithFailingDelivery = {
      ...deps,
      client: {
        ...deps.client,
        session: { ...deps.client.session, promptAsync: async () => { throw new Error("transport down") } },
      },
    } as ToolDeps

    expect(dispatchNextTask(depsWithFailingDelivery, "t1", "alice")).toBe("task_1")
    await Promise.resolve()
    await Promise.resolve()

    const row = deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task_1'").get() as { status: string; assignee: string | null }
    expect(row.status).toBe("pending")
    expect(row.assignee).toBeNull()
  })

  test("is a no-op for a member that is not ready or still initializing", () => {
    deps.config = { ...deps.config, autoDispatch: true }
    insertTask(deps.db, "t1", "task_1")
    insertAgentMember(deps.db, "t1", "bob", "sess-bob", "build", "busy")
    deps.registry.register("t1", "bob", "sess-bob")
    deps.db.run("UPDATE team_member SET spawn_pending = 1 WHERE name = 'alice'")

    expect(dispatchNextTask(deps, "t1", "bob")).toBeNull()
    expect(dispatchNextTask(deps, "t1", "alice")).toBeNull()
    expect(deps.client.calls).toHaveLength(0)
  })

  test("is a no-op when the board has no eligible task", () => {
    deps.config = { ...deps.config, autoDispatch: true }
    expect(dispatchNextTask(deps, "t1", "alice")).toBeNull()
    expect(deps.client.calls).toHaveLength(0)
  })
})
