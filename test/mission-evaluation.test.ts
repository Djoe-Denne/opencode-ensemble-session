import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupDeps, prepareHistoricalMission as prepareMission } from "./helpers"
import { openMissionConfiguration, approveMission } from "../src/mission-policy"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { classifyBoardTasks } from "../src/board-classification"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function fixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-mission-evaluation-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { beta: 0.35, models: [
    { id: "fixture/light", intelligenceScore: 10, averageCostPerTask: 0, available: true },
    { id: "fixture/strong", intelligenceScore: 30, averageCostPerTask: 1, available: true },
  ] }, classification: { ...deps.config.classification, mode: "auto", helperModel: "fixture/light", limits: { retries: 0 } } }
  const requests: unknown[] = []
  deps.classifier = {
    list: async () => [{ id: "router_jev_ask", input: { type: "object", properties: { state: {}, questions: {} }, required: ["state", "questions"] } }],
    invoke: async request => {
      requests.push(request)
      return { answers: { complexity: { type: "score", score: requests.length === 1 ? 0.15 : 0.85 }, risk: { type: "score", score: requests.length === 1 ? 0.15 : 0.85 } } }
    },
  }
  return { deps, requests }
}

describe("mission evaluator admission", () => {
  test("does not allocate a classifier before approval and enforces the helper provider", async () => {
    const f = fixture()
    f.deps.config.classification.helperModel = "forbidden/helper"
    const mission = await prepareMission(f.deps, "lead", "Evaluate cache safety")
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "Evaluate", priority: "medium" }] }, "lead")
    await classifyBoardTasks(f.deps, mission.teamId)
    expect(f.requests).toHaveLength(0)
    expect(f.deps.db.query("SELECT classification_attempts FROM team_task").get()).toEqual({ classification_attempts: 0 })
    openMissionConfiguration(f.deps, mission.teamId, "lead")
    expect(() => approveMission(f.deps, mission.teamId, "lead")).toThrow("provider")
  })

  test("a newly approved rubric re-evaluates unassigned automatic scores without resetting mission budgets", async () => {
    const f = fixture()
    const mission = await prepareMission(f.deps, "lead", "Evaluate cache safety")
    openMissionConfiguration(f.deps, mission.teamId, "lead")
    approveMission(f.deps, mission.teamId, "lead")
    await executeTeamTasksAdd(f.deps, { tasks: [{ content: "Evaluate", priority: "medium" }] }, "lead")
    await classifyBoardTasks(f.deps, mission.teamId)
    expect(f.requests).toHaveLength(1)
    const policy = JSON.parse(readFileSync(mission.policyPath, "utf8"))
    policy.assessment.risk = ["Low: disposable cache miss.", "High: persisted cache corruption is critical in this mission."]
    writeFileSync(mission.policyPath, JSON.stringify(policy))
    openMissionConfiguration(f.deps, mission.teamId, "lead")
    approveMission(f.deps, mission.teamId, "lead")
    await classifyBoardTasks(f.deps, mission.teamId)
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]).toMatchObject({ input: { questions: { risk: { criteria: policy.assessment.risk } } } })
    const row = f.deps.db.query("SELECT classification_result FROM team_task").get() as { classification_result: string }
    expect(JSON.parse(row.classification_result)).toMatchObject({ complexity: 0.85, risk: 0.85 })
    const team = f.deps.db.query("SELECT classification_runtime FROM team").get() as { classification_runtime: string }
    expect(JSON.parse(team.classification_runtime).calls).toBe(2)
  })
})
