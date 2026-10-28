import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { pumpTeam } from "../dispatch"
import { log } from "../log"

/**
 * Execute the team_tasks_complete tool. Marks a task as completed
 * and unblocks any dependent tasks.
 *
 * Enforces task-board accuracy (issue #27):
 * - Rejects completing an already-completed or cancelled task.
 * - Rejects completing a blocked task (dependencies must resolve first).
 * - Only the assignee (or the lead) may complete a claimed task.
 * - Completing an unclaimed task attributes it to the caller atomically.
 */
export async function executeTeamTasksComplete(
  deps: ToolDeps,
  args: { task_id: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  const caller = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  const task = deps.db.query("SELECT id, content, status, assignee, model_routing, publication, completion_policy, control_revision FROM team_task WHERE id = ? AND team_id = ? AND (? = 1 OR publication = 'published')")
    .get(args.task_id, teamInfo.teamId, teamInfo.role === "lead" ? 1 : 0) as { id: string; content: string; status: string; assignee: string | null; model_routing: string | null; publication: string; completion_policy: string; control_revision: number } | null
  if (!task) throw new Error(`Task "${args.task_id}" not found`)
  if (task.publication === "deferred") throw new Error("Publish the deferred task before completing it")
  if (task.completion_policy === "lead" && teamInfo.role !== "lead") throw new Error("Only the lead may accept and complete this integration-gated task")
  const execution = task.model_routing ? (JSON.parse(task.model_routing) as { execution?: { applying?: boolean; phase: string } }).execution : undefined
  if (execution?.applying) throw new Error("Task has a pending native execution transition; resolve it before completion")
  const owner = task.assignee ? deps.db.query("SELECT report_mode FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, task.assignee) as { report_mode: string } | null : null
  const candidates = deps.db.query("SELECT task_ids FROM member_result WHERE team_id = ?").all(teamInfo.teamId) as Array<{ task_ids: string }>
  const hasCandidate = candidates.some(candidate => (JSON.parse(candidate.task_ids) as string[]).includes(args.task_id))
  if ((owner?.report_mode === "final_response" || hasCandidate) && teamInfo.role !== "lead") throw new Error("Only the lead may validate and complete a native-response task after persisting/integrating its candidate")
  if (execution?.phase === "planning" && teamInfo.role !== "lead") throw new Error("Finish planning and enter implementation before completing the task")
  if (task.status === "completed") throw new Error(`Task "${args.task_id}" is already completed`)
  if (task.status === "cancelled") throw new Error(`Task "${args.task_id}" was cancelled`)
  if (task.status === "blocked") throw new Error(`Task "${args.task_id}" is blocked by unresolved dependencies`)
  if (task.status === "in_progress" && task.assignee && teamInfo.role !== "lead" && caller !== task.assignee) {
    throw new Error(`Task "${args.task_id}" is claimed by ${task.assignee}`)
  }

  const now = Date.now()
  if (task.assignee) {
    const changed = deps.db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ? AND publication = 'published' AND control_revision = ? AND status = ? AND assignee = ?",
      [now, args.task_id, task.control_revision, task.status, task.assignee])
    if (!changed.changes) throw new Error("Task changed during completion; reread the board before accepting it")
  } else {
    // Attribute an unclaimed task to the caller so the board reflects who did it.
    const result = deps.db.run(
      "UPDATE team_task SET status = 'completed', assignee = ?, time_updated = ? WHERE id = ? AND assignee IS NULL AND publication = 'published' AND control_revision = ? AND status = ?",
      [caller, now, args.task_id, task.control_revision, task.status]
    )
    if (result.changes === 0) {
      throw new Error(`Task "${args.task_id}" was just completed by another teammate`)
    }
  }

  // Unblock dependent tasks
  const allTasks = deps.db.query("SELECT id, depends_on, status, publication FROM team_task WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ id: string; depends_on: string | null; status: string; publication: string }>

  let unblocked = 0
  for (const t of allTasks) {
    if (t.status !== "blocked" || !t.depends_on) continue
    const depIds: string[] = JSON.parse(t.depends_on)
    if (!depIds.includes(args.task_id)) continue

    const allResolved = depIds.every(depId => {
      if (depId === args.task_id) return true
      const dep = allTasks.find(d => d.id === depId)
      return dep && (dep.status === "completed" || dep.status === "cancelled")
    })

    if (allResolved) {
      deps.db.run("UPDATE team_task SET status = 'pending', time_updated = ? WHERE id = ?", [now, t.id])
      if (t.publication === "published" || teamInfo.role === "lead") unblocked++
    }
  }

  // Fire progress toast so the lead has visibility
  const counts = deps.db.query(
    "SELECT status, COUNT(*) as c FROM team_task WHERE team_id = ? AND publication = 'published' GROUP BY status"
  ).all(teamInfo.teamId) as Array<{ status: string; c: number }>
  const completed = counts.find(r => r.status === "completed")?.c ?? 0
  const total = counts.reduce((sum, r) => sum + r.c, 0)
  const who = teamInfo.memberName ?? "teammate"
  try {
    deps.client.tui.showToast({
      title: "Team",
      message: `${who}: ${completed}/${total} tasks complete`,
      variant: "info",
      duration: 3000,
    }).catch(() => { /* TUI may not be available */ })
  } catch { log(`tasks-complete:toast:failed`) }

  const unblockedMsg = unblocked > 0 ? ` Unblocked ${unblocked} dependent task${unblocked !== 1 ? "s" : ""}.` : ""

  // Pull-based pool: newly unblocked work may exceed idle capacity — feed
  // idle members, then scale up within the cap (opt-in — docs/task-pool.md).
  pumpTeam(deps, teamInfo.teamId)

  return `Completed task: ${task.content}${unblockedMsg}`
}
