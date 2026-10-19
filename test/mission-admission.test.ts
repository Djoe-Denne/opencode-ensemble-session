import { describe, expect, test } from "bun:test"
import { insertMember, insertTeam, setupDeps } from "./helpers"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { claimTask } from "../src/tools/team-claim"
import { executeTeamMessage } from "../src/tools/team-message"
import { pumpTeam } from "../src/dispatch"

function draft() {
  const deps = setupDeps()
  insertTeam(deps.db, "mission", "draft", "lead")
  deps.db.run("INSERT INTO mission_policy (team_id, objective, policy_path, time_updated) VALUES ('mission', 'Fix cache', 'not-read-before-approval.json', ?)", [Date.now()])
  deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, complexity, risk, time_created, time_updated) VALUES ('task', 'mission', 'Fix cache', 'pending', 'medium', 20, 10, ?, ?)", [Date.now(), Date.now()])
  insertMember(deps.db, "mission", "worker", "worker-session")
  deps.registry.register("mission", "worker", "worker-session")
  return deps
}

describe("draft mission admission", () => {
  test("refuses explicit-model spawning before any resource is allocated", async () => {
    const deps = draft()
    await expect(executeTeamSpawn(deps, { name: "unapproved", prompt: "Bypass draft", model: "other/model", worktree: false }, "lead")).rejects.toThrow("approved")
    expect(deps.client.calls).toHaveLength(0)
    expect(deps.db.query("SELECT name FROM team_member WHERE name = 'unapproved'").get()).toBeNull()
  })

  test("refuses direct claims without consuming the task", () => {
    const deps = draft()
    expect(() => claimTask(deps.db, "mission", "task", "worker")).toThrow("approved")
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task'").get()).toEqual({ status: "pending", assignee: null })
  })

  test("auto-dispatch and auto-scale cannot start tasks published before approval", async () => {
    const deps = draft()
    deps.config = { ...deps.config, autoDispatch: true, autoScale: true, maxActiveMembers: 3 }
    await pumpTeam(deps, "mission")
    expect(deps.client.calls).toHaveLength(0)
    expect(deps.db.query("SELECT status FROM team_task WHERE id = 'task'").get()).toEqual({ status: "pending" })
  })

  test("team_message cannot replace policy-controlled models or classifier settings", async () => {
    const deps = draft()
    await expect(executeTeamMessage(deps, { to: "worker", model: "other/model" }, "lead")).rejects.toThrow("mission policy")
    await expect(executeTeamMessage(deps, { to: "lead", classification: { mode: "off" } }, "lead")).rejects.toThrow("mission policy")
    expect(deps.client.calls).toHaveLength(0)
  })
})
