import type { SessionContinuity } from "./types"
import type { V2Context } from "./v2-client"
import path from "node:path"
import { runCommand } from "./process"
import { discoverV2HttpBridge } from "./v2-http-bridge"

interface NativeSession {
  id: string
  projectID?: string
  agent?: string
  time?: { created?: number }
  location: { directory: string }
  permissions?: NativeRule[]
  metadata?: Record<string, unknown>
}
interface NativeRule { action: string; resource: string; effect: string }

/** Tools available to a teammate independently of its current agent role. */
export const MEMBER_TOOLS = ["team_message", "team_broadcast", "team_tasks_list", "team_tasks_add", "team_tasks_complete", "team_claim", "team_results", "team_status", "team_view", "team_handoff"] as const

const sameDirectory = (a: string, b: string) => path.resolve(a) === path.resolve(b)

/** Fail closed: a context fork must not silently transfer or omit another branch's changes. */
async function verifyIsolatedMove(source: string, destination: string): Promise<void> {
  const inspect = async (directory: string) => {
    const status = await runCommand(["git", "status", "--porcelain"], { cwd: directory })
    const head = await runCommand(["git", "rev-parse", "HEAD"], { cwd: directory })
    if (status.exitCode !== 0 || head.exitCode !== 0) throw new Error("Cannot verify source/worktree Git isolation; refusing session.move")
    if (status.stdout.trim()) throw new Error("Non-transferable source/worktree changes: commit or resolve them before inheriting into another directory")
    return head.stdout.trim()
  }
  const [sourceHead, destinationHead] = await Promise.all([inspect(source), inspect(destination)])
  if (sourceHead !== destinationHead) throw new Error("Source and destination worktree have different commits; integrate the source branch before inheriting. Changes are never transferred implicitly.")
}

function notFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError"
}

/** Optional connection to the same V2 server's public API (fork is missing from Plugin.Context). */
export interface V2ContinuityOptions {
  apiUrl?: string
  authorization?: string
  fetch?: typeof globalThis.fetch
  verifyMove?: (source: string, destination: string) => Promise<void>
  discoverBridge?: () => Promise<{ apiUrl: string; authorization?: string } | undefined>
}

