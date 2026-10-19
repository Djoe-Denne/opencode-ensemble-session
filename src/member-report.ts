import type { Database } from "./db"
import type { PluginClient } from "./types"
import { parseTaskResult } from "./result-parser"
import { sendMessage } from "./messaging"
import { generateId } from "./util"
import { log } from "./log"

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

function timestamp(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  const epoch = record(value).epochMilliseconds
  return typeof epoch === "number" ? epoch : Number.NaN
}

/** Recover a completed native response as a candidate for lead review, never task completion. */
export async function recoverFinalResponse(db: Database, client: PluginClient, teamId: string, memberName: string): Promise<boolean> {
  const member = db.query("SELECT session_id, status, execution_status, report_mode, spawn_pending, reported_to_lead, report_started_at, report_generation, time_created FROM team_member WHERE team_id = ? AND name = ? AND team_id IN (SELECT id FROM team WHERE status = 'active')")
    .get(teamId, memberName) as { session_id: string; status: string; execution_status: string; report_mode: string; spawn_pending: number; reported_to_lead: number; report_started_at: number; report_generation: number; time_created: number } | null
  if (!member || member.spawn_pending || !(member.status === "ready" || (member.status === "shutdown" && member.report_mode === "final_response" && member.execution_status === "idle"))) return false
  if (member.reported_to_lead || hasCurrentTaskReport(db, teamId, memberName)) return true
  try {
    const nativeStatus = await client.session.status()
    if (nativeStatus.data?.[member.session_id]?.type === "busy") return false
    const messages = (await client.session.messages({ sessionID: member.session_id })).data ?? []
    // Inspect the latest assistant response only: an interrupted final turn must
    // not resurrect a successful response from earlier in the conversation.
    const latest = messages.filter(message => record(message.info).role === "assistant").at(-1)
    if (!latest) return false
    const info = record(latest.info)
    const time = record(info.time)
    if (typeof info.id !== "string" || info.error || info.finish !== "stop" ||
      !Number.isFinite(timestamp(time.completed)) || timestamp(time.created) < Math.max(member.report_started_at, member.time_created) ||
      !Number.isFinite(timestamp(time.created))) return false
    const content = latest.parts.filter(part => record(part).type === "text" && !record(part).synthetic)
      .map(part => record(part).text).filter((text): text is string => typeof text === "string").join("\n")
    if (!content.trim()) return false
    const persisted = db.transaction(() => {
      // Recheck after the asynchronous read: a new run or shutdown invalidates it.
      const current = db.query("SELECT status, report_generation, reported_to_lead FROM team_member WHERE team_id = ? AND name = ? AND team_id IN (SELECT id FROM team WHERE status = 'active')")
        .get(teamId, memberName) as { status: string; report_generation: number; reported_to_lead: number } | null
      if (!current || current.status !== member.status || current.report_generation !== member.report_generation) return null
      if (current.reported_to_lead) return false
      const tasks = db.query("SELECT id FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress'").all(teamId, memberName) as Array<{ id: string }>
      const id = generateId("result")
      const inserted = db.run("INSERT OR IGNORE INTO member_result (id, team_id, member_name, session_id, native_message_id, task_ids, content, report_generation, time_created, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'final_response')",
        [id, teamId, memberName, member.session_id, info.id as string, JSON.stringify(tasks.map(task => task.id)), content, member.report_generation, Date.now()])
      if (!inserted.changes) return false
      sendMessage(db, { teamId, from: "system", to: "lead", content: `Native response available for review from ${memberName}. Candidate ${id}; session ${member.session_id}; message ${info.id}; tasks: ${tasks.map(task => task.id).join(", ") || "standalone"}. This is NOT task validation or integration. Read the full candidate with team_results, review and persist/integrate it before completing its tasks.` })
      db.run("UPDATE team_member SET reported_to_lead = 1 WHERE team_id = ? AND name = ?", [teamId, memberName])
      return true
    })()
    if (persisted) {
      const team = db.query("SELECT lead_session_id FROM team WHERE id = ? AND status = 'active'").get(teamId) as { lead_session_id: string } | null
      if (team) client.session.promptAsync({ sessionID: team.lead_session_id, synthetic: true, parts: [{ type: "text", text: `[System: Native response from ${memberName} awaits lead review; use team_results.]` }] })
        .catch(error => log(`report:wake-failed member=${memberName} ${String(error)}`))
    }
    if (persisted === null) return false
    return persisted || !!db.query("SELECT id FROM member_result WHERE session_id = ? AND native_message_id = ? AND report_generation = ?").get(member.session_id, info.id as string, member.report_generation)
  } catch (error) {
    log(`report:recover-failed member=${memberName} ${String(error)}`)
    return false
  }
}

/** Check for a structured task result in the current work period, not a question or old report. */
export function hasCurrentTaskReport(db: Database, teamId: string, memberName: string): boolean {
  const messages = db.query(`SELECT content FROM team_message WHERE team_id = ? AND from_name = ? AND to_name = 'lead'
    AND rowid > (SELECT report_message_cursor FROM team_member WHERE team_id = ? AND name = ?)`)
    .all(teamId, memberName, teamId, memberName) as Array<{ content: string }>
  return messages.some(message => {
    const result = parseTaskResult(message.content)
    return result?.status === "completed" || result?.status === "failed"
  })
}
