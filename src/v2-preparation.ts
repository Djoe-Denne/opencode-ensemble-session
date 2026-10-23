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
    wait?(input: Record<string, unknown>): Promise<unknown>
    context?(input: Record<string, unknown>): Promise<unknown>
    interrupt?(input: Record<string, unknown>): Promise<unknown>
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function assistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  const texts = messages.flatMap(message => {
    const entry = record(message)
    const info = record(entry.info)
    const role = entry.type ?? entry.role ?? info.role
    if (role !== "assistant") return []
    if (typeof entry.content === "string") return [entry.content]
    const parts = Array.isArray(entry.content) ? entry.content : Array.isArray(entry.parts) ? entry.parts : []
    const text = parts.flatMap(part => {
      const row = record(part)
      return row.type === "text" && row.synthetic !== true && typeof row.text === "string" ? [row.text] : []
    }).join("")
    return text.trim() ? [text] : []
  })
  return texts.at(-1) ?? ""
}

/** Copy native allow-rules. A denied edit action marks the agent read-only. */
export function nativeAgentFacts(value: unknown): { readOnly: boolean; permissions: string[] } {
  const root = record(value)
  const data = Object.keys(record(root.data)).length ? record(root.data) : root
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
  return {
    hooksReady,
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
      const created = await ctx.session.create({ title: input.title, location: { directory: input.directory } })
      if (!created.id) throw new Error("Preparation session was not created")
      return { id: created.id }
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
    prompt: async input => ctx.session.prompt({ sessionID: input.sessionID, text: input.text, delivery: input.delivery } satisfies PreparationPromptCall),
    wait: async input => {
      if (ctx.session.wait) await ctx.session.wait({ sessionID: input.sessionID })
    },
    readAssistant: async input => {
      if (!ctx.session.context) throw new Error("Preparation readback requires session.context")
      return assistantText(await ctx.session.context({ sessionID: input.sessionID }))
    },
    abort: async input => {
      if (ctx.session.interrupt) await ctx.session.interrupt({ sessionID: input.sessionID })
    },
  }
}
