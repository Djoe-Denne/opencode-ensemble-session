import type { Database } from "./db"
import { createDb, getDbPath } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import { MemberRegistry as MemberRegistryImpl, DescendantTracker as DescendantTrackerImpl, PendingPurgeApprovals } from "./state"
import { dispatchV2Event, type V2EventLike } from "./v2-events"
import { deliverPrompt, type V2SessionPort } from "./v2-session"
import type { V2Context } from "./v2-client"
import { createV2Client } from "./v2-client"
import { registerV2Tools } from "./v2-tools"
import type { ToolDeps } from "./types"
import { ProgressTracker } from "./progress"
import { checkToolIsolation, shouldNudgeIdleMember } from "./hooks"
import { pumpTeam } from "./dispatch"
import { hasReportedCompletion } from "./messaging"
import { recoverFinalResponse } from "./member-report"
import { notifyLead } from "./notify"
import { enrichToolError } from "./tool-arg-hint"
import { rehydrateRegistry } from "./recovery"
import { findTeamBySession } from "./types"
import { loadConfig } from "./config"
import { TokenBucket } from "./rate-limit"
import { ActivityBuffer, recordFromToolBefore, recordFromToolAfter } from "./activity"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "./system-prompt"
import { startDashboard, type DashboardServer } from "./dashboard"
import { EnsembleRpc, emitMemberEvent, emitNoticeEvent } from "./v2-rpc"
import { isWorktreeInstance } from "./util"
import { vlog } from "./log"
import { recoverSessionContinuity } from "./session-continuity"
import { MEMBER_TOOLS } from "./v2-continuity"
import { invokeNativeClassifier, invokeNativeGeneralClassifier, removeNativeClassificationHelper, type V2ClassificationContext } from "./v2-classification"
import type { ClassifierTool } from "./classification-protocol"
import { classifyBoardTasks } from "./board-classification"
import type { MissionCommandHost } from "./mission-commands"
import type { NativeMissionModel } from "./mission-native-models"
import { nativeMissionModels } from "./mission-native-models"
import { registerMissionCommands } from "./mission-commands"
import { bundledSkillsDir, registerPluginSkills, type SkillDefinition } from "./plugin-skills"

/** V2 setup context subset (structural, mock-friendly). */
export interface V2SetupContext {
  location: { directory: string }
  options: Record<string, unknown>
  session: V2Context["session"] & {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
  }
  worktree: V2Context["worktree"]
  permission: V2Context["permission"]
  agent?: V2Context["agent"]
  /** Optional public APIs on older V2 hosts; no command emulation on V1. */
  command?: MissionCommandHost["command"]
  model?: { list(input?: { location?: { directory?: string } }): Promise<{ data: readonly NativeMissionModel[] }> }
  /** Optional skill registration on capable V2 hosts; skipped silently elsewhere. */
  skill?: {
    transform(callback: (editor: { add(definition: SkillDefinition): void }) => unknown): Promise<unknown>
  }
  event: {
    subscribe(opts?: { signal?: AbortSignal }): AsyncIterable<V2EventLike>
  }
  tool: {
    list?(): Promise<readonly ClassifierTool[]>
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
    transform(cb: (editor: never) => void): Promise<{ dispose(): Promise<void> }>
  }
  rpc: {
    register(
      definition: unknown,
      handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
    ): Promise<{ events: { emit(name: string, data: unknown): Promise<unknown> } }>
  }
  shell: {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
  }
}

/** Extract answer text from a V2 tool result for approval matching. */
export function extractQuestionOutput(result?: {
  content?: string | Array<{ type?: string; text?: string }>
}): string {
  const content = result?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
  }
  return ""
}

/** Options for setupEnsemble. */
export interface SetupOptions {
  /** SQLite path. Defaults to the global ensemble.db. */
  dbPath?: string
  /** Dashboard port. Defaults to config; 0 disables. */
  dashboardPort?: number
  /** Skills directory override for tests; defaults to the running package's own. */
  skillsDir?: string
}

