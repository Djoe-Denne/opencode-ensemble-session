import type { ToolDeps } from "./types"

interface ClosureTeam { id: string; status: string }

function assertFinished(deps: ToolDeps, teamId: string): string[] {
  const policy = deps.db.query("SELECT approved_hash FROM mission_policy WHERE team_id = ?").get(teamId) as { approved_hash: string | null } | null
  if (!policy?.approved_hash) throw new Error("Only an approved mission can be closed")
  const open = deps.db.query("SELECT id FROM team_task WHERE team_id = ? AND status != 'completed' LIMIT 1").get(teamId)
  if (open) throw new Error("Every task must be completed and accepted before close; no tasks are cancelled implicitly")
  const members = deps.db.query("SELECT session_id, status, execution_status, spawn_pending FROM team_member WHERE team_id = ?").all(teamId) as Array<{
    session_id: string; status: string; execution_status: string; spawn_pending: number
  }>
  if (members.some(m => !["shutdown", "error"].includes(m.status) || m.spawn_pending !== 0 ||
      !["idle", "completed", "failed", "cancelled", "timed_out"].includes(m.execution_status))) {
    throw new Error("All members and admissions must be stopped before close")
  }
  if (deps.db.query("SELECT session_id FROM classification_helper WHERE team_id = ? LIMIT 1").get(teamId)) {
    throw new Error("Classification helper still registered; resolve it before close")
  }
  if (deps.db.query("SELECT id FROM preparation_run WHERE team_id = ? AND status = 'running' LIMIT 1").get(teamId)) {
    throw new Error("Preparation still running; resolve it before close")
  }
  if (deps.db.query("SELECT id FROM member_result WHERE team_id = ? AND superseded = 0 AND read = 0 LIMIT 1").get(teamId)) {
    throw new Error("Unread member results must be reviewed before close")
  }
  return members.map(m => m.session_id)
}

/** Close a finished lead-owned mission without retiring any resources. */
export async function closeMission(deps: ToolDeps, sessionId: string): Promise<{ teamId: string; alreadyClosed: boolean }> {
  // An archived retry must not accidentally target a new/different project or
  // reinterpret `close` as a fresh objective. No Git or filesystem API is used.
  const team = deps.db.query(`SELECT t.id, t.status FROM team t JOIN project p ON p.id = t.project_id
    WHERE t.lead_session_id = ? AND p.path = ?
    ORDER BY CASE WHEN t.status = 'active' THEN 0 ELSE 1 END, t.time_created DESC LIMIT 1`)
    .get(sessionId, deps.directory) as ClosureTeam | null
  if (!team) throw new Error("Only the mission lead in its project can close the mission")
  const alreadyClosed = team.status === "archived"
  if (!alreadyClosed) {
    const sessions = assertFinished(deps, team.id)
    const native = (await deps.client.session.status()).data
    if (!native || typeof native !== "object" || Array.isArray(native) ||
        Object.values(native).some(s => !s || typeof s.type !== "string")) {
      throw new Error("Cannot close without verified native session status")
    }
    // The lead necessarily runs this command; only worker activity is a blocker.
    if (sessions.some(id => native[id] && native[id].type !== "idle")) {
      throw new Error("A stopped member still has native activity; close refused")
    }
    deps.db.transaction(() => {
      assertFinished(deps, team.id)
      deps.db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ? AND status = 'active'", [Date.now(), team.id])
    })()
  }
  // Preserve mission_state (including safety stops), every policy revision,
  // member/result/task and all worktree/branch pointers for later explicit cleanup.
  deps.registry.unregisterTeam(team.id)
  try {
    await deps.syncMissionPermissions?.(team.id, true)
  } catch {
    throw new Error("Mission archived with all resources retained; native permission restoration incomplete. Retry close to reconcile it.")
  }
  return { teamId: team.id, alreadyClosed }
}
