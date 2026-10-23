import type { Database } from "../db"
import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { assertMissionAdmission, hasMissionPolicy, routeMissionTask, saveMissionTaskRoute } from "../mission-policy"
import { getMemberPromptModel } from "../member-model"
import { notifyLead } from "../notify"
import { hasAutonomousAssignment, startTaskPlanning, taskExecutionInstructions } from "../task-execution"

/**
 * Atomically claim a pending task for an assignee. Sets status to
 * 'in_progress' and records the assignee. Throws if the task is missing,
 * blocked, already claimed, or no longer pending. Returns the task content
 * on success.
 *
 * Shared by team_claim and team_spawn's claim_task auto-claim so both paths
 * enforce the same atomic claim invariant.
 */
export function claimTask(db: Database, teamId: string, taskId: string, assignee: string): string {
  assertMissionAdmission(db, teamId)
  const mission = db.query("SELECT mission_state FROM team WHERE id = ?").get(teamId) as { mission_state: string } | null
  if (mission?.mission_state === "critical") throw new Error("Mission is critical; resolve the classification safety/budget failure before claiming work")
  const task = db.query("SELECT content, status, assignee, classification_status, execution_request, execution_decision FROM team_task WHERE id = ? AND team_id = ?")
    .get(taskId, teamId) as { content: string; status: string; assignee: string | null; classification_status: string; execution_request: string | null; execution_decision: string | null } | null
  if (!task) throw new Error(`Task "${taskId}" not found`)
  if (task.execution_request && !task.execution_decision) throw new Error("Task execution proposal requires a supervisor decision before admission")
  if (!["not_required", "completed"].includes(task.classification_status)) throw new Error(`Task "${taskId}" is awaiting classification (${task.classification_status})`)
  if (task.status === "blocked") throw new Error(`Task "${taskId}" is blocked by unresolved dependencies`)
  if (task.status !== "pending") throw new Error(`Task "${taskId}" is not pending (status: ${task.status})`)
  if (task.assignee) throw new Error(`Task "${taskId}" is already claimed by ${task.assignee}`)

  // Atomic claim: UPDATE only if still pending and unassigned
  const route = routeMissionTask(db, teamId, taskId)
  db.transaction(() => {
    if (route) {
      const active = db.query("SELECT id FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress' AND id != ?").get(teamId, assignee, taskId)
      if (active) throw new Error(`Assignee ${assignee} already has an in-progress mission task`)
      const approved = assertMissionAdmission(db, teamId)
      if (approved?.hash !== route.policyHash || approved.revision !== route.policyRevision) throw new Error("Mission approval changed during claim")
    }
    const result = db.run(
    "UPDATE team_task SET status = 'in_progress', assignee = ?, time_updated = ? WHERE id = ? AND team_id = ? AND status = 'pending' AND assignee IS NULL AND classification_status IN ('not_required', 'completed') AND team_id IN (SELECT id FROM team WHERE mission_state != 'critical')",
    [assignee, Date.now(), taskId, teamId]
    )

    if (result.changes === 0) throw new Error(`Task "${taskId}" is already claimed (race condition)`)
    if (route) saveMissionTaskRoute(db, teamId, taskId, assignee, route)
  })()

  return task.content
}

/**
 * Execute the team_claim tool. Atomically claims a pending task.
 * Rejects if the task is already claimed, blocked, or not pending.
 */
export async function executeTeamClaim(
  deps: ToolDeps,
  args: { task_id: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const claimerName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")
  const governedWorker = teamInfo.role === "member" && hasMissionPolicy(deps.db, teamInfo.teamId)
  const pinModel = governedWorker ? deps.client.session.switchModel?.bind(deps.client.session) : undefined
  if (governedWorker && !pinModel) throw new Error("Direct mission claims require native model switching on this host; request a routed assignment from the lead")
  const content = claimTask(deps.db, teamInfo.teamId, args.task_id, claimerName)
  if (pinModel) {
    try {
      const selection = getMemberPromptModel(deps.db, teamInfo.teamId, claimerName)
      if (!selection.model) throw new Error("No approved native model for the claimed task")
      if (hasAutonomousAssignment(deps, sessionId)) await startTaskPlanning(deps, teamInfo.teamId, claimerName, sessionId)
      else await pinModel({ sessionID: sessionId, model: selection.model, ...(selection.variant ? { variant: selection.variant } : {}) })
    } catch (error) {
      deps.db.transaction(() => {
        deps.db.run("UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE id = ? AND team_id = ? AND assignee = ? AND status = 'in_progress'",
          [Date.now(), args.task_id, teamInfo.teamId, claimerName])
        deps.db.run("UPDATE team_member SET status = 'error', time_updated = ? WHERE team_id = ? AND name = ?", [Date.now(), teamInfo.teamId, claimerName])
      })()
      deps.registry.unregister(sessionId)
      notifyLead(deps.client, deps.db, teamInfo.teamId, `Worker ${claimerName} could not apply its mission model; task ${args.task_id} was released and the worker retained for recovery: ${String(error)}`)
      throw new Error(`Mission native model selection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return `Claimed task: ${content}\n${taskExecutionInstructions(deps, sessionId)}`.trim()
}
