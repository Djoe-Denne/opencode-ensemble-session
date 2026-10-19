import type { Database } from "./db"
import { assertMissionMemberModel } from "./mission-policy"

/** A parsed provider/model pair, as accepted by session.promptAsync. */
export interface ParsedModel {
  providerID: string
  modelID: string
}

/**
 * Parse a "provider/model" string into { providerID, modelID } for the SDK.
 * Returns undefined if the string is not in "provider/model" form (empty
 * provider or empty model). The model portion may itself contain slashes.
 */
export function parseModelId(model: string): ParsedModel | undefined {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

/**
 * Read a team member's stored model and parse it for session.promptAsync.
 * Returns undefined when the member is unknown, has no model set, or the
 * stored value is malformed. Never throws — safe to call from delivery paths.
 */
export function getMemberModel(db: Database, teamId: string, memberName: string): ParsedModel | undefined {
  const row = db.query("SELECT model FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { model: string | null } | null
  if (!row?.model) return undefined
  return parseModelId(row.model)
}

/** Read a stored native model/variant pair for all subsequent member deliveries. */
export function getMemberPromptModel(db: Database, teamId: string, memberName: string): { model?: ParsedModel; variant?: string } {
  const row = db.query("SELECT model, model_variant, model_routing FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { model: string | null; model_variant: string | null; model_routing: string | null } | null
  assertMissionMemberModel(db, teamId, row)
  const model = row?.model ? parseModelId(row.model) : undefined
  if (!model) return {}
  return { model, ...(row?.model_variant ? { variant: row.model_variant } : {}) }
}
