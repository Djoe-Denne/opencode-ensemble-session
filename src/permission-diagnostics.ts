import type { Database } from "./db"
import type { DescendantTracker } from "./state"
import { appendFileSync, mkdirSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { getDbPath } from "./db"

/** Distinct symptoms, not automatic conclusions about the configured permission rule. */
export const PERMISSION_INCIDENT_CATEGORIES = ["permission_denied", "permission_declined", "user_rejected", "filesystem_access_denied", "external_authorization_denied", "tool_unavailable", "ensemble_isolation_denied"] as const
type Category = typeof PERMISSION_INCIDENT_CATEGORIES[number]
type Observation = "tool_error" | "native_tool_state" | "reported_tool_error" | "isolation_guard"

/** Safe local correlation record. Arguments, resource values, error text and credentials are excluded. */
export interface PermissionIncident {
  version: 1
  incidentID: string
  time: string
  projectDirectory: string
  sessionID: string
  parentSessionID: string | null
  agent: string | null
  teamID: string | null
  ownerMemberName: string | null
  tool: string
  namespace: string | null
  permissionAction: string | null
  callID: string | null
  messageID: string | null
  category: Category
  observation: Observation
  errorFingerprint: string
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function label(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/@+-]{1,200}$/u.test(value) ? value : null
}

function directoryKey(value: string): string {
  const path = resolve(value)
  return process.platform === "win32" ? path.toLowerCase() : path
}

function classify(error: unknown, depth = 0): { category: Category; fingerprint: string } | undefined {
  const value = object(error)
  const message = typeof error === "string" ? error : typeof value?.message === "string" ? value.message : ""
  const code = typeof value?.code === "string" ? value.code : ""
  const tag = typeof value?.type === "string" ? value.type : typeof value?._tag === "string" ? value._tag : ""
  const text = `${code} ${tag} ${message.slice(0, 8192)}`
  const category: Category | undefined = tag === "Permission.DeclinedError" || message.trim() === "Permission.DeclinedError" ? "permission_declined"
    : /user (?:rejected|denied)|rejected by (?:the )?user/i.test(text) ? "user_rejected"
    : /\bEACCES\b|\bEPERM\b/i.test(text) ? "filesystem_access_denied"
    : value?.status === 401 || value?.status === 403 ? "external_authorization_denied"
    : /permission.{0,30}(?:denied|rejected)|access (?:is )?denied|not allowed to (?:use|call|execute|access)|do not have permission|does not have permission|rule.{0,60}prevents.{0,60}tool call|not permitted by.{0,30}(?:policy|rule|agent)|accès refusé|permission refusée/i.test(text) ? "permission_denied"
    : /no tool named|unknown tool|ToolNotFound|tool.{0,160}(?:not available|unavailable)/i.test(text) ? "tool_unavailable" : undefined
  if (!category) return depth < 2 && value?.error ? classify(value.error, depth + 1) : undefined
  return { category, fingerprint: createHash("sha256").update(text).digest("hex") }
}

/** Default shared journal location, adjacent to Ensemble's database rather than inside user repositories. */
export function defaultPermissionLogDirectory(dbPath = getDbPath()): string {
  return join(dirname(dbPath), "diagnostics", "permissions")
}

/** Only safe correlation metadata is persisted; never tool arguments or raw errors. */
export interface PermissionToolContext {
  sessionID: string
  tool: string
  id?: string
  messageID?: string
  agent?: string
}

interface PermissionDiagnosticsOptions {
  directory?: string | false
  projectDirectory: string
  db?: Database
  tracker?: DescendantTracker
  now?: () => Date
  onWriteError?: () => void
}

/** Append-only observation of permission failures, without changing authorization. */
export class PermissionDiagnostics {
  private readonly agents = new Map<string, string>()
  private readonly catalogue = new Map<string, { namespace: string | null; action: string | null }>()
  private readonly seen = new Set<string>()
  private warned = false

  constructor(private readonly options: PermissionDiagnosticsOptions) {}

  /** Remember native actor identity without retaining session contents. */
  noteSession(sessionID: string, agent?: string): void {
    const safeAgent = label(agent)
    if (!safeAgent) return
    this.agents.set(sessionID, safeAgent)
    if (this.agents.size > 2000) this.agents.delete(this.agents.keys().next().value ?? "")
  }

  /** Resolve namespaces/actions from the public catalogue, never from tool arguments. */
  noteTools(tools: readonly unknown[]): void {
    tools.forEach(tool => {
      const value = object(tool)
      const id = label(value?.id)
      if (!id) return
      const options = object(value?.options)
      this.catalogue.set(id, { namespace: label(object(options?.namespace)?.name), action: label(options?.permission) })
    })
  }

  private owner(sessionID: string): { teamID: string | null; ownerMemberName: string | null; agent: string | null; project: string | null } {
    const unknown = { teamID: null, ownerMemberName: null, agent: null, project: null }
    const db = this.options.db
    if (!db) return unknown
    try {
      const visited = new Set<string>()
      let current: string | undefined = sessionID
      while (current && visited.size <= 10 && !visited.has(current)) {
        visited.add(current)
        const member = db.query("SELECT tm.team_id, tm.name, tm.agent, t.project_id FROM team_member tm JOIN team t ON t.id = tm.team_id WHERE tm.session_id = ?")
          .get(current) as { team_id: string; name: string; agent: string; project_id: string } | null
        if (member) return { teamID: label(member.team_id), ownerMemberName: label(member.name), agent: current === sessionID ? label(member.agent) : null, project: member.project_id }
        const lead = db.query("SELECT id, project_id FROM team WHERE lead_session_id = ? ORDER BY time_created DESC LIMIT 1")
          .get(current) as { id: string; project_id: string } | null
        if (lead) return { teamID: label(lead.id), ownerMemberName: null, agent: null, project: lead.project_id }
        current = this.options.tracker?.getParent(current)
      }
    } catch { /* Optional ownership metadata must not prevent recording a denial. */ }
    return unknown
  }

  private record(input: PermissionToolContext, signal: { category: Category; fingerprint: string }, observation: Observation): void {
    if (!this.options.directory || !label(input.sessionID)) return
    const callID = label(input.id)
    const messageID = label(input.messageID)
    const identity = callID ? createHash("sha256").update(JSON.stringify([this.options.projectDirectory, input.sessionID, messageID, callID, signal.category])).digest("hex") : randomUUID()
    if (this.seen.has(identity)) return
    try {
      const owner = this.owner(input.sessionID)
      const tool = label(input.tool) ?? "unknown"
      const binding = this.catalogue.get(tool)
      const record: PermissionIncident = { version: 1, incidentID: identity, time: (this.options.now?.() ?? new Date()).toISOString(),
        projectDirectory: this.options.projectDirectory, sessionID: input.sessionID, parentSessionID: label(this.options.tracker?.getParent(input.sessionID)),
        agent: label(input.agent) ?? this.agents.get(input.sessionID) ?? owner.agent, teamID: owner.teamID, ownerMemberName: owner.ownerMemberName,
        tool, namespace: binding?.namespace ?? null, permissionAction: binding?.action ?? null, callID, messageID,
        category: signal.category, observation, errorFingerprint: signal.fingerprint }
      mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
      appendFileSync(join(this.options.directory, `${record.time.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
      this.seen.add(identity)
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value ?? "")
    } catch {
      if (this.warned) return
      this.warned = true
      try { this.options.onWriteError?.() } catch { /* Diagnostics must never replace the original tool result. */ }
    }
  }

  /** Record a refusal enforced by Ensemble's own descendant-isolation guard. */
  recordIsolation(input: PermissionToolContext): void {
    this.record(input, { category: "ensemble_isolation_denied", fingerprint: createHash("sha256").update("ensemble_isolation_denied").digest("hex") }, "isolation_guard")
  }

  private observe(event: unknown, observation: "tool_error" | "native_tool_state"): void {
    const value = object(event)
    if (typeof value?.sessionID !== "string" || typeof value.tool !== "string") return
    const context: PermissionToolContext = { sessionID: value.sessionID, tool: value.tool,
      id: label(value.id) ?? undefined, messageID: label(value.messageID) ?? undefined, agent: label(value.agent) ?? undefined }
    if (value.status === "error") {
      const signal = classify(value.error)
      if (signal) this.record(context, signal, observation)
      return
    }
    if (value.status !== "completed") return
    const result = object(value.result)
    const packets: unknown[] = [result, result?.output, result?.structuredContent]
    const content = result?.content
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map(item => object(item)?.text) : []
    texts.forEach(text => {
      if (typeof text !== "string" || text.length > 32768) return
      // Code Mode completes the dispatcher even when a nested native call fails.
      // Require its error marker and an exact native tag, never quoted prose.
      if (value.tool === "execute" && object(result?.metadata)?.error === true && text.trim() === "Permission.DeclinedError") {
        const signal = classify(text.trim())
        if (signal) this.record(context, signal, "reported_tool_error")
      }
      try { packets.push(JSON.parse(text)) } catch { /* Ordinary successful text is not evidence of a refusal. */ }
    })
    packets.forEach(packet => {
      const error = object(packet)?.error
      const signal = classify(error)
      if (signal) this.record(context, signal, "reported_tool_error")
    })
  }

  /** Observe actual tool failures or explicitly reported nested tool errors. */
  observeToolAfter(event: unknown): void {
    this.observe(event, "tool_error")
  }

  /** Observe native final tool states, including configured denies that skip evaluation hooks. */
  observeNativeEvent(event: unknown): void {
    const value = object(event)
    const data = object(value?.data)
    const sessionID = label(data?.sessionID)
    if (!sessionID) return
    const location = object(value?.location)?.directory
    if (typeof location === "string" && directoryKey(location) !== directoryKey(this.options.projectDirectory)) return
    if (typeof location !== "string" && !this.agents.has(sessionID)) {
      const project = this.owner(sessionID).project
      if (!project || directoryKey(project) !== directoryKey(this.options.projectDirectory)) return
    }
    if (value?.type === "session.agent.selected") { this.noteSession(sessionID, label(data?.agent) ?? undefined); return }
    if (value?.type !== "session.message.content.updated" || !Array.isArray(data?.content)) return
    data.content.forEach(part => {
      const tool = object(part)
      const state = object(tool?.state)
      if (tool?.type !== "tool" || !state) return
      this.observe({ sessionID, messageID: data.messageID, tool: tool.name, id: tool.id, status: state.status, error: state.error, result: state }, "native_tool_state")
    })
  }
}
