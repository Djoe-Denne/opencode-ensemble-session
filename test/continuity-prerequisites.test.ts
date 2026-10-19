import { describe, expect, test } from "bun:test"
import { createV2Client } from "../src/v2-client"
import { executeTeamSpawn, spawnFailures } from "../src/tools/team-spawn"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { insertTeam, setupDeps } from "./helpers"

describe("session continuity prerequisites (upstream #41)", () => {
  test("V2 creation works after removal of permission.rules", async () => {
    const client = createV2Client({
      session: { create: async () => ({ id: "ses_new" }) },
      permission: {},
    } as never)
    expect((await client.session.create({ permission: [] })).data?.id).toBe("ses_new")
  })

  test("fresh writer spawn fails closed instead of using a shared directory", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "pr41", "pr41", "lead")
    spawnFailures.clear()
    deps.client.worktree.create = async () => { throw new Error("missing strategy") }
    try {
      await expect(executeTeamSpawn(deps, { name: "builder", prompt: "Build" }, "lead")).rejects.toThrow(/admission failed/i)
      expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
    } finally { deps.db.close() }
  })

  test.each(["missing", "other-team-task"])("rejects %s dependency before inserting a batch", async (dependency) => {
    const deps = setupDeps()
    insertTeam(deps.db, "pr41", "pr41", "lead")
    insertTeam(deps.db, "other", "other", "other-lead")
    deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('other-team-task', 'other', 'x', 'pending', 'medium', 0, 0)")
    try {
      await expect(executeTeamTasksAdd(deps, { tasks: [
        { content: "valid", priority: "medium" },
        { content: "invalid", priority: "medium", depends_on: [dependency] },
      ] }, "lead")).rejects.toThrow(dependency)
      expect(deps.db.query("SELECT id FROM team_task WHERE team_id = 'pr41'").all()).toHaveLength(0)
    } finally { deps.db.close() }
  })
})
