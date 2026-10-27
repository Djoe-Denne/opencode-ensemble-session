import type { Database } from "./db"
import type { ToolDeps } from "./types"
import { claimTask } from "./tools/team-claim"
import { executeTeamSpawn } from "./tools/team-spawn"
import { getMemberPromptModel } from "./member-model"
import { hasAutonomousAssignment, startTaskPlanning, taskExecutionInstructions } from "./task-execution"
import { log } from "./log"
import { assertMissionAdmission } from "./mission-policy"
import { notifyLead } from "./notify"

/** A task candidate the pool can hand to an idle member. */
export interface PoolTask {
  id: string
  content: string
}

/** How many candidates to try before giving up (race-fallback bound). */
const MAX_CLAIM_ATTEMPTS = 5

/** Priority rank for deterministic ordering: high=0, medium=1, low=2. */
function priorityRank(priority: string): number {
  return priority === "high" ? 0 : priority === "low" ? 2 : 1
}

/**
 * Pick the board tasks an idle member could take, best first. Eligible tasks
 * are pending, unassigned, and either unaffiliated or reserved for the
 * member's agent type. Order: exact affinity match first, then priority
 * (high > medium > low), then FIFO (the SQL keeps time_created ASC and the
 * sort is stable). Bounded to `limit` candidates.
 */
export function pickNextTask(db: Database, teamId: string, agentType: string, limit = MAX_CLAIM_ATTEMPTS): PoolTask[] {
  const rows = db.query(
    `SELECT id, content, agent, priority FROM team_task
      WHERE team_id = ? AND status = 'pending' AND assignee IS NULL
        AND spawn_context IS NULL
        AND classification_status IN ('not_required', 'completed')
        AND (execution_request IS NULL OR execution_decision IS NOT NULL)
        AND team_id IN (SELECT id FROM team WHERE mission_state != 'critical')
       AND (agent IS NULL OR agent = ?)
     ORDER BY time_created ASC`,
  ).all(teamId, agentType) as Array<{ id: string; content: string; agent: string | null; priority: string }>

  return rows
    .sort((a, b) => {
      const affinity = Number(b.agent !== null) - Number(a.agent !== null)
      if (affinity !== 0) return affinity
      return priorityRank(a.priority) - priorityRank(b.priority)
    })
    .slice(0, limit)
    .map(({ id, content }) => ({ id, content }))
}

export function nextWorkerName(db: Database, teamId: string): string {
  const rows = db.query("SELECT name FROM team_member WHERE team_id = ? AND name LIKE 'pool-%'")
    .all(teamId) as Array<{ name: string }>
  let max = 0
  for (const { name } of rows) {
    const n = Number.parseInt(name.slice("pool-".length), 10)
    if (Number.isInteger(n) && n > max) max = n
  }
  return `pool-${max + 1}`
}

/** Auto-scale spawn workers in flight per team — one spawn per pump, no storms. */
const scaleInFlight = new Set<string>()

/**
 * Maximize pool utilization: feed every idle member, then spawn additional
 * workers while eligible work remains and the active-member cap allows.
 *
 * Feed phase reuses dispatchNextTask (atomic claims, affinity ordering).
 * Scale phase picks the best remaining task (unaffiliated/build-affinity
 * first, then priority, then FIFO), derives the worker's agent type from the
 * task affinity (default "build"), names it pool-<N>, and spawns through
 * executeTeamSpawn — so the concurrency cap, worktree isolation, permission
 * rules, circuit breaker, and rollback all apply unchanged. Model selection
 * follows the existing resolveModel chain: set modelPool to your providers
 * with modelAssignment "rotate" to spread workers evenly across them.
 *
 * No-op unless autoDispatch or autoScale is enabled. Callers may ignore the
 * returned promise (fire-and-forget per settled decision #10); it resolves
 * once any triggered spawn settles, which makes tests deterministic.
 */
