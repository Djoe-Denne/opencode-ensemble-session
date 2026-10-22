import type { Database } from "./db"
import { markDelivered } from "./messaging"
import { parseTaskResult, formatTaskResult } from "./result-parser"
import type { EnsembleConfig } from "./config"
import { getMissionClassification } from "./mission-classification"
import { missionPolicySummary } from "./mission-policy"
import { annotatedEffort } from "./variant-effort"
import { taskExecutionInstructions } from "./task-execution"
import { missionReportingInstructions } from "./mission-reporting"

/** Truncate a string to maxLen chars, appending "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s
}

/** Status display mapping from DB status to human-readable label. */
const STATUS_DISPLAY: Record<string, string> = {
  busy: "working",
  ready: "idle",
  shutdown_requested: "shutting down",
  shutdown: "shut down",
  error: "error",
}

/**
 * Build the system prompt injected into the lead's session.
 * Includes team name, member statuses, task counts, and anti-polling guidance.
 */
export function buildLeadSystemPrompt(db: Database, teamId: string, config?: Required<EnsembleConfig>): string {
  const team = db.query("SELECT name, mission_mode, mission_state FROM team WHERE id = ?").get(teamId) as { name: string; mission_mode: string; mission_state: string } | null
  if (!team) return ""

  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId) as Array<{ name: string; status: string }>

  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status",
  ).all(teamId) as Array<{ status: string; count: number }>

  const countMap: Record<string, number> = {}
  for (const row of taskCounts) {
    countMap[row.status] = row.count
  }

  const completed = countMap.completed ?? 0
  const inProgress = countMap.in_progress ?? 0
  const pending = countMap.pending ?? 0

  const memberList = members
    .map((m) => `${m.name} [${STATUS_DISPLAY[m.status] ?? m.status}]`)
    .join(", ")

  const teammateLine = members.length > 0
    ? `Teammates: ${memberList}`
    : "Teammates: none"

  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId) as Array<{ id: string; from_name: string; content: string }>

  const lines = [
    `You are leading team "${team.name}" with ${members.length} active teammates.`,
    teammateLine,
    `Tasks: ${completed} completed, ${inProgress} in progress, ${pending} pending`,
    missionReportingInstructions(`.opencode/missions/${teamId}/reports`),
  ]
  const classification = getMissionClassification(db, teamId, true)
  const missionPolicy = missionPolicySummary(db, teamId)
  if (missionPolicy) lines.push(missionPolicy)
  if (classification) lines.push(`Mission ${team.mission_mode}/${team.mission_state}; classification: ${classification.method}; protocol=${classification.protocol ?? "ensemble-task-v1"}; tool=${classification.toolId || "none"}; helper=${classification.helperModel || "unset"}; general=${classification.generalModel || "unset"}. ${classification.reason} Do not rediscover a method per task or change this policy without an explicit user instruction. If supervised methods are exhausted, ask the user. In long_run continue independent work; stop admission on critical failures, never abort existing workers. ${missionPolicy ? "Mission controls are command-only; team_message cannot override this policy." : 'User-authorized override: team_message({to:"lead", classification:{...}}).'}`)

  // Inline active and recently completed tasks
  const activeTasks = db.query(
    "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'in_progress' ORDER BY time_updated DESC LIMIT 5"
  ).all(teamId) as Array<{ content: string; assignee: string | null }>

  const recentCompleted = db.query(
    "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 3"
  ).all(teamId) as Array<{ content: string; assignee: string | null }>

  if (activeTasks.length > 0) {
    lines.push("Active tasks:")
    for (const t of activeTasks) {
      lines.push(`  [in_progress] ${truncate(t.content, 120)}${t.assignee ? ` → ${t.assignee}` : ""}`)
    }
  }
  if (recentCompleted.length > 0) {
    lines.push("Recently completed:")
    for (const t of recentCompleted) {
      lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` → ${t.assignee}` : ""}`)
    }
  }

  if (pendingMessages.length > 0) {
    lines.push("", "--- Team Messages ---")
    const MAX_MSG = 500
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content)
      if (parsed) {
        // Truncate details for system prompt — full content available via team_results
        const truncatedResult = { ...parsed, details: truncate(parsed.details, 500) }
        lines.push(formatTaskResult(msg.from_name, truncatedResult))
      } else if (msg.content.length > MAX_MSG) {
        lines.push(`[From ${msg.from_name}]: ${msg.content.slice(0, MAX_MSG)}... (use team_results to read full message)`)
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`)
      }
      markDelivered(db, msg.id)
    }
    lines.push("--- End Messages ---")
  }

  // Model selection guidance (only when promptForModels is enabled)
  if (config?.promptForModels && !missionPolicy) {
    const poolOptions = (config.modelPool && config.modelPool.length > 0)
      ? config.modelPool.map(m => `      { label: "${m}", description: "" }`).join(",\n")
      : ""
    lines.push(
      "",
      "MODEL SELECTION:",
      "Before spawning teammates, use the question tool to ask the user about model preferences.",
      "Do NOT spawn any agents until the user confirms their model preference.",
      "Keep descriptions simple and clear — explain what each option means in plain language.",
      "Example question tool call:",
      '  question({ questions: [{ question: "Which AI models should your team agents use?", header: "Agent models", options: [',
      '    { label: "Same as me (Recommended)", description: "Every agent uses the same model I\'m running on. Simplest option — no extra setup needed." },',
      '    { label: "Mix of models", description: "Each agent gets a different model from your configured pool. Useful for getting diverse perspectives on the same problem." },',
      '    { label: "I\'ll choose per agent", description: "You pick the exact model for each agent as I spawn them. Most control, but requires a choice per agent." }',
      "  ]}]})",
    )
    if (poolOptions) {
      lines.push(
        'If user picks "Mix of models", ask which models with multiple: true:',
        "  question({ questions: [{ question: \"Which models should agents rotate through? Pick all that apply.\", header: \"Model pool\", multiple: true, options: [",
        poolOptions,
        "  ]}]})",
      )
    }
    lines.push(
      'If user picks "I\'ll choose per agent", ask for each agent\'s model individually before each team_spawn call.',
      "Pass the chosen model via the model parameter on each team_spawn call.",
    )
  }

  lines.push(
    "",
    "Spawn teammates ONE AT A TIME. Wait for each tool result before spawning the next.",
    "This avoids git worktree contention. Once all are spawned, wait for their messages.",
    "Read-only agents (explore, plan) automatically skip worktree creation.",
    "For other agents that only need to read, pass worktree: false to avoid unnecessary isolation.",
    "",
    "Teammates work asynchronously and message you when done.",
    "Do NOT poll team_status or team_tasks_list repeatedly — wait for messages.",
    "After spawning all teammates, tell the user what you've set up and wait.",
    "When all teammates finish, summarize results and suggest next steps.",
    "",
    "MERGE WORKFLOW:",
    "After a teammate finishes and you shut them down, use team_merge to merge their branch.",
    "Do NOT tell teammates to commit — they handle that themselves.",
    "Do NOT run git merge manually — use team_merge which squash-merges and unstages for you.",
    "team_cleanup will safety-net merge any branches you forgot, but prefer explicit team_merge.",
    "",
    "Before calling team_cleanup, verify teammates have committed their work.",
    "team_shutdown will warn you if a teammate has uncommitted changes.",
    "team_cleanup will block if any worktree has uncommitted changes — merge or commit first.",
    "To permanently delete archived teams, call team_cleanup with purge: [\"team-name\"] or purge: [\"*\"] for all archived teams.",
    "The first purge call is preview-only and deletes nothing.",
    "Use the question tool to ask the user for visible human approval before deleting archived team records or preserved Ensemble branches.",
    "The question must include the exact approval and denial option labels shown in the preview.",
    "Only if the user selects that exact approval option, call team_cleanup again with the same purge value, confirm_purge: true, and the confirm_token from the preview.",
  )

  return lines.join("\n")
}

