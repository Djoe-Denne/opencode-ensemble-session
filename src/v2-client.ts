import type { PluginClient } from "./types"
import { runCommand } from "./process"
import { attachWorktreeBranch } from "./worktree-branches"
import { createV2Continuity, type V2ContinuityOptions } from "./v2-continuity"
import { discoverV2HttpBridge } from "./v2-http-bridge"
import { retireV2Worktree } from "./v2-worktree-retirement"

/** V2 plugin context subset Ensemble needs (structural, mock-friendly). */
export interface V2Context {
  location?: { directory: string; project?: { id: string; canonical?: string } }
  session: {
    create(input: Record<string, unknown>): Promise<{ id: string }>
    prompt(input: Record<string, unknown>): Promise<unknown>
    switchAgent(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
    switchModel(input: Record<string, unknown>): Promise<unknown>
    interrupt(input: Record<string, unknown>): Promise<unknown>
    get(input: Record<string, unknown>): Promise<unknown>
    context(input: Record<string, unknown>): Promise<unknown[]>
    active?(): Promise<Record<string, { type: string }>>
    synthetic(input: Record<string, unknown>): Promise<unknown>
    fork?(input: Record<string, unknown>): Promise<{ id: string }>
    move?(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
    compact?(input: Record<string, unknown>): Promise<{ id: string }>
    wait?(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
    remove?(input: Record<string, unknown>): Promise<unknown>
    update?(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
  }
  agent?: { get(input: { agentID: string }): Promise<unknown> }
  worktree: {
    create(input: Record<string, unknown>): Promise<{ directory: string }>
    remove(input: Record<string, unknown>): Promise<unknown>
    list(input?: Record<string, unknown>): Promise<Array<{ directory: string }>>
    refresh(input?: Record<string, unknown>): Promise<unknown>
  }
  permission?: {
    list?(input?: { location?: { directory: string } }): Promise<unknown>
    rules?(input: Record<string, unknown>): Promise<unknown>
    hook?(name: "evaluate", callback: (event: { sessionID: string; action: string; effect: string }) => void): Promise<unknown>
  }
}

/** Prefix marking a workspace id that is really a local directory (see below). */
const DIR_WORKSPACE_PREFIX = "v2dir:"

/** Injectable shell lookups (default to git; overridden in tests). */
export interface V2ClientDeps extends V2ContinuityOptions {
  /** Verified retirement seam; public native operations remain the default. */
  retireWorktree?: typeof retireV2Worktree
  /** Current branch checked out in a directory, or null when unknown. */
  gitBranch?: (directory: string) => Promise<string | null>
  /** Worktree directory currently on a branch, or null when none. */
  gitDir?: (branch: string) => Promise<string | null>
  /** Attach a verified detached worktree to a new Ensemble-owned branch. */
  attachBranch?: (directory: string, source: string) => Promise<string>
  /** RPC emitter for companion events (team_view navigation). */
  rpcEmitter?: { events: { emit(name: string, data: unknown): Promise<unknown> } }
}

/** Current branch in a directory via git. */
async function gitBranchDefault(directory: string): Promise<string | null> {
  try {
    const result = await runCommand(["git", "branch", "--show-current"], { cwd: directory })
    const branch = result.stdout.trim()
    return result.exitCode === 0 && branch ? branch : null
  } catch {
    return null
  }
}

/** Concatenate the text parts of a promptAsync payload into one string. */
function joinParts(parts: Array<{ type: "text"; text: string }>): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

/**
 * Adapt a V2 plugin context to the shared PluginClient interface so all 15
 * team tools run unchanged on V2 (DRY: one adapter, zero logic forks).
 *
 * Mapping notes (all spike-verified live against v2.0.3 unless marked OQ):
 * - create: V1 `permission` rules become V2 `{action, resource, effect}`;
 *   `workspaceID`/`directory` nest under `location`.
 * - promptAsync: queue delivery wakes idle sessions; `agent` is applied via
 *   switchAgent first (V2 binds the agent at create/admission, and the shared
 *   create signature has no agent slot — only spawn passes one).
 * - abort: interrupt. status: derived from the active set — sessions absent
 *   from it read as idle, which matches the shutdown default (team-shutdown
 *   treats unknown as idle). OQ-V2-status: if V2 ever reports non-running
 *   states here, extend the mapping.
 * - tui.*: no-op. Toasts and session-select move to the CLI (`./tui`) plugin
 *   in a later phase — the server plugin must not depend on a TUI.
 * - worktree.create: V2 reports only the directory, so the branch is read
 *   back via git. A verified detached worktree gets a unique Ensemble branch.
 * - worktree.list: V2 entries carry directory only; name is the basename
 *   (recovery filters on the `ensemble-` prefix — a non-matching dir is
 *   skipped, never wrongly deleted). reset has no production callers and
 *   maps to refresh. OQ-V2-wtname.
 * - workspace.*: V2 ctx has no workspace domain (workspaces are
 *   provider-based). create bridges a branch to its worktree directory and
 *   returns a `v2dir:<dir>` id; session.create routes that id to
 *   location.directory, preserving worktree isolation with zero tool
 *   changes. list returns [] and remove resolves — the DB workspace_id
 *   column stays the source of truth and is still nulled by cleanup.
 */
export function createV2Client(ctx: V2Context, deps: V2ClientDeps = {}): PluginClient {
  const gitBranch = deps.gitBranch ?? gitBranchDefault
  const worktreeDirectories = new Map<string, string>()
  const project = ctx.location?.project ? { projectID: ctx.location.project.id } : {}
  return {
    continuity: createV2Continuity(ctx, deps),
    session: {
      create: async (options) => {
        const input: Record<string, unknown> = { title: options.title }
        if (options.parentID) input["parentID"] = options.parentID
        // V1 action names predate the V2 vocabulary: bash is now shell.
        const V1_ACTION_MAP: Record<string, string> = { bash: "shell" }
        const permissions = options.permission?.map((rule) => ({
          action: V1_ACTION_MAP[rule.permission] ?? rule.permission,
          resource: rule.pattern,
          effect: rule.action,
        }))
        if (permissions) input["permissions"] = permissions
        if (permissions) input["metadata"] = { "ensemble.permissions": permissions }
        if (options.workspaceID ?? options.directory) {
          if (options.workspaceID?.startsWith(DIR_WORKSPACE_PREFIX)) {
            input["location"] = {
              directory: options.workspaceID.slice(DIR_WORKSPACE_PREFIX.length),
            }
          } else {
            input["location"] = {
              ...(options.directory ? { directory: options.directory } : {}),
              ...(options.workspaceID ? { workspaceID: options.workspaceID } : {}),
            }
          }
        }
        const created = await ctx.session.create(input)
        if (permissions && ctx.permission?.rules) {
          // Session.create permissions lose to agent rules (last match wins
          // and agent rules apply later), which strips team tools from
          // read-only agents. Re-assert here: rules() evaluates after the
          // agent's rules, restoring the tools. OQ-V2-rules.
          await ctx.permission.rules({ sessionID: created.id, permissions })
        }
        return { data: { id: created.id } }
      },
      promptAsync: async (options) => {
        // Synthetic (system) messages render as persistent transcript entries
        // instead of fake user turns — the native form for agent notifications.
        if (options.synthetic) {
          return ctx.session.synthetic({ sessionID: options.sessionID, text: joinParts(options.parts), delivery: "queue" })
        }
        if (options.agent) {
          await ctx.session.switchAgent({ sessionID: options.sessionID, agent: options.agent })
        }
        // V2 binds model at create/admission; the shared create signature has
        // no model slot, so apply it here (spawn is the only model passer).
        // Caught live: without this, teammates inherit the server default.
        // Precedence: the persisted native variant is sent unchanged. An omitted
        // variant means host default and must not inherit a profile effort.
        // Canonical effort is an annotation, not a switchModel input.
        if (options.model) {
          await ctx.session.switchModel({
            sessionID: options.sessionID,
            model: { providerID: options.model.providerID, id: options.model.modelID, ...(options.variant ? { variant: options.variant } : {}) },
          })
        }
        const text = joinParts(options.parts)
        return ctx.session.prompt({ sessionID: options.sessionID, text, delivery: "queue", ...(options.metadata ? { metadata: options.metadata } : {}) })
      },
      switchModel: async options => ctx.session.switchModel({
        sessionID: options.sessionID,
        model: { providerID: options.model.providerID, id: options.model.modelID, ...(options.variant ? { variant: options.variant } : {}) },
      }),
      abort: async (options) => ctx.session.interrupt({ sessionID: options.sessionID }),
      status: async () => {
        // The installed public Plugin.Context omits active(), although the
        // same server exposes it through its authenticated public HTTP API.
        const active = ctx.session.active ? await ctx.session.active() : await (async () => {
          const bridge = deps.apiUrl
            ? { apiUrl: deps.apiUrl, authorization: deps.authorization }
            : await (deps.discoverBridge ?? discoverV2HttpBridge)()
          if (!bridge) throw new Error("Native activity unavailable: shared service not discovered")
          const authorization = deps.authorization ?? bridge.authorization
          const get = async (route: string): Promise<unknown> => {
            const response = await (deps.fetch ?? globalThis.fetch)(new URL(route, bridge.apiUrl), {
              method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
              headers: authorization ? { authorization } : {},
            })
            if (!response.ok) throw new Error(`Native activity inspection failed (HTTP ${response.status})`)
            return response.json()
          }
          const info = await get("/api/info")
          if (!info || typeof info !== "object" || !("pid" in info) || info.pid !== process.pid) {
            throw new Error("Native activity bridge must address the same OpenCode process")
          }
          const result = await get("/api/session/active")
          return result && typeof result === "object" && "data" in result ? result.data : result
        })()
        if (!active || typeof active !== "object" || Array.isArray(active) || Object.values(active).some(value =>
          !value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string")) {
          throw new Error("Malformed native activity response; idleness is not established")
        }
        const data: Record<string, { type: string }> = {}
        for (const sessionID of Object.keys(active)) data[sessionID] = { type: "busy" }
        return { data }
      },
      messages: async (options) => {
        const messages = await ctx.session.context({ sessionID: options.sessionID })
        // V2 context contains native typed messages, not V1 {info, parts} rows.
        return { data: messages.map(message => {
          const value = message as Record<string, unknown>
          if (value.info) return value as { info: unknown; parts: unknown[] }
          return { info: { ...value, role: value.type }, parts: Array.isArray(value.content) ? value.content : [] }
        }) }
      },
      get: async (options) => {
        const data = await ctx.session.get({ sessionID: options.sessionID })
        return { data }
      },
    },
    tui: {
      showToast: async () => undefined,
      selectSession: async (options) => {
        // Native agent switching on V2: shared team_view calls this, the
        // companion receives the event and navigates the TUI to the
        // teammate session. No server-side TUI API exists on V2.
        if (deps.rpcEmitter) {
          await deps.rpcEmitter.events.emit("view", { sessionID: options.sessionID }).catch(() => {
            // Companion optional — never fail team_view for it.
          })
        }
        return undefined
      },
    },
    worktree: {
      create: async (options) => {
        const name = (options.worktreeCreateInput as { name?: string } | undefined)?.name ?? "ensemble-worktree"
        const created = await ctx.worktree.create({ name, ...project, ...(ctx.location ? { from: ctx.location.directory } : {}) })
        const discovered = await gitBranch(created.directory)
        const branch = discovered ?? (ctx.location
          ? await (deps.attachBranch ?? attachWorktreeBranch)(created.directory, ctx.location.directory)
          : null)
        if (!branch) throw new Error(`Refusing worktree ${created.directory}: git branch --show-current is empty`)
        if (!discovered && await gitBranch(created.directory) !== branch) {
          throw new Error(`Refusing worktree ${created.directory}: branch attachment was not verified`)
        }
        worktreeDirectories.set(branch, created.directory)
        return { data: { name, branch, directory: created.directory } }
      },
      remove: async (options) => {
        const directory = (options.worktreeRemoveInput as { directory: string }).directory
        return ctx.worktree.remove({ ...project, directory, force: false })
      },
      retire: request => (deps.retireWorktree ?? retireV2Worktree)(ctx.worktree, ctx.location?.project?.id, request),
      list: async () => {
        const entries = await ctx.worktree.list(project)
        return {
          data: entries.map((entry) => ({
            name: entry.directory.split(/[\\/]/u).filter(segment => segment.length > 0).pop() ?? entry.directory,
            branch: "",
            directory: entry.directory,
          })),
        }
      },
      reset: async () => ctx.worktree.refresh(project),
    },
    workspace: {
      create: async (options) => {
        const branch = (options as { branch?: string }).branch ?? ""
        const directory = await deps.gitDir?.(branch) ?? worktreeDirectories.get(branch)
        if (!directory) throw new Error(`V2 workspace bridge: no worktree found on branch "${branch}"`)
        return {
          data: {
            id: `${DIR_WORKSPACE_PREFIX}${directory}`,
            type: "local",
            branch,
            directory,
            projectID: "",
          },
        }
      },
      remove: async () => undefined,
      list: async () => ({
        data: [] as Array<{
          id: string
          type: string
          branch: string | null
          directory: string | null
          projectID: string
        }>,
      }),
    },
  } as PluginClient
}
