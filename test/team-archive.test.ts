import { describe, expect, test } from "bun:test"
import { setupDb, insertTeam, insertMember } from "./helpers"
import { archiveTeam } from "../src/team-archive"

describe("archiveTeam", () => {
  test("preserves before abort, cancels open tasks, and leaves mission_state unchanged", async () => {
    const db = setupDb()
    insertTeam(db, "t1", "my-team", "lead")
    insertMember(db, "t1", "alice", "sess-alice", "ready", "idle")
    db.run("UPDATE team_member SET worktree_branch = 'ensemble-alice' WHERE name = 'alice'")
    db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('task', 't1', 'work', 'pending', 'medium', 0, 0)")
    const order: string[] = []
    await archiveTeam({
      db,
      teamId: "t1",
      directory: "/tmp/test-project",
      preserve: async () => {
        order.push("preserve")
        return true
      },
      abort: async () => {
        order.push("abort")
      },
      preservedName: () => "ensemble/preserved/alice",
    })
    expect(order).toEqual(["preserve", "abort"])
    expect(db.query("SELECT status, mission_state FROM team WHERE id = 't1'").get()).toEqual({ status: "archived", mission_state: "running" })
    expect(db.query("SELECT status FROM team_task WHERE id = 'task'").get()).toEqual({ status: "cancelled" })
    expect(db.query("SELECT status, worktree_branch, checkout_branch, preserved_branch FROM team_member WHERE name = 'alice'").get()).toEqual({
      status: "shutdown",
      worktree_branch: "ensemble-alice",
      checkout_branch: "ensemble-alice",
      preserved_branch: "ensemble/preserved/alice",
    })
    expect(db.query("SELECT id FROM team").all()).toHaveLength(1)
  })

  test("does not abort or archive when preservation fails", async () => {
    const db = setupDb()
    insertTeam(db, "t1", "my-team", "lead")
    insertMember(db, "t1", "alice", "sess-alice", "ready", "idle")
    db.run("UPDATE team_member SET worktree_branch = 'ensemble-alice' WHERE name = 'alice'")
    let aborted = false
    await expect(archiveTeam({
      db,
      teamId: "t1",
      directory: "/tmp/test-project",
      preserve: async () => false,
      abort: async () => { aborted = true },
      preservedName: () => "ensemble/preserved/alice",
    })).rejects.toThrow(/preserve/)
    expect(aborted).toBe(false)
    expect(db.query("SELECT status FROM team WHERE id = 't1'").get()).toEqual({ status: "active" })
    expect(db.query("SELECT status FROM team_member WHERE name = 'alice'").get()).toEqual({ status: "ready" })
  })
})