export function pumpTeam(deps: ToolDeps, teamId: string): Promise<void> {
  if (!deps.config.autoDispatch && !deps.config.autoScale) return Promise.resolve()
  try { assertMissionAdmission(deps.db, teamId) } catch (error) {
    log(`mission-policy:admission-blocked team=${teamId} ${String(error)}`)
    return Promise.resolve()
  }

  // Feed phase: keep assigning while some idle member takes a task.
  let assigned = true
  while (assigned && deps.config.autoDispatch) {
    assigned = false
    const idle = deps.db.query(
      "SELECT name FROM team_member WHERE team_id = ? AND status = 'ready' AND spawn_pending = 0 AND report_mode = 'team_message'",
    ).all(teamId) as Array<{ name: string }>
    for (const member of idle) {
      if (dispatchNextTask(deps, teamId, member.name)) {
        assigned = true
        break
      }
    }
  }

  // Scale phase: spawn one worker when work remains and capacity allows.
  if (!deps.config.autoScale || scaleInFlight.has(teamId)) return Promise.resolve()
  const cap = deps.config.maxActiveMembers
  const active = (deps.db.query(
    "SELECT COUNT(*) as c FROM team_member WHERE team_id = ? AND status NOT IN ('shutdown', 'error')",
  ).get(teamId) as { c: number }).c
  if (cap > 0 && active >= cap) return Promise.resolve()

  const task = deps.db.query(
    `SELECT id, content, agent FROM team_task
      WHERE team_id = ? AND status = 'pending' AND assignee IS NULL
        AND classification_status IN ('not_required', 'completed')
        AND (execution_request IS NULL OR execution_decision IS NOT NULL)
        AND team_id IN (SELECT id FROM team WHERE mission_state != 'critical')
     ORDER BY (agent IS NULL OR agent = 'build') DESC,
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       time_created ASC`,
  ).get(teamId) as { id: string; content: string; agent: string | null } | null
  if (!task) return Promise.resolve()

  const team = deps.db.query("SELECT lead_session_id FROM team WHERE id = ? AND status = 'active'")
    .get(teamId) as { lead_session_id: string } | null
  if (!team) return Promise.resolve()

  const name = nextWorkerName(deps.db, teamId)
  const agent = task.agent?.trim() || "build"
  scaleInFlight.add(teamId)
  log(`pool:scale-up team=${teamId} worker=${name} agent=${agent} task=${task.id} active=${active}${cap > 0 ? `/${cap}` : ""}`)
  return executeTeamSpawn(deps, {
    name,
    agent,
    prompt: dispatchMessage({ id: task.id, content: task.content }),
    claim_task: task.id,
  }, team.lead_session_id)
    .then(() => {
      scaleInFlight.delete(teamId)
    })
    .catch((err) => {
      scaleInFlight.delete(teamId)
      log(`pool:scale-up:failed team=${teamId} worker=${name} err=${err instanceof Error ? err.message : String(err)}`)
    })
}

/** The mission delta delivered to a member alongside an auto-assigned task. */
function dispatchMessage(task: PoolTask): string {
  return [
    `[System] Auto-dispatch: you have been assigned task ${task.id}.`,
    `Task: ${task.content}`,
    "",
    "Work on it now. When done, mark it complete with team_tasks_complete and report to the lead as usual.",
    "If the task is unclear or blocked, message the lead instead of guessing.",
  ].join("\n")
}

/**
 * Assign the next eligible board task to an idle member (pull-based pool).
 * Returns the claimed task ID, or null when autoDispatch is off, the member
 * is not claimable (not ready / still initializing / unknown session), or the
 * board has nothing eligible.
 *
 * Claiming goes through the same atomic claimTask as team_claim and
 * spawn's claim_task, so a task is never double-assigned across paths. A
 * lost race falls through to the next candidate. Delivery is fire-and-forget;
 * if it fails, the claim is released back to the pool.
 */
export function dispatchNextTask(deps: ToolDeps, teamId: string, memberName: string): string | null {
  if (!deps.config.autoDispatch) return null

  const member = deps.db.query("SELECT agent, status, spawn_pending, report_mode FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { agent: string; status: string; spawn_pending: number; report_mode: string } | null
  if (!member || member.status !== "ready" || member.spawn_pending !== 0 || member.report_mode === "final_response") return null
  if (deps.db.query("SELECT id FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress' LIMIT 1").get(teamId, memberName)) return null

  const entry = deps.registry.getByName(teamId, memberName)
  if (!entry) return null

  for (const task of pickNextTask(deps.db, teamId, member.agent)) {
    try {
      claimTask(deps.db, teamId, task.id, memberName)
    } catch {
      continue // Lost a race or state changed — try the next candidate.
    }

    const model = getMemberPromptModel(deps.db, teamId, memberName)
    const deliver = () => deps.client.session.promptAsync({
      sessionID: entry.sessionId,
      parts: [{ type: "text", text: `${dispatchMessage(task)}\n${taskExecutionInstructions(deps, entry.sessionId)}`.trim() }],
      ...model,
    })
    const autonomous = hasAutonomousAssignment(deps, entry.sessionId)
    const delivery = autonomous
      ? startTaskPlanning(deps, teamId, memberName, entry.sessionId).then(deliver)
      : deliver()
    delivery.catch(error => {
      // Delivery failed — release the claim so the task returns to the pool.
      deps.db.run(
        "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE id = ? AND assignee = ? AND status = 'in_progress'",
        [Date.now(), task.id, memberName],
      )
      if (autonomous) {
        deps.db.run("UPDATE team_member SET status = 'error', time_updated = ? WHERE team_id = ? AND name = ?", [Date.now(), teamId, memberName])
        deps.registry.unregister(entry.sessionId)
        notifyLead(deps.client, deps.db, teamId, `Worker ${memberName} could not apply its execution boundary; task ${task.id} was released and the session retained for recovery: ${String(error)}`)
      }
      log(`dispatch:release team=${teamId} member=${memberName} task=${task.id}`)
    })
    log(`dispatch:assigned team=${teamId} member=${memberName} task=${task.id}`)
    return task.id
  }
  return null
}
