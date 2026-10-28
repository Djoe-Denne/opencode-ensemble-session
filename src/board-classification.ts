import type { ToolDeps } from "./types"
import type { Database } from "./db"
import { createHash } from "node:crypto"
import { getMissionClassification, type MissionClassificationPolicy } from "./mission-classification"
import { generateId } from "./util"
import { notifyLead } from "./notify"
import { pumpTeam } from "./dispatch"
import { runClassification } from "./classification-runtime"
import { assertMissionAdmission } from "./mission-policy"
import { log } from "./log"

interface ClassificationTask {
  id: string
  content: string
  complexity: number | null
  risk: number | null
  task_type: string | null
  classification_input: string | null
  status: string
  assignee: string | null
  classification_token: string | null
  publication: string
}

const inFlight = new WeakMap<Database, Map<string, Promise<void>>>()

/** Retire classification leases for supervisor-authorized direct tasks without resetting safety budgets. */
export function retireDirectClassifications(db: Database, teamId: string): void {
  db.run(`UPDATE team_task SET classification_status = 'not_required', classification_token = NULL,
    classification_until = NULL, classification_error = NULL, classification_result = NULL
    WHERE team_id = ? AND status IN ('pending', 'blocked') AND assignee IS NULL
      AND json_extract(execution_decision, '$.mode') = 'direct'
      AND json_extract(execution_decision, '$.authorizedBy') = (SELECT lead_session_id FROM team WHERE id = ?)`, [teamId, teamId])
}

function fingerprint(task: ClassificationTask, policy: MissionClassificationPolicy): string {
  return createHash("sha256").update(JSON.stringify([task.content, task.complexity, task.risk, task.task_type, task.classification_input, policy])).digest("hex")
}

/** Drain the team's pending classifications asynchronously, with atomic admission. */
export function classifyBoardTasks(deps: ToolDeps, teamId: string): Promise<void> {
  const running = inFlight.get(deps.db) ?? new Map<string, Promise<void>>()
  inFlight.set(deps.db, running)
  const existing = running.get(teamId)
  if (existing) return existing
  const work = Promise.resolve().then(() => drain(deps, teamId)).finally(() => running.delete(teamId))
  running.set(teamId, work)
  return work
}

