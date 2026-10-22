import type { Database } from "./db"
import type { MemberRegistry, DescendantTracker, PendingPurgeApprovals } from "./state"
import type { EnsembleConfig } from "./config"
import type { ProgressTracker } from "./progress"
import type { ClassificationPort } from "./mission-classification"
import type { MissionPolicyModel } from "./mission-model-policy"

/**
 * Shared dependencies injected into every tool's execute function.
 * This avoids global state and makes tools testable with mocks.
 */
export interface ToolDeps {
  db: Database
  registry: MemberRegistry
  tracker: DescendantTracker
  purgeApprovals: PendingPurgeApprovals
  /** The OpenCode SDK client — used for session.create, promptAsync, abort, etc. */
  client: PluginClient
  /** The project root directory — used for reading AGENTS.md and other project files. */
  directory: string
  /** Plugin configuration. */
  config: Required<EnsembleConfig>
  /** Stall/activity tracker — shared with the Watchdog. */
  progressTracker: ProgressTracker
  /** Branch preservation seam for spawn rollback; defaults to the real Git helper. */
  preserveBranch?: (source: string, target: string, directory: string) => Promise<boolean>
  /** Capability-gated native classification; V1/unsupported hosts leave this absent. */
  classifier?: ClassificationPort
  /** Exact enabled model/variant identities from the public V2 host catalogue. */
  nativeModels?: () => Promise<readonly MissionPolicyModel[]>
}

