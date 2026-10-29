import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupDeps, historicalModelPolicy } from "./helpers"
import { approveMission, openMissionConfiguration, prepareMission } from "../src/mission-policy"
import { buildMissionAutonomyPrompt, buildMissionDecisionPrompt, validateMissionAutonomyPolicy } from "../src/mission-autonomy"
import { applyMissionClassification, getMissionClassification } from "../src/mission-classification"
import { buildLeadSystemPrompt } from "../src/system-prompt"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

async function fixture(version: 1 | 2 | 3 = 2) {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-autonomy-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { ...deps.config.modelRouting,
    models: [{ id: "fixture/worker", intelligenceScore: 60, averageCostPerTask: 1, available: true }] } }
  if (version === 1) deps.config.missionPolicy = historicalModelPolicy(deps)
  if (version === 3) deps.config.planningIntelligenceRange = { min: 40 }
  const mission = await prepareMission(deps, "lead", "Implement a cache")
  const edit = (autonomy: unknown) => {
    const policy = JSON.parse(readFileSync(mission.policyPath, "utf8"))
    writeFileSync(mission.policyPath, JSON.stringify({ ...policy, autonomy }))
  }
  const approve = () => {
    openMissionConfiguration(deps, mission.teamId, "lead")
    return approveMission(deps, mission.teamId, "lead")
  }
  return { deps, ...mission, edit, approve }
}