async function drain(deps: ToolDeps, teamId: string): Promise<void> {
  // Revisions/recovery can requeue classifications; direct authorization still wins.
  retireDirectClassifications(deps.db, teamId)
  const retained = deps.db.query("SELECT session_id FROM classification_helper WHERE team_id = ? AND lease_until <= ?").all(teamId, Date.now()) as Array<{ session_id: string }>
  for (const helper of retained) {
    try {
      if (!deps.classifier?.removeHelper) throw new Error("Native helper removal unavailable")
      await deps.classifier.removeHelper(helper.session_id)
      deps.db.run("DELETE FROM classification_helper WHERE session_id = ?", [helper.session_id])
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return
      deps.db.run("UPDATE team SET mission_state = 'critical' WHERE id = ?", [teamId])
      notifyLead(deps.client, deps.db, teamId, `Critical classification recovery: helper ${helper.session_id} could not be removed: ${String(error)}. No new classification helpers will be allocated.`)
      return
    }
  }
  // Lease expiry permits crash recovery. Admission tokens reject late results;
  try { assertMissionAdmission(deps.db, teamId) } catch (error) {
    log(`mission-policy:classification-blocked team=${teamId} ${String(error)}`)
    return
  }
  // remote calls may be repeated after a crash (not an exactly-once guarantee).
  deps.db.run("UPDATE team_task SET classification_status = 'pending', classification_token = NULL WHERE team_id = ? AND classification_status = 'running' AND classification_until < ?", [teamId, Date.now()])
  const invalidations = new Map<string, number>()
  const current = (task: ClassificationTask, signature: string, token: string): boolean => {
    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get(teamId) as { status: string } | null
    const latest = deps.db.query("SELECT * FROM team_task WHERE id = ? AND team_id = ?").get(task.id, teamId) as ClassificationTask | null
    if (latest?.classification_token !== token) return false
    const policy = getMissionClassification(deps.db, teamId)
    if (team?.status === "active" && latest && ["pending", "blocked"].includes(latest.status) && !latest.assignee && policy && fingerprint(latest, policy) === signature) return true
    const attempts = (invalidations.get(task.id) ?? 0) + 1
    invalidations.set(task.id, attempts)
    const eligible = team?.status === "active" && latest && ["pending", "blocked"].includes(latest.status) && !latest.assignee
    const state = !eligible || attempts >= 3 ? "blocked" : policy?.method === "manual" ? "not_required" : "pending"
    const error = state === "blocked" ? "Classification cancelled: task/mission became ineligible or its data changed repeatedly" : null
    deps.db.run("UPDATE team_task SET classification_status = ?, classification_error = ?, classification_token = NULL, classification_until = NULL WHERE id = ? AND classification_token = ?", [state, error, task.id, token])
    return false
  }
  // Native awaits yield between tasks. Repeated edits are bounded per task,
  // without silently stranding large finite boards after an arbitrary batch cap.
  while (true) {
    const team = deps.db.query("SELECT status, mission_state FROM team WHERE id = ?").get(teamId) as { status: string; mission_state: string } | null
    if (team?.status !== "active" || team.mission_state === "critical") return
    const policy = getMissionClassification(deps.db, teamId)
    if (!policy || (policy.method === "manual" && !policy.specialized)) return
    const task = deps.db.query("SELECT * FROM team_task WHERE team_id = ? AND publication = 'published' AND classification_status = 'pending' AND status IN ('pending', 'blocked') AND assignee IS NULL ORDER BY time_created, id")
      .get(teamId) as ClassificationTask | null
    if (!task) return
    const token = generateId("classification")
    const leaseMs = (policy.limits?.maxAttempts ?? 3) * (policy.timeoutMs + (policy.limits?.retryDelayMs ?? 100) + 15_000) + 120_000
    const admitted = deps.db.run("UPDATE team_task SET classification_status = 'running', classification_token = ?, classification_until = ? WHERE id = ? AND team_id = ? AND publication = 'published' AND classification_status = 'pending' AND assignee IS NULL",
      [token, Date.now() + leaseMs, task.id, teamId])
    if (!admitted.changes) continue
    const signature = fingerprint(task, policy)
    try {
      if (!deps.classifier) throw new Error("Native classifier bridge unavailable")
      const manual = { ...(task.complexity !== null ? { complexity: task.complexity / 100 } : {}), ...(task.risk !== null ? { risk: task.risk / 100 } : {}) }
      const result = await runClassification(deps, teamId, policy, { id: task.id, token, content: task.content, type: task.task_type ?? "general", data: task.classification_input ? JSON.parse(task.classification_input) : null, manual })
      if (!current(task, signature, token)) continue
      const saved = deps.db.run("UPDATE team_task SET classification_status = 'completed', classification_result = ?, classification_error = NULL, classification_token = NULL, classification_until = NULL, time_updated = ? WHERE id = ? AND classification_token = ? AND status IN ('pending', 'blocked') AND assignee IS NULL",
        [JSON.stringify({ ...result, fingerprint: signature }), Date.now(), task.id, token])
      if (saved.changes) {
        notifyLead(deps.client, deps.db, teamId, `Task ${task.id} classified by ${result.toolId || result.classifierModel || policy.method}: complexity=${result.complexity}, risk=${result.risk} (0–1).`)
        await pumpTeam(deps, teamId)
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        deps.db.run("UPDATE team_task SET classification_status = 'pending', classification_token = NULL, classification_until = NULL WHERE id = ? AND classification_token = ?", [task.id, token])
        return
      }
      if (!current(task, signature, token)) continue
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
      const blocked = deps.db.run("UPDATE team_task SET classification_status = 'blocked', classification_error = ?, classification_token = NULL, classification_until = NULL, time_updated = ? WHERE id = ? AND classification_token = ?",
        [message, Date.now(), task.id, token])
      if (blocked.changes) {
        if (policy.missionMode !== "long_run") deps.db.run("UPDATE team SET mission_state = 'attention' WHERE id = ? AND mission_state != 'critical'", [teamId])
        notifyLead(deps.client, deps.db, teamId, `Classification blocked for task ${task.id}: ${message}. ${policy.missionMode === "long_run" ? "Independent tasks continue unless a critical budget/safety failure stopped admission." : "Authorized methods exhausted; ask the user for an explicit method/model or manual scores."} The lead can explicitly update classification through team_message(to=lead); no unauthorized fallback has been selected.`)
      }
    }
  }
}
