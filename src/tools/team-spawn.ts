import type { ToolDeps, PermissionRule, SpawnContext } from "../types"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MEMBER_TOOLS } from "../v2-continuity"
import { lintAgentProfile } from "../profile-lint"
import { admitWorktree, isEnsembleWorktree, worktreeSlug } from "../worktree-guard"
import { storePreservedBranch } from "../worktree-state"
import { parseSpawnContext, resolveSpawnContext, rollbackInheritedSpawn } from "../session-continuity"
import { validateMemberName } from "../util"
import { requireLead } from "./shared"
import { claimTask } from "./team-claim"
import { notifyLead } from "../notify"
import { parseModelId } from "../member-model"
import { log } from "../log"
import { assertMissionAdmission, routeMissionTask } from "../mission-policy"
import type { EnsembleConfig } from "../config"
import { routeNormalizedModel, validateTaskRoutingScores, type TaskRoutingScores } from "../model-router"
import { getTeamResourceParts, preserveBranch, preservedBranchName } from "./merge-helper"
import { releaseMemberTasks } from "../tasks"
import { planningPermissions, startTaskPlanning, taskExecutionInstructions } from "../task-execution"
import { taskSpawnOptions } from "../task-admission"

/** Tracks consecutive spawn failures per team for circuit breaker. */
export const spawnFailures = new Map<string, { count: number; lastError: string }>()

/**
 * Resolve which model to use for a spawned agent.
 * Priority: explicit arg > modelsByAgent > rotation/random > defaultModel > undefined.
 */
export function resolveModel(
  explicitModel: string | undefined,
  agentType: string,
  teamMemberCount: number,
  config: Required<EnsembleConfig>,
): string | undefined {
  if (explicitModel) return explicitModel
  if (config.modelsByAgent[agentType]) return config.modelsByAgent[agentType]
  if (config.modelAssignment === "rotate" && config.modelPool.length > 0) {
    return config.modelPool[teamMemberCount % config.modelPool.length]
  }
  if (config.modelAssignment === "random" && config.modelPool.length > 0) {
    return config.modelPool[Math.floor(Math.random() * config.modelPool.length)]
  }
  if (config.defaultModel) return config.defaultModel
  return undefined
}

/** Timeout for worktree.create and session.create to prevent hanging on git lock contention. */
function getSpawnTimeout(): number {
  return Number(process.env.SPAWN_TIMEOUT_MS) || 120_000
}

/** Returns true if the directory is already inside an OpenCode worktree. */
function isWorktreeDirectory(dir: string): boolean {
  return isEnsembleWorktree(dir)
}

/** Race a promise against a timeout. Throws if the timeout fires first. Cleans up timer on resolution. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

/** Warn when a project collaborator profile hides Ensemble tools. Unreadable files do not fail the spawn. */
function profileAdmissionWarning(directory: string, agent: string, finalResponse: boolean): string {
  if (finalResponse) return ""
  try {
    const findings = lintAgentProfile(readFileSync(join(directory, ".opencode", "agents", `${agent}.md`), "utf8"))
      .filter(finding => finding.id === "missing-ensemble-tools")
    if (findings.length === 0) return ""
    return ` WARNING: missing-ensemble-tools (${findings.map(finding => finding.message).join("; ")})`
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code === "ENOENT") return ""
    return " WARNING: profile-unreadable"
  }
}

/**
 * Execute the team_spawn tool. Creates a child session and starts a teammate.
 * By default, each teammate gets their own git worktree for file isolation.
 * Pass worktree: false for read-only agents that don't need isolation.
 * Pass plan_approval: true to require the teammate to send a plan before writing.
 */