describe("approved long-run autonomy", () => {
  test("supervised missions decide routine choices and do not invent milestone approval gates", async () => {
    const f = await fixture()
    f.approve()
    const text = buildMissionDecisionPrompt(f.deps.db, f.teamId)
    expect(text).toContain("In both supervised and long_run")
    expect(text).toContain("Do not enter standby")
    expect(text).toContain("architectural change not already authorized")
    expect(text).toContain("mission objective")
    expect(text).toContain("private helper refactors")
    expect(text).toContain("existing approval")
    expect(text).toContain("plan_approval")
    expect(text).toContain("lead's approval, not a new user go")
    expect(text).not.toContain("[Approved long-run autonomy]")
    expect(buildLeadSystemPrompt(f.deps.db, f.teamId)).toContain("config/start only for initial approval or a policy revision")
  })

  test("shared decisions never authorize execution before start or override worker completion rules", async () => {
    const f = await fixture()
    const text = buildMissionDecisionPrompt(f.deps.db, f.teamId)
    expect(text).toContain("authorized phase")
    expect(text).toContain("config/start")
    expect(text).toContain("permissions")
    expect(text).toContain("explicit user hold")
    expect(text).toContain("stop after their assigned deliverable")
    expect(buildMissionDecisionPrompt(f.deps.db, "missing")).toBe("")
  })

  test("long-run priorities follow the same architecture and objective boundaries in a stable suffix", async () => {
    const f = await fixture()
    const initial = buildMissionDecisionPrompt(f.deps.db, f.teamId)
    f.edit({ mode: "long_run", instructions: ["Choose the fastest correct implementation."] })
    expect(buildMissionDecisionPrompt(f.deps.db, f.teamId)).toBe(initial)
    f.approve()
    const approved = buildMissionDecisionPrompt(f.deps.db, f.teamId)
    expect(approved).toStartWith(initial)
    expect(approved).toEndWith("[/Approved long-run autonomy]")
    expect(approved).toContain("architectural change not already authorized")
    expect(approved).toContain("mission objective")
    expect(approved).toContain("Choose the fastest correct implementation.")
  })

  test.each([1, 2, 3] as const)("version %s hashes and approves autonomy independently of classification", async version => {
    const f = await fixture(version)
    f.approve()
    const policy = { mode: "long_run", instructions: ["Prioritize quality and fidelity to the original plan."] }
    f.edit(policy)
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).toBe("")
    const preview = openMissionConfiguration(f.deps, f.teamId, "lead")
    expect(preview.policy).toMatchObject({ autonomy: policy })
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).toBe("")
    const approved = approveMission(f.deps, f.teamId, "lead")
    expect(approved.hash).toBe(preview.hash)
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).toContain(policy.instructions[0]!)
    expect(f.deps.db.query("SELECT mission_mode FROM team WHERE id = ?").get(f.teamId)).toEqual({ mission_mode: "long_run" })
  })

  test("the stable approved suffix survives draft changes, configuration, restart and transient state", async () => {
    const f = await fixture()
    f.edit({ mode: "long_run", instructions: ["Prioritize quality."] })
    f.approve()
    const suffix = buildMissionAutonomyPrompt(f.deps.db, f.teamId)
    expect(suffix).toContain("Prioritize quality.")
    f.edit({ mode: "long_run", instructions: ["Choose the fastest correct implementation."] })
    expect(() => approveMission(f.deps, f.teamId, "lead")).toThrow("changed")
    openMissionConfiguration(f.deps, f.teamId, "lead")
    f.deps.db.run("UPDATE team SET mission_state = 'critical', time_updated = time_updated + 1 WHERE id = ?", [f.teamId])
    expect(buildMissionAutonomyPrompt(setupDeps(f.deps.db).db, f.teamId)).toBe(suffix)
    approveMission(f.deps, f.teamId, "lead")
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).toContain("Choose the fastest correct implementation.")
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).not.toContain("Prioritize quality.")
    expect(f.deps.db.query("SELECT mission_state FROM team WHERE id = ?").get(f.teamId)).toEqual({ mission_state: "critical" })
    f.edit({ mode: "supervised" })
    openMissionConfiguration(f.deps, f.teamId, "lead")
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).not.toBe("")
    approveMission(f.deps, f.teamId, "lead")
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).toBe("")
    expect(f.deps.db.query("SELECT mission_mode FROM team WHERE id = ?").get(f.teamId)).toEqual({ mission_mode: "supervised" })
  })

  test("draft edits after preview and member approval cannot activate delegated authority", async () => {
    const f = await fixture()
    f.edit({ mode: "long_run", instructions: ["Prioritize quality."] })
    openMissionConfiguration(f.deps, f.teamId, "lead")
    f.edit({ mode: "long_run", instructions: ["Prioritize speed."] })
    expect(() => approveMission(f.deps, f.teamId, "lead")).toThrow("changed")
    expect(() => approveMission(f.deps, f.teamId, "worker")).toThrow("lead")
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).toBe("")
  })

  test("legacy classification long_run is not an approved delegation contract", async () => {
    const f = await fixture()
    f.approve()
    f.deps.db.run("UPDATE team SET mission_mode = 'long_run' WHERE id = ?", [f.teamId])
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).toBe("")
    expect(buildMissionAutonomyPrompt(f.deps.db, "absent")).toBe("")
  })

  test("approved autonomy governs classifier resilience without a classifier change downgrading it", async () => {
    const f = await fixture()
    f.edit({ mode: "long_run", instructions: ["Choose the fastest correct option."] })
    f.approve()
    expect(getMissionClassification(f.deps.db, f.teamId)?.missionMode).toBe("long_run")
    await applyMissionClassification(f.deps, f.teamId, { mode: "off", missionMode: "supervised" })
    expect(getMissionClassification(f.deps.db, f.teamId)?.missionMode).toBe("long_run")
    expect(f.deps.db.query("SELECT mission_mode FROM team WHERE id = ?").get(f.teamId)).toEqual({ mission_mode: "long_run" })
  })

  test("corrupt approved storage fails closed rather than injecting instructions", async () => {
    const f = await fixture()
    f.edit({ mode: "long_run", instructions: ["Choose quality."] })
    f.approve()
    f.deps.db.run("UPDATE mission_policy_revision SET policy_json = '{}' WHERE team_id = ?", [f.teamId])
    expect(() => buildMissionAutonomyPrompt(f.deps.db, f.teamId)).toThrow("integrity")
  })

  test("instructions explicitly delegate routine choices without bypassing safety or worker scope", async () => {
    const f = await fixture()
    f.edit({ mode: "long_run", instructions: ["Respect the original plan and choose quality."] })
    f.approve()
    const text = buildMissionAutonomyPrompt(f.deps.db, f.teamId)
    expect(text).toContain("Decide technical and organizational choices")
    expect(text).toContain("Do not ask for confirmation")
    expect(text).toContain("already granted")
    expect(text).toContain("permissions")
    expect(text).toContain("irreversible")
    expect(text).toContain("lead")
    expect(text).toContain("independent work")
  })

  test.each([1, 2, 3] as const)("version %s delegates operational validations by default without category-based approval gates", async version => {
    const f = await fixture(version)
    f.edit({ mode: "long_run", instructions: ["Prioritize quality."] })
    expect(buildMissionDecisionPrompt(f.deps.db, f.teamId)).not.toContain("Contract ratification")
    f.approve()
    const text = buildMissionDecisionPrompt(f.deps.db, f.teamId)
    expect(text).toContain("operational validations within the approved mandate are delegated by default")
    expect(text).toContain("Contract ratification, SDK publication, Kind operations")
    expect(text).toContain("not categorical exceptions or automatic user-approval gates")
    expect(text).toContain("Check their prerequisites")
    expect(text).toContain("Progress reports are informational, not permission requests")
    expect(text).toContain("research, tests, existing instructions or reasonable assumptions")
    expect(text).toContain("Technical difficulty alone")
    expect(text).toContain("specific missing authority")
    expect(text).toContain("initial config/start approval")
    expect(text).toContain("explicit prohibitions")
    expect(text).toContain("do not gain tools or permissions")
    expect(text).not.toContain("These priorities do not authorize")
    f.edit({ mode: "supervised" })
    f.approve()
    expect(buildMissionDecisionPrompt(f.deps.db, f.teamId)).not.toContain("Contract ratification")
  })

  test("long-run local reads are already delegated without inventing rights or bypassing a refusal", async () => {
    const f = await fixture()
    f.edit({ mode: "long_run", instructions: ["Prioritize quality."] })
    expect(buildMissionAutonomyPrompt(f.deps.db, f.teamId)).toBe("")
    f.approve()
    const text = buildMissionAutonomyPrompt(f.deps.db, f.teamId)
    expect(text).toContain("Necessary non-secret local reads and read-only diagnostics are already covered")
    expect(text).toContain("Do not ask whether you may read a local file")
    expect(text).toContain("configuration/profile metadata")
    expect(text).toContain("Use the permitted native tool normally")
    expect(text).toContain("Permission.DeclinedError alone does not establish")
    expect(text).toContain("do not retry a confirmed refusal or switch tools to evade it")
    expect(text).toContain("specific indispensable action")
    expect(text).toContain("without expanding permissions")
  })

  test("an unmet acceptance criterion does not stop authorized long-run investigation", async () => {
    const f = await fixture()
    f.edit({ mode: "long_run", instructions: ["Prioritize quality."] })
    f.approve()
    const text = buildMissionAutonomyPrompt(f.deps.db, f.teamId)
    expect(text).toContain("An acceptance failure is not automatically an execution blocker")
    expect(text).toContain("Freeze only the affected acceptance/integration")
    expect(text).toContain("allowed diagnosis, source analysis, documentation research")
    expect(text).toContain("failed criterion, affected dependencies and remaining authorized next steps")
    expect(text).toContain("Do not end the mission as partially blocked while useful authorized work remains")
    expect(text).toContain("Do not relax test limits or repeat explicitly frozen experiments")
  })

  test.each([null, {}, { mode: "fast" }, { mode: "long_run" }, { mode: "long_run", instructions: [] },
    { mode: "long_run", instructions: [" "] }, { mode: "long_run", instructions: [3] },
    { mode: "long_run", instructions: ["x".repeat(2001)] }, { mode: "long_run", instructions: Array(51).fill("x") },
    { mode: "long_run", instructions: ["quality"], bypass: true },
  ])("rejects malformed or empty delegation %j", value => {
    expect(() => validateMissionAutonomyPolicy(value)).toThrow()
  })

  test("invalid autonomy in the draft is rejected, not silently removed", async () => {
    const f = await fixture()
    f.edit({ mode: "long_run", instructions: [] })
    expect(() => openMissionConfiguration(f.deps, f.teamId, "lead")).toThrow("autonomy")
  })
})
