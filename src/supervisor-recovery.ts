import type { Database } from "./db"
import type { PluginClient } from "./types"
import { createHash } from "node:crypto"
import { assertMissionAdmission } from "./mission-policy"
import { sendMessage } from "./messaging"
import { log } from "./log"

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
}

interface Snapshot {
  fingerprint: string
  sessions: [string, ...string[]]
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

  private snapshot(teamId: string): Snapshot | undefined {
    const { db, projectId } = this.options
    const team = db.query(`SELECT t.id, t.lead_session_id, t.time_updated FROM team t JOIN project p ON p.id = t.project_id
      WHERE t.id = ? AND t.project_id = ? AND t.status = 'active' AND p.status = 'active' AND t.mission_state = 'running'`)
      .get(teamId, projectId) as Team | null
    if (!team) return undefined
    // Draft edits and pending config must not be converted into execution approval.
    try { assertMissionAdmission(db, team.id) } catch { return undefined }
    const policy = db.query("SELECT time_updated FROM mission_policy WHERE team_id = ?").get(teamId) as { time_updated: number } | null
    const tasks = db.query("SELECT id, status, assignee, classification_status, time_updated FROM team_task WHERE team_id = ? ORDER BY id")
      .all(teamId) as Array<{ id: string; status: string; assignee: string | null; classification_status: string; time_updated: number }>
    const members = db.query("SELECT session_id, status, execution_status, spawn_pending, report_generation, time_updated FROM team_member WHERE team_id = ? ORDER BY name")
      .all(teamId) as Array<{ session_id: string; status: string; execution_status: string; spawn_pending: number; report_generation: number; time_updated: number }>
    if (members.some(member => member.spawn_pending !== 0)) return undefined
    const messages = db.query(`SELECT COUNT(*) AS count, COALESCE(MAX(time_created), 0) AS latest,
      COALESCE(SUM(CASE WHEN delivered = 0 THEN 1 ELSE 0 END), 0) AS pending
      FROM team_message WHERE team_id = ? AND to_name = 'lead' AND from_name != 'system'`)
      .get(teamId) as { count: number; latest: number; pending: number }
    const results = db.query(`SELECT COUNT(*) AS count, COALESCE(MAX(time_created), 0) AS latest,
      COALESCE(SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END), 0) AS pending
      FROM member_result WHERE team_id = ? AND superseded = 0`)
      .get(teamId) as { count: number; latest: number; pending: number }
    if (!tasks.some(task => task.status === "pending" || task.status === "in_progress") && !messages.pending && !results.pending) return undefined
    const latest = [...tasks, ...members].reduce((last, item) => Math.max(last, item.time_updated),
      Math.max(team.time_updated, policy?.time_updated ?? 0, messages.latest, results.latest))
    if (this.now() - latest < this.intervalMs) return undefined
    const helpers = db.query("SELECT session_id FROM classification_helper WHERE team_id = ?").all(teamId) as Array<{ session_id: string }>
    // Delivery/read flags and our own system messages are not mission progress.
    const fingerprint = createHash("sha256").update(JSON.stringify({ team, tasks, members,
      messages: [messages.count, messages.latest], results: [results.count, results.latest] })).digest("hex")
    return { fingerprint, sessions: [team.lead_session_id, ...members.map(member => member.session_id), ...helpers.map(helper => helper.session_id)] }
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
          "[Supervisor liveness recovery] No worker or supervisor is active, and unfinished work or worker reports have been unattended for at least ten minutes. Inspect native worker sessions, team_results and the task board; recover missing reports and decide the next permitted step under the approved mission contract. Inactivity is not success. Do not bypass user approval, permissions, QA, scope, budget or safety stops; do not restart completed work or ask the user to reconfirm decisions already delegated." })
      db.run("UPDATE team_message SET delivered = 0, read = 0 WHERE id = ?", [id])
      db.run(`INSERT INTO supervisor_recovery (team_id, fingerprint, message_id, last_attempt) VALUES (?, ?, ?, ?)
        ON CONFLICT(team_id) DO UPDATE SET fingerprint = excluded.fingerprint, message_id = excluded.message_id, last_attempt = excluded.last_attempt`,
      [team.id, snapshot.fingerprint, id, attemptedAt])
      return id
    })()
    if (!messageId || this.stopped) return
    // Persist first; never await promptAsync. Failed deliveries retry the same
    // durable diagnostic on a later tick instead of duplicating the inbox entry.
    client.session.promptAsync({ sessionID: snapshot.sessions[0], synthetic: true,
      parts: [{ type: "text", text: "[System: Supervisor liveness recovery; review the persisted team message and resume permitted coordination.]" }] })
      .catch(error => { log(`supervisor-recovery:wake-failed team=${team.id} ${error instanceof Error ? error.message : String(error)}`) })
  }

  /** Inspect native activity and attempt at most one wake per mission per ten-minute window. */
  async check(): Promise<void> {
    if (this.checking || this.stopped) return
    this.checking = true
    try {
      const teams = this.options.db.query("SELECT id, lead_session_id, time_updated FROM team WHERE project_id = ? AND status = 'active' AND mission_state = 'running'")
        .all(this.options.projectId) as Team[]
      const active = await this.nativeActivity()
      if (!active || this.stopped) return
      for (const team of teams) {
        const snapshot = this.snapshot(team.id)
        if (!snapshot || this.isActive(snapshot, active)) continue
        if (this.options.hasPendingPermission) {
          try {
            if (await this.options.hasPendingPermission(snapshot.sessions)) continue
          } catch (error) {
            log(`supervisor-recovery:permission-check-failed team=${team.id} ${error instanceof Error ? error.message : String(error)}`)
            continue
          }
        }
        if (this.stopped) return
        const freshActivity = await this.nativeActivity()
        if (!freshActivity || this.stopped) return
        const fresh = this.snapshot(team.id)
        if (fresh && !this.isActive(fresh, freshActivity)) this.wake(team, fresh)
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
  }

  /** Stop the safety check and suppress pending asynchronous wake attempts. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
