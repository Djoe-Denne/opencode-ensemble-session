import type { SpawnContext, ToolDeps } from "../types"
import { taskSpawnContext } from "../session-continuity"
import { requireTeamMember } from "./shared"
import { generateId } from "../util"
import { pumpTeam } from "../dispatch"
import { validateTaskRoutingScores } from "../model-router"
import { classificationReadiness, getMissionClassification } from "../mission-classification"
import { classifyBoardTasks, retireDirectClassifications } from "../board-classification"
import { log } from "../log"
import { assertMissionAdmission } from "../mission-policy"
import { executionStarts, routeExecution, validateTaskExecutionDecision, type AuthorizedTaskExecution, type TaskExecutionDecision } from "../execution-policy"

interface TaskInput {
  content: string
  priority: string
  depends_on?: string[]
  /** Optional agent type affinity for pool dispatch (docs/task-pool.md). */
  agent?: string
  /** Requires a new session satisfying this context, never idle-worker reuse. */
  context?: SpawnContext
  complexity?: number
  risk?: number
  task_type?: string
  classification_input?: Record<string, unknown>
  execution?: TaskExecutionDecision
}

/**
 * Execute the team_tasks_add tool. Adds tasks to the shared board.
 * Tasks with unresolved dependencies are marked as 'blocked'.
 */
