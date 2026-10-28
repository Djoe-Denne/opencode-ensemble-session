import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { missionPolicySummary } from "../mission-policy"

/** Tracks the last time team_status was called per team ID (epoch ms). */
export const lastCallTime = new Map<string, number>()

/** Tracks the state marker (see computeStateMarker) observed at the last real read per team. */
export const lastKnownState = new Map<string, number>()

const RATE_LIMIT_MS = 30_000

/**
 * Cheap per-team "has anything changed" fingerprint — the max time_updated/time_created
 * across the three tables team_status reports on. One MAX() query, no hashing: the
 * throttle only needs to detect "something changed," not what, so this is deliberately
 * the simplest sufficient version (see Fix 3 in the spec).
 */
function computeStateMarker(deps: ToolDeps, teamId: string): number {
  const row = deps.db.query(
    `SELECT MAX(x) as marker FROM (
       SELECT MAX(time_updated) as x FROM team_member WHERE team_id = ?
       UNION SELECT MAX(time_updated) FROM team_task WHERE team_id = ?
        UNION SELECT MAX(time_created) FROM team_message WHERE team_id = ?
        UNION SELECT MAX(time_updated) FROM mission_policy WHERE team_id = ?
     )`
   ).get(teamId, teamId, teamId, teamId) as { marker: number | null } | null
  return row?.marker ?? 0
}

/** Format a duration in ms to a human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

/**
 * Execute the team_status tool. Shows team overview with member statuses and task summary.
 */