/**
 * Build the system prompt injected into a teammate's session.
 * Includes role reminder and delivers any pending peer messages.
 */
export function buildTeammateSystemPrompt(db: Database, teamId: string, memberName: string): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const member = db.query("SELECT session_id, report_mode, model, model_variant FROM team_member WHERE team_id = ? AND name = ?").get(teamId, memberName) as { session_id: string; report_mode: string; model: string | null; model_variant: string | null } | null
  const lines = [member?.report_mode === "final_response"
    ? `You are "${memberName}", a teammate in team "${team.name}". Return findings or blockers in your final response, then stop. Ensemble retrieves the candidate for lead review. Do not use team tools or close tasks; preserve your native profile permissions.`
    : `You are "${memberName}", a teammate in team "${team.name}". Use team_message to communicate. You MUST send your results to the lead via team_message as a <task-result> with status, summary and details before stopping.`,
  ]
  if (member?.model) {
    lines.push(`Model identity: ${member.model}, variant ${member.model_variant ?? "default"}, effort ${annotatedEffort({ variant: member.model_variant })}.`)
  }
  if (member?.session_id) {
    const execution = taskExecutionInstructions({ db }, member.session_id)
    if (execution) lines.push(execution)
  }
  if (member?.report_mode !== "final_response") {
    lines.push("On V2, your member tools are called through the execute tool: team_message, team_broadcast, team_tasks_list, team_tasks_add, team_tasks_complete, team_claim, team_results, team_status, team_view, and team_handoff. Do not assume edit or shell permission beyond your profile.")
  }

  // Deliver pending peer messages addressed to this teammate
  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = ? AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId, memberName) as Array<{ id: string; from_name: string; content: string }>

  if (pendingMessages.length > 0) {
    lines.push("", "--- Messages for you ---")
    const MAX_MSG = 500
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content)
      if (parsed) {
        lines.push(formatTaskResult(msg.from_name, { ...parsed, details: truncate(parsed.details, MAX_MSG) }))
      } else if (msg.content.length > MAX_MSG) {
        lines.push(`[From ${msg.from_name}]: ${msg.content.slice(0, MAX_MSG)}... (truncated)`)
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`)
      }
      markDelivered(db, msg.id)
    }
    lines.push("--- End Messages ---")
  }

  return lines.join("\n")
}

/**
 * Build a concise context string for compaction.
 * Includes team name, member statuses, task progress, and role statement.
 */
export function buildTeamCompactionContext(
  db: Database,
  teamId: string,
  role: "lead" | "member",
  memberName?: string,
): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId) as Array<{ name: string; status: string }>

  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status",
  ).all(teamId) as Array<{ status: string; count: number }>

  const countMap: Record<string, number> = {}
  for (const row of taskCounts) {
    countMap[row.status] = row.count
  }

  const completed = countMap.completed ?? 0
  const inProgress = countMap.in_progress ?? 0
  const pending = countMap.pending ?? 0

  const roleLine = role === "lead"
    ? `[Team Context] You are the lead of team "${team.name}".`
    : `[Team Context] You are a teammate named "${memberName}" in team "${team.name}".`

  const memberList = members
    .map((m) => `${m.name} (${STATUS_DISPLAY[m.status] ?? m.status})`)
    .join(", ")

  const membersLine = members.length > 0
    ? `Members: ${memberList}`
    : "Members: none"

  const lines = [
    roleLine,
    membersLine,
    `Tasks: ${completed} completed, ${inProgress} in progress, ${pending} pending`,
  ]
  const classification = getMissionClassification(db, teamId, true)
  const missionPolicy = missionPolicySummary(db, teamId)
  if (missionPolicy) lines.push(missionPolicy)
  if (classification) lines.push(`Persisted ${classification.missionMode ?? "supervised"} mission classification: ${classification.method}; protocol=${classification.protocol ?? "ensemble-task-v1"}; tool=${classification.toolId || "none"}; helper=${classification.helperModel || "unset"}; general=${classification.generalModel || "unset"}; timeoutMs=${classification.timeoutMs}. ${classification.reason} Do not change method per task or without an explicit user instruction.`)

  if (role === "member" && memberName) {
    // Include original task prompt
    const member = db.query("SELECT prompt, report_mode, model, model_variant FROM team_member WHERE team_id = ? AND name = ?")
      .get(teamId, memberName) as { prompt: string | null; report_mode: string; model: string | null; model_variant: string | null } | null
    if (member?.model) lines.push(`Model identity: ${member.model}, variant ${member.model_variant ?? "default"}, effort ${annotatedEffort({ variant: member.model_variant })}.`)
    lines.push(member?.report_mode === "final_response"
      ? "Return findings or blockers in your final response, then stop. Preserve native permissions; the lead reviews and integrates the candidate before closing tasks."
      : "IMPORTANT: You MUST send your results to the lead via team_message as a <task-result> with status, summary and details before stopping.")
    if (member?.prompt) {
      lines.push(`Your original task: ${truncate(member.prompt, 300)}`)
    }

    // Include recent messages involving this member
    const recentMsgs = db.query(
      "SELECT from_name, content FROM team_message WHERE team_id = ? AND (from_name = ? OR to_name = ?) ORDER BY time_created DESC LIMIT 3"
    ).all(teamId, memberName, memberName) as Array<{ from_name: string; content: string }>
    if (recentMsgs.length > 0) {
      lines.push("Recent context:")
      for (const msg of recentMsgs) {
        lines.push(`  [${msg.from_name}]: ${truncate(msg.content, 200)}`)
      }
    }
  } else if (role === "member") {
    lines.push("Follow your persisted reporting mode: a structured team report or a final-response candidate for lead review. Do not assume additional tool permissions.")
  }

  if (role === "lead") {
    lines.push(missionReportingInstructions(`.opencode/missions/${teamId}/reports`))
    // Include recently completed tasks
    const completedTasks = db.query(
      "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 5"
    ).all(teamId) as Array<{ content: string; assignee: string | null }>
    if (completedTasks.length > 0) {
      lines.push("Recently completed:")
      for (const t of completedTasks) {
        lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` (by ${t.assignee})` : ""}`)
      }
    }
  }

  return lines.join("\n")
}
