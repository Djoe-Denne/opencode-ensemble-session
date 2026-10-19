import type { Database } from "./db"
import { liveCheckoutBranch, storePreservedBranch } from "./worktree-state"

/** Injectable preservation. Returning false blocks abort and archive. */
export type ArchivePreserve = (source: string, target: string, directory: string) => Promise<boolean>

interface ArchiveMember {
  name: string
  session_id: string
  status: string
  worktree_branch: string | null
  checkout_branch: string | null
}

/**
 * Archive one team without changing mission_state.
 * Live checkout branches are copied before any session.abort.
 * Open tasks are cancelled and kept. Rows are not deleted.
 */
export async function archiveTeam(input: {
  db: Database
  teamId: string
  directory: string
  preserve: ArchivePreserve
  abort: (sessionId: string) => Promise<unknown>
  preservedName: (memberName: string, checkoutBranch: string) => string
}): Promise<void> {
  const team = input.db.query("SELECT status, mission_state FROM team WHERE id = ?").get(input.teamId) as { status: string; mission_state: string } | null
  if (!team) throw new Error(`Cannot archive missing team ${input.teamId}`)
  if (team.status === "archived") return
  const missionState = team.mission_state
  const members = input.db.query("SELECT name, session_id, status, worktree_branch, checkout_branch FROM team_member WHERE team_id = ?")
    .all(input.teamId) as ArchiveMember[]
  for (const member of members) {
    const source = liveCheckoutBranch(member)
    if (!source) continue
    const target = input.preservedName(member.name, source)
    const preserved = await input.preserve(source, target, input.directory)
    if (!preserved) throw new Error(`Refusing to archive ${input.teamId}: could not preserve ${source}`)
    storePreservedBranch(input.db, input.teamId, member.name, source, target)
  }
  for (const member of members) {
    if (member.status === "shutdown" || member.status === "error") continue
    await input.abort(member.session_id)
  }
  commitArchive(input.db, input.teamId)
  const after = input.db.query("SELECT mission_state FROM team WHERE id = ?").get(input.teamId) as { mission_state: string }
  if (after.mission_state !== missionState) throw new Error("Archive changed mission_state")
}

/** Mark the team archived, cancel open tasks, and shut down residual members. */
export function commitArchive(db: Database, teamId: string): void {
  const now = Date.now()
  db.transaction(() => {
    db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ? AND status = 'active'", [now, teamId])
    db.run("UPDATE team_task SET status = 'cancelled', time_updated = ? WHERE team_id = ? AND status IN ('pending', 'blocked', 'in_progress')", [now, teamId])
    db.run("UPDATE team_member SET status = 'shutdown', execution_status = 'cancelled', time_updated = ? WHERE team_id = ? AND status NOT IN ('shutdown', 'error')", [now, teamId])
  })()
}
