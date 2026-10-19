import { describe, expect, test, spyOn } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { recoverFinalResponse, hasCurrentTaskReport } from "../src/member-report"
import { sendMessage, hasReportedCompletion } from "../src/messaging"
import { handleSessionStatusEvent, shouldNudgeIdleMember } from "../src/hooks"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { buildTeammateSystemPrompt, buildTeamCompactionContext } from "../src/system-prompt"
import { executeTeamTasksComplete } from "../src/tools/team-tasks-complete"
import { executeTeamResults } from "../src/tools/team-results"
import { dispatchNextTask } from "../src/dispatch"

const result = "<task-result><status>completed</status><summary>QA plan</summary><details>Regression cases</details></task-result>"

function fixture() {
  const deps = setupDeps()
  insertTeam(deps.db, "t", "report-test", "lead")
  insertMember(deps.db, "t", "qa", "worker")
  deps.registry.register("t", "qa", "worker")
  deps.client.session.messages = async () => ({ data: [{
    info: { id: "native-final", role: "assistant", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 } },
    parts: [{ type: "text", text: "QA plan to review" }],
  }] })
  return deps
}

describe("member report protocol", () => {
  test("a question is not a completion report", () => {
    const deps = fixture()
    handleSessionStatusEvent(deps.db, deps.registry, "worker", "busy")
    sendMessage(deps.db, { teamId: "t", from: "qa", to: "lead", content: "Which file?" })
    handleSessionStatusEvent(deps.db, deps.registry, "worker", "idle")
    expect(hasReportedCompletion(deps.db, "t", "qa")).toBe(false)
    expect(shouldNudgeIdleMember(deps.db, "t", "qa")).toBe(true)
  })

  test("a structured report belongs only to its current work period", () => {
    const deps = fixture()
    handleSessionStatusEvent(deps.db, deps.registry, "worker", "busy")
    sendMessage(deps.db, { teamId: "t", from: "qa", to: "lead", content: result })
    expect(hasCurrentTaskReport(deps.db, "t", "qa")).toBe(true)
    handleSessionStatusEvent(deps.db, deps.registry, "worker", "idle")
    expect(hasReportedCompletion(deps.db, "t", "qa")).toBe(true)
    handleSessionStatusEvent(deps.db, deps.registry, "worker", "busy")
    handleSessionStatusEvent(deps.db, deps.registry, "worker", "idle")
    expect(hasReportedCompletion(deps.db, "t", "qa")).toBe(false)
    expect(shouldNudgeIdleMember(deps.db, "t", "qa")).toBe(true)
  })

  test("recovers one candidate without completing work or mutating native permissions", async () => {
    const deps = fixture()
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(true)
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(true)
    expect(deps.client.calls.filter(c => c.method === "session.promptAsync")).toHaveLength(1)
    expect(deps.client.calls.every(c => ["session.promptAsync", "session.status"].includes(c.method))).toBe(true)
  })

  test.each(["length", "tool-calls", "error", "unknown"])("does not recover an interrupted or nonfinal response (%s)", async finish => {
    const deps = fixture()
    deps.client.session.messages = async () => ({ data: [{ info: { id: "bad", role: "assistant", finish, time: { created: Date.now(), completed: Date.now() } }, parts: [{ type: "text", text: "partial" }] }] })
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("no messages, API failure or non-text content invents no result", async () => {
    const deps = fixture()
    deps.client.session.messages = async () => ({ data: [] })
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
    deps.client.session.messages = async () => { throw new Error("offline") }
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
  })

  test("final-response spawn preserves profile permissions and supplies no impossible completion instruction", async () => {
    const deps = fixture()
    await executeTeamSpawn(deps, { name: "restricted", agent: "qa", prompt: "Review only", worktree: false, report_mode: "final_response" }, "lead")
    const creation = deps.client.calls.find(call => call.method === "session.create")!
    expect(creation.args[0]).not.toHaveProperty("permission")
    const prompt = JSON.stringify(deps.client.calls.find(call => call.method === "session.promptAsync")!.args)
    expect(prompt).toContain("final response")
    expect(prompt).not.toContain("using team_tasks_complete")
    expect(prompt).not.toContain("MUST use team_message")
    expect(buildTeammateSystemPrompt(deps.db, "t", "restricted")).not.toContain("MUST send your results to the lead via team_message")
    expect(buildTeamCompactionContext(deps.db, "t", "member", "restricted")).not.toContain("MUST send your results to the lead via team_message")
    expect(shouldNudgeIdleMember(deps.db, "t", "restricted")).toBe(false)
  })

  test("candidate retrieval leaves a dependency blocked until the lead explicitly accepts the task", async () => {
    const deps = fixture()
    deps.db.run("UPDATE team_member SET report_mode = 'final_response' WHERE name = 'qa'")
    deps.db.run("INSERT INTO team_task (id,team_id,content,status,priority,assignee,time_created,time_updated) VALUES ('plan','t','QA plan','in_progress','medium','qa',1,1)")
    deps.db.run("INSERT INTO team_task (id,team_id,content,status,priority,depends_on,time_created,time_updated) VALUES ('author','t','Author tests','blocked','medium','[\"plan\"]',1,1)")
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(true)
    await executeTeamResults(deps, { from: "qa" }, "lead")
    expect(deps.db.query("SELECT status FROM team_task WHERE id = 'author'").get()).toEqual({ status: "blocked" })
    await expect(executeTeamTasksComplete(deps, { task_id: "plan" }, "worker")).rejects.toThrow("lead")
    await executeTeamTasksComplete(deps, { task_id: "plan" }, "lead")
    expect(deps.db.query("SELECT status FROM team_task WHERE id = 'author'").get()).toEqual({ status: "pending" })
  })

  test("full candidate is retrievable even above the team message limit, once by default", async () => {
    const deps = fixture()
    const full = "QA details ".repeat(2000)
    deps.client.session.messages = async () => ({ data: [{ info: { id: "long-final", role: "assistant", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 } }, parts: [{ type: "text", text: full }] }] })
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(true)
    expect(await executeTeamResults(deps, { from: "qa" }, "lead")).toContain(full.trim())
    expect(await executeTeamResults(deps, { from: "qa" }, "lead")).not.toContain(full.trim())
  })

  test("candidate text preserves exact whitespace and retained IDs allow explicit rereading", async () => {
    const deps = fixture()
    const content = "  Indented finding\n\n"
    deps.client.session.messages = async () => ({ data: [{ info: { id: "verbatim", role: "assistant", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 } }, parts: [{ type: "text", text: content }] }] })
    await recoverFinalResponse(deps.db, deps.client, "t", "qa")
    const candidate = deps.db.query("SELECT id, content FROM member_result").get() as { id: string; content: string }
    expect(candidate.content).toBe(content)
    await executeTeamResults(deps, { from: "qa" }, "lead")
    expect(await executeTeamResults(deps, { candidate_id: candidate.id }, "lead")).toContain(content)
    await expect(executeTeamResults(deps, { candidate_id: candidate.id }, "worker")).rejects.toThrow("Candidate not found")
  })

  test("a restrictive worker is never auto-dispatched an incompatible task", () => {
    const deps = fixture()
    deps.config.autoDispatch = true
    deps.db.run("UPDATE team_member SET report_mode = 'final_response'")
    deps.db.run("INSERT INTO team_task (id,team_id,content,status,priority,time_created,time_updated) VALUES ('next','t','Next','pending','medium',1,1)")
    expect(dispatchNextTask(deps, "t", "qa")).toBeNull()
  })

  test("recovery is safe under concurrent events and survives a new client instance", async () => {
    const deps = fixture()
    await Promise.all([recoverFinalResponse(deps.db, deps.client, "t", "qa"), recoverFinalResponse(deps.db, deps.client, "t", "qa")])
    expect(deps.db.query("SELECT COUNT(*) AS c FROM member_result").get()).toEqual({ c: 1 })
    expect(deps.db.query("SELECT COUNT(*) AS c FROM team_message").get()).toEqual({ c: 1 })
    const other = setupDeps(deps.db)
    expect(await recoverFinalResponse(other.db, other.client, "t", "qa")).toBe(true)
    expect(other.client.calls).toHaveLength(0)
  })

  test("an older completed response cannot replace a more recent interrupted response", async () => {
    const deps = fixture()
    const old = (await deps.client.session.messages({ sessionID: "worker" })).data![0]!
    deps.client.session.messages = async () => ({ data: [old, { info: { id: "interrupted", role: "assistant", finish: "length", time: { created: Date.now() + 3, completed: Date.now() + 4 } }, parts: [{ type: "text", text: "partial" }] }] })
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
  })

  test("a native active session cannot be harvested using stale ready state", async () => {
    const deps = fixture()
    deps.client.session.status = async () => ({ data: { worker: { type: "busy" } } })
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
  })

  test("late events cannot publish candidates into an archived team", async () => {
    const deps = fixture()
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = 't'")
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
  })

  test("repeated idle cannot resurrect a shut-down member", () => {
    const deps = fixture()
    deps.db.run("UPDATE team_member SET status = 'shutdown_requested'")
    handleSessionStatusEvent(deps.db, deps.registry, "worker", "idle")
    handleSessionStatusEvent(deps.db, deps.registry, "worker", "idle")
    expect(deps.db.query("SELECT status FROM team_member WHERE name = 'qa'").get()).toEqual({ status: "shutdown" })
  })

  test("fallback candidates also require lead validation, even after their assignee is cleared", async () => {
    const deps = fixture()
    deps.db.run("INSERT INTO team_task (id,team_id,content,status,priority,assignee,time_created,time_updated) VALUES ('plan','t','QA plan','in_progress','medium','qa',1,1)")
    await recoverFinalResponse(deps.db, deps.client, "t", "qa")
    deps.db.run("UPDATE team_task SET assignee = NULL, status = 'pending' WHERE id = 'plan'")
    await expect(executeTeamTasksComplete(deps, { task_id: "plan" }, "worker")).rejects.toThrow("lead")
  })

  test("same-millisecond reactivation invalidates an in-flight recovery", async () => {
    const deps = fixture()
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(now)
    try {
      deps.db.run("UPDATE team_member SET report_started_at = ?, time_created = ?", [now, now])
      const snapshot = await deps.client.session.messages({ sessionID: "worker" })
      deps.client.session.messages = async () => {
        handleSessionStatusEvent(deps.db, deps.registry, "worker", "busy")
        handleSessionStatusEvent(deps.db, deps.registry, "worker", "idle")
        return snapshot
      }
      expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
      expect(deps.db.query("SELECT COUNT(*) AS c FROM member_result").get()).toEqual({ c: 0 })
    } finally {
      clock.mockRestore()
    }
  })

  test("a candidate from an earlier generation cannot satisfy a new run in the same millisecond", async () => {
    const deps = fixture()
    const clock = spyOn(Date, "now").mockReturnValue(Date.now())
    try {
      expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(true)
      handleSessionStatusEvent(deps.db, deps.registry, "worker", "busy")
      handleSessionStatusEvent(deps.db, deps.registry, "worker", "idle")
      expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
    } finally {
      clock.mockRestore()
    }
  })

  test("stale, incomplete, erroneous and reasoning-only messages are not candidates", async () => {
    const deps = fixture()
    for (const info of [
      { id: "old", role: "assistant", finish: "stop", time: { created: 1, completed: 2 } },
      { id: "incomplete", role: "assistant", finish: "stop", time: { created: Date.now() + 1 } },
      { id: "error", role: "assistant", finish: "stop", error: { message: "cancelled" }, time: { created: Date.now() + 1, completed: Date.now() + 2 } },
    ]) {
      deps.client.session.messages = async () => ({ data: [{ info, parts: [{ type: "text", text: "not a deliverable" }] }] })
      expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
    }
    deps.client.session.messages = async () => ({ data: [{ info: { id: "reasoning", role: "assistant", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 } }, parts: [{ type: "reasoning", text: "private" }] }] })
    expect(await recoverFinalResponse(deps.db, deps.client, "t", "qa")).toBe(false)
  })
})
