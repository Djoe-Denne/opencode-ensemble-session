import type { ToolDeps } from "../types"
import { generateId, generateProjectName, validateProjectName, validateTeamName } from "../util"
import { findTeamBySession } from "../types"
import { isSessionAlive } from "../recovery"
import { archiveTeam } from "../team-archive"
import { getTeamResourceParts, preserveBranch, preservedBranchName } from "./merge-helper"
import { resolveMissionClassification, type MissionClassificationConfig } from "../mission-classification"
import { createExecutionPolicy, nativeExecutionCatalogue } from "../execution-policy"
import { createHash } from "node:crypto"

/**
 * Execute the team_create tool. Creates a new team with the caller as lead.
 */
export async function executeTeamCreate(
  deps: ToolDeps,
  args: { name: string; project_name?: string; mission_mode?: "supervised" | "long_run"; classification?: Partial<MissionClassificationConfig> },
  sessionId: string,
  onCreated?: (teamId: string) => void,
): Promise<string> {
  const nameError = validateTeamName(args.name)
  if (nameError) throw new Error(nameError)
  if (args.project_name) {
    const projectNameError = validateProjectName(args.project_name)
    if (projectNameError) throw new Error(projectNameError)
  }

  // Check if team name already exists
  const projectId = deps.directory
  const existing = deps.db.query("SELECT id, lead_session_id FROM team WHERE name = ? AND project_id = ? AND status = 'active'")
    .get(args.name, projectId) as { id: string; lead_session_id: string } | undefined
  if (existing) {
    // The existing team's lead session may have been deleted externally (via
    // OpenCode's own session UI/API, not team_cleanup) rather than genuinely
    // still being in use. Reconcile on demand rather than block this call on a
    // team nobody can ever be lead of again -- don't wait for the next plugin
    // restart's periodic recoverOrphanedTeams pass to notice.
    if (await isSessionAlive(deps.client, existing.lead_session_id)) {
      throw new Error(`Team "${args.name}" already exists`)
    }
    const resource = getTeamResourceParts(deps.db, existing.id)
    await archiveTeam({
      db: deps.db,
      teamId: existing.id,
      directory: deps.directory,
      preserve: deps.preserveBranch ?? preserveBranch,
      abort: sessionId => deps.client.session.abort({ sessionID: sessionId }),
      preservedName: memberName => preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName),
    })
    deps.registry.unregisterTeam(existing.id)
  }

  // Check if session already leads a team
  const lead = findTeamBySession(deps.db, deps.registry, sessionId)
  if (lead) throw new Error(`This session already belongs to team "${lead.teamName}"`)

  const classification = await resolveMissionClassification(deps, { ...args.classification, ...(args.mission_mode !== undefined ? { missionMode: args.mission_mode } : {}) })
  // Command-prepared missions install their own approval gate via onCreated.
  // Direct V2 teams freeze the same catalogue policy at their explicit creation.
  const execution = !onCreated && !deps.config.missionPolicy && deps.config.modelRouting.models.length && deps.client.continuity && deps.client.session.switchModel && deps.nativeModels
    ? createExecutionPolicy(nativeExecutionCatalogue(deps.config.modelRouting.models, await deps.nativeModels()), deps.config.startingIntelligence, deps.config.modelRouting.beta, deps.config.planningIntelligenceRange) : undefined

  const id = generateId("team")
  const now = Date.now()
  const projectName = args.project_name ?? generateProjectName()
  deps.db.transaction(() => {
    // Capability discovery yields. Recheck under the creation transaction so
    // concurrent commands cannot give one lead multiple active teams.
    if (findTeamBySession(deps.db, deps.registry, sessionId)) throw new Error("This session already belongs to a team")
    deps.db.run(
    `INSERT INTO project (id, name, path, status, time_created, time_updated)
     VALUES (?, ?, ?, 'active', ?, ?)
     ON CONFLICT(id) DO UPDATE SET time_updated = excluded.time_updated`,
    [projectId, projectName, projectId, now, now]
  )
    deps.db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, classification_policy, mission_mode) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)",
    [id, args.name, projectId, sessionId, now, now, JSON.stringify(classification), classification.missionMode ?? "supervised"]
  )
    onCreated?.(id)
    if (execution) {
      const json = JSON.stringify(execution)
      deps.db.run("INSERT INTO mission_policy_revision (team_id, revision, policy_hash, policy_json, time_created) VALUES (?, 1, ?, ?, ?)",
        [id, createHash("sha256").update(json).digest("hex"), json, now])
    }
  })()

  return `Team "${args.name}" created. You are the lead. Use team_spawn to add teammates.\nClassification: ${classification.reason}`
}
