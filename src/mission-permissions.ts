import type { Database } from "./db"
import { getApprovedMissionAutonomy } from "./mission-autonomy"

interface Rule { action: string; resource: string; effect: "allow" | "deny" | "ask" }
interface Owned { version: 1; teamId: string; before: Rule[]; applied: Rule[] }
const KEY = "ensemble.longRunPermissions"
const FULL: Rule = { action: "*", resource: "*", effect: "allow" }
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function rules(value: unknown): Rule[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => {
    const rule = object(item)
    return !rule || typeof rule.action !== "string" || typeof rule.resource !== "string" || !["allow", "deny", "ask"].includes(String(rule.effect))
  })) throw new Error("Native session/profile permissions are malformed")
  return value as Rule[]
}

function owned(value: unknown): Owned | undefined {
  if (value === undefined) return undefined
  const marker = object(value)
  if (marker?.version !== 1 || typeof marker.teamId !== "string" || !Array.isArray(marker.before) || !Array.isArray(marker.applied)) throw new Error("Invalid owned long-run permission metadata")
  return { version: 1, teamId: marker.teamId, before: rules(marker.before), applied: rules(marker.applied) }
}

function baseline(current: Rule[], marker: Owned | undefined): Rule[] {
  if (!marker) return current
  // Preserve rules appended by the user. A replacement (e.g. native handoff)
  // is authoritative instead of resurrecting the previous role's permissions.
  return equal(current.slice(0, marker.applied.length), marker.applied)
    ? [...marker.before, ...current.slice(marker.applied.length)] : current
}

/** Public native APIs used to scope and restore long-run session access. */
export interface MissionPermissionsHost {
  session: {
    get(input: Record<string, unknown>): Promise<unknown>
    update?(input: Record<string, unknown>): Promise<unknown>
  }
  agent?: { get(input: { agentID: string; location?: { directory?: string } }): Promise<unknown> }
}

/** Own only native session overrides derived from the last approved autonomy. */
export class MissionPermissions {
  private readonly pending = new Map<string, Promise<void>>()
  constructor(private readonly db: Database, private readonly host: MissionPermissionsHost) {}

  /** Reconcile one lead/member; preparation and classification helpers receive no grants. */
  async syncSession(teamId: string | undefined, sessionID: string): Promise<void> {
    const previous = this.pending.get(sessionID) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => this.reconcile(teamId, sessionID))
    this.pending.set(sessionID, operation)
    try { await operation } finally { if (this.pending.get(sessionID) === operation) this.pending.delete(sessionID) }
  }

  private async reconcile(teamId: string | undefined, sessionID: string): Promise<void> {
    const team = teamId ? this.db.query(`SELECT t.lead_session_id FROM team t JOIN project p ON p.id = t.project_id
      WHERE t.id = ? AND t.status = 'active' AND p.status = 'active'`).get(teamId) as { lead_session_id: string } | null : null
    const lead = team?.lead_session_id === sessionID
    // Phase 2 is isolated and awaiting prompt acknowledgement; context still
    // requires its exact task marker before any inherited worker can execute.
    const member = team && !lead ? this.db.query(`SELECT session_id FROM team_member WHERE team_id = ? AND session_id = ?
      AND status IN ('ready', 'busy') AND spawn_pending IN (0, 2)`).get(teamId, sessionID) : undefined
    const delegated = Boolean(team && (lead || member) && getApprovedMissionAutonomy(this.db, teamId!)?.mode === "long_run")
    const session = object(await this.host.session.get({ sessionID }))
    if (!session) {
      if (delegated) throw new Error(`Native session unavailable for long-run permissions: ${sessionID}`)
      return
    }
    const metadata = object(session.metadata) ?? {}
    const marker = owned(metadata[KEY])
    if (!delegated && !marker) return
    const current = rules(session.permissions)
    const before = baseline(current, marker)
    let desired = before
    if (delegated && lead) {
      desired = [...before, FULL, ...before.filter(rule => rule.effect === "deny")]
    } else if (delegated) {
      if (!this.host.agent?.get || typeof session.agent !== "string") throw new Error("Native worker profile permissions are unavailable")
      const directory = object(session.location)?.directory
      const profile = object(await this.host.agent.get({ agentID: session.agent,
        ...(typeof directory === "string" ? { location: { directory } } : {}) }))
      if (!Array.isArray(profile?.permissions)) throw new Error("Native worker profile permissions are unavailable")
      const allowQuestions = (rule: Rule): Rule => rule.effect === "ask" ? { ...rule, effect: "allow" } : rule
      // Do not propagate an inherited lead wildcard into a restricted worker.
      // The profile and existing coordination/planning overlays remain intact.
      desired = [...rules(profile.permissions).map(allowQuestions),
        ...before.filter(rule => !(rule.action === "*" && rule.resource === "*" && rule.effect === "allow")).map(allowQuestions)]
    }
    const nextMetadata = { ...metadata }
    if (delegated) nextMetadata[KEY] = { version: 1, teamId: teamId!, before: before.map(rule => ({ ...rule })), applied: desired.map(rule => ({ ...rule })) } satisfies Owned
    else delete nextMetadata[KEY]
    if (equal(current, desired) && equal(metadata, nextMetadata)) return
    if (!this.host.session.update) throw new Error("Native session.update is required for long-run access")
    await this.host.session.update({ sessionID, permissions: desired, metadata: nextMetadata })
    const verified = object(await this.host.session.get({ sessionID }))
    if (!verified || !equal(rules(verified.permissions), desired) || !equal(object(verified.metadata)?.[KEY], nextMetadata[KEY])) {
      throw new Error(`Native long-run permission update was not verified: ${sessionID}`)
    }
  }

  /** Apply or revoke a team's session overrides without changing native profiles. */
  async syncTeam(teamId: string, restore = false): Promise<void> {
    const team = this.db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamId) as { lead_session_id: string } | null
    if (!team) return
    const members = this.db.query("SELECT session_id FROM team_member WHERE team_id = ?").all(teamId) as Array<{ session_id: string }>
    for (const sessionID of [team.lead_session_id, ...members.map(member => member.session_id)]) await this.syncSession(restore ? undefined : teamId, sessionID)
  }
}