/** Live handle for a V2 ensemble instance. */
export interface EnsembleHandle {
  db: Database
  registry: MemberRegistry
  tracker: DescendantTracker
  /** Dispatch one event (used by the live subscription loop; tests call directly). */
  dispatch(event: V2EventLike): Promise<void>
  /** Stop the event loop and release resources. */
  dispose(): Promise<void>
}

/**
 * Initialize Ensemble on a V2 plugin context: database, registries, event
 * subscription, tool hooks, session hooks, and shell env. Tool registration
 * lands in the next slice.
 */
export async function setupEnsemble(
  ctx: V2SetupContext,
  options: SetupOptions = {},
): Promise<EnsembleHandle> {
  const db = createDb(options.dbPath ?? getDbPath())
  const config = loadConfig(ctx.location.directory)
  const registry: MemberRegistry = new MemberRegistryImpl()
  const tracker: DescendantTracker = new DescendantTrackerImpl()
  const purgeApprovals = new PendingPurgeApprovals()
  const activityBuffer = new ActivityBuffer()
  const progressTracker = new ProgressTracker()
  const nudgedMembers = new Set<string>()
  const continuityOptions = { apiUrl: config.v2ApiUrl, authorization: process.env.OPENCODE_ENSEMBLE_V2_AUTHORIZATION }
  await recoverSessionContinuity({ db, registry, tracker, purgeApprovals, progressTracker, config,
    directory: ctx.location.directory, client: createV2Client(ctx, continuityOptions) })

  // Rehydrate the in-memory registry from SQLite so members from before a
  // restart are visible again. Without this, their events are ignored and
  // teams freeze silently after every server restart (seen live 2026-09-14).
  const rehydrated = rehydrateRegistry(db, registry)
  if (rehydrated > 0) vlog(`init:registry:rehydrated members=${rehydrated}`)
  const reportClient = createV2Client(ctx, continuityOptions)
  // Retry the wake, not the report insertion. The durable inbox is the outbox
  // backstop if a process dies after persisting a candidate but before delivery.
  const pendingLeadInboxes = db.query(`SELECT DISTINCT t.lead_session_id FROM team t JOIN team_message m ON m.team_id = t.id
    WHERE t.status = 'active' AND m.to_name = 'lead' AND m.delivered = 0`).all() as Array<{ lead_session_id: string }>

  /** Send the idle-without-report nudge once per member. */
  const nudgeMember = (teamId: string, memberName: string, sessionId: string): void => {
    const member = db.query("SELECT report_mode, report_generation, last_nudged_at FROM team_member WHERE team_id = ? AND name = ?").get(teamId, memberName) as { report_mode: string; report_generation: number; last_nudged_at: number | null } | null
    if (!member || hasReportedCompletion(db, teamId, memberName)) return
    const nudgeKey = `${teamId}:${memberName}:${member.report_generation}`
    if (nudgedMembers.has(nudgeKey)) return
    if (member.report_mode === "final_response") {
      if (member.last_nudged_at) return
      db.run("UPDATE team_member SET last_nudged_at = ? WHERE team_id = ? AND name = ?", [Date.now(), teamId, memberName])
      notifyLead(reportClient, db, teamId, `${memberName} is inactive but no completed final response could be recovered. No task was completed. Inspect the session; the worker was not asked to use unavailable tools.`)
      return
    }
    if (member.last_nudged_at && member.last_nudged_at >= Date.now() - 60 * 60 * 1000) return
    if (!shouldNudgeIdleMember(db, teamId, memberName)) return
    if (hasReportedCompletion(db, teamId, memberName)) return
    nudgedMembers.add(nudgeKey)
    // Persist so hot-reloads don't re-nudge: every setup re-runs the sweep,
    // and without this each file save re-nudged every silent member (seen
    // live 2026-09-14 — 40+ nudges on one scout).
    db.run("UPDATE team_member SET last_nudged_at = ? WHERE team_id = ? AND name = ?", [
      Date.now(),
      teamId,
      memberName,
    ])
    vlog(`nudge:idle-without-report name=${memberName}`)
    void deliverPrompt(
      ctx.session as unknown as V2SessionPort,
      sessionId,
      "[System]: Your session is inactive and you did not report a final result. Send findings or a failure/blocker to the lead via team_message as a <task-result> with status, summary and details. Inactivity alone does not mean success.",
    ).catch((err) => {
      vlog(`nudge:idle-without-report:failed name=${memberName} err=${err instanceof Error ? err.message : String(err)}`)
    })
  }

  // Startup sweep: members already idle (e.g. finished while the plugin was
  // down) never emit a fresh transition, so nudge them now. Skip members
  // nudged within the hour — the guard survives reloads via the DB column.
  const silent = db.query(
    `SELECT tm.team_id, tm.name, tm.session_id FROM team_member tm
     JOIN team t ON tm.team_id = t.id
      WHERE t.status = 'active' AND (tm.status = 'ready' OR (tm.status = 'shutdown' AND tm.report_mode = 'final_response'))`,
  ).all() as Array<{ team_id: string; name: string; session_id: string }>
  const rateLimiter = new TokenBucket({
    capacity: config.rateLimitCapacity,
    refillRate: 2,
    refillIntervalMs: 1000,
  })
  const controller = new AbortController()

  const dispatch = async (event: V2EventLike): Promise<void> => {
    const transition = dispatchV2Event(db, registry, tracker, event)
    // Status and execution events may arrive in either order. An already-ready
    // member still needs harvesting when its final response becomes durable.
    if (!transition && event.data?.sessionID && ["session.execution.succeeded", "session.idle", "session.status"].includes(event.type)) {
      const member = registry.getBySession(event.data.sessionID)
      if (member) await recoverFinalResponse(db, reportClient, member.teamId, member.memberName)
    }
    if (transition?.to === "error") {
      notifyLead(reportClient, db, transition.teamId, `Teammate ${transition.memberName} execution failed: ${event.data?.error?.message ?? "inspect the native session"}. No result was accepted and no task was completed.`)
    }
    if (transition?.to === "shutdown") await recoverFinalResponse(db, reportClient, transition.teamId, transition.memberName)
    // Idle-without-report nudge (parity with V1): a member that went idle
    // without ever messaging the lead gets ONE reminder to report via
    // team_message. Without this, weak models finish silently and the lead
    // waits forever — the exact failure seen live on 2026-09-14.
    if (transition && transition.to === "ready" && transition.from === "busy") {
      const entry = registry.getByName(transition.teamId, transition.memberName)
      if (entry) {
        if (!await recoverFinalResponse(db, reportClient, transition.teamId, transition.memberName)) nudgeMember(transition.teamId, transition.memberName, entry.sessionId)
        // Pull-based pool: feed the newly idle member, then scale up if work
        // remains and the cap allows (opt-in — docs/task-pool.md). deps is
        // captured lazily; events only flow after setup completes.
        pumpTeam(deps, transition.teamId)
      }
    }
    if (transition && rpc) {
      await emitMemberEvent(rpc, transition).catch(() => {
        // Companions are optional — never break the state machine for them.
      })
      if (transition.to === "ready" && transition.from === "busy") {
        await emitNoticeEvent(rpc, {
          title: "Team",
          message: `${transition.memberName} is inactive (task validation is separate)`,
          variant: "info",
        }).catch(() => undefined)
      } else if (transition.to === "error") {
        await emitNoticeEvent(rpc, {
          title: "Team",
          message: `${transition.memberName} errored`,
          variant: "error",
        }).catch(() => undefined)
      }
    }
  }

  // RPC bridge for terminal companions (toasts, navigation). Best-effort:
  // a failed registration must not break tools, hooks, or events.
  let rpc: { events: { emit(name: string, data: unknown): Promise<unknown> } } | null = null
  try {
    rpc = await ctx.rpc.register(EnsembleRpc, {
      summary: async (input) => {
        const team = (input as { team?: string }).team ?? ""
        const row = db.query("SELECT status FROM team WHERE name = ?").get(team) as {
          status: string
        } | null
        if (!row) return { text: `No team "${team}".` }
        const members = db.query("SELECT name, status FROM team_member WHERE team_id IN (SELECT id FROM team WHERE name = ?)").all(team) as Array<{
          name: string
          status: string
        }>
        const summary = members.map((m) => `${m.name}: ${m.status}`).join(", ")
        return { text: `Team "${team}" (${row.status}): ${summary || "no members"}` }
      },
      teamContext: async (input) => {
        const sessionID = (input as { sessionID?: string }).sessionID ?? ""
        const teamInfo = findTeamBySession(db, registry, sessionID)
        if (!teamInfo) return { team: null, members: [], tasks: { pending: 0, done: 0 } }
        const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(
          teamInfo.teamId,
        ) as Array<{ name: string; status: string }>
        const pending = (
          db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ? AND status != 'completed'").get(
            teamInfo.teamId,
          ) as { c: number }
        ).c
        const done = (
          db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ? AND status = 'completed'").get(
            teamInfo.teamId,
          ) as { c: number }
        ).c
        return { team: teamInfo.teamName, members, tasks: { pending, done } }
      },
    })
  } catch (err) {
    vlog(`init:rpc:failed err=${err instanceof Error ? err.message : String(err)}`)
  }

  await ctx.tool.hook("execute.before", (raw) => {
    const input = raw as unknown as { tool: string; sessionID: string }
    checkToolIsolation(registry, tracker, input.tool, input.sessionID, db)
    if (input.tool.startsWith("team_")) {
      if (!rateLimiter.tryConsume()) {
        return rateLimiter.waitForToken().then(() => undefined)
      }
    }
    recordFromToolBefore({ sessionID: input.sessionID, tool: input.tool }, registry, activityBuffer)
  })

  await ctx.tool.hook("execute.after", (raw) => {
    const event = raw as unknown as {
      tool: string
      sessionID: string
      input: unknown
      status: string
      result?: { content?: string | Array<{ type?: string; text?: string }> }
      error?: { message?: unknown }
    }
    if (event.status === "error" && event.error) {
      // Weak-model arg fumbles (issue #39): the call is already dead from
      // validation, so append an explicit "the param is X, not Y" hint to
      // the error the model sees. Arguments are never rewritten — the
      // model stays in the correction loop. Fail-open by design: a
      // non-fumble error is returned untouched.
      if (enrichToolError(event.tool, event.error, event.input)) {
        vlog(`tool-arg-hint:fired tool=${event.tool} session=${event.sessionID}`)
      }
    }
    if (event.tool === "question") {
      // Feed the answer text to purge approvals (team_cleanup confirm flow).
      // The question tool renders in every client, so this is the universal
      // approval channel on V2 — no forms or TUI needed.
      purgeApprovals.recordQuestionAnswer(
        event.sessionID,
        extractQuestionOutput(event.result),
        event.input,
      )
    }
    recordFromToolAfter(
      { sessionID: event.sessionID, tool: event.tool },
      {},
      registry,
      activityBuffer,
    )
  })

  await ctx.session.hook("context", (raw) => {
    const event = raw as unknown as {
      sessionID: string
      system: Array<{ type: string; text: string }>
      messages?: unknown[]
    }
    if (!event.sessionID) return
    // Native switchAgent can wake an idle fork. Stop dispatch until isolation is
    // bound; no provider/tools may run at the source location during preparation.
    const preparing = db.query("SELECT spawn_pending FROM team_member WHERE session_id = ?").get(event.sessionID) as { spawn_pending: number } | null
    if (preparing?.spawn_pending && (preparing.spawn_pending === 1 || !JSON.stringify(event.messages ?? []).includes(`[Ensemble task ${event.sessionID}]`))) {
      throw new Error("Ensemble teammate initialization is still in progress")
    }
    const teamInfo = findTeamBySession(db, registry, event.sessionID)
    if (!teamInfo) return
    const prompt =
      teamInfo.role === "lead"
        ? buildLeadSystemPrompt(db, teamInfo.teamId, config)
        : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown")
    vlog(`system-prompt:injected role=${teamInfo.role} len=${prompt.length}`)
    event.system.push({ type: "text", text: prompt })
    const finalResponse = teamInfo.role === "member" && (db.query("SELECT report_mode FROM team_member WHERE team_id = ? AND name = ?").get(teamInfo.teamId, teamInfo.memberName ?? "") as { report_mode: string } | null)?.report_mode === "final_response"
    if (teamInfo.role === "member" && !finalResponse) {
      // V2 invokes plugin tools through Code Mode, not direct calls —
      // without this hint teammates attempt direct calls that the runtime
      // rejects with "No tool named team_message is currently available"
      // (seen live 2026-09-14: explore scout denied twice, gave up).
      event.system.push({
        type: "text",
        text: 'Ensemble tools on this platform are called through the execute tool, e.g. tools.team_message({ to: "lead", text: "..." }). Do not call them directly.',
      })
    }
  })

  await ctx.session.hook("compaction", (raw) => {
    const event = raw as unknown as {
      sessionID: string
      system: Array<{ type: string; text: string }>
    }
    if (!event.sessionID) return
    const teamInfo = findTeamBySession(db, registry, event.sessionID)
    if (!teamInfo) return
    const context = buildTeamCompactionContext(db, teamInfo.teamId, teamInfo.role, teamInfo.memberName)
    event.system.push({ type: "text", text: context })
  })

  // Modern V2 removed permission.rules. Keep the same scoped team-tool grants,
  // while nested edit/shell calls still use the target agent's normal policy.
  await ctx.permission?.hook?.("evaluate", event => {
    if (event.action !== "execute" && !(MEMBER_TOOLS as readonly string[]).includes(event.action)) return
    const team = findTeamBySession(db, registry, event.sessionID)
    if (team?.role === "member") {
      const member = db.query("SELECT report_mode FROM team_member WHERE team_id = ? AND name = ?").get(team.teamId, team.memberName ?? "") as { report_mode: string } | null
      if (member?.report_mode !== "final_response") event.effect = "allow"
    }
  })

  // OQ-V2-shell: the V2 shell hook carries no sessionID. Cwd is visible, but
  // a member must not be guessed from it because the lead shells in the
  // canonical directory too. Model id, native variant and canonical effort
  // travel in the teammate system prompt, not this hook.
  await ctx.shell.hook("create.before", () => undefined)

  const client = createV2Client(ctx, { ...continuityOptions, ...(rpc ? { rpcEmitter: rpc } : {}) })
  const deps: ToolDeps = {
    db,
    registry,
    tracker,
    purgeApprovals,
    client,
    directory: ctx.location.directory,
    config,
    progressTracker,
  }
  const listClassifiers = ctx.tool.list?.bind(ctx.tool)
  if (listClassifiers && ctx.session.wait && ctx.session.remove && ctx.permission?.hook) {
    deps.classifier = { list: listClassifiers, invoke: request => invokeNativeClassifier(ctx as unknown as V2ClassificationContext, { ...request, signal: controller.signal }), general: request => invokeNativeGeneralClassifier(ctx as unknown as V2ClassificationContext, { ...request, signal: controller.signal }), removeHelper: sessionID => removeNativeClassificationHelper(ctx as unknown as V2ClassificationContext, sessionID) }
  }
  const listMissionModels = ctx.model?.list.bind(ctx.model)
  if (listMissionModels) deps.nativeModels = async () => nativeMissionModels((await listMissionModels({ location: { directory: ctx.location.directory } })).data)
  await registerV2Tools(ctx.tool, deps)
  const missionCommands = await registerMissionCommands(ctx, deps, deps.nativeModels)
  // Self-register the shipped skills so instructions follow the running
  // revision even when an external skills pointer lags behind a deployment.
  try {
    const registered = await registerPluginSkills(ctx, options.skillsDir ?? bundledSkillsDir())
    vlog(`init:skills registered=${registered}`)
  } catch (error) {
    vlog(`init:skills:failed ${String(error)}`)
  }

  // Install context/permissions/tools and dependencies before consuming events or
  // waking sessions. Otherwise a startup report can run without its team context,
  // or an immediate idle event can access deps before initialization.
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) await dispatch(event)
    } catch {
      // Aborted on dispose or stream error — nothing to report.
    }
  })()
  for (const team of pendingLeadInboxes) reportClient.session.promptAsync({ sessionID: team.lead_session_id, synthetic: true,
    parts: [{ type: "text", text: "[System: Undelivered team reports await review; use team_results.]" }] })
    .catch(error => vlog(`report:startup-wake-failed ${String(error)}`))
  for (const member of silent) {
    if (!await recoverFinalResponse(db, reportClient, member.team_id, member.name)) nudgeMember(member.team_id, member.name, member.session_id)
  }

  // Resume pending work and arm a single wake at the next persisted lease expiry.
  // No idle polling; helpers use native wait and their own bounded cleanup.
  const classificationTimers = new Set<ReturnType<typeof setTimeout>>()
  const resumeClassifications = (teamId: string): void => {
    if (controller.signal.aborted) return
    void classifyBoardTasks(deps, teamId).catch(error => { vlog(`classification:recovery-failed ${String(error)}`) }).then(() => {
      if (controller.signal.aborted) return
      const team = db.query("SELECT mission_state FROM team WHERE id = ?").get(teamId) as { mission_state: string } | null
      if (!team || team.mission_state === "critical") return
      const next = db.query("SELECT MIN(due) AS until FROM (SELECT classification_until AS due FROM team_task WHERE team_id = ? AND classification_status = 'running' UNION ALL SELECT lease_until AS due FROM classification_helper WHERE team_id = ? AND lease_until > ?)").get(teamId, teamId, Date.now()) as { until: number | null }
      if (next.until === null) return
      const timer = setTimeout(() => { classificationTimers.delete(timer); resumeClassifications(teamId) }, Math.max(1, Math.min(2_147_483_647, next.until - Date.now() + 1)))
      classificationTimers.add(timer)
    })
  }
  const recoverable = db.query("SELECT id FROM team WHERE project_id = ? AND status = 'active' AND (id IN (SELECT team_id FROM team_task WHERE classification_status IN ('pending', 'running')) OR id IN (SELECT team_id FROM classification_helper))").all(ctx.location.directory) as Array<{ id: string }>
  recoverable.forEach(team => { resumeClassifications(team.id) })

  // Dashboard mirrors V1: main instance only, skipped when port is 0.
  let dashboard: DashboardServer | null = null
  const dashboardPort = options.dashboardPort ?? config.dashboardPort
  if (dashboardPort !== 0 && !isWorktreeInstance(ctx.location.directory)) {
    dashboard = await startDashboard(db, dashboardPort, { activityBuffer, client }).catch((err) => {
      vlog(`init:dashboard:failed err=${err instanceof Error ? err.message : String(err)}`)
      return null
    })
  }

  return {
    db,
    registry,
    tracker,
    dispatch,
    dispose: async () => {
      controller.abort()
      await missionCommands?.dispose()
      classificationTimers.forEach(clearTimeout)
      dashboard?.stop()
    },
  }
}