export async function executeTeamSpawn(
  deps: ToolDeps,
  args: { name: string; agent?: string | null; prompt: string; model?: string; variant?: string; complexity?: number; risk?: number; claim_task?: string; worktree?: boolean; plan_approval?: boolean; context?: SpawnContext; report_mode?: "team_message" | "final_response" },
  sessionId: string,
): Promise<string> {
  // Normalize agent: the tool schema defaults to "build", but Zod's .default()
  // only fires on undefined — an explicit null slips through and would violate
  // the team_member.agent NOT NULL constraint (issue #28).
  taskSpawnOptions(args)

  const nameError = validateMemberName(args.name)
  if (nameError) throw new Error(nameError)

  const teamInfo = requireLead(deps, sessionId)
  const taskContract = args.claim_task
    ? deps.db.query("SELECT agent, spawn_context, spawn_options, publication, completion_policy, control_revision FROM team_task WHERE id=? AND team_id=?").get(args.claim_task, teamInfo.teamId) as { agent: string | null; spawn_context: string | null; spawn_options: string | null; publication: string; completion_policy: string; control_revision: number } | null
    : null
  if (taskContract?.publication === "deferred") throw new Error("Publish the deferred task before spawning its worker")
  const taskContext = taskContract?.spawn_context != null ? parseSpawnContext(JSON.parse(taskContract.spawn_context)) : undefined
  const options = taskContract?.spawn_options != null ? taskSpawnOptions(JSON.parse(taskContract.spawn_options)) : undefined
  if (options?.worktree !== undefined && args.worktree !== undefined && options.worktree !== args.worktree) throw new Error("Spawn worktree conflicts with the task admission contract")
  if (options?.report_mode !== undefined && args.report_mode !== undefined && options.report_mode !== args.report_mode) throw new Error("Spawn report_mode conflicts with the task admission contract")
  const worktree = options?.worktree ?? args.worktree
  const reportMode = options?.report_mode ?? args.report_mode ?? "team_message"
  const finalResponse = reportMode === "final_response"
  const taskBound = Boolean(taskContext || options)
  const agent = args.agent ?? (taskBound ? taskContract?.agent : undefined) ?? "build"
  if (taskBound && taskContract?.agent && agent !== taskContract.agent) throw new Error("Task context requires the requested agent profile")
  assertMissionAdmission(deps.db, teamInfo.teamId)
  const mission = deps.db.query("SELECT mission_state FROM team WHERE id = ?").get(teamInfo.teamId) as { mission_state: string }
  if (mission.mission_state === "critical") throw new Error("Mission is critical; resolve the classification safety/budget failure before spawning")
  const inheritance = resolveSpawnContext(deps, taskContext ?? args.context, teamInfo.teamId, sessionId)
  if (taskContext && args.context !== undefined) {
    if (parseSpawnContext(args.context).mode !== taskContext.mode) throw new Error("Spawn context conflicts with the task context contract")
    const explicit = resolveSpawnContext(deps, args.context, teamInfo.teamId, sessionId)
    if (JSON.stringify(explicit) !== JSON.stringify(inheritance)) throw new Error("Spawn context conflicts with the task context contract")
  }
  const inherited = inheritance.mode !== "fresh"
  const continuity = deps.client.continuity

  // Circuit breaker — stop retrying after 3 consecutive failures
  const failures = spawnFailures.get(teamInfo.teamId)
  if (failures && failures.count >= 3) {
    throw new Error(`Spawn circuit breaker tripped for team "${teamInfo.teamName}": 3 consecutive failures. Last error: ${failures.lastError}. Investigate before retrying — the circuit breaker resets on the next successful spawn.`)
  }

  // Check duplicate name
  const existing = deps.db.query("SELECT name FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.name)
  if (existing) throw new Error(`Teammate "${args.name}" already exists in team "${teamInfo.teamName}"`)

  // Deterministic concurrency cap (docs/task-pool.md). Members in non-terminal
  // status still occupy a slot (shutdown_requested still owns a worktree).
  // Explicit refusal before any resource is created — never a silent queue.
  if (deps.config.maxActiveMembers > 0) {
    const active = (deps.db.query(
      "SELECT COUNT(*) as c FROM team_member WHERE team_id = ? AND status NOT IN ('shutdown', 'error')",
    ).get(teamInfo.teamId) as { c: number }).c
    if (active >= deps.config.maxActiveMembers) {
      throw new Error(
        `Active member limit reached for team "${teamInfo.teamName}": ${active}/${deps.config.maxActiveMembers}. ` +
        "Shut down a teammate or raise maxActiveMembers before spawning.",
      )
    }
  }

  // Resolve before any fork/session/worktree allocation: invalid routing must
  // never strand resources. Explicit scores override those on claim_task.
  const taskScores = args.claim_task
    ? deps.db.query("SELECT complexity, risk, status, assignee, classification_status, classification_result FROM team_task WHERE id = ? AND team_id = ?")
      .get(args.claim_task, teamInfo.teamId) as { complexity: number | null; risk: number | null; status: string; assignee: string | null; classification_status: string; classification_result: string | null } | null
    : null
  if (taskScores && !["not_required", "completed"].includes(taskScores.classification_status)) throw new Error(`Task ${args.claim_task} is awaiting classification (${taskScores.classification_status})`)
  const classified = taskScores?.classification_result ? JSON.parse(taskScores.classification_result) as { complexity: number; risk: number } : undefined
  const scores: TaskRoutingScores = {
    complexity: args.complexity ?? taskScores?.complexity ?? undefined,
    risk: args.risk ?? taskScores?.risk ?? undefined,
  }
  validateTaskRoutingScores(scores)
  const hasScores = scores.complexity !== undefined || scores.risk !== undefined || classified !== undefined
  const policyRouting = routeMissionTask(deps.db, teamInfo.teamId, args.claim_task, { complexity: args.complexity, risk: args.risk })
  const governed = Boolean(policyRouting && "execution" in policyRouting)
  const autonomous = governed && !finalResponse
  if (autonomous && (!deps.client.continuity || !deps.client.session.switchModel || !deps.nativeModels)) throw new Error("Autonomous execution requires OpenCode V2 model catalogue and permission switching")
  if (governed && !args.claim_task) throw new Error("Autonomous workers require claim_task")
  if (policyRouting && taskScores && (taskScores.status !== "pending" || taskScores.assignee)) throw new Error(`Cannot claim mission task ${args.claim_task}: it is not unassigned and pending`)
  if (policyRouting && args.claim_task && !finalResponse && (agent === "plan" || agent === "explore")) throw new Error("Built-in read-only agents cannot claim mission tasks; use complete standalone scores or an appropriate task-owning profile")
  if (policyRouting && ((args.model !== undefined && args.model !== policyRouting.selected.id) || (args.variant !== undefined && args.variant !== policyRouting.selected.variant))) {
    throw new Error("Explicit model/variant cannot override the approved mission policy; use /ensemble-mission config")
  }
  const routing = !policyRouting && !args.model && hasScores && deps.config.modelRouting.models.length
    ? routeNormalizedModel({ complexity: scores.complexity !== undefined ? scores.complexity / 100 : classified?.complexity ?? 0,
      risk: scores.risk !== undefined ? scores.risk / 100 : classified?.risk ?? 0, ...deps.config.modelRouting })
    : undefined
  if (routing && !parseModelId(routing.selected.id)) throw new Error(`Routed model id must be in provider/model format: ${routing.selected.id}`)
  const memberCount = (deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ? AND name != ?")
    .get(teamInfo.teamId, args.name) as { c: number }).c
  const resolvedModel = policyRouting?.selected.id || args.model || routing?.selected.id || resolveModel(undefined, agent, memberCount, deps.config)
  // Precedence: an approved cell's native variant is authoritative. An omitted
  // variant stays omitted and does not inherit profile effort.
  const resolvedVariant = policyRouting ? policyRouting.selected.variant : routing
    ? routing.selected.reasoningEffort === "default" ? undefined : routing.selected.reasoningEffort
    : args.variant
  if (routing) log(`spawn:routing name=${args.name} demand=${routing.demand} ${routing.reason}`)

  const isReadOnly = agent === "plan" || agent === "explore"
  if (isReadOnly && worktree === true) throw new Error("Built-in read-only profiles cannot satisfy worktree:true")
  const useWorktree = worktree !== false && !isReadOnly && (worktree === true || inherited || !isWorktreeDirectory(deps.directory))
  const usePlanApproval = args.plan_approval === true

  log(`spawn:start name=${args.name} agent=${agent} worktree=${useWorktree}`)

  // Create worktree if enabled
  let worktreeDir: string | null = null
  let worktreeBranch: string | null = null
  let childSessionId: string | undefined

  if (inherited) {
    if (!continuity || !inheritance.source) throw new Error("Native continuity and a source are required for inherited spawning")
    // Validate the persisted native source even for a finished Ensemble member.
    await deps.client.session.get({ sessionID: inheritance.source })
    if (inheritance.mode === "compact_fork") await continuity.compact({ sessionID: inheritance.source })
    const child = await continuity.fork({ sessionID: inheritance.source, before: inheritance.before })
    childSessionId = child.id
    try {
      // Persist immediately after fork, before switch/worktree/move, for crash recovery.
      deps.db.run(`INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status,
        prompt, context_mode, source_session_id, context_message_id, spawn_pending, time_created, time_updated)
        VALUES (?, ?, ?, ?, 'busy', 'starting', ?, ?, ?, ?, 1, ?, ?)`,
      [teamInfo.teamId, args.name, child.id, agent, args.prompt, inheritance.mode, inheritance.source, inheritance.before ?? null, Date.now(), Date.now()])
    } catch (error) {
      await continuity.remove({ sessionID: child.id })
      throw error
    }
  }

  if (useWorktree) {
    const project = deps.db.query("SELECT project_id FROM team WHERE id = ?").get(teamInfo.teamId) as { project_id: string } | null
    const worktreeName = worktreeSlug(project?.project_id ?? deps.directory, teamInfo.teamId, args.name)
    try {
      log(`spawn:worktree:start name=${args.name}`)
      const result = await withTimeout(
        deps.client.worktree.create({ worktreeCreateInput: { name: worktreeName } }),
        getSpawnTimeout(), `worktree.create for "${args.name}"`
      )
      if (result.data) {
        worktreeDir = result.data.directory
        worktreeBranch = result.data.branch
        if (inherited) deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE team_id = ? AND name = ?", [worktreeDir, worktreeBranch, teamInfo.teamId, args.name])
      }
      if (!worktreeDir || !worktreeBranch) throw new Error(`Worktree admission failed for "${args.name}": directory and branch are required`)
      log(`spawn:worktree:done name=${args.name} dir=${worktreeDir}`)
    } catch (err) {
      if (inherited) await rollbackInheritedSpawn(deps, teamInfo.teamId, args.name)
      const message = err instanceof Error ? err.message : String(err)
      log(`spawn:worktree:failed name=${args.name} err=${message}`)
      throw new Error(`Worktree admission failed for "${args.name}": ${message}`)
    }
  }

  // Create workspace from worktree branch — links session to worktree directory.
  // OQ-workspace: assumes workspace.create({ branch }) auto-links to the worktree at that branch.
  let workspaceId: string | null = null
  if (worktreeDir && worktreeBranch && !inherited) {
    try {
      log(`spawn:workspace:start name=${args.name}`)
      const wsResult = await withTimeout(
        deps.client.workspace.create({ branch: worktreeBranch }),
        getSpawnTimeout(), `workspace.create for "${args.name}"`
      )
      if (wsResult.data) {
        workspaceId = wsResult.data.id
      }
      log(`spawn:workspace:done name=${args.name} id=${workspaceId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`spawn:workspace:failed name=${args.name} err=${message}`)
      throw new Error(`Workspace admission failed for "${args.name}": ${message}`)
    }
  }

  // Permission rules on session.create are the hard gate (server-enforced).
  // For read-only agents, deny write tools and explicitly allow team tools.
  // For all agents with worktrees, allowlist the worktree path for edit/bash.
  // The 9 shared member tools plus V2 handoff: the 6 worker tools and the
  // 3 inspection tools (team_results/team_status/team_view — any member).
  // Caught live 2026-09-15: teammates could not read each
  // other's messages because team_results was missing from this list.
  const grantedMemberTools = MEMBER_TOOLS.filter(tool => tool !== "team_handoff" || Boolean(deps.client.continuity))
  const permission: PermissionRule[] = []

  if (worktreeDir) {
    permission.push(
      { permission: "edit", pattern: `${worktreeDir}/**`, action: "allow" },
    )
    if (!isReadOnly) {
      permission.push({ permission: "bash", pattern: "*", action: "allow" })
    }
  }

  if (isReadOnly) {
    permission.push(
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    )
  }

  permission.push(
    ...grantedMemberTools.map(tool => ({ permission: tool, pattern: "*", action: "allow" as const })),
  )

  // Code Mode is the invocation path for plugin tools on V2 — without this,
  // read-only agents (deny-all policies like explore's) cannot reach any
  // team tool. Safe: nested calls inside execute still enforce their own
  // permissions, so explore stays read-only.
  permission.push({ permission: "execute", pattern: "*", action: "allow" })
  if (autonomous) permission.push(...planningPermissions())

  // Create child session — bind to workspace if available (server-enforced CWD isolation).
  // Falls back to no workspace binding if workspace.create failed.
  try {
    log(`spawn:session:start name=${args.name}`)
    if (inherited) {
      if (!continuity || !childSessionId) throw new Error("Native continuity did not create an inherited child")
      // Native move binds actual tool CWD. Never transfer source changes or fall back to a prompt-only CWD.
      await continuity.move({ sessionID: childSessionId, directory: worktreeDir ?? deps.directory })
      // Switch only after move: native agent-switch synthetic input can wake a
      // fork, and must never run the requested writer at the source location.
      await continuity.switchAgent({ sessionID: childSessionId, agent, initializing: true, ...(finalResponse ? { permission: [] } : {}) })
    } else {
      const createResult = await withTimeout(
        deps.client.session.create({
          parentID: sessionId,
          title: `${args.name} (@${agent} teammate)`,
          // Clear inherited supervisor overrides without adding any grants.
          permission: finalResponse ? [] : permission,
          ...(workspaceId ? { workspaceID: workspaceId } : {}),
        }),
        getSpawnTimeout(), `session.create for "${args.name}"`
      )
      childSessionId = createResult.data?.id
    }
    log(`spawn:session:done name=${args.name} sessionId=${childSessionId}`)
  } catch (err) {
    if (inherited) {
      await rollbackInheritedSpawn(deps, teamInfo.teamId, args.name)
      throw err
    }
    log(`spawn:session:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
    // Track failure for circuit breaker
    const errMsg = err instanceof Error ? err.message : String(err)
    const prev = spawnFailures.get(teamInfo.teamId)
    spawnFailures.set(teamInfo.teamId, { count: (prev?.count ?? 0) + 1, lastError: errMsg })
    // Rollback workspace and worktree if session creation failed
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error(`Failed to create session for teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!childSessionId) {
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error("Failed to create teammate session")
  }

  // Register in DB
  const planApproval = usePlanApproval ? "pending" : "none"
  const now = Date.now()
  // Persist exactly the model/variant used by promptAsync.
  if (resolvedModel) log(`spawn:model name=${args.name} model=${resolvedModel}`)

  if (inherited) {
    deps.db.run("UPDATE team_member SET model = ?, plan_approval = ?, time_updated = ? WHERE team_id = ? AND name = ?", [resolvedModel ?? null, planApproval, now, teamInfo.teamId, args.name])
  } else deps.db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, worktree_dir, worktree_branch, workspace_id, plan_approval, time_created, time_updated)
     VALUES (?, ?, ?, ?, 'busy', 'starting', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamInfo.teamId, args.name, childSessionId, agent, resolvedModel ?? null, args.prompt, worktreeDir, worktreeBranch, workspaceId, planApproval, now, now]
  )

  deps.db.run("UPDATE team_member SET model_variant = ?, model_routing = ? WHERE team_id = ? AND name = ?",
    [resolvedVariant ?? null, policyRouting ? JSON.stringify(policyRouting) : routing ? JSON.stringify(routing) : null, teamInfo.teamId, args.name])
  deps.db.run("UPDATE team_member SET report_mode = ?, report_started_at = ?, report_message_cursor = (SELECT COALESCE(MAX(rowid), 0) FROM team_message) WHERE team_id = ? AND name = ?",
    [reportMode, now, teamInfo.teamId, args.name])
  const admitted = admitWorktree({ agent, worktree: useWorktree ? undefined : false, directory: worktreeDir, branch: worktreeBranch })
  if (admitted.state === "failed") throw new Error(`Worktree admission failed for "${args.name}": ${admitted.reason}`)
  deps.db.run("UPDATE team_member SET worktree_state = ?, checkout_branch = ? WHERE team_id = ? AND name = ?",
    [admitted.state, admitted.state === "ready" ? admitted.branch : null, teamInfo.teamId, args.name])

  // Row is inserted as 'busy' directly -- there is no ready->busy status-event
  // transition for a fresh spawn, so the watchdog's usual hook point never fires.
  // Record the baseline here instead, or a member stalled on its first action
  // is invisible to checkStalled() until its first step-finish event lands.
  deps.progressTracker.recordBusyStart(childSessionId)

  // Register in memory
  deps.registry.register(teamInfo.teamId, args.name, childSessionId)

  // Auto-claim a task for this teammate when claim_task is provided (issue #27).
  // Claims atomically so a task is never double-assigned when the lead hands out
  // more tasks than there are teammates. Context-bound reviews also admit read-only agents.
  let claimedTaskContent: string | null = null
  let claimWarning: string | null = null
  const allocatedSessionId = childSessionId
  const rejectPolicySpawn = async (error: unknown): Promise<never> => {
    const reason = error instanceof Error ? error.message : String(error)
    if (inherited) {
      await rollbackInheritedSpawn(deps, teamInfo.teamId, args.name)
      throw new Error(reason)
    }
    releaseMemberTasks(deps.db, teamInfo.teamId, args.name)
    deps.registry.unregister(allocatedSessionId)
    try {
      // Allocation may have yielded to a config command. Preserve before abort,
      // exactly as for ordinary spawn rollback; never discard a branch on doubt.
      if (worktreeBranch) {
        const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
        const preserved = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.name)
        if (!await (deps.preserveBranch ?? preserveBranch)(worktreeBranch, preserved, deps.directory)) throw new Error("branch preservation failed")
        storePreservedBranch(deps.db, teamInfo.teamId, args.name, worktreeBranch, preserved)
      }
      await deps.client.session.abort({ sessionID: allocatedSessionId })
      if (workspaceId) await deps.client.workspace.remove({ id: workspaceId })
      if (worktreeDir) await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } })
      deps.db.run("DELETE FROM team_member WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.name])
    } catch (cleanupError) {
      deps.db.run("UPDATE team_member SET status = 'error', time_updated = ? WHERE team_id = ? AND name = ?", [Date.now(), teamInfo.teamId, args.name])
      notifyLead(deps.client, deps.db, teamInfo.teamId, `Mission admission cancelled for ${args.name}; resources retained for recovery: ${String(cleanupError)}`)
      throw new Error(`${reason}; cleanup pending: ${String(cleanupError)}`)
    }
    throw new Error(reason)
  }
  if (policyRouting) {
    try {
      const current = routeMissionTask(deps.db, teamInfo.teamId, args.claim_task, { complexity: args.complexity, risk: args.risk })
      if (current?.policyHash !== policyRouting.policyHash || current.policyRevision !== policyRouting.policyRevision) throw new Error("Mission policy changed during spawn allocation")
      if (JSON.stringify(current) !== JSON.stringify(policyRouting)) throw new Error("Task execution decision changed during spawn allocation")
    } catch (error) { return rejectPolicySpawn(error) }
  }
  if (taskContract && args.claim_task) {
    const current = deps.db.query("SELECT agent, spawn_context, spawn_options, publication, completion_policy, control_revision FROM team_task WHERE id=? AND team_id=?").get(args.claim_task, teamInfo.teamId)
    if (JSON.stringify(current) !== JSON.stringify(taskContract)) return rejectPolicySpawn(new Error("Task admission contract changed during spawn allocation"))
  }
  if (args.claim_task && (!isReadOnly || finalResponse || taskBound)) {
    try {
      if (taskBound) deps.db.run("UPDATE team_member SET context_task_id=? WHERE team_id=? AND name=?", [args.claim_task, teamInfo.teamId, args.name])
      claimedTaskContent = claimTask(deps.db, teamInfo.teamId, args.claim_task, args.name)
      log(`spawn:claim:ok name=${args.name} task=${args.claim_task}`)
    } catch (err) {
      claimWarning = err instanceof Error ? err.message : String(err)
      log(`spawn:claim:failed name=${args.name} task=${args.claim_task} err=${claimWarning}`)
      if (policyRouting || taskBound) return rejectPolicySpawn(err)
      if (inherited) {
        await rollbackInheritedSpawn(deps, teamInfo.teamId, args.name)
        throw new Error(`Cannot claim task for inherited teammate "${args.name}": ${claimWarning}`)
      }
    }
  }

  // Legacy built-in readers deliberately skip ownership, but delivery is still
  // an admission/disclosure: never allow their referenced task to be deferred later.
  if (args.claim_task && taskContract && isReadOnly && !finalResponse && !taskBound) {
    const admitted = deps.db.run("UPDATE team_task SET admitted_at=COALESCE(admitted_at, ?) WHERE id=? AND team_id=? AND publication='published' AND control_revision=?",
      [Date.now(), args.claim_task, teamInfo.teamId, taskContract.control_revision])
    if (!admitted.changes) return rejectPolicySpawn(new Error("Task changed during read-only admission"))
  }

  if (autonomous) {
    try { await startTaskPlanning(deps, teamInfo.teamId, args.name, childSessionId) }
    catch (error) { return rejectPolicySpawn(error) }
  }

  // Build teammate context message
  const context = [
    `You are "${args.name}", a teammate in team "${teamInfo.teamName}".`,
    `Your agent type is "${agent}".`,
  ]
  if (governed) context.push(taskExecutionInstructions(deps, childSessionId))
  if (taskContract?.completion_policy === "lead") context.push("Integration gate: do not call team_tasks_complete for this task. Report your deliverable; only the lead closes the task after review and integration.")
  if (inherited) context.push(`[Ensemble task ${childSessionId}]`, "You inherited the source session's projected research/history. This message defines your new identity and task; historical teammate roles and instructions belong to the source, not to you.")

  // Show other teammates so this agent knows who to message
  const otherMembers = deps.db.query(
    "SELECT name FROM team_member WHERE team_id = ? AND name != ? AND status NOT IN ('shutdown', 'error')"
  ).all(teamInfo.teamId, args.name) as Array<{ name: string }>
  if (otherMembers.length > 0) {
    context.push(`Other teammates: ${otherMembers.map(m => m.name).join(", ")}`)
  }

  if (worktreeBranch && worktreeDir && !workspaceId && !inherited) {
    // Workspace binding failed — fallback to prompt-based CWD instruction
    context.push(
      `You are working on branch "${worktreeBranch}" in your own worktree at: ${worktreeDir}`,
      `Your changes are isolated from other teammates.`,
      `IMPORTANT: All file operations and shell commands MUST target your worktree directory.`,
      `Before running shell commands, cd to: ${worktreeDir}`,
    )
  } else if (worktreeBranch && worktreeDir) {
    // Workspace binding active — server handles CWD
    context.push(
      `You are working on branch "${worktreeBranch}" in your own isolated worktree.`,
      `Your changes are isolated from other teammates.`,
    )
  } else if (worktreeBranch) {
    context.push(`You are working on branch "${worktreeBranch}". Your changes are isolated from other teammates.`)
  }
  if (worktreeBranch) context.push("Verify the deliverable exists on disk in this worktree before you report the task complete.")

  // Plan approval mode — teammate must send plan before writing
  if (usePlanApproval && !finalResponse) {
    context.push(
      "",
      "IMPORTANT: You are in PLAN MODE.",
      "Read and explore the codebase, then send your implementation plan to the lead via team_message.",
      "Do NOT write or modify any files until the lead approves your plan.",
      "Wait for the lead's approval message before proceeding with implementation.",
    )
  }

  if (finalResponse) {
    context.push("", "Reporting mode: final response for lead review.",
      "Use only the tools permitted by your native agent profile. Ensemble grants no additional permissions in this mode.",
      "Return your full findings, plan, or blocker in your final response, then stop. Ensemble will retrieve it and notify the lead.",
      "Do not call team tools or mark tasks complete. The lead must review, persist/integrate the candidate and explicitly close tasks; consumers stay blocked until then.")
    if (usePlanApproval) context.push("PLAN MODE: return a plan only; do not modify files. Wait for explicit lead approval before implementation.")
  } else {
    if (isReadOnly) {
      context.push(
        "", "Tools available to you:",
        "- team_message: send a message to the lead or another teammate",
        "- team_broadcast: send a message to all team members",
        "- team_tasks_list: view the shared team task board",
        "- team_results: retrieve a teammate's full message",
        "- team_status: view members and task counts",
        "- team_view: focus a teammate session when navigation is requested",
      )
    } else {
      context.push(
        "", "Tools available to you:",
        "- team_message: send a message to the lead or another teammate",
        "- team_broadcast: send a message to all team members",
        "- team_tasks_list: view the shared team task board",
        "- team_tasks_add: add tasks to the shared board",
        "- team_tasks_complete: mark a task complete on the shared board",
        "- team_claim: claim a pending task from the shared board",
      )
    }

    // Collaboration guidance for peer-to-peer communication
    if (otherMembers.length > 0) {
      context.push(
        "",
        "Collaboration:",
        "- Check team_tasks_list to see what other teammates are working on.",
        "- If you need information another teammate has, message them directly via team_message.",
        "- If you discover something relevant to another teammate's task, share it with them.",
        "- Use team_broadcast for updates that affect the whole team.",
        "- Keep peer messages focused and actionable — coordinate, don't chat.",
      )
    }

    context.push("", "When you finish your task:")
    if (deps.client.continuity && !autonomous) context.push("Use team_handoff to change your own agent in this same session when needed. Use team_results, team_status and team_view for inspection.")
    if (!isReadOnly && worktreeBranch) {
      context.push(`1. Commit your changes: git add -A && git commit -m "your summary"`)
      context.push(taskContract?.completion_policy === "lead" ? "2. Leave the task open for lead acceptance after integration." : "2. If you claimed a task, mark it complete using team_tasks_complete.")
      context.push("3. Send ONE message to the lead using team_message with this format:")
    } else if (!isReadOnly) {
      context.push(taskContract?.completion_policy === "lead" ? "1. Leave the task open for lead acceptance after integration." : "1. If you claimed a task, mark it complete using team_tasks_complete.")
      context.push("2. Send ONE message to the lead using team_message with this format:")
    } else {
      context.push("1. Send ONE message to the lead using team_message with this format:")
    }
    context.push(
      "<task-result>",
      "<status>completed or failed</status>",
      "<summary>One-line summary of what you did</summary>",
      "<details>Full findings or changes made</details>",
    )
    if (worktreeBranch) context.push(`<branch>${worktreeBranch}</branch>`)
    context.push("</task-result>")
    const lastStep = !isReadOnly && worktreeBranch ? "4" : !isReadOnly ? "3" : "2"
    context.push(
      `${lastStep}. STOP. Do not send follow-up confirmations, status updates, or 'standing by' messages.`,
      "",
      "If you encounter uncertainty or a blocker:",
      "- First consider safe in-scope alternatives and reasonable reversible assumptions under the assigned plan. Routine choices are yours; do not bypass permissions, explicit plan approval, architecture boundaries or the mission objective.",
      "- If no compliant choice remains, send ONE message to the lead via team_message describing the specific boundary, and wait for the lead's response for that blocked work; continue independent authorized work where possible.",
      "",
      "Use team_message for explicit structured reports. Native final output can be recovered for lead review, but does not complete a task.",
    )
  }

  context.push(
    "",
    "Your task:",
    args.prompt,
  )

  if (claimedTaskContent) {
    context.push("", `You have been assigned task ${args.claim_task}. ${finalResponse ? "Return its candidate for lead review; do not close it." : "Mark it complete when done."}`)
  }

  const contextStr = context.join("\n")

  // Model was already resolved before DB insert — just parse for promptAsync
  const modelParam = resolvedModel ? parseModelId(resolvedModel) : undefined
  if (resolvedModel && !modelParam) {
    log(`spawn:model:invalid name=${args.name} model=${resolvedModel} — expected "provider/model" format, falling back to default`)
  }

  // Fire-and-forget: send prompt to teammate session.
  // Phase 2 opens the initialization guard only after move/wait completed.
  if (inherited) deps.db.run("UPDATE team_member SET spawn_pending = 2 WHERE session_id = ?", [childSessionId])
  log(`spawn:promptAsync:fire name=${args.name} sessionId=${childSessionId}`)
  deps.client.session.promptAsync({
    sessionID: childSessionId,
    parts: [{ type: "text", text: contextStr }],
    ...(inherited ? {} : { agent }),
    ...(inherited ? { metadata: { "ensemble.spawn": `${teamInfo.teamId}/${args.name}/${childSessionId}` } } : {}),
    ...(modelParam ? { model: modelParam } : {}),
    ...(resolvedVariant ? { variant: resolvedVariant } : {}),
  }).then(() => {
    if (inherited) deps.db.run("UPDATE team_member SET spawn_pending = 0 WHERE session_id = ?", [childSessionId])
  }).catch(async (err) => {
    const errMsg = err instanceof Error ? err.message : String(err)
    log(`spawn:promptAsync:failed name=${args.name} err=${errMsg} — rolling back`)
    if (inherited) {
      try {
        const outcome = await rollbackInheritedSpawn(deps, teamInfo.teamId, args.name)
        notifyLead(deps.client, deps.db, teamInfo.teamId, outcome === "adopted"
          ? `Teammate "${args.name}" was admitted by OpenCode despite the delivery error; its session and work were retained: ${errMsg}`
          : `Teammate "${args.name}" failed to start and was removed: ${errMsg}`)
      } catch (cleanupError) {
        log(`spawn:rollback:pending name=${args.name} error=${String(cleanupError)}`)
        notifyLead(deps.client, deps.db, teamInfo.teamId, `Teammate "${args.name}" failed to start. Cleanup is pending recovery: ${String(cleanupError)}`)
      }
      return
    }
    try {
      if (worktreeBranch) {
        const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
        const preserved = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.name)
        const safe = await (deps.preserveBranch ?? preserveBranch)(worktreeBranch, preserved, deps.directory)
        if (!safe) {
          deps.db.run("UPDATE team_member SET status = 'error' WHERE session_id = ?", [childSessionId])
          notifyLead(deps.client, deps.db, teamInfo.teamId, `Could not preserve "${args.name}" before rollback; session and worktree retained for recovery.`)
          return
        }
        storePreservedBranch(deps.db, teamInfo.teamId, args.name, worktreeBranch, preserved)
      }
      deps.db.run("DELETE FROM team_member WHERE team_id = ? AND session_id = ?", [teamInfo.teamId, childSessionId])
      deps.registry.unregister(childSessionId)
      // Release any task auto-claimed for this teammate so it returns to the pool.
      if (claimedTaskContent) {
        deps.db.run(
          "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE id = ? AND assignee = ? AND status = 'in_progress'",
          [Date.now(), args.claim_task, args.name]
        )
      }
      deps.client.session.abort({ sessionID: childSessionId }).catch(() => { /* best effort */ })
      if (workspaceId) {
        deps.client.workspace.remove({ id: workspaceId }).catch(() => { /* best effort */ })
      }
      if (worktreeDir) {
        deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }).catch(() => { /* best effort */ })
      }
      const modelInfo = resolvedModel ? ` (model: ${resolvedModel})` : ""
      deps.client.tui.showToast({
        title: "Team",
        message: `Teammate "${args.name}" failed to start${modelInfo}: ${errMsg}`,
        variant: "error",
        duration: 8000,
      }).catch(() => { /* TUI may not be available */ })
      notifyLead(
        deps.client,
        deps.db,
        teamInfo.teamId,
        `Teammate "${args.name}" failed to start and was removed${modelInfo}. Error: ${errMsg}. You may retry the spawn.`,
      )
    } catch { /* rollback failed — watchdog will clean up stale member */ }
  })

  const branchInfo = worktreeBranch ? ` (branch: ${worktreeBranch})` : ""
  const planInfo = usePlanApproval ? " [plan mode — will send plan for approval]" : ""
  const claimInfo = claimedTaskContent
    ? ` (claimed task: ${args.claim_task})`
    : claimWarning ? ` (could not claim task: ${claimWarning})` : ""
  // Reset circuit breaker on success
  spawnFailures.delete(teamInfo.teamId)
  log(`spawn:done name=${args.name} sessionId=${childSessionId}`)
  const routingInfo = policyRouting ? `\nMission policy v${policyRouting.policyRevision}: ${policyRouting.group} → ${policyRouting.selected.id} (${policyRouting.selected.variant ?? "default"}).`
    : routing ? `\nModel routing: ${routing.reason}` : ""
  const isolation = useWorktree ? "" : ` worktree off (${isReadOnly ? "readonly-agent" : "flag"})`
  return `Teammate "${args.name}" spawned (agent: ${agent})${branchInfo}${planInfo}${claimInfo}. They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}${routingInfo}${profileAdmissionWarning(deps.directory, agent, finalResponse)}${isolation}`
}
