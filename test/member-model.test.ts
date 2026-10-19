import { afterEach, describe, test, expect, beforeEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupDb, setupDeps, insertTeam, insertMember } from "./helpers"
import type { Database } from "../src/db"
import { parseModelId, getMemberModel, getMemberPromptModel } from "../src/member-model"
import { approveMission, assertMissionMemberModel, openMissionConfiguration, prepareMission, routeMissionTask, saveMissionTaskRoute } from "../src/mission-policy"

describe("parseModelId", () => {
  test("parses a valid provider/model string", () => {
    expect(parseModelId("anthropic/claude-3-5-sonnet")).toEqual({
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet",
    })
  })

  test("keeps additional slashes in the model portion", () => {
    expect(parseModelId("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude",
    })
  })

  test("returns undefined for malformed input", () => {
    expect(parseModelId("")).toBeUndefined()
    expect(parseModelId("foo")).toBeUndefined()
    expect(parseModelId("/model")).toBeUndefined()
    expect(parseModelId("provider/")).toBeUndefined()
  })
})

describe("getMemberModel", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
    insertTeam(db, "t1", "my-team", "lead-sess")
  })

  test("returns the parsed model when the member has one set", () => {
    insertMember(db, "t1", "alice", "sess-alice")
    db.run("UPDATE team_member SET model = 'anthropic/claude-sonnet' WHERE team_id = 't1' AND name = 'alice'")

    expect(getMemberModel(db, "t1", "alice")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
    })
  })

  test("returns undefined when the member has no model set", () => {
    insertMember(db, "t1", "alice", "sess-alice")
    expect(getMemberModel(db, "t1", "alice")).toBeUndefined()
  })

  test("returns undefined when the stored model is malformed", () => {
    insertMember(db, "t1", "alice", "sess-alice")
    db.run("UPDATE team_member SET model = 'garbage' WHERE team_id = 't1' AND name = 'alice'")
    expect(getMemberModel(db, "t1", "alice")).toBeUndefined()
  })

  test("returns undefined for an unknown member", () => {
    expect(getMemberModel(db, "t1", "nobody")).toBeUndefined()
  })

  test("returns a paired native variant for later deliveries, and no fields for an unknown member", () => {
    insertMember(db, "t1", "alice", "sess-alice")
    db.run("UPDATE team_member SET model = 'openai/model', model_variant = 'high' WHERE name = 'alice'")
    expect(getMemberPromptModel(db, "t1", "alice")).toEqual({ model: { providerID: "openai", modelID: "model" }, variant: "high" })
    expect(getMemberPromptModel(db, "t1", "nobody")).toEqual({})
    db.run("UPDATE team_member SET model = 'malformed' WHERE name = 'alice'")
    expect(getMemberPromptModel(db, "t1", "alice")).toEqual({})
  })
})

describe("assertMissionMemberModel native variant", () => {
  const fixtures: string[] = []
  afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

  test("rejects a canonical synonym and ignores an effort annotation beside the native variant", async () => {
    const deps = setupDeps()
    deps.directory = mkdtempSync(join(tmpdir(), "ensemble-member-model-"))
    fixtures.push(deps.directory)
    deps.config = { ...deps.config, modelRouting: { beta: 0.35, models: [
      { id: "allowed/light", intelligenceScore: 10, averageCostPerTask: 0.1, available: true },
      { id: "allowed/standard", reasoningEffort: "medium", intelligenceScore: 20, averageCostPerTask: 0.2, available: true },
      { id: "other/strong", reasoningEffort: "high", intelligenceScore: 30, averageCostPerTask: 1, available: true },
    ] } }
    const mission = await prepareMission(deps, "lead", "Provenance")
    openMissionConfiguration(deps, mission.teamId, "lead")
    approveMission(deps, mission.teamId, "lead")
    deps.db.run("INSERT INTO team_task (id, team_id, content, status, priority, complexity, risk, time_created, time_updated) VALUES (?, ?, ?, 'pending', 'medium', ?, ?, ?, ?)",
      ["risky", mission.teamId, "risky", 10, 90, Date.now(), Date.now()])
    insertMember(deps.db, mission.teamId, "alice", "sess-alice")
    const route = routeMissionTask(deps.db, mission.teamId, "risky")
    if (!route) throw new Error("expected a governed route")
    saveMissionTaskRoute(deps.db, mission.teamId, "risky", "alice", route)
    const stored = () => deps.db.query("SELECT model, model_variant, model_routing FROM team_member WHERE name = 'alice'").get() as { model: string | null; model_variant: string | null; model_routing: string | null }
    expect(() => assertMissionMemberModel(deps.db, mission.teamId, stored())).not.toThrow()
    deps.db.run("UPDATE team_member SET model_variant = 'Extra High' WHERE name = 'alice'")
    expect(() => assertMissionMemberModel(deps.db, mission.teamId, stored())).toThrow("Mission model provenance invalid")
    const routing = JSON.parse(stored().model_routing ?? "{}") as { selected: { id: string; variant?: string; effort?: string } }
    routing.selected.effort = "high"
    deps.db.run("UPDATE team_member SET model_variant = 'high', model_routing = ? WHERE name = 'alice'", [JSON.stringify(routing)])
    expect(() => assertMissionMemberModel(deps.db, mission.teamId, stored())).not.toThrow()
  })
})
