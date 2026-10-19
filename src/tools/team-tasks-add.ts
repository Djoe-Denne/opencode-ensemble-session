import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { generateId } from "../util"
import { pumpTeam } from "../dispatch"
import { validateTaskRoutingScores } from "../model-router"
import { getMissionClassification } from "../mission-classification"
import { classifyBoardTasks } from "../board-classification"
import { log } from "../log"

interface TaskInput {
  content: string
  priority: string
  depends_on?: string[]
  /** Optional agent type affinity for pool dispatch (docs/task-pool.md). */
  agent?: string
  complexity?: number
  risk?: number
  task_type?: string
  classification_input?: Record<string, unknown>
}

/**
 * Execute the team_tasks_add tool. Adds tasks to the shared board.
 * Tasks with unresolved dependencies are marked as 'blocked'.
 */
export async function executeTeamTasksAdd(
  deps: ToolDeps,
  args: { tasks: TaskInput[] },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  const policy = getMissionClassification(deps.db, teamInfo.teamId)

  const unknown = [...new Set(args.tasks.flatMap(task => task.depends_on ?? []))].filter(id =>
    !deps.db.query("SELECT id FROM team_task WHERE id = ? AND team_id = ?").get(id, teamInfo.teamId),
  )
  if (unknown.length) throw new Error(`Unknown depends_on task IDs in this team: ${unknown.join(", ")}`)
  args.tasks.forEach(task => {
    validateTaskRoutingScores({ complexity: task.complexity, risk: task.risk })
    if (task.task_type !== undefined && (typeof task.task_type !== "string" || !task.task_type.trim())) throw new Error("task_type must be a non-empty string")
    if (task.classification_input !== undefined) {
      if (!task.classification_input || typeof task.classification_input !== "object" || Array.isArray(task.classification_input)) throw new Error("classification_input must be an object")
      JSON.stringify(task.classification_input) // Preflight the whole batch, including circular/non-JSON input.
    }
  })

  const ids: string[] = []
  const now = Date.now()

  for (const task of args.tasks) {
    const id = generateId("task")
    const depsJson = task.depends_on?.length ? JSON.stringify(task.depends_on) : null
    const agent = task.agent?.trim() || null

    // Determine initial status — blocked if has unresolved dependencies
    let status = "pending"
    if (task.depends_on?.length) {
      const resolved = task.depends_on.every(depId => {
        const dep = deps.db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?")
          .get(depId, teamInfo.teamId) as { status: string } | null
        return dep && (dep.status === "completed" || dep.status === "cancelled")
      })
      if (!resolved) status = "blocked"
    }

    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, depends_on, agent, complexity, risk, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, teamInfo.teamId, task.content, status, task.priority, depsJson, agent, task.complexity ?? null, task.risk ?? null, now, now]
    )
    deps.db.run("UPDATE team_task SET task_type = ?, classification_input = ?, classification_status = ? WHERE id = ?",
      [task.task_type ?? null, task.classification_input ? JSON.stringify(task.classification_input) : null,
        policy && (policy.method !== "manual" || (policy.specialized && task.task_type === "x86")) && (task.complexity === undefined || task.risk === undefined) ? "pending" : "not_required", id])
    ids.push(id)
  }

  // Pull-based pool: newly added work may exceed idle capacity — feed idle
  // members, then scale up within the cap (opt-in — docs/task-pool.md).
  pumpTeam(deps, teamInfo.teamId)
  void classifyBoardTasks(deps, teamInfo.teamId).catch(error => { log(`classification:drain-failed ${String(error)}`) })

  return `Added ${ids.length} task${ids.length !== 1 ? "s" : ""}: ${ids.join(", ")}`
}
