import type { PermissionRule, ToolDeps } from "./types"
import type { ExecutionRoute, ExecutionPolicy } from "./execution-policy"
import { validateExecutionPolicy } from "./execution-policy"
import { parseModelId } from "./member-model"
import type { MissionModelPolicy } from "./mission-model-policy"
import { verificationInstructions } from "./verification-policy"

type Assignment = ExecutionRoute & { policyRevision: number; policyHash: string }
interface Worker { agent: string; model: string; model_variant: string | null; model_routing: string; status: string; spawn_pending: number }

/** Read-only planning overrides; Code Mode still checks permissions of nested tools. */
export function planningPermissions(): PermissionRule[] {
  const tools = ["read", "glob", "grep", "webfetch", "websearch", "question", "skill", "execute",
    "team_message", "team_broadcast", "team_tasks_list", "team_tasks_add", "team_claim", "team_results", "team_status", "team_view", "team_handoff",
    "*grepai*", "*serena*find*", "*serena*get_*", "*serena*search*", "*serena*initial_instructions",
    "*context-mode*ctx_execute_file", "*context-mode*ctx_search", "*context-mode*ctx_index", "*context-mode*ctx_fetch_and_index"]
  return [{ permission: "*", pattern: "*", action: "deny" }, ...tools.map(permission => ({ permission, pattern: "*", action: "allow" as const }))]
}

/** Whether this session has a catalogue-driven assignment, including an uncertain transition. */
export function hasAutonomousAssignment(deps: ToolDeps, sessionID: string): boolean {
  const row = deps.db.query("SELECT model_routing FROM team_member WHERE session_id = ? AND EXISTS (SELECT 1 FROM team_task WHERE team_task.team_id = team_member.team_id AND assignee = team_member.name AND status = 'in_progress')").get(sessionID) as { model_routing: string | null } | null
  return Boolean(row?.model_routing && "execution" in JSON.parse(row.model_routing))
}

/** Describe the current task boundary without adding another prompt or reminder. */
export function taskExecutionInstructions(deps: Pick<ToolDeps, "db">, sessionID: string): string {
  const row = deps.db.query("SELECT model_routing FROM team_member WHERE session_id = ?").get(sessionID) as { model_routing: string | null } | null
  if (!row?.model_routing) return ""
  const route = JSON.parse(row.model_routing) as Assignment
  if (!Number.isInteger(route.policyRevision)) return ""
  const revision = deps.db.query("SELECT policy_json FROM mission_policy_revision WHERE revision = ? AND team_id = (SELECT team_id FROM team_member WHERE session_id = ?)")
    .get(route.policyRevision, sessionID) as { policy_json: string } | null
  if (!revision) return ""
  const policy = JSON.parse(revision.policy_json) as ExecutionPolicy | MissionModelPolicy
  const verification = verificationInstructions(policy.verification)
  if (!route.execution || policy.version !== 2) return verification
  const variants = policy.models.filter(model => model.id === route.selected.id).map(model => model.reasoningEffort ?? "default")
  const boundary = route.execution.phase === "planning"
    ? 'Plan read-only first. Once the plan is established, reassess the reasoning needed for implementation. Choose the lowest allowed level you judge sufficient; do not automatically retain the planning level. Briefly explain your choice in public text before calling team_handoff({ phase: "implementation", reasoning: "<allowed variant>" }) with an explicit reasoning choice. Keeping the current level is appropriate when needed. General-purpose command execution is unavailable during planning; use permitted read/search tools.'
    : route.authorization?.mode === "direct" ? `Supervisor-authorized direct ${route.authorization.kind} task: no separate planning phase. Native profile permissions and project safety/isolation rules still apply; this decision grants no additional permissions.` : "Planning is complete. Native profile permissions and project safety rules still apply."
  return `${verification}\nTask phase: ${route.execution.phase}${route.execution.applying ? " (pending native application; retry the same choice or report the blocker)" : ""}; fixed model: ${route.selected.id}; reasoning: ${route.execution.variant ?? "default"}. Allowed reasoning: ${variants.join(", ")}. ${boundary} During implementation, team_handoff({ reasoning: "<allowed variant>" }) raises or lowers effort. Model, profile and session remain fixed.`
}

