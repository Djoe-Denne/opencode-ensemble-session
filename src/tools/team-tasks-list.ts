import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"

/**
 * Execute the team_tasks_list tool. Shows all tasks on the shared board.
 */
export async function executeTeamTasksList(
  deps: ToolDeps,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const tasks = deps.db.query(
    "SELECT * FROM team_task WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamInfo.teamId) as Array<Record<string, unknown>>

  if (tasks.length === 0) return "No tasks on the board."

  return tasks.map(t => {
    const result = t.classification_status === "completed" && typeof t.classification_result === "string"
      ? JSON.parse(t.classification_result) as { complexity: number; risk: number; method?: string; toolId?: string; model?: string } : undefined
    const scores = result ? ` [classified 0–1: complexity:${result.complexity} risk:${result.risk} via:${result.method ?? result.toolId ?? result.model ?? "classifier"}]` : ""
    return `[${t.status}] ${t.content} (${t.id})${t.assignee ? ` → ${t.assignee}` : ""}${t.priority !== "medium" ? ` [${t.priority}]` : ""}${t.agent ? ` @${t.agent}` : ""}${t.complexity != null || t.risk != null ? ` [complexity:${t.complexity ?? 0} risk:${t.risk ?? 0}]` : ""}${t.classification_status !== "not_required" ? ` [classification:${t.classification_status}${t.classification_error ? `: ${t.classification_error}` : ""}]` : ""}${scores}`
  }).join("\n")
}