export async function executeTeamStatus(
  deps: ToolDeps,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const now = Date.now()
  const statusKey = teamInfo.role === "lead" ? teamInfo.teamId : `${teamInfo.teamId}:member`
  const last = lastCallTime.get(statusKey)
  const currentMarker = computeStateMarker(deps, teamInfo.teamId)
  // The 30s throttle's purpose is preventing hammering, not lying about state — only
  // short-circuit when nothing has actually changed since the last real read.
  if (last !== undefined && (now - last) < RATE_LIMIT_MS && lastKnownState.get(statusKey) === currentMarker) {
    return "No changes since last check."
  }
  lastCallTime.set(statusKey, now)
  lastKnownState.set(statusKey, currentMarker)

  const members = deps.db.query(
    "SELECT name, session_id, agent, status, execution_status, worktree_branch, checkout_branch, preserved_branch, worktree_state, worktree_dir, plan_approval, time_updated, last_nudged_at, retry_until, retry_attempt FROM team_member WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamInfo.teamId) as Array<{
    name: string; session_id: string; agent: string; status: string; execution_status: string; worktree_branch: string | null; checkout_branch: string | null; preserved_branch: string | null; worktree_state: string; worktree_dir: string | null; plan_approval: string; time_updated: number; last_nudged_at: number | null
    retry_until: number | null; retry_attempt: number | null
  }>

  const tasks = deps.db.query(
    "SELECT status FROM team_task WHERE team_id = ? AND (? = 1 OR publication = 'published')"
  ).all(teamInfo.teamId, teamInfo.role === "lead" ? 1 : 0) as Array<{ status: string }>

  const lines: string[] = []
  lines.push(`Team: ${teamInfo.teamName} (you are the ${teamInfo.role})`)
  const undelivered = deps.db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND delivered = 0").get(teamInfo.teamId) as { c: number }
  lines.push(`Undelivered messages: ${undelivered.c}`)
  const explicitPolicy = missionPolicySummary(deps.db, teamInfo.teamId)
  if (explicitPolicy) lines.push(explicitPolicy)
  const mission = deps.db.query("SELECT mission_mode, mission_state, classification_policy, classification_runtime FROM team WHERE id = ?").get(teamInfo.teamId) as { mission_mode: string; mission_state: string; classification_policy: string | null; classification_runtime: string | null }
  if (mission.classification_policy) {
    const policy = JSON.parse(mission.classification_policy) as { method: string; toolId: string; helperModel: string; generalModel?: string }
    const budget = mission.classification_runtime ? JSON.parse(mission.classification_runtime) as { calls: number; bytes: number } : { calls: 0, bytes: 0 }
    lines.push(`Mission: ${mission.mission_mode}/${mission.mission_state}; classification=${policy.method} (${policy.toolId || policy.generalModel || "manual"}); calls=${budget.calls}, input bytes=${budget.bytes}`)
    const counts = deps.db.query("SELECT classification_status AS state, COUNT(*) AS count FROM team_task WHERE team_id = ? AND (? = 1 OR publication = 'published') GROUP BY classification_status").all(teamInfo.teamId, teamInfo.role === "lead" ? 1 : 0) as Array<{ state: string; count: number }>
    lines.push(`Classification: ${counts.map(row => `${row.count} ${row.state}`).join(", ") || "no tasks"}`)
    const incidents = deps.db.query("SELECT kind, detail FROM classification_incident WHERE team_id = ? ORDER BY time_created DESC, id DESC LIMIT 3").all(teamInfo.teamId) as Array<{ kind: string; detail: string }>
    incidents.forEach(row => { lines.push(`  classification ${row.kind}: ${row.detail}`) })
  }
  lines.push("")

  if (members.length === 0) {
    lines.push("No teammates spawned yet.")
  } else {
    lines.push("Members:")
    for (const m of members) {
      const statusIcon = m.status === "busy" ? "working" : m.status === "ready" ? "idle" : m.status
      const duration = formatDuration(now - m.time_updated)
      const branch = m.worktree_branch ? `  branch: ${m.worktree_branch}` : ""
      const checkout = m.checkout_branch ? `  checkout: ${m.checkout_branch}` : ""
      const preserved = m.preserved_branch ? `  preserved: ${m.preserved_branch}` : ""
      const worktreeState = `  state: ${m.worktree_state}`
      const plan = m.plan_approval !== "none" ? `, plan: ${m.plan_approval}` : ""
      // Additive display-staleness annotation (Fix 1) — surfaces a soft stall-nudge
      // without inventing a new status value. Annotates the existing status, doesn't
      // replace it.
      const nudged = m.last_nudged_at ? `, nudged ${formatDuration(now - m.last_nudged_at)} ago` : ""
      // Additive provider-retry annotation (Fix 4) — derived at read time from the
      // retry_until TTL (Fix 3), same annotation pattern as `nudged` above. Generic
      // "retrying" label, no rate-limit-specific wording (Fix 2).
      const isRetrying = m.retry_until !== null && m.retry_until > now
      const retrying = isRetrying ? `, retrying (attempt ${m.retry_attempt}, ~${formatDuration(m.retry_until! - now)})` : ""

      // Last message time
      const lastMsg = deps.db.query("SELECT MAX(time_created) as last_msg FROM team_message WHERE team_id = ? AND from_name = ?")
        .get(teamInfo.teamId, m.name) as { last_msg: number | null } | null
      const msgInfo = lastMsg?.last_msg ? `last msg: ${formatDuration(now - lastMsg.last_msg)} ago` : "no messages yet"

      lines.push(`  ${m.name}  [${statusIcon} ${duration}, ${msgInfo}${plan}${nudged}${retrying}]  agent: ${m.agent}${branch}${checkout}${preserved}${worktreeState}`)

      // Current task
      const task = deps.db.query("SELECT content FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress' LIMIT 1")
        .get(teamInfo.teamId, m.name) as { content: string } | null
      if (task) {
        const truncated = task.content.length > 80 ? `${task.content.slice(0, 80)}...` : task.content
        lines.push(`    task: ${truncated}`)
      }
      if (m.worktree_dir) {
        lines.push(`    worktree: ${m.worktree_dir}`)
      }
    }
  }

  if (tasks.length > 0) {
    const byStatus = new Map<string, number>()
    for (const t of tasks) {
      byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1)
    }
    const parts = Array.from(byStatus.entries()).map(([s, n]) => `${n} ${s}`)
    lines.push("")
    lines.push(`Tasks: ${tasks.length} total (${parts.join(", ")})`)
  }

  // Fire a toast so the user (not just the model) sees the status summary
  if (members.length > 0) {
    const memberParts = members.map(m => {
      const label = m.status === "busy" ? "working" : m.status === "ready" ? "idle" : m.status
      return `${m.name} [${label}]`
    })
    let toastMsg = memberParts.join(", ")
    if (tasks.length > 0) {
      const completed = tasks.filter(t => t.status === "completed").length
      toastMsg += ` | Tasks: ${completed}/${tasks.length} done`
    }
    try {
      await deps.client.tui.showToast({
        title: "Team",
        message: toastMsg,
        variant: "info",
        duration: 4000,
      })
    } catch {
      // TUI may not be available — silently ignore
    }
  }

  return lines.join("\n")
}