export async function executeTeamTasksAdd(
  deps: ToolDeps,
  args: { tasks: TaskInput[]; execution_decisions?: Array<TaskExecutionDecision & { task_id: string }> },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  const policy = getMissionClassification(deps.db, teamInfo.teamId)
  const decisions = args.execution_decisions ?? []
  if (decisions.length && teamInfo.role !== "lead") throw new Error("Only the lead supervisor can authorize task execution decisions")
  if (new Set(decisions.map(decision => decision.task_id)).size !== decisions.length) throw new Error("Duplicate task execution decisions")
  const request = (input: TaskExecutionDecision): TaskExecutionDecision => {
    const value = { mode: input.mode, kind: input.kind, ...(input.model !== undefined ? { model: input.model } : {}), ...(input.variant !== undefined ? { variant: input.variant } : {}), ...(input.reason !== undefined ? { reason: input.reason } : {}) }
    validateTaskExecutionDecision(value)
    return value
  }
  const requests = args.tasks.map(task => task.execution === undefined ? undefined : request(task.execution))
  const contexts = args.tasks.map(task => task.context === undefined ? undefined : taskSpawnContext(task.context, sessionId))
  const updates = decisions.map(decision => ({ taskID: decision.task_id, decision: request(decision) }))
  updates.forEach(({ taskID }) => {
    const row = deps.db.query("SELECT status, assignee, model_routing FROM team_task WHERE id=? AND team_id=?").get(taskID, teamInfo.teamId) as { status: string; assignee: string | null; model_routing: string | null } | null
    if (!row || !["pending", "blocked"].includes(row.status) || row.assignee || row.model_routing) throw new Error("Execution decisions require an unassigned, not-yet-admitted pending or blocked task")
  })
  const authorizations = [...(teamInfo.role === "lead" ? requests.filter(value => value !== undefined) : []), ...updates.map(update => update.decision)]
  const routed = authorizations.filter(decision => decision.mode === "direct" || decision.model !== undefined)
  const admittedPolicy = (() => {
    if (!routed.length) return undefined
    const snapshot = assertMissionAdmission(deps.db, teamInfo.teamId)
    if (!snapshot || snapshot.policy.version === 1) throw new Error("Explicit execution choices require an approved execution catalogue")
    return snapshot
  })()
  if (admittedPolicy && admittedPolicy.policy.version !== 1) {
    const executionPolicy = admittedPolicy.policy
    const catalogue = executionStarts(executionPolicy, "direct")
    const native = deps.nativeModels ? await deps.nativeModels() : []
    routed.forEach(decision => {
      routeExecution(executionPolicy, "decision-preflight", undefined, { ...decision, authorizedBy: sessionId })
      const candidates = catalogue.filter(model => !decision.model || (model.id === decision.model && model.variant === decision.variant))
      if (!candidates.length) throw new Error("Task selection is outside the approved catalogue")
      if (!candidates.some(model => native.some(candidate => candidate.id === model.id && candidate.variant === model.variant))) throw new Error("Native model/variant unavailable for task execution")
    })
  }

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

  const missionPolicy = deps.db.query("SELECT team_id FROM mission_policy WHERE team_id = ?").get(teamInfo.teamId) as { team_id: string } | null
  const readiness = classificationReadiness(policy)
  if (!missionPolicy && !readiness.ready && args.tasks.some((task, index) =>
    !(teamInfo.role === "lead" && requests[index]?.mode === "direct") && (task.complexity === undefined || task.risk === undefined))) {
    throw new Error(readiness.reason)
  }

  const now = Date.now()

  const ids = deps.db.transaction(() => {
    if (admittedPolicy) {
      const current = assertMissionAdmission(deps.db, teamInfo.teamId)
      if (current?.hash !== admittedPolicy.hash || current.revision !== admittedPolicy.revision) throw new Error("Mission approval changed during execution decision")
    }
    updates.forEach(({ taskID, decision }) => {
      const authorization: AuthorizedTaskExecution = { ...decision, authorizedBy: sessionId }
      if (decision.mode === "planned" && policy && (policy.method !== "manual" || policy.specialized)) {
        deps.db.run(`UPDATE team_task SET classification_status = 'pending'
          WHERE id = ? AND team_id = ? AND status IN ('pending', 'blocked') AND assignee IS NULL AND model_routing IS NULL
            AND json_extract(execution_decision, '$.mode') = 'direct' AND (complexity IS NULL OR risk IS NULL)
            AND (? != 'manual' OR (? = 1 AND task_type = 'x86'))`, [taskID, teamInfo.teamId, policy.method, policy.specialized ? 1 : 0])
      }
      const changed = deps.db.run("UPDATE team_task SET execution_decision=?, time_updated=? WHERE id=? AND team_id=? AND status IN ('pending', 'blocked') AND assignee IS NULL AND model_routing IS NULL",
        [JSON.stringify(authorization), now, taskID, teamInfo.teamId])
      if (!changed.changes) throw new Error("Task was admitted during its execution decision")
    })
    const added = args.tasks.map((task, index) => {
      const id = generateId("task")
      const depsJson = task.depends_on?.length ? JSON.stringify(task.depends_on) : null
      const agent = task.agent?.trim() || null
      const resolved = task.depends_on?.every(depId => {
        const dep = deps.db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?")
          .get(depId, teamInfo.teamId) as { status: string } | null
        return dep && (dep.status === "completed" || dep.status === "cancelled")
      }) ?? true

      deps.db.run(
        "INSERT INTO team_task (id, team_id, content, status, priority, depends_on, agent, complexity, risk, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, teamInfo.teamId, task.content, resolved ? "pending" : "blocked", task.priority, depsJson, agent, task.complexity ?? null, task.risk ?? null, now, now]
      )
      if (contexts[index]) deps.db.run("UPDATE team_task SET spawn_context=? WHERE id=?", [JSON.stringify(contexts[index]), id])
      deps.db.run("UPDATE team_task SET task_type = ?, classification_input = ?, classification_status = ? WHERE id = ?",
        [task.task_type ?? null, task.classification_input ? JSON.stringify(task.classification_input) : null,
          policy && (policy.method !== "manual" || (policy.specialized && task.task_type === "x86")) && (task.complexity === undefined || task.risk === undefined) ? "pending" : "not_required", id])
      const execution = requests[index]
      if (execution) deps.db.run("UPDATE team_task SET execution_request=?, execution_decision=? WHERE id=?",
        [JSON.stringify(execution), teamInfo.role === "lead" ? JSON.stringify({ ...execution, authorizedBy: sessionId }) : null, id])
      return id
    })
    retireDirectClassifications(deps.db, teamInfo.teamId)
    return added
  })()

  // Pull-based pool: newly added work may exceed idle capacity — feed idle
  // members, then scale up within the cap (opt-in — docs/task-pool.md).
  pumpTeam(deps, teamInfo.teamId)
  void classifyBoardTasks(deps, teamInfo.teamId).catch(error => { log(`classification:drain-failed ${String(error)}`) })

  return `Added ${ids.length} task${ids.length !== 1 ? "s" : ""}: ${ids.join(", ")}${updates.length ? `; recorded ${updates.length} supervisor execution decision(s)` : ""}`
}