function assignment(deps: ToolDeps, teamId: string, memberName: string, initializing = false) {
  const member = deps.db.query("SELECT agent, model, model_variant, model_routing, status, spawn_pending FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as Worker | null
  if (!member || !["busy", "ready"].includes(member.status) || (member.spawn_pending && !initializing)) throw new Error("Worker cannot transition in its current lifecycle state")
  const tasks = deps.db.query("SELECT id, model_routing FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress'")
    .all(teamId, memberName) as Array<{ id: string; model_routing: string | null }>
  if (tasks.length !== 1 || tasks[0]?.model_routing !== member.model_routing) throw new Error("Execution requires exactly one matching active task")
  const route = JSON.parse(member.model_routing) as Assignment
  const revision = deps.db.query("SELECT policy_hash, policy_json FROM mission_policy_revision WHERE team_id = ? AND revision = ?")
    .get(teamId, route.policyRevision) as { policy_hash: string; policy_json: string } | null
  if (!revision || revision.policy_hash !== route.policyHash || !route.execution || route.selected.id !== member.model) throw new Error("Invalid task execution provenance")
  const policy: unknown = JSON.parse(revision.policy_json)
  validateExecutionPolicy(policy)
  return { member, taskId: tasks[0].id, route, policy: policy as ExecutionPolicy }
}

function store(deps: ToolDeps, teamId: string, memberName: string, taskId: string, route: Assignment, previous: string): string {
  const json = JSON.stringify(route)
  deps.db.transaction(() => {
    const updated = deps.db.run("UPDATE team_task SET model_routing = ? WHERE id = ? AND team_id = ? AND assignee = ? AND status = 'in_progress' AND model_routing = ?",
      [json, taskId, teamId, memberName, previous])
    if (!updated.changes) throw new Error("Task execution changed during transition")
    const member = deps.db.run("UPDATE team_member SET model_routing = ?, model_variant = ?, time_updated = ? WHERE team_id = ? AND name = ? AND model_routing = ?",
      [json, route.execution.variant ?? null, Date.now(), teamId, memberName, previous])
    if (!member.changes) throw new Error("Worker execution changed during transition")
  })()
  return json
}

/** Apply the admitted initial boundary (planning by default, direct only when authorized). */
export async function startTaskPlanning(deps: ToolDeps, teamId: string, memberName: string, sessionID: string): Promise<void> {
  if (!hasAutonomousAssignment(deps, sessionID)) return
  await transition(deps, teamId, memberName, sessionID, {}, true)
}

/** Adjust this worker's phase/reasoning, never its task's fixed model or profile. */
export async function transitionTaskExecution(deps: ToolDeps, teamId: string, memberName: string, sessionID: string,
  args: { agent?: string; phase?: "implementation"; reasoning?: string }, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  await transition(deps, teamId, memberName, sessionID, args, false, signal)
  return "Task execution updated. The same session and model are retained; subsequent requests use the selected reasoning."
}

async function transition(deps: ToolDeps, teamId: string, memberName: string, sessionID: string,
  args: { agent?: string; phase?: "implementation"; reasoning?: string }, starting: boolean, signal?: AbortSignal): Promise<void> {
  const { member, route, policy, taskId } = assignment(deps, teamId, memberName, starting)
  if (args.agent !== undefined && args.agent !== member.agent) throw new Error("An autonomous task cannot change its profile; use phase/ reasoning instead")
  if (!starting && args.phase === undefined && args.reasoning === undefined) throw new Error("Specify the implementation phase or reasoning for this task")
  if (!starting && route.execution.phase === "planning" && args.phase !== "implementation") throw new Error("Choose the implementation phase before adjusting reasoning")
  const variant = args.reasoning === "default" ? undefined : args.reasoning ?? route.execution.variant
  if (!policy.models.some(model => model.id === member.model && (model.reasoningEffort === "default" ? undefined : model.reasoningEffort) === variant)) throw new Error("Requested reasoning is outside the approved catalogue")
  const phase = starting ? route.execution.phase : args.phase ?? route.execution.phase
  if (route.execution.applying && (route.execution.phase !== phase || route.execution.variant !== variant)) throw new Error("A pending transition must be retried with the same phase and reasoning")
  if (!starting && !route.execution.applying && phase === route.execution.phase && variant === route.execution.variant) return
  const model = parseModelId(member.model)
  const switchModel = deps.client.session.switchModel?.bind(deps.client.session)
  const continuity = deps.client.continuity
  if (!model || !switchModel || !continuity) throw new Error("Autonomous task execution requires OpenCode V2 model and permission switching")
  if (!deps.nativeModels || !(await deps.nativeModels()).some(candidate => candidate.id === member.model && candidate.variant === variant)) throw new Error("Native model/variant unavailable for this task")
  const reserved = deps.db.run("UPDATE team_member SET handoff_pending = ? WHERE team_id = ? AND name = ? AND handoff_pending IS NULL", [member.agent, teamId, memberName])
  if (!reserved.changes) throw new Error("A transition is already pending for this session")
  const next: Assignment = { ...route, execution: { phase, ...(variant ? { variant } : {}), applying: true } }
  let previous = member.model_routing
  try {
    signal?.throwIfAborted()
    previous = store(deps, teamId, memberName, taskId, next, previous)
    await switchModel({ sessionID, model, ...(variant ? { variant } : {}) })
    signal?.throwIfAborted()
    if (starting || route.execution.applying || phase !== route.execution.phase) {
      await continuity.switchAgent({ sessionID, agent: member.agent, ...(phase === "planning" ? { permission: planningPermissions() } : {}) }, signal)
    }
    signal?.throwIfAborted()
    store(deps, teamId, memberName, taskId, { ...next, execution: { phase, ...(variant ? { variant } : {}) } }, previous)
  } finally {
    deps.db.run("UPDATE team_member SET handoff_pending = NULL WHERE team_id = ? AND name = ? AND handoff_pending = ?", [teamId, memberName, member.agent])
  }
}