/** A single permission rule for session-level enforcement. */
export interface PermissionRule {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

/** Opt-in native context inheritance. messageID is an exclusive checkpoint boundary. */
export interface SpawnContext {
  mode: "fresh" | "fork" | "checkpoint" | "compact_fork"
  from?: string
  messageID?: string
}

/** Public V2 operations; absent on V1 and on hosts without these capabilities. */
export interface SessionContinuity {
  fork(options: { sessionID: string; before?: string }): Promise<{ id: string }>
  switchAgent(options: { sessionID: string; agent: string; permission?: PermissionRule[]; initializing?: boolean }, signal?: AbortSignal): Promise<void>
  move(options: { sessionID: string; directory: string }): Promise<void>
  compact(options: { sessionID: string }): Promise<void>
  remove(options: { sessionID: string }): Promise<void>
}

/**
 * Minimal interface for the OpenCode v2 SDK client methods we actually use.
 * Uses flat params matching the v2 SDK (imported from @opencode-ai/sdk/v2).
 * Makes mocking trivial in tests.
 */
export interface PluginClient {
  /** Capability-gated V2 session continuity, using the same host as session.*. */
  continuity?: SessionContinuity
  session: {
    create(options: {
      parentID?: string
      title?: string
      permission?: PermissionRule[]
      workspaceID?: string
      directory?: string
    }): Promise<{ data?: { id: string } }>
    promptAsync(options: {
      sessionID: string
      parts: Array<{ type: "text"; text: string }>
      model?: { providerID: string; modelID: string }
      /** Native reasoning-effort variant for the selected model. */
      variant?: string
      agent?: string
      tools?: Record<string, boolean>
      system?: string
      /** V2: deliver as a synthetic (system) message instead of a user prompt. */
      synthetic?: boolean
      /** V2 durable admission marker; never copied or used to reconstruct history. */
      metadata?: Record<string, unknown>
    }): Promise<unknown>
    abort(options: { sessionID: string }): Promise<unknown>
    /** V2 native model pinning for a direct claim before the worker's next turn. */
    switchModel?(options: { sessionID: string; model: { providerID: string; modelID: string }; variant?: string }): Promise<unknown>
    status(): Promise<{ data?: Record<string, { type: string }> }>
    messages(options: { sessionID: string; limit?: number }): Promise<{ data?: Array<{ info: unknown; parts: unknown[] }> }>
    get(options: { sessionID: string }): Promise<{ data?: unknown }>
  }
  tui: {
    showToast(options: {
      title?: string
      message?: string
      variant?: "info" | "success" | "warning" | "error"
      duration?: number
    }): Promise<unknown>
    selectSession(options: { sessionID?: string }): Promise<unknown>
  }
  worktree: {
    create(options: { worktreeCreateInput?: { name?: string; startCommand?: string } }): Promise<{ data?: { name: string; branch: string; directory: string } }>
    remove(options: { worktreeRemoveInput?: { directory: string } }): Promise<unknown>
    list(): Promise<{ data?: Array<{ name: string; branch: string; directory: string }> }>
    reset(options: { worktreeResetInput?: { directory: string } }): Promise<unknown>
  }
  workspace: {
    create(options: { id?: string; type?: string; branch?: string | null; extra?: unknown | null }): Promise<{ data?: { id: string; type: string; branch: string | null; directory: string | null; projectID: string } }>
    remove(options: { id: string }): Promise<unknown>
    list(): Promise<{ data?: Array<{ id: string; type: string; branch: string | null; directory: string | null; projectID: string }> }>
  }
}

/**
 * Look up which team a session belongs to (as lead or member).
 * Returns team info or undefined.
 *
 * Lookup order for member sessions:
 *   1. Registry fast-path (in-memory cache)
 *   2. SQLite fallback (canonical source)
 *
 * The SQLite fallback is critical when multiple Plugin instances run in the
 * same process (e.g. opencode Desktop's local sidecar plus a connected
 * `opencode serve` sharing the same DB). Each instance has its own
 * MemberRegistry; without a SQLite fallback, a tool call dispatched to
 * a Plugin instance whose registry never saw the spawn fails with
 * "This session is not in a team."
 *
 * Only members in active teams with non-terminal status are resolved.
 */
export function findTeamBySession(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
): { teamId: string; teamName: string; role: "lead" | "member"; memberName?: string } | undefined {
  // Fast path: registry cache
  const entry = registry.getBySession(sessionId)
  if (entry) {
    const team = db.query("SELECT name FROM team WHERE id = ? AND status = 'active'").get(entry.teamId) as { name: string } | null
    if (team) return { teamId: entry.teamId, teamName: team.name, role: "member", memberName: entry.memberName }
  }

  // SQLite fallback: another Plugin instance may have registered this teammate
  if (!entry) {
    const memberRow = db.query(
      `SELECT tm.team_id, tm.name as member_name, t.name as team_name
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE tm.session_id = ?
         AND t.status = 'active'
          AND tm.status NOT IN ('shutdown', 'error')
          AND tm.spawn_pending = 0`
    ).get(sessionId) as { team_id: string; member_name: string; team_name: string } | null
    if (memberRow) {
      // Populate the cache so subsequent lookups skip the SQL query.
      // Safe without TTL: session IDs are server-generated UUIDs and are
      // never reused across team_spawn invocations, so a session ID maps
      // to at most one (teamId, memberName) for the life of the process.
      // team_cleanup explicitly invalidates via registry.unregisterTeam.
      registry.register(memberRow.team_id, memberRow.member_name, sessionId)
      return { teamId: memberRow.team_id, teamName: memberRow.team_name, role: "member", memberName: memberRow.member_name }
    }
  }

  // Check if session is a team lead (already SQLite-backed, naturally cross-instance)
  const leadTeam = db.query("SELECT id, name FROM team WHERE lead_session_id = ? AND status = 'active'").get(sessionId) as { id: string; name: string } | null
  if (leadTeam) return { teamId: leadTeam.id, teamName: leadTeam.name, role: "lead" }

  return undefined
}

/**
 * Get the session ID for a recipient by name.
 * "lead" resolves to the team's lead_session_id.
 * Otherwise looks up the member via the registry, then falls back to SQLite
 * (covers the multi-Plugin-instance scenario — see findTeamBySession).
 */
export function resolveRecipientSession(
  db: Database,
  registry: MemberRegistry,
  teamId: string,
  recipientName: string,
): string | undefined {
  if (recipientName === "lead") {
    const team = db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamId) as { lead_session_id: string } | null
    return team?.lead_session_id
  }
  const entry = registry.getByName(teamId, recipientName)
  if (entry) return entry.sessionId

  // SQLite fallback: another Plugin instance may have registered this teammate
  const memberRow = db.query(
    `SELECT session_id FROM team_member
     WHERE team_id = ? AND name = ? AND status NOT IN ('shutdown', 'error')`
  ).get(teamId, recipientName) as { session_id: string } | null
  if (!memberRow) return undefined

  // Populate the cache
  registry.register(teamId, recipientName, memberRow.session_id)
  return memberRow.session_id
}
