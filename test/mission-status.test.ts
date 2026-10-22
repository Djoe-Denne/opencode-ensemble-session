import { describe, expect, test } from "bun:test"
import { setupDeps, insertTeam } from "./helpers"
import { resolveMissionClassification } from "../src/mission-classification"
import { buildLeadSystemPrompt, buildTeamCompactionContext } from "../src/system-prompt"
import { executeTeamStatus } from "../src/tools/team-status"

async function fixture() {
  const deps = setupDeps()
  insertTeam(deps.db, "governed", "governed", "lead")
  const classification = await resolveMissionClassification(deps, { mode: "off" })
  deps.db.run("UPDATE team SET classification_policy = ? WHERE id = 'governed'", [JSON.stringify(classification)])
  deps.db.run("INSERT INTO mission_policy (team_id, objective, policy_path, time_updated) VALUES ('governed', 'Fix cache', 'mission-policy.json', ?)", [Date.now()])
  deps.config = { ...deps.config, promptForModels: true }
  return deps
}

describe("mission policy operating context", () => {
  test("lead instructions advertise the durable grid instead of conflicting legacy model controls", async () => {
    const deps = await fixture()
    const prompt = buildLeadSystemPrompt(deps.db, "governed", deps.config)
    expect(prompt).toContain("not approved")
    expect(prompt).toContain("/ensemble-mission config")
    expect(prompt).toContain("mission-policy.json")
    expect(prompt).not.toContain('User-authorized override: team_message({to:"lead", classification:')
    expect(prompt).not.toContain("Before spawning teammates, use the question tool")
  })

  test("status and compaction retain the policy file and approval gate without copying the grid into context", async () => {
    const deps = await fixture()
    expect(await executeTeamStatus(deps, "lead")).toContain("Mission policy: draft")
    const compacted = buildTeamCompactionContext(deps.db, "governed", "lead")
    expect(compacted).toContain("mission-policy.json")
    expect(compacted).toContain("admitted task")
  })
})
