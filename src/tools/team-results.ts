import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { parseTaskResult, formatTaskResult } from "../result-parser"

/** Row shape for unread messages query. */
interface UnreadMessageRow {
  id: string
  from_name: string
  content: string
  time_created: number
}

/**
 * Retrieve unread messages from the team message store.
 * Optionally filter by sender name. Marks returned messages as read.
 */
export async function executeTeamResults(
  deps: ToolDeps,
  args: { from?: string; candidate_id?: string },
  sessionId: string,
): Promise<string> {
  const team = requireTeamMember(deps, sessionId)
  const candidates = team.role === "lead" ? deps.db.query(`SELECT id, member_name, session_id, native_message_id, task_ids, content FROM member_result
    WHERE team_id = ? AND ${args.candidate_id ? "id = ?" : "read = 0"}${args.from ? " AND member_name = ?" : ""} ORDER BY time_created ASC`)
    .all(team.teamId, ...(args.candidate_id ? [args.candidate_id] : []), ...(args.from ? [args.from] : [])) as Array<{ id: string; member_name: string; session_id: string; native_message_id: string; task_ids: string; content: string }> : []
  if (args.candidate_id && !candidates.length) throw new Error("Candidate not found in this lead's team")

  const rows = args.from
    ? (deps.db
        .query(
          "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND from_name = ? ORDER BY time_created ASC",
        )
        .all(team.teamId, args.from) as UnreadMessageRow[])
    : (deps.db
        .query(
          "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 ORDER BY time_created ASC",
        )
        .all(team.teamId) as UnreadMessageRow[])

  if (rows.length === 0 && candidates.length === 0) return "No unread messages."

  // Mark all returned messages as read
  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => "?").join(", ")
  if (ids.length) deps.db.run(`UPDATE team_message SET read = 1 WHERE id IN (${placeholders})`, ids)
  for (const candidate of candidates) deps.db.run("UPDATE member_result SET read = 1 WHERE id = ?", [candidate.id])

  // Format output — parse structured task results when present
  return [...candidates.map(candidate => `[Candidate ${candidate.id} from ${candidate.member_name}; NOT validated or integrated]\nSession: ${candidate.session_id}; native message: ${candidate.native_message_id}; tasks: ${candidate.task_ids}\n${candidate.content}`), ...rows.map((r) => {
    const parsed = parseTaskResult(r.content)
    if (parsed) return formatTaskResult(r.from_name, parsed)
    return `[Message from ${r.from_name}]:\n${r.content}`
  })].join("\n\n")
}
