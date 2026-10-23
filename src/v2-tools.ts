import type { ToolDeps } from "./types"
import { executeTeamCreate } from "./tools/team-create"
import { executeTeamSpawn } from "./tools/team-spawn"
import { executeTeamHandoff } from "./tools/team-handoff"
import { executeTeamMessage } from "./tools/team-message"
import { executeTeamBroadcast } from "./tools/team-broadcast"
import { executeTeamTasksList } from "./tools/team-tasks-list"
import { executeTeamTasksAdd } from "./tools/team-tasks-add"
import { executeTeamTasksComplete } from "./tools/team-tasks-complete"
import { executeTeamClaim } from "./tools/team-claim"
import { executeTeamResults } from "./tools/team-results"
import { executeTeamShutdown } from "./tools/team-shutdown"
import { executeTeamCleanup } from "./tools/team-cleanup"
import { executeTeamMerge } from "./tools/team-merge"
import { executeTeamStatus } from "./tools/team-status"
import { executeTeamView } from "./tools/team-view"
import type { TaskExecutionDecision } from "./execution-policy"

/** V2 tool definition (JSON Schema input, structured content output). */
export interface V2ToolDef {
  name: string
  description: string
  input: Record<string, unknown>
  execute(input: unknown, context: { sessionID: string; signal?: AbortSignal }): Promise<{ content: string }>
}

/** Minimal structural subset of the V2 tool domain. */
export interface V2ToolDomain {
  transform(cb: (editor: { add(def: V2ToolDef): void }) => void): Promise<{ dispose(): Promise<void> }>
}

/** JSON Schema string property. */
function str(description: string): Record<string, unknown> {
  return { type: "string", description }
}

/** JSON Schema boolean property with default. */
function bool(description: string, fallback: boolean): Record<string, unknown> {
  return { type: "boolean", description, default: fallback }
}

function classification(): Record<string, unknown> {
  return { type: "object", description: "Frozen mission classification defaults/explicit overrides", additionalProperties: false, properties: {
    mode: { type: "string", enum: ["off", "auto", "jev", "general", "x86"] },
    helperModel: str("Explicit helper model in provider/model format; no model is chosen implicitly"),
    helperVariant: str("Native reasoning variant for the helper model"),
    toolId: str("Exact classifier tool ID; empty means discover the known JEV contract"),
    timeoutMs: { type: "integer", minimum: 1 },
    missionMode: { type: "string", enum: ["supervised", "long_run"] },
    generalModel: str("Explicit model for embedded general classification; never activated automatically"),
    generalVariant: str("Reasoning variant for the general classifier"),
    specialized: { type: "boolean", description: "In auto mode, prefer the discovered x86 tool for explicit x86 tasks" },
    x86ToolId: str("Exact specialized tool ID; empty discovers the known classify_x86 contract"),
    fallbacks: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["method", "model"], properties: {
      method: { type: "string", enum: ["jev", "general"] }, model: str("Explicitly authorized classifier/helper model"), variant: str("Reasoning variant"), toolId: str("Exact JEV tool ID"),
    } } },
    limits: { type: "object", additionalProperties: false, properties: Object.fromEntries([
      "retries", "retryDelayMs", "maxAttempts", "maxCalls", "maxDurationMs", "maxInputBytes", "concurrency", "circuitThreshold", "circuitCooldownMs", "maxCircuitRechecks",
    ].map(key => [key, { type: "integer", minimum: ["retries", "retryDelayMs", "maxCircuitRechecks"].includes(key) ? 0 : 1 }])) },
  } }
}

/** Task priority enum shared by the schema and the runtime validator. */
const TASK_PRIORITIES = ["high", "medium", "low"] as const
type TaskPriority = (typeof TASK_PRIORITIES)[number]

/** JSON Schema enum property for task priority. */
function priority(): Record<string, unknown> {
  return { type: "string", description: "Task priority", enum: [...TASK_PRIORITIES], default: "medium" }
}

function taskExecutionProperties(): Record<string, unknown> {
  return {
    mode: { type: "string", enum: ["planned", "direct"], description: "Default planned; direct requires supervisor authorization before admission" },
    kind: { type: "string", enum: ["documentation", "research", "code", "mixed", "unspecified"], description: "Only strictly documentation/research may be direct" },
    model: str("Optional direct-task model from the approved catalogue; never grants permissions"),
    variant: str("Exact approved native variant for the explicit direct-task model"),
  }
}

