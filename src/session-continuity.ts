import type { SpawnContext, ToolDeps } from "./types"
import { releaseMemberTasks } from "./tasks"
import { log } from "./log"

/** Validate a context contract without allocating a native session or requiring host capabilities. */
export function parseSpawnContext(value: unknown): SpawnContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context")
  const context = value as SpawnContext
  if (!["fresh", "fork", "checkpoint", "compact_fork"].includes(context.mode)) throw new Error("Invalid context.mode")
  if (Object.keys(context).some(key => !["mode", "from", "messageID"].includes(key))) throw new Error("Unknown context option")
  if (context.mode === "fresh") {
    if (context.from !== undefined || context.messageID !== undefined) throw new Error("fresh context cannot specify from or messageID")
    return { mode: "fresh" }
  }
  if (context.from !== undefined && (typeof context.from !== "string" || !context.from.trim())) throw new Error("Invalid context.from")
  if (context.mode === "checkpoint") {
    if (typeof context.messageID !== "string" || !context.messageID.startsWith("msg_")) throw new Error("checkpoint requires a native messageID (exclusive boundary)")
  } else if (context.messageID !== undefined) throw new Error("messageID requires checkpoint mode")
  return { mode: context.mode, ...(context.from !== undefined ? { from: context.from } : {}), ...(context.messageID !== undefined ? { messageID: context.messageID } : {}) }
}

/** Freeze task-relative current to its creator, not the later dispatcher or spawning lead. */
export function taskSpawnContext(value: unknown, creatorSessionId: string): SpawnContext {
  const context = parseSpawnContext(value)
  return context.mode === "fresh" ? context : { ...context, from: !context.from || context.from === "current" ? creatorSessionId : context.from }
}

/** Validate and resolve a context source inside the caller's team. */
export function resolveSpawnContext(deps: ToolDeps, context: SpawnContext | undefined, teamId: string, sessionId: string): { mode: SpawnContext["mode"]; source?: string; before?: string } {
  if (context === undefined) return { mode: "fresh" }
  context = parseSpawnContext(context)
  if (context.mode === "fresh") return { mode: "fresh" }
  if (!deps.client.continuity) throw new Error("Session inheritance requires OpenCode V2 continuity capabilities; no fresh fallback was performed")
  const team = deps.db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamId) as { lead_session_id: string }
  const from = context.from ?? "current"
  if (typeof from !== "string" || !from) throw new Error("context.from must be current, lead, or a member of this team")
  const source = from === "current" ? sessionId : from === "lead" || from === team.lead_session_id ? team.lead_session_id
    : (deps.db.query("SELECT session_id FROM team_member WHERE team_id = ? AND (name = ? OR session_id = ?)").get(teamId, from, from) as { session_id: string } | null)?.session_id
  if (!source) throw new Error(`Context source "${from}" is not a member/session of this team`)
  const preparing = deps.db.query("SELECT name FROM team_member WHERE team_id = ? AND session_id = ? AND spawn_pending > 0").get(teamId, source)
  if (preparing) throw new Error("Context source is still initializing; wait for its task admission before forking")
  if (context.mode === "compact_fork" && source === sessionId) throw new Error("compact_fork cannot wait on the current tool session; select an idle teammate source")
  return { mode: context.mode, source, ...(context.messageID ? { before: context.messageID } : {}) }
}

/** Remove a partially admitted inherited teammate, retaining failed cleanup for recovery. */
export async function rollbackInheritedSpawn(deps: ToolDeps, teamId: string, name: string): Promise<"removed" | "adopted" | "absent"> {
  const member = deps.db.query("SELECT session_id, workspace_id, worktree_dir FROM team_member WHERE team_id = ? AND name = ? AND spawn_pending > 0")
    .get(teamId, name) as { session_id: string; workspace_id: string | null; worktree_dir: string | null } | null
  if (!member) return "absent"
  if (!deps.client.continuity) throw new Error("V2 continuity is required to recover the pending spawn")
  // A crash may lose the admission ACK after OpenCode durably stored the prompt.
  // Adopt that session rather than deleting a worker that could already have work.
  const messages = await deps.client.session.messages({ sessionID: member.session_id }).catch(error => {
    if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError") return { data: [] }
    throw error
  })
  const marker = `${teamId}/${name}/${member.session_id}`
  if (messages.data?.some(message => (message as unknown as { metadata?: Record<string, unknown> }).metadata?.["ensemble.spawn"] === marker)) {
    deps.db.run("UPDATE team_member SET spawn_pending = 0 WHERE session_id = ?", [member.session_id])
    deps.registry.register(teamId, name, member.session_id)
    return "adopted"
  }
  deps.registry.unregister(member.session_id)
  releaseMemberTasks(deps.db, teamId, name)
  try {
    // This child has never completed admission. Never abort or remove its source.
    await deps.client.continuity.remove({ sessionID: member.session_id })
    if (member.workspace_id) await deps.client.workspace.remove({ id: member.workspace_id })
    if (member.worktree_dir) await deps.client.worktree.remove({ worktreeRemoveInput: { directory: member.worktree_dir } })
    deps.db.run("DELETE FROM team_member WHERE team_id = ? AND name = ?", [teamId, name])
    return "removed"
  } catch (error) {
    // Retain resource references for another recovery attempt; never hide an orphan.
    deps.db.run("UPDATE team_member SET status = 'error', time_updated = ? WHERE team_id = ? AND name = ?", [Date.now(), teamId, name])
    throw error
  }
}

/** Reconcile cached role/model after a switch, including an interrupted API response. */
export async function reconcileSessionAgent(deps: ToolDeps, sessionId: string): Promise<void> {
  const { data } = await deps.client.session.get({ sessionID: sessionId })
  const info = data as { agent?: string; model?: { providerID: string; id: string } } | undefined
  if (!info?.agent) throw new Error("Native session did not return its agent")
  const model = info.model ? `${info.model.providerID}/${info.model.id}` : null
  deps.db.run("UPDATE team_member SET agent = ?, model = ?, handoff_pending = NULL, time_updated = ? WHERE session_id = ?", [info.agent, model, Date.now(), sessionId])
  deps.db.run("UPDATE team SET lead_agent = ?, handoff_pending = NULL WHERE lead_session_id = ? AND status = 'active'", [info.agent, sessionId])
}

/** Reconcile interrupted spawns and handoffs using persisted native session references. */
export async function recoverSessionContinuity(deps: ToolDeps): Promise<void> {
  const pending = deps.db.query(`SELECT m.team_id, m.name FROM team_member m JOIN team t ON t.id = m.team_id
    WHERE m.spawn_pending > 0 AND t.status = 'active' AND t.project_id = ?`).all(deps.directory) as Array<{ team_id: string; name: string }>
  for (const member of pending) {
    try { await rollbackInheritedSpawn(deps, member.team_id, member.name) }
    catch (error) { log(`recovery:continuity:pending name=${member.name} error=${String(error)}`) }
  }
  const handoffs = deps.db.query(`SELECT m.session_id FROM team_member m JOIN team t ON t.id = m.team_id
    WHERE m.handoff_pending IS NOT NULL AND t.status = 'active' AND t.project_id = ?
    UNION SELECT lead_session_id AS session_id FROM team WHERE handoff_pending IS NOT NULL AND status = 'active' AND project_id = ?`)
    .all(deps.directory, deps.directory) as Array<{ session_id: string }>
  for (const member of handoffs) {
    try { await reconcileSessionAgent(deps, member.session_id) }
    catch (error) { log(`recovery:continuity:handoff session=${member.session_id} error=${String(error)}`) }
  }
}
