import { Database } from "bun:sqlite"
import { readFileSync, writeFileSync } from "node:fs"
import { applyMissionClassification } from "../src/mission-classification"
import { validateMissionModelPolicy } from "../src/mission-model-policy"

const live = new Database("C:/Users/djden/.config/opencode/ensemble.db")

type Deps = Parameters<typeof applyMissionClassification>[0]
function stubDeps(db: InstanceType<typeof Database>): Deps {
  return {
    db,
    config: { classification: { mode: "off", helperModel: "", helperVariant: "", toolId: "", timeoutMs: 30000, limits: {} } },
    classifier: { list: async () => [], invoke: async () => { throw new Error("classifier must not run") }, general: async () => ({}) },
  } as unknown as Deps
}

const override = {
  mode: "general" as const,
  generalModel: "openai/gpt-6.1-sol",
  generalVariant: "high",
  fallbacks: [] as [],
  limits: { retries: 1, maxAttempts: 3 },
}

const missions = [
  { teamId: "team_mvgfot5z_0000_muyr0t", file: "C:/Users/djden/source/repos/devoir-civil/.opencode/missions/team_mvgfot5z_0000_muyr0t/model-policy.json", cleanDraft: true },
  { teamId: "team_mvgflkth_0000_xl23p5", file: "C:/Users/djden/source/repos/ARTIST/.opencode/missions/team_mvgflkth_0000_xl23p5/model-policy.json", cleanDraft: false },
  { teamId: "team_mvgfk6d8_0000_dl9355", file: "C:/Users/djden/source/repos/AIForAll/.opencode/missions/team_mvgfk6d8_0000_dl9355/model-policy.json", cleanDraft: false },
]

for (const mission of missions) {
  const result: Record<string, unknown> = { team: mission.teamId }
  try {
    const draft = JSON.parse(readFileSync(mission.file, "utf8"))
    if (mission.cleanDraft && draft.classification !== undefined) {
      delete draft.classification
      writeFileSync(mission.file, `${JSON.stringify(draft, null, 2)}\n`)
      result.draftCleaned = true
    }
    validateMissionModelPolicy(draft)
    result.draftValid = true
  } catch (error) {
    result.draftError = String(error instanceof Error ? error.message : error)
  }
  try {
    const policy = await applyMissionClassification(stubDeps(live), mission.teamId, override)
    result.applied = { method: policy.method, generalModel: policy.generalModel, generalVariant: policy.generalVariant }
  } catch (error) {
    result.appliedError = String(error instanceof Error ? error.message : error)
  }
  const row = live.query("SELECT classification_policy FROM team WHERE id = ?").get(mission.teamId) as { classification_policy: string } | null
  result.frozenNow = row ? JSON.parse(row.classification_policy).method : "row-missing"
  console.log(JSON.stringify(result))
}
live.close()
