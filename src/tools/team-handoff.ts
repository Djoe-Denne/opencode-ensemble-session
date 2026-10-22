import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { reconcileSessionAgent } from "../session-continuity"
import { hasAutonomousAssignment, transitionTaskExecution } from "../task-execution"

/** Switch this team session's agent for subsequent turns without replacing its history. */
export async function executeTeamHandoff(deps: ToolDeps, args: { agent?: string; phase?: "implementation"; reasoning?: string }, sessionId: string, signal?: AbortSignal): Promise<string> {
  const team = requireTeamMember(deps, sessionId)
  if (team.role === "member" && hasAutonomousAssignment(deps, sessionId)) {
    return transitionTaskExecution(deps, team.teamId, team.memberName ?? "", sessionId, args, signal)
  }
  if (args.phase !== undefined || args.reasoning !== undefined) throw new Error("Phase and reasoning controls require an autonomous task assignment")
  if (typeof args.agent !== "string" || !args.agent.trim()) throw new Error("agent is required")
  if (!deps.client.continuity) throw new Error("team_handoff requires OpenCode V2 switchAgent")
  signal?.throwIfAborted()
  if (team.role === "member") {
    const member = deps.db.query("SELECT status, spawn_pending FROM team_member WHERE session_id = ?").get(sessionId) as { status: string; spawn_pending: number }
    if (!["ready", "busy"].includes(member.status) || member.spawn_pending) throw new Error("This teammate cannot hand off in its current lifecycle state")
  }
  const reserved = team.role === "member"
    ? deps.db.query("UPDATE team_member SET handoff_pending = ? WHERE session_id = ? AND handoff_pending IS NULL RETURNING session_id").get(args.agent, sessionId)
    : deps.db.query("UPDATE team SET handoff_pending = ? WHERE id = ? AND handoff_pending IS NULL RETURNING id").get(args.agent, team.teamId)
  if (!reserved) throw new Error("A handoff is already pending for this session; wait for completion or recovery")
  try {
    const finalResponse = team.role === "member" && (deps.db.query("SELECT report_mode FROM team_member WHERE session_id = ?").get(sessionId) as { report_mode: string } | null)?.report_mode === "final_response"
    await deps.client.continuity.switchAgent({ sessionID: sessionId, agent: args.agent, ...(finalResponse ? { permission: [] } : {}) }, signal)
    await reconcileSessionAgent(deps, sessionId)
  } catch (error) {
    // switchAgent may have committed even when a tool cancellation loses its response.
    await reconcileSessionAgent(deps, sessionId).catch(() => undefined)
    throw error
  }
  return `Session ${sessionId} handed off to "${args.agent}". Subsequent provider turns use this agent; history, tasks and worktree are retained.`
}
