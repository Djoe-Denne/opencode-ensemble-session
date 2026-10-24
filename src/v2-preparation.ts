import type { MissionPolicyModel } from "./mission-model-policy"
import type { PreparationPort, PreparationPromptCall } from "./preparation-runtime"

/** Subset of the V2 host used to run a preparation session without team spawn. */
export interface PreparationHost {
  location: { directory: string }
  agent?: { get?(input: { agentID: string }): Promise<unknown> }
  session: {
    create(input: Record<string, unknown>): Promise<{ id: string }>
    prompt(input: Record<string, unknown>): Promise<unknown>
    switchAgent(input: Record<string, unknown>): Promise<unknown>
    switchModel(input: Record<string, unknown>): Promise<unknown>
    get?(input: { sessionID: string }): Promise<unknown>
    update?(input: { sessionID: string; permissions: readonly unknown[] }): Promise<unknown>
    wait?(input: { sessionID: string }, requestOptions?: { signal?: AbortSignal }): Promise<unknown>
    context?(input: Record<string, unknown>): Promise<unknown>
    interrupt?(input: Record<string, unknown>): Promise<unknown>
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function assistantBody(entry: Record<string, unknown>): string {
  if (typeof entry.content === "string") return entry.content
  const parts = Array.isArray(entry.content) ? entry.content : Array.isArray(entry.parts) ? entry.parts : []
  return parts.flatMap(part => {
    const row = record(part)
    return row.type === "text" && row.synthetic !== true && typeof row.text === "string" ? [row.text] : []
  }).join("")
}

/** Last assistant message, keyed by the host message id when the host provides one. */
function lastAssistant(messages: unknown): { cursor: string; text: string } | undefined {
  if (!Array.isArray(messages)) return undefined
  let found: { cursor: string; text: string } | undefined
  messages.forEach((message, index) => {
    const entry = record(message)
    const info = record(entry.info)
    const role = entry.type ?? entry.role ?? info.role
    if (role !== "assistant") return
    const text = assistantBody(entry)
    if (!text.trim()) return
    const id = typeof info.id === "string" && info.id.trim() ? info.id : typeof entry.id === "string" && entry.id.trim() ? entry.id : ""
    found = { cursor: id || `${index}:${text}`, text }
  })
  return found
}

function requireHost(session: PreparationHost["session"]): void {
  if (typeof session.wait !== "function") throw new Error("Preparation requires session.wait")
  if (typeof session.context !== "function") throw new Error("Preparation requires session.context")
  if (typeof session.interrupt !== "function") throw new Error("Preparation requires session.interrupt")
  if (typeof session.get !== "function") throw new Error("Preparation requires session.get")
}

function agentBody(value: unknown): Record<string, unknown> {
  const root = record(value)
  const nested = record(root.data)
  return Object.keys(nested).length > 0 ? nested : root
}

/** Copy the agent rule list. A missing list cannot replace inherited permissions. */
function permissionRules(value: unknown): unknown[] {
  const permissions = agentBody(value).permissions
  if (!Array.isArray(permissions)) throw new Error("Preparation requires session.update to replace inherited permissions")
  return permissions.map(rule => rule !== null && typeof rule === "object" && !Array.isArray(rule) ? { ...record(rule) } : rule)
}

/** Copy native allow-rules. A denied edit action marks the agent read-only. */
export function nativeAgentFacts(value: unknown): { readOnly: boolean; permissions: string[] } {
  const data = agentBody(value)
  if (typeof data.readOnly === "boolean" && Array.isArray(data.permissions) && data.permissions.every(item => typeof item === "string")) {
    return { readOnly: data.readOnly, permissions: data.permissions.map(item => item.trim()).filter(item => item.length > 0) }
  }
  const rules = Array.isArray(data.permissions) ? data.permissions : []
  let edit: string | undefined
  let shell: string | undefined
  const allowed: string[] = []
  for (const rule of rules) {
    const row = record(rule)
    if (typeof row.action !== "string" || (row.effect !== "allow" && row.effect !== "deny" && row.effect !== "ask")) continue
    if (row.effect === "allow" && row.action !== "*") allowed.push(row.action)
    if (row.action === "edit" || row.action === "*") edit = row.effect
    if (row.action === "shell" || row.action === "bash" || row.action === "*") shell = row.effect
  }
  return { readOnly: edit === "deny" && shell !== "allow", permissions: [...new Set(allowed)] }
}

/**
 * Adapt the public V2 host onto the selected native agent.
 * No agent is registered and no permission rule is added.
 */
export function createPreparationPort(ctx: PreparationHost, hooksReady: boolean, nativeModels: () => Promise<readonly MissionPolicyModel[]>): PreparationPort {
  const cursors = new Map<string, string>()
  return {
    hooksReady,
    assertCapabilities: async () => { requireHost(ctx.session) },
    probeAgent: async agent => {
      if (!ctx.agent?.get) throw new Error("Native agent lookup is not available on this host")
      try {
        const found = await ctx.agent.get({ agentID: agent })
        return found ? "available" : "unavailable"
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/not found|unknown agent|\b404\b/i.test(message)) return "unavailable"
        throw error
      }
    },
    describeAgent: async agent => {
      if (!ctx.agent?.get) return { readOnly: false, permissions: [] }
      return nativeAgentFacts(await ctx.agent.get({ agentID: agent }))
    },
    nativeModels,
    createSession: async input => {
      const created = await ctx.session.create({
        title: input.title,
        parentID: input.parentID,
        location: { directory: ctx.location.directory },
      })
      if (!created.id) throw new Error("Preparation session was not created")
      return { id: created.id }
    },
    replacePermissions: async input => {
      if (typeof ctx.session.update !== "function" || typeof ctx.agent?.get !== "function") {
        throw new Error("Preparation requires session.update to replace inherited permissions")
      }
      try {
        const permissions = permissionRules(await ctx.agent.get({ agentID: input.agent }))
        await ctx.session.update({ sessionID: input.sessionID, permissions })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("session.update")) throw error
        throw new Error(`Preparation requires session.update to replace inherited permissions (${message})`)
      }
    },
    switchAgent: async input => {
      await ctx.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })
    },
    switchModel: async input => {
      await ctx.session.switchModel({
        sessionID: input.sessionID,
        model: { providerID: input.providerID, id: input.modelID, ...(input.variant ? { variant: input.variant } : {}) },
      })
    },
    prompt: async input => {
      requireHost(ctx.session)
      const before = lastAssistant(await ctx.session.context!({ sessionID: input.sessionID }))
      cursors.set(input.sessionID, before?.cursor ?? "")
      return ctx.session.prompt({ sessionID: input.sessionID, text: input.text, delivery: input.delivery } satisfies PreparationPromptCall)
    },
    wait: async input => {
      requireHost(ctx.session)
      await ctx.session.wait!({ sessionID: input.sessionID }, { signal: input.signal })
      const outcome = record(await ctx.session.get!({ sessionID: input.sessionID })).outcome
      if (outcome === "failed" || outcome === "interrupted") throw new Error(`Preparation native session ${outcome}`)
    },
    readAssistant: async input => {
      requireHost(ctx.session)
      const current = lastAssistant(await ctx.session.context!({ sessionID: input.sessionID }))
      const cursor = cursors.get(input.sessionID) ?? ""
      if (!current || current.cursor === cursor || !current.text.trim()) throw new Error("Preparation received no new assistant reply")
      cursors.set(input.sessionID, current.cursor)
      return current.text
    },
    abort: async input => {
      requireHost(ctx.session)
      await ctx.session.interrupt!({ sessionID: input.sessionID })
    },
  }
}