/** Adapt public native V2 operations, with an explicit HTTP bridge for fork. */
export function createV2Continuity(ctx: V2Context, options: V2ContinuityOptions = {}): SessionContinuity {
  const connection = async () => {
    if (options.apiUrl) return { apiUrl: options.apiUrl, authorization: options.authorization }
    let discovered: Awaited<ReturnType<typeof discoverV2HttpBridge>>
    try {
      discovered = await (options.discoverBridge ?? discoverV2HttpBridge)()
    } catch {
      throw new Error("Cannot discover the shared OpenCode service; configure v2ApiUrl for the same server. No fresh fallback was performed.")
    }
    if (!discovered) throw new Error("Native fork is not exposed and no shared OpenCode service was discovered. Configure v2ApiUrl (OPENCODE_ENSEMBLE_V2_API_URL) for the same server; no fresh fallback was performed.")
    return { ...discovered, authorization: options.authorization ?? discovered.authorization }
  }
  const request = async (bridge: { apiUrl: string; authorization?: string }, method: string, route: string, body?: unknown): Promise<unknown> => {
    const url = new URL(route, bridge.apiUrl)
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method, redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { "content-type": "application/json", ...(bridge.authorization ? { authorization: bridge.authorization } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`OpenCode V2 ${method} ${route} failed (HTTP ${response.status})`)
    if (response.status === 204) return undefined
    const result = await response.json() as { data?: unknown }
    return result.data ?? result
  }
  const get = async (sessionID: string) => await ctx.session.get({ sessionID }) as NativeSession
  const verifyServer = async (sessionID: string, bridge: { apiUrl: string; authorization?: string }) => {
    const local = await get(sessionID)
    const remote = await request(bridge, "GET", `/api/session/${encodeURIComponent(sessionID)}`) as NativeSession
    if (remote.id !== local.id || !local.projectID || remote.projectID !== local.projectID ||
      local.time?.created === undefined || remote.time?.created !== local.time.created ||
      !remote.location?.directory || !sameDirectory(remote.location.directory, local.location.directory)) {
      throw new Error("v2ApiUrl must address the same OpenCode server/source session as the plugin")
    }
  }
  const wait = async (sessionID: string) => {
    if (!ctx.session.wait) throw new Error("This OpenCode V2 host does not expose session.wait")
    await ctx.session.wait({ sessionID }, { signal: AbortSignal.timeout(120_000) })
  }
  return {
    fork: async ({ sessionID, before }) => {
      if (!ctx.session.remove) throw new Error("Native session.remove is required for safe fork rollback on this V2 host")
      if (ctx.session.fork) return ctx.session.fork({ sessionID, ...(before ? { before } : {}) })
      const bridge = await connection()
      await verifyServer(sessionID, bridge)
      const child = await request(bridge, "POST", `/api/session/${encodeURIComponent(sessionID)}/fork`, before ? { before } : {}) as { id?: string; fork?: { sessionID: string } }
      if (!child.id || child.id === sessionID || child.fork?.sessionID !== sessionID) throw new Error("Native fork returned an invalid child/source relationship")
      return { id: child.id }
    },
    switchAgent: async ({ sessionID, agent, permission, initializing }, signal) => {
      signal?.throwIfAborted()
      // Native agent lookup rejects typos before changing role or permission overrides.
      if (ctx.agent) await ctx.agent.get({ agentID: agent })
      const original = await get(sessionID)
      const managed = original.metadata?.["ensemble.permissions"]
      if (Array.isArray(managed) && !ctx.session.update) throw new Error("This V2 host needs session.update to replace Ensemble-owned permission overrides during handoff")
      try {
        signal?.throwIfAborted()
        await ctx.session.switchAgent({ sessionID, agent }, { signal })
        if (ctx.session.update && (Array.isArray(managed) || permission)) {
          const owned = Array.isArray(managed) ? [...managed] as NativeRule[] : []
          const retained = (original.permissions ?? []).filter(rule => {
            const i = owned.findIndex(value => value.action === rule.action && value.resource === rule.resource && value.effect === rule.effect)
            if (i < 0) return true
            owned.splice(i, 1)
            return false
          })
          // Let the new native agent supply its own edit/shell/model policy.
          const next = permission?.map(rule => ({ action: rule.permission === "bash" ? "shell" : rule.permission, resource: rule.pattern, effect: rule.action }))
            ?? [...MEMBER_TOOLS, "execute"].map(action => ({ action, resource: "*", effect: "allow" }))
          await ctx.session.update({ sessionID, permissions: [...retained, ...next], metadata: { ...original.metadata, "ensemble.permissions": next } }, { signal })
        }
        if (initializing) await wait(sessionID)
      } catch (error) {
        // If permission replacement fails, restore the previous role before returning.
        if (original.agent) await ctx.session.switchAgent({ sessionID, agent: original.agent }).catch(() => undefined)
        throw error
      }
    },
    move: async ({ sessionID, directory }) => {
      if (!ctx.session.move || !ctx.session.wait) throw new Error("Native V2 session.move/wait are required for inherited worktree isolation")
      const source = await get(sessionID)
      if (sameDirectory(source.location.directory, directory)) return
      await (options.verifyMove ?? verifyIsolatedMove)(source.location.directory, directory)
      // Spike-verified on V2 2.0.25: move is a durable location switch, not a Git patch transfer.
      // The public contract has no moveChanges field; do not invent one or copy files.
      await ctx.session.move({ sessionID, directory, delivery: "steer" })
      // Resume native control items (the move), while queued prompts remain
      // parked. Agent switching happens after this boundary. The pending-spawn
      // context hook prevents provider execution until the task is admitted.
      await ctx.session.interrupt({ sessionID, resume: true })
      await wait(sessionID)
      const moved = await get(sessionID)
      if (!sameDirectory(moved.location.directory, directory)) throw new Error("Native session.move did not bind the child to its teammate worktree")
    },
    compact: async ({ sessionID }) => {
      if (!ctx.session.compact || !ctx.session.wait) throw new Error("Native V2 compact/wait capabilities are required for compact_fork")
      const active = await (async () => {
        if (ctx.session.active) return ctx.session.active()
        const bridge = await connection()
        await verifyServer(sessionID, bridge)
        return await request(bridge, "GET", "/api/session/active") as Record<string, unknown>
      })()
      if (active[sessionID]) throw new Error("compact_fork requires an idle source session")
      const admitted = await ctx.session.compact({ sessionID, delivery: "queue" })
      await wait(sessionID)
      const messages = await ctx.session.context({ sessionID })
      const checkpoint = messages.find(message => !!message && typeof message === "object" && "id" in message && message.id === admitted.id) as { type?: string; status?: string } | undefined
      if (checkpoint?.type !== "compaction" || checkpoint.status !== "completed") throw new Error(`Native compaction ${admitted.id} did not complete successfully; no fork was created`)
    },
    remove: async ({ sessionID }) => {
      if (!ctx.session.remove) throw new Error("Native V2 session.remove is required for rollback")
      try { await ctx.session.remove({ sessionID }) }
      catch (error) { if (!notFound(error)) throw error }
    },
  }
}
