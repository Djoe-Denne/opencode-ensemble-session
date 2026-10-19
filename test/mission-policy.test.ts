import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupDeps } from "./helpers"
import { approveMission, assertMissionAdmission, openMissionConfiguration, prepareMission } from "../src/mission-policy"
import { executeTeamCreate } from "../src/tools/team-create"

const fixtures: string[] = []

afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function fixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-mission-policy-"))
  fixtures.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { beta: 0.35, models: [
    { id: "allowed/light", intelligenceScore: 10, averageCostPerTask: 0.1, available: true },
    { id: "allowed/standard", reasoningEffort: "medium", intelligenceScore: 20, averageCostPerTask: 0.2, available: true },
    { id: "other/strong", reasoningEffort: "high", intelligenceScore: 30, averageCostPerTask: 1, available: true },
  ] } }
  return deps
}

describe("mission policy lifecycle", () => {
  test("prepares a persisted draft without starting a worker", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement an isolated cache")
    expect(mission.policyPath.startsWith(join(deps.directory, ".opencode", "missions"))).toBe(true)
    expect(JSON.parse(readFileSync(mission.policyPath, "utf8"))).toMatchObject({ version: 1, providers: ["allowed", "other"] })
    expect(deps.client.calls.filter(call => call.method === "session.create")).toHaveLength(0)
    expect(() => assertMissionAdmission(deps.db, mission.teamId)).toThrow("approved")
  })

  test("approves only the policy previously presented to the lead and survives dependency reconstruction", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    expect(() => approveMission(deps, mission.teamId, "lead")).toThrow("config")
    const preview = openMissionConfiguration(deps, mission.teamId, "lead")
    const approved = approveMission(deps, mission.teamId, "lead")
    expect(approved.hash).toBe(preview.hash)
    expect(approved.revision).toBe(1)
    const restarted = setupDeps(deps.db)
    expect(assertMissionAdmission(restarted.db, mission.teamId)).toMatchObject({ hash: preview.hash, revision: 1 })
  })

  test("editing a file is not approval and cannot replace a presented or approved policy silently", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    openMissionConfiguration(deps, mission.teamId, "lead")
    const policy = JSON.parse(readFileSync(mission.policyPath, "utf8"))
    policy.assessment.risk.push("Persisted cache corruption is high risk for this mission.")
    writeFileSync(mission.policyPath, JSON.stringify(policy))
    expect(() => approveMission(deps, mission.teamId, "lead")).toThrow("changed")
    openMissionConfiguration(deps, mission.teamId, "lead")
    approveMission(deps, mission.teamId, "lead")
    policy.assessment.risk.push("Another unapproved edit")
    writeFileSync(mission.policyPath, JSON.stringify(policy))
    expect(() => assertMissionAdmission(deps.db, mission.teamId)).toThrow("changed")
    openMissionConfiguration(deps, mission.teamId, "lead")
    expect(() => assertMissionAdmission(deps.db, mission.teamId)).toThrow("approved")
    expect(approveMission(deps, mission.teamId, "lead").revision).toBe(2)
  })

  test("rejects member approval and preserves legacy team admission", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    expect(() => openMissionConfiguration(deps, mission.teamId, "not-lead")).toThrow("lead")
    expect(() => approveMission(deps, mission.teamId, "not-lead")).toThrow("lead")
    expect(assertMissionAdmission(deps.db, "legacy-team")).toBeUndefined()
  })

  test("requires an objective and refuses to attach a mission to an existing team", async () => {
    const deps = fixture()
    await expect(prepareMission(deps, "lead", " ")).rejects.toThrow("objective")
    await prepareMission(deps, "lead", "First objective")
    await expect(prepareMission(deps, "lead", "Second objective")).rejects.toThrow("already")
  })

  test("repeated approval of an unchanged presented policy is idempotent", async () => {
    const deps = fixture()
    const mission = await prepareMission(deps, "lead", "Implement cache")
    openMissionConfiguration(deps, mission.teamId, "lead")
    expect(approveMission(deps, mission.teamId, "lead").revision).toBe(1)
    expect(approveMission(deps, mission.teamId, "lead").revision).toBe(1)
    expect(deps.db.query("SELECT revision FROM mission_policy_revision").all()).toHaveLength(1)
  })

  test("concurrent preparation cannot leave an extra active team without its mission gate", async () => {
    const deps = fixture()
    let release: () => void = () => {}
    const discovery = new Promise<void>(resolve => { release = resolve })
    deps.classifier = { list: async () => { await discovery; return [] }, invoke: async () => ({}) }
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => ++now)
    try {
      const results = Promise.allSettled([prepareMission(deps, "lead", "First objective"), prepareMission(deps, "lead", "Second objective")])
      release()
      const settled = await results
      expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1)
      expect(deps.db.query("SELECT id FROM team WHERE status = 'active'").all()).toHaveLength(1)
      expect(deps.db.query("SELECT team_id FROM mission_policy").all()).toHaveLength(1)
    } finally { clock.mockRestore() }
  })

  test("ordinary concurrent team creation also rechecks lead membership after capability discovery", async () => {
    const deps = fixture()
    let release: () => void = () => {}
    const discovery = new Promise<void>(resolve => { release = resolve })
    deps.classifier = { list: async () => { await discovery; return [] }, invoke: async () => ({}) }
    const results = Promise.allSettled([executeTeamCreate(deps, { name: "first" }, "lead"), executeTeamCreate(deps, { name: "second" }, "lead")])
    release()
    expect((await results).filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(deps.db.query("SELECT id FROM team WHERE lead_session_id = 'lead' AND status = 'active'").all()).toHaveLength(1)
  })
})
