import type { Database } from "./db"
import type { PluginClient } from "./types"
import { createHash } from "node:crypto"
import { assertMissionAdmission } from "./mission-policy"
import { sendMessage } from "./messaging"
import { log } from "./log"
import { getApprovedMissionAutonomy } from "./mission-autonomy"

interface SupervisorRecoveryOptions {
  db: Database
  client: PluginClient
  projectId: string
  intervalMs?: number
  now?: () => number
  hasPendingPermission?: (sessionIDs: readonly string[]) => Promise<boolean>
}

interface Team {
  id: string
  lead_session_id: string
  time_updated: number
  mission_state?: string
}

interface Snapshot {
  fingerprint: string
  sessions: [string, ...string[]]
  longRun: boolean
}

interface RecoveryState {
  fingerprint: string
  message_id: string | null
  last_attempt: number
}

/** Conditional recovery of an idle supervisor with unfinished, unattended work. */
export class SupervisorRecovery {
  private readonly intervalMs: number
  private readonly now: () => number
  private timer?: ReturnType<typeof setInterval>
  private checking = false
  private stopped = false

  constructor(private readonly options: SupervisorRecoveryOptions) {
    this.intervalMs = options.intervalMs ?? 10 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  private observation(teamId: string, outcome: string, reason: string): void {
    this.options.db.run(`INSERT INTO supervisor_recovery_observation (team_id, checked_at, outcome, reason) VALUES (?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET checked_at = excluded.checked_at, outcome = excluded.outcome, reason = excluded.reason`,
    [teamId, this.now(), outcome, reason])
  }

  private snapshot(teamId: string): Snapshot | undefined {
    const { db, projectId } = this.options
    const skip = (reason: string): undefined => { this.observation(teamId, "skipped", reason); return undefined }
    const team = db.query(`SELECT t.id, t.lead_session_id, t.time_updated, t.mission_state FROM team t JOIN project p ON p.id = t.project_id
      WHERE t.id = ? AND t.project_id = ? AND t.status = 'active' AND p.status = 'active'`)
      .get(teamId, projectId) as Team | null
    if (!team) return skip("project_or_team_inactive")
    let longRun: boolean
    try { longRun = getApprovedMissionAutonomy(db, team.id)?.mode === "long_run" } catch { return skip("approved_policy_invalid") }
    // Waking an already-approved long run is not admission of new work. Keep
    // mutable-draft and classification barriers on spawn/claim, not diagnosis.
    if (!longRun) {
      if (team.mission_state !== "running") return skip("supervised_state_not_running")
      try { assertMissionAdmission(db, team.id) } catch { return skip("mission_admission_required") }
    }
    const policy = db.query("SELECT time_updated FROM mission_policy WHERE team_id = ?").get(teamId) as { time_updated: number } | null
    const tasks = db.query("SELECT id, status, assignee, classification_status, time_updated FROM team_task WHERE team_id = ? ORDER BY id")
      .all(teamId) as Array<{ id: string; status: string; assignee: string | null; classification_status: string; time_updated: number }>
    const members = db.query("SELECT session_id, status, execution_status, spawn_pending, report_generation, time_updated FROM team_member WHERE team_id = ? ORDER BY name")
      .all(teamId) as Array<{ session_id: string; status: string; execution_status: string; spawn_pending: number; report_generation: number; time_updated: number }>
    if (!longRun && members.some(member => member.spawn_pending !== 0)) return skip("worker_initializing")
    const messages = db.query(`SELECT COUNT(*) AS count, COALESCE(MAX(time_created), 0) AS latest,
      COALESCE(SUM(CASE WHEN delivered = 0 THEN 1 ELSE 0 END), 0) AS pending
      FROM team_message WHERE team_id = ? AND to_name = 'lead' AND from_name != 'system'`)
      .get(teamId) as { count: number; latest: number; pending: number }
    const results = db.query(`SELECT COUNT(*) AS count, COALESCE(MAX(time_created), 0) AS latest,
      COALESCE(SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END), 0) AS pending
      FROM member_result WHERE team_id = ? AND superseded = 0`)
      .get(teamId) as { count: number; latest: number; pending: number }
    if (!longRun && !tasks.some(task => task.status === "pending" || task.status === "in_progress") && !messages.pending && !results.pending) return skip("no_unfinished_board_work")
    const latest = [...tasks, ...members].reduce((last, item) => Math.max(last, item.time_updated),
      Math.max(team.time_updated, policy?.time_updated ?? 0, messages.latest, results.latest))
    if (!longRun && this.now() - latest < this.intervalMs) return skip("recent_progress")
    const helpers = db.query("SELECT session_id FROM classification_helper WHERE team_id = ?").all(teamId) as Array<{ session_id: string }>
    // Delivery/read flags and our own system messages are not mission progress.
    const fingerprint = createHash("sha256").update(JSON.stringify({ team, tasks, members,
      messages: [messages.count, messages.latest], results: [results.count, results.latest] })).digest("hex")
    return { fingerprint, longRun, sessions: [team.lead_session_id, ...members.map(member => member.session_id), ...helpers.map(helper => helper.session_id)] }
  }

  private async nativeActivity(): Promise<Record<string, { type: string }> | undefined> {
    try {
      const { data } = await this.options.client.session.status()
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.values(data).some(status => !status || typeof status.type !== "string")) return undefined
      return data
    } catch (error) {
      log(`supervisor-recovery:status-failed ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private isActive(snapshot: Snapshot, active: Record<string, { type: string }>): boolean {
    // Retry, permission waits and unknown native states are not proof of idleness.
    return snapshot.sessions.some(session => active[session] && active[session].type !== "idle")
  }

  private wake(team: Team, snapshot: Snapshot): void {
    const { db, client } = this.options
    const attemptedAt = this.now()
    const messageId = db.transaction(() => {
      const previous = db.query("SELECT fingerprint, message_id, last_attempt FROM supervisor_recovery WHERE team_id = ?")
        .get(team.id) as RecoveryState | null
      if (previous && attemptedAt - previous.last_attempt < this.intervalMs) return undefined
      const id = previous?.fingerprint === snapshot.fingerprint && previous.message_id
        ? previous.message_id
        : sendMessage(db, { teamId: team.id, from: "system", to: "lead", content:
          snapshot.longRun
            ? "[Supervisor liveness recovery] No worker or supervisor is active, but the approved long-run mission is not closed. Continue authorized coordination, investigation or finalization without a new user GO. A blocked/attention/critical label or completed task board is not proof that the mission is finished or autonomously insoluble. Reassess the concrete blocker, existing authorizations and useful alternatives; pursue independent work. If no autonomous progress is possible, record the evidence and the condition needed for progress instead of repeating a failed operation blindly. Inspect incomplete admissions before duplicating a spawn. This wake does not admit unapproved work, clear a safety stop, waive QA/budgets, grant rights or reset a critical state."
            : "[Supervisor liveness recovery] No worker or supervisor is active, and unfinished work or worker reports have been unattended for at least ten minutes. Inspect native worker sessions, team_results and the task board; recover missing reports and decide the next permitted step under the approved mission contract. Inactivity is not success. Do not bypass user approval, permissions, QA, scope, budget or safety stops; do not restart completed work or ask the user to reconfirm decisions already delegated." })
      db.run("UPDATE team_message SET delivered = 0, read = 0 WHERE id = ?", [id])
      db.run(`INSERT INTO supervisor_recovery (team_id, fingerprint, message_id, last_attempt) VALUES (?, ?, ?, ?)
        ON CONFLICT(team_id) DO UPDATE SET fingerprint = excluded.fingerprint, message_id = excluded.message_id, last_attempt = excluded.last_attempt`,
      [team.id, snapshot.fingerprint, id, attemptedAt])
      return id
    })()
    if (!messageId || this.stopped) {
      if (!this.stopped) this.observation(team.id, "skipped", "wake_cooldown")
      return
    }
    this.observation(team.id, "wake_attempted", snapshot.longRun ? "idle_approved_long_run" : "unattended_supervised_work")
    // Persist first; never await promptAsync. Failed deliveries retry the same
    // durable diagnostic on a later tick instead of duplicating the inbox entry.
    client.session.promptAsync({ sessionID: snapshot.sessions[0], synthetic: true,
      parts: [{ type: "text", text: "[System: Supervisor liveness recovery; review the persisted team message and resume permitted coordination.]" }] })
      .catch(error => { log(`supervisor-recovery:wake-failed team=${team.id} ${error instanceof Error ? error.message : String(error)}`) })
  }

  /** Inspect native activity and attempt at most one wake per mission per ten-minute window. */
  async check(longRunOnly = false): Promise<void> {
    if (this.checking || this.stopped) return
    this.checking = true
    try {
      const teams = this.options.db.query("SELECT id, lead_session_id, time_updated FROM team WHERE project_id = ? AND status = 'active'")
        .all(this.options.projectId) as Team[]
      const active = await this.nativeActivity()
      if (this.stopped) return
      if (!active) {
        teams.forEach(team => this.observation(team.id, "skipped", "native_activity_unavailable"))
        return
      }
      for (const team of teams) {
        const snapshot = this.snapshot(team.id)
        if (!snapshot || (longRunOnly && !snapshot.longRun)) continue
        if (this.isActive(snapshot, active)) { this.observation(team.id, "skipped", "native_session_active"); continue }
        if (this.options.hasPendingPermission) {
          try {
            if (await this.options.hasPendingPermission(snapshot.sessions) && !snapshot.longRun) {
              this.observation(team.id, "skipped", "native_permission_pending"); continue
            }
          } catch (error) {
            log(`supervisor-recovery:permission-check-failed team=${team.id} ${error instanceof Error ? error.message : String(error)}`)
            if (!snapshot.longRun) { this.observation(team.id, "skipped", "permission_inspection_unavailable"); continue }
          }
        }
        if (this.stopped) return
        const freshActivity = await this.nativeActivity()
        if (this.stopped) return
        if (!freshActivity) { this.observation(team.id, "skipped", "native_activity_unavailable"); continue }
        const fresh = this.snapshot(team.id)
        if (fresh) {
          if (this.isActive(fresh, freshActivity)) this.observation(team.id, "skipped", "native_session_active")
          else this.wake(team, fresh)
        }
      }
    } finally {
      this.checking = false
    }
  }

  /** Start one ten-minute safety check; this does not periodically prompt workers. */
  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.check().catch(error => { log(`supervisor-recovery:check-failed ${error instanceof Error ? error.message : String(error)}`) })
    }, this.intervalMs)
    this.timer.unref?.()
    void this.check(true).catch(error => { log(`supervisor-recovery:initial-check-failed ${String(error)}`) })
  }

  /** Stop the safety check and suppress pending asynchronous wake attempts. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