/** Throw on unknown priority — fail fast instead of writing garbage to SQLite. */
export function normalizePriority(value: string | undefined): TaskPriority {
  if (value === undefined) return "medium"
  if ((TASK_PRIORITIES as readonly string[]).includes(value)) return value as TaskPriority
  throw new Error(`Invalid priority "${value}" — expected one of: high, medium, low.`)
}

/**
 * Register all 15 team tools on a V2 context. Each execute delegates to the
 * same implementation V1 uses (DRY) — only arg transport changes from Zod to
 * JSON Schema. V1 applied schema defaults before execute; V2 may not, so
 * priority is normalized here (team_tasks_add writes it straight to SQLite).
 *
 * Purge approval (team_cleanup) has no approver on V2 yet — the question-tool
 * flow it used is TUI-side. Preview works; confirmed purge needs the forms
 * slice. team_view resolves without navigating (no server-side TUI select).
 */
export async function registerV2Tools(domain: V2ToolDomain, deps: ToolDeps): Promise<void> {
  const run = <A>(
    fn: (deps: ToolDeps, args: A, sessionID: string) => Promise<string>,
    track?: (sessionID: string, args: A) => void,
  ) => async (input: unknown, context: { sessionID: string }) => {
    const args = input as A
    track?.(context.sessionID, args)
    return { content: await fn(deps, args, context.sessionID) }
  }
  const runSession = (fn: (deps: ToolDeps, sessionID: string) => Promise<string>) => async (
    _input: unknown,
    context: { sessionID: string },
  ) => ({ content: await fn(deps, context.sessionID) })

  await domain.transform((editor) => {
    editor.add({
      name: "team_create",
      description: "Create a new agent team. You become the team lead. Use this before spawning teammates.",
      input: {
        type: "object",
        properties: {
          name: str("Team name (lowercase alphanumeric with hyphens, 1-64 chars)"),
          project_name: str("Project display name for first use of this working directory."),
          classification: classification(),
          mission_mode: { type: "string", enum: ["supervised", "long_run"], description: "Supervised asks when authorized methods are exhausted; long_run isolates failures until a critical budget/safety stop" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      execute: run(executeTeamCreate),
    })

    editor.add({
      name: "team_spawn",
      description:
        "Spawn a new teammate that works in parallel. The teammate starts immediately with the given prompt. " +
        "Each teammate gets their own git worktree for file isolation. " +
        "Teammates work asynchronously and will message you when done. Do not poll for their status. " +
        "Context is fresh by default; opt into fork/checkpoint/compact_fork to inherit a team's session history. Lead only.",
      input: {
        type: "object",
        properties: {
          name: str("Teammate name (lowercase alphanumeric with hyphens)"),
          agent: str("Agent type (e.g. 'build', 'plan', 'explore')"),
          prompt: str("Task instructions for the teammate"),
          model: str("Model in provider/model format (optional, uses default)"),
          variant: str("Native reasoning variant for an explicit/configured model; routed models use the catalogue effort"),
          complexity: { type: "integer", minimum: 0, maximum: 100, description: "Task complexity for deterministic model routing; overrides claim_task" },
          risk: { type: "integer", minimum: 0, maximum: 100, description: "Task risk for deterministic model routing only; overrides claim_task" },
          claim_task: str("Task ID to auto-claim for this teammate (optional)"),
          worktree: bool("Create a git worktree for file isolation (default: true, set false for read-only agents)", true),
          plan_approval: bool("Require teammate to send a plan for approval before writing files (default: false)", false),
          report_mode: { type: "string", enum: ["team_message", "final_response"], description: "Use final_response for restrictive profiles: preserve native permissions, retrieve a candidate for lead review, never auto-complete tasks. Default team_message." },
          context: {
            type: "object",
            description: "Opt-in V2 history inheritance; independent reviewers should use fresh.",
            properties: {
              mode: { type: "string", enum: ["fresh", "fork", "checkpoint", "compact_fork"] },
              from: str("current (default), lead, or a member name/session ID in this team; compact_fork requires a distinct idle source"),
              messageID: str("checkpoint only: exclusive native boundary; this message and later messages are excluded"),
            },
            required: ["mode"],
            additionalProperties: false,
          },
        },
        required: ["name", "prompt"],
        additionalProperties: false,
      },
      execute: run(executeTeamSpawn),
    })

    editor.add({
      name: "team_handoff",
      description: "V2: retain this session/history/worktree. For an autonomous task, pass phase:'implementation' and optional reasoning to finish planning, or reasoning alone to adjust implementation effort. The task's model/profile remain fixed. Outside autonomous tasks, agent changes the native profile. This does not grant lead privileges.",
      input: { type: "object", properties: { agent: str("Native target agent outside autonomous tasks"), phase: { type: "string", enum: ["implementation"] }, reasoning: str("Exact allowed catalogue variant; default selects the omitted native variant") }, anyOf: [{ required: ["agent"] }, { required: ["phase"] }, { required: ["reasoning"] }], additionalProperties: false },
      execute: async (input, context) => ({ content: await executeTeamHandoff(deps, input as Parameters<typeof executeTeamHandoff>[1], context.sessionID, context.signal) }),
    })

    editor.add({
      name: "team_message",
      description:
        "Send a message to a specific teammate or to the lead. Use 'lead' to message the team lead. " +
        "Lead only: pass 'model' (provider/model) to update a teammate's model in-place.",
      input: {
        type: "object",
        properties: {
          to: str("Recipient name ('lead' or teammate name)"),
          text: str("Message content (max 10KB). Optional only when 'model' is provided."),
          approve: bool("Approve a teammate's plan (only when recipient has plan_approval='pending')", false),
          reject: str("Reject a teammate's plan with reason (only when recipient has plan_approval='pending')"),
          force: bool("Lead only. Re-activate a teammate who already reported task completion.", false),
          model: str("Lead only: update the recipient teammate's model in-place, in 'provider/model' format."),
          classification: classification(),
        },
        required: ["to"],
        additionalProperties: false,
      },
      execute: run(executeTeamMessage, (sessionID, args) => {
        const to = args.to ?? ""
        deps.progressTracker.recordMessage(sessionID)
        if (to !== "lead") deps.progressTracker.recordPeerMessage(sessionID)
      }),
    })

    editor.add({
      name: "team_broadcast",
      description: "Send a message to all teammates and the lead (excluding yourself).",
      input: {
        type: "object",
        properties: { text: str("Message content (max 10KB)") },
        required: ["text"],
        additionalProperties: false,
      },
      execute: run(executeTeamBroadcast, (sessionID) => {
          deps.progressTracker.recordMessage(sessionID)
          deps.progressTracker.recordPeerMessage(sessionID)
        },
      ),
    })

    editor.add({
      name: "team_tasks_list",
      description:
        "View the shared team task board. Use this to check task status, not to wait for teammates. Teammates will message you when done.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: runSession(executeTeamTasksList),
    })

    editor.add({
      name: "team_tasks_add",
      description: "Add tasks or propose execution boundaries. Only the lead supervisor can authorize direct documentation/research via execution_decisions before admission; use tasks: [] to decide existing proposals.",
      input: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "Tasks to add",
            items: {
              type: "object",
              properties: {
                content: str("Task description"),
                priority: priority(),
                depends_on: {
                  type: "array",
                  items: { type: "string" },
                  description: "Task IDs this depends on",
                },
                agent: {
                  type: "string",
                  description: "Agent type affinity for auto-dispatch (e.g. build). Omit for any member.",
                },
                complexity: { type: "integer", minimum: 0, maximum: 100, description: "Task complexity for deterministic model routing" },
                risk: { type: "integer", minimum: 0, maximum: 100, description: "Task risk for model routing only (not review policy)" },
                task_type: str("Explicit task kind supplied to the fixed classification protocol"),
                classification_input: { type: "object", additionalProperties: true, description: "Task-specific classification data, treated as data rather than instructions" },
                execution: { type: "object", properties: taskExecutionProperties(), required: ["mode", "kind"], additionalProperties: false,
                  description: "Execution proposal; a lead's proposal is also its authorization. Other members' proposals await a supervisor decision." },
              },
              required: ["content"],
              additionalProperties: false,
            },
          },
          execution_decisions: { type: "array", description: "Lead-only decisions for existing unassigned, not-yet-admitted tasks", items: {
            type: "object", properties: { task_id: str("Existing task ID"), ...taskExecutionProperties() }, required: ["task_id", "mode", "kind"], additionalProperties: false,
          } },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
      execute: async (input: unknown, context: { sessionID: string }) => {
        const args = input as {
          tasks: Array<{ content: string; priority?: string; depends_on?: string[]; agent?: string; complexity?: number; risk?: number; task_type?: string; classification_input?: Record<string, unknown>; execution?: TaskExecutionDecision }>
          execution_decisions?: Array<TaskExecutionDecision & { task_id: string }>
        }
        const content = await executeTeamTasksAdd(
          deps,
          {
            tasks: args.tasks.map((task) => ({
              content: task.content,
              priority: normalizePriority(task.priority),
              ...(task.depends_on ? { depends_on: task.depends_on } : {}),
              ...(task.agent ? { agent: task.agent } : {}),
              ...(task.complexity !== undefined ? { complexity: task.complexity } : {}),
              ...(task.risk !== undefined ? { risk: task.risk } : {}),
              ...(task.task_type !== undefined ? { task_type: task.task_type } : {}),
              ...(task.classification_input !== undefined ? { classification_input: task.classification_input } : {}),
              ...(task.execution !== undefined ? { execution: task.execution } : {}),
            })),
            ...(args.execution_decisions !== undefined ? { execution_decisions: args.execution_decisions } : {}),
          },
          context.sessionID,
        )
        return { content }
      },
    })

    editor.add({
      name: "team_tasks_complete",
      description: "Mark a task as completed on the shared board. This unblocks any tasks that depend on it.",
      input: {
        type: "object",
        properties: { task_id: str("ID of the task to mark complete") },
        required: ["task_id"],
        additionalProperties: false,
      },
      execute: run(executeTeamTasksComplete, (sessionID) =>
        deps.progressTracker.recordTaskComplete(sessionID),
      ),
    })

    editor.add({
      name: "team_claim",
      description: "Claim a pending task from the shared task list. Only unclaimed, unblocked tasks can be claimed.",
      input: {
        type: "object",
        properties: { task_id: str("ID of the task to claim") },
        required: ["task_id"],
        additionalProperties: false,
      },
      execute: run(executeTeamClaim),
    })

    editor.add({
      name: "team_results",
      description:
        "Retrieve unread teammate messages and full native candidates for lead review. Marks items read. candidate_id retrieves a retained candidate again without accepting it.",
      input: {
        type: "object",
        properties: { from: str("Filter messages by sender name (optional, returns all if omitted)"), candidate_id: str("Lead only: retrieve a retained native candidate by ID, including one already read") },
        additionalProperties: false,
      },
      execute: run(executeTeamResults),
    })

    editor.add({
      name: "team_shutdown",
      description:
        "Request a teammate to shut down. The teammate finishes current work then stops. Pass force: true to abort immediately without waiting.",
      input: {
        type: "object",
        properties: {
          member: str("Teammate name to shut down"),
          force: bool("Force immediate abort without waiting for current work to finish", false),
        },
        required: ["member"],
        additionalProperties: false,
      },
      execute: run(executeTeamShutdown),
    })

    editor.add({
      name: "team_cleanup",
      description:
        "Clean up the current team, or purge archived teams after human approval. Omit purge for normal cleanup.",
      input: {
        type: "object",
        properties: {
          force: bool("Force cleanup even if members are active (will abort them)", false),
          acknowledge_uncommitted: bool("Acknowledge uncommitted changes", false),
          purge: {
            type: "array",
            items: { type: "string" },
            description: "Archived team names to permanently delete, or ['*'] for all archived teams.",
          },
          confirm_purge: bool("Set true only after the user explicitly approves the purge preview.", false),
          confirm_token: str("Confirmation token from the purge preview."),
        },
        additionalProperties: false,
      },
      execute: async (input: unknown, context: { sessionID: string }) => {
        const args = input as {
          force?: boolean
          acknowledge_uncommitted?: boolean
          purge?: string[]
          confirm_purge?: boolean
          confirm_token?: string
        }
        const content = await executeTeamCleanup(
          deps,
          {
            force: args.force ?? false,
            acknowledge_uncommitted: args.acknowledge_uncommitted,
            purge: args.purge,
            confirm_purge: args.confirm_purge,
            confirm_token: args.confirm_token,
          },
          context.sessionID,
        )
        return { content }
      },
    })

    editor.add({
      name: "team_merge",
      description:
        "Merge a shutdown teammate's branch into the working directory as unstaged changes. Use this after team_shutdown to review and integrate a teammate's work. The teammate must be shut down first.",
      input: {
        type: "object",
        properties: { member: str("Teammate name whose branch to merge") },
        required: ["member"],
        additionalProperties: false,
      },
      execute: run(executeTeamMerge),
    })

    editor.add({
      name: "team_status",
      description:
        "View team members with their current status, agent type, and session IDs. Use this to check who is working, idle, or shut down. Includes a task summary.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: runSession(executeTeamStatus),
    })

    editor.add({
      name: "team_view",
      description:
        "Resolve a teammate's session so the user can inspect it. Default reports the session ID + status without switching. " +
        "navigate: true switches the user's client — ONLY when the user explicitly asked to view the teammate's session.",
      input: {
        type: "object",
        properties: {
          member: str("Teammate name to view"),
          navigate: bool("Switch the user's client to this session. Only when the user explicitly asked.", false),
        },
        required: ["member"],
        additionalProperties: false,
      },
      execute: run(executeTeamView),
    })
  })
}
