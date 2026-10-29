import type { ToolDeps } from "./types"
import type { MissionPolicyModel } from "./mission-model-policy"
import type { Plugin } from "@opencode/plugin"
import { prepareMission, openMissionConfiguration, approveMission, getPresentedMission, markMissionPresented, previewMissionTask, type MissionPolicySnapshot } from "./mission-policy"
import { findTeamBySession } from "./types"
import { checkToolIsolation } from "./hooks"
import { pumpTeam } from "./dispatch"
import { classifyBoardTasks } from "./board-classification"
import { applyMissionClassification, classificationReadiness, getMissionClassification } from "./mission-classification"
import { log } from "./log"
import { calibrationWarnings, describeMissionModel } from "./variant-effort"
import { verificationInstructions } from "./verification-policy"
import { missionReportingInstructions } from "./mission-reporting"
import { dirname, join } from "node:path"
import { executionStarts, planningCatalogue } from "./execution-policy"
import { PreparationAdmissionError } from "./preparation-admission"
import { closeMission } from "./mission-close"
import { executePreparation, PREPARATION_SESSION_TITLE, preparationSessionReference, type PreparationPort, type PreparationRunResult, type PreparationRequest } from "./preparation-runtime"

const QA_CONFIG_GUIDANCE = 'Discuss mission QA interactively: light (targeted checks), proportionate (risk-based checks; default), or reinforced (explicit verification plan and independent review). Offer the current/default choice for confirmation, not a new questionnaire per task. Ask only for consequential commands and acceptance criteria. Persist corrections in verification: { level, commands?, acceptance? } before presenting config again. Project safety/mandatory rules cannot be silently waived; surface conflicts for explicit arbitration. Do not impose a fixed QA agent pipeline.'
const AUTONOMY_CONFIG_GUIDANCE = 'When the user requests long_run, persist their general decision priorities in autonomy: { mode: "long_run", instructions: ["user decision priorities"] }, independently of classification. Capture priorities such as quality/fidelity to the plan or fastest correct implementation; do not invent preferences or create a routine questionnaire. Resolve most choices within that mandate, retaining permissions, QA and explicit limits. This draft is not active until user start approves the exact presented revision. To revoke delegation, propose autonomy: { mode: "supervised" }. Do not use classification.missionMode as a substitute for the decision contract.'

/** A generic mission command; project workflows remain in project instructions. */
export interface MissionCommand {
  action: "prepare" | "config" | "start" | "close"
  text: string
  preparation?: Omit<PreparationRequest, "text">
}

function parsePrepareRequest(text: string): MissionCommand {
  let rest = text.slice("prepare".length).trim()
  if (/^--accept(?:\s|$)/.test(rest)) {
    const json = rest.slice("--accept".length).trim()
    if (!json) throw new Error("prepare --accept requires the supervisor JSON")
    if (json.startsWith("--")) throw new Error("prepare --accept and PM options are exclusive")
    return { action: "prepare", text: json, preparation: { kind: "accept" } }
  }
  const preparation: NonNullable<MissionCommand["preparation"]> = { kind: "pm" }
  const seen = new Set<string>()
  while (rest.startsWith("--")) {
    if (/^--(?:\s|$)/.test(rest)) { rest = rest.slice(2).trimStart(); break }
    const flag = rest.match(/^--[\w-]+/)?.[0]
    if (!flag) throw new Error("Unknown prepare option")
    if (seen.has(flag)) throw new Error(`Duplicate prepare option ${flag}`)
    seen.add(flag)
    rest = rest.slice(flag.length).trimStart()
    if (flag === "--accept") throw new Error("prepare --accept and PM options are exclusive")
    if (flag === "--resume") { preparation.resume = true; continue }
    if (!["--pm", "--preplan", "--history", "--before"].includes(flag)) throw new Error(`Unknown prepare option ${flag}`)
    const token = rest.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
    const value = token?.[1] ?? token?.[2] ?? token?.[3]
    if (value === "--accept") throw new Error("prepare --accept and PM options are exclusive")
    if (!token || !value || value.startsWith("--")) throw new Error(`${flag} requires ${flag === "--pm" ? "an agent" : "a value"}`)
    rest = rest.slice(token[0].length).trimStart()
    if (flag === "--pm") preparation.pm = value
    if (flag === "--preplan") preparation.preplan = value
    if (flag === "--before") preparation.before = value
    if (flag === "--history") {
      if (value !== "none" && value !== "fork" && value !== "checkpoint") throw new Error("--history must be none, fork, or checkpoint")
      preparation.history = value
    }
  }
  if (preparation.history === "checkpoint" && !preparation.before) throw new Error("--history checkpoint requires --before <messageID>")
  if (preparation.before && preparation.history !== "checkpoint") throw new Error("--before requires --history checkpoint")
  if (preparation.resume && (preparation.preplan || preparation.history || preparation.before)) throw new Error("--resume cannot replace a frozen preparation dossier")
  return { action: "prepare", text: rest.trim(), preparation }
}

/** Parse the single command namespace without interpreting user preferences. */
export function parseMissionCommand(input: string): MissionCommand {
  const text = input.trim()
  if (!text) throw new Error("Provide a mission objective, config, start, or close")
  if (text === "close") return { action: "close", text: "" }
  if (/^close\s/.test(text)) throw new Error("close accepts no extra arguments; it preserves resources and requires completed tasks and stopped members")
  if (text === "start") return { action: "start", text: "" }
  if (/^start\s/.test(text)) throw new Error("start accepts no extra arguments; configure the proposal first")
  if (text === "config") return { action: "config", text: "" }
  if (/^config\s/.test(text)) return { action: "config", text: text.slice(6).trim() }
  if (text === "prepare" || /^prepare\s/.test(text)) return parsePrepareRequest(text)
  return { action: "prepare", text }
}

type NativeCommandEditor = Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0]

/** Public V2 command definition, including its native prompt/attachment contract. */
export type MissionCommandDefinition = Parameters<NativeCommandEditor["add"]>[0]

/** Native command invocation; the SDK does not authenticate human origin. */
export type MissionCommandInvocation = Parameters<MissionCommandDefinition["execute"]>[0]

/** Disposable public command registration. */
export type MissionCommandRegistration = Awaited<ReturnType<Plugin.Context["command"]["transform"]>>

/** Capability-gated subset of the public V2 command and session APIs. */
export interface MissionCommandHost {
  command?: Pick<Plugin.Context["command"], "transform">
  session: { prompt(input: Parameters<Plugin.Context["session"]["prompt"]>[0]): Promise<unknown> }
}

function formatPreparation(result: PreparationRunResult): string {
  if (result.status === "blocked" || result.status === "incomplete") return [
    `Preparation ${result.status}. No tasks imported; this is not an executable plan.`,
    ...(result.issues ?? []),
    ...result.questions.map(item => `- ${item.id}: ${item.question}`),
    `Current candidate tasks: ${result.candidateTaskCount ?? "unverified"}.`,
    ...(result.validationHistory?.length ? [
      "Historical validation errors (not current blockers):",
      ...result.validationHistory,
      "A schema correction preceded this pause. Compare the complete candidate with earlier PM responses in the native PM session referenced below, especially any removed tasks or newly asserted blockers. Do not infer substantive blockers from a formatting rejection.",
    ] : []),
    "Supervisor review: distinguish facts required to prepare an actionable plan from work and gates to satisfy before execution. Keep genuine blockers; do not declare ready without evidence. Use the native PM session for the complete candidate, not this notification alone.",
    "If the available evidence resolves a misunderstanding, propose a precise /ensemble-mission prepare --resume <clarification>; ask the user only for a genuinely missing decision or authorization. Do not auto-resume or invoke start.",
  ].join("\n")
  if (result.status === "cancelled") return "Preparation stopped because the mission is already approved. No document was imported."
  if (result.status === "exhausted") {
    return [
      "Preparation used the initial reply and five corrections without a valid document.",
      "Issues:",
      result.issues?.join("\n") || "Preparation document is invalid",
      "Last candidate:",
      result.candidate ?? "none",
      "Submit one correction with /ensemble-mission prepare --accept <json>.",
    ].join("\n")
  }
  const questions = result.questions.map(item => `- ${item.id}: ${item.question}`).join("\n")
  const tasks = (result.mapping ?? []).map(item => `- ${item.pmId} → ${item.taskId} (${item.disposition}${item.holdReason ? `: ${item.holdReason}` : ""}; ${item.mode}/${item.kind})`).join("\n")
  const groups = (result.parallelGroups ?? []).map(group => {
    const body = [group.reason.trim(), group.integrationNotes.trim()].filter(part => part.length > 0).join(" ")
    return `- ${group.taskIds.join(", ")} (${group.isolation}): ${body}`.trim()
  })
  const variant = result.model.variant ? ` variant ${result.model.variant}` : ""
  return [
    `Preparation imported for ${result.agent} on ${result.model.id}${variant}.`,
    "Ready for supervisor review; import is not execution approval.",
    "Supervisor questions:",
    questions || "- none",
    "Imported tasks:",
    tasks || "- none",
    ...(groups.length ? ["Parallel groups:", ...groups] : []),
  ].join("\n")
}

function appendSessionReference(text: string, sessionId: string | null | undefined): string {
  const reference = preparationSessionReference(sessionId)
  return reference ? `${text}\n${reference}` : text
}

function preparationAck(sessionID: string): string {
  return appendSessionReference(
    `${PREPARATION_SESSION_TITLE} session was queued. Its result or error will be delivered to this supervisor session when the PM finishes.`,
    sessionID,
  )
}

function storedPreparationSession(deps: ToolDeps, sessionID: string): string | undefined {
  const team = findTeamBySession(deps.db, deps.registry, sessionID)
  if (!team) return undefined
  const row = deps.db.query("SELECT session_id FROM preparation_run WHERE team_id = ?").get(team.teamId) as { session_id: string | null } | undefined
  return row?.session_id ?? undefined
}

function preparationPending(sessionID: string | undefined): string {
  return appendSessionReference([
    `${PREPARATION_SESSION_TITLE} kept the existing session and its history. This prepare did not create, retry, or clone another session.`,
    "The stored preparation record is still open. That record is not a native session status.",
  ].join("\n"), sessionID)
}

async function promptLead(host: MissionCommandHost, input: MissionCommandInvocation, text: string): Promise<void> {
  await host.session.prompt({ ...input.prompt, sessionID: input.sessionID, delivery: input.delivery, text })
}

async function deliverPreparationResult(host: MissionCommandHost, deps: ToolDeps, input: MissionCommandInvocation, result: PreparationRunResult): Promise<void> {
  const text = appendSessionReference(formatPreparation(result), storedPreparationSession(deps, input.sessionID))
  try {
    await promptLead(host, input, text)
  } catch (error) {
    if (result.status !== "imported") throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Preparation remains committed.\n${text}\nDelivery failed: ${reason}`)
  }
}

async function deliverPreparationFailure(host: MissionCommandHost, deps: ToolDeps, input: MissionCommandInvocation, error: unknown, background: boolean): Promise<void> {
  if (!(error instanceof PreparationAdmissionError)) {
    if (!background) throw error
    const text = appendSessionReference(error instanceof Error ? error.message : String(error), storedPreparationSession(deps, input.sessionID))
    await promptLead(host, input, text).catch(failure => { log(`preparation:background ${failure instanceof Error ? failure.message : String(failure)}`) })
    return
  }
  const sessionId = storedPreparationSession(deps, input.sessionID)
  const text = error.code === "running" ? preparationPending(sessionId) : appendSessionReference(error.message, sessionId)
  try {
    await promptLead(host, input, text)
  } catch (failure) {
    if (!background) throw failure
    log(`preparation:background ${failure instanceof Error ? failure.message : String(failure)}`)
  }
}

/** Return once the PM session exists. The later result or error is owned before the ack, so an ack rejection still delivers it once. */
async function deliverPreparation(host: MissionCommandHost, deps: ToolDeps, input: MissionCommandInvocation, command: MissionCommand, preparation: PreparationPort | undefined): Promise<void> {
  const request = command.preparation
  if (!request) return
  if (!preparation) throw new Error("Preparation runtime is not available on this host")
  let settled: { ok: true; result: PreparationRunResult } | { ok: false; error: unknown } | undefined
  let markReady: (sessionID: string) => void = () => undefined
  const ready = new Promise<string>(resolve => { markReady = resolve })
  const completion = executePreparation(deps, input.sessionID, { ...request, text: command.text }, preparation, {
    onReady: notice => markReady(notice.sessionID),
  }).then(
    result => {
      settled = { ok: true, result }
      return result
    },
    (error: unknown) => {
      settled = { ok: false, error }
      throw error
    },
  )
  const outcome = await Promise.race([
    ready.then(sessionID => ({ kind: "ready" as const, sessionID })),
    completion.then(
      result => ({ kind: "done" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
  ])
  if (outcome.kind === "done") {
    await deliverPreparationResult(host, deps, input, outcome.result)
    return
  }
  if (outcome.kind === "error") {
    await deliverPreparationFailure(host, deps, input, outcome.error, false)
    return
  }
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  const current = settled
  if (current?.ok === true) {
    await deliverPreparationResult(host, deps, input, current.result)
    return
  }
  if (current?.ok === false) {
    await deliverPreparationFailure(host, deps, input, current.error, false)
    return
  }
  let posted = false
  const owned = completion.then(
    result => {
      if (posted) return undefined
      posted = true
      return deliverPreparationResult(host, deps, input, result)
    },
    (error: unknown) => {
      if (posted) return undefined
      posted = true
      return deliverPreparationFailure(host, deps, input, error, true)
    },
  ).catch(error => {
    const reason = error instanceof Error ? error.message : String(error)
    log(`preparation:background ${reason}`)
    return promptLead(host, input, appendSessionReference(reason, storedPreparationSession(deps, input.sessionID))).catch(() => undefined)
  })
  void owned
  try {
    await promptLead(host, input, preparationAck(outcome.sessionID))
  } catch (error) {
    log(`preparation:ack ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/** Register the generic mission command on supported V2 hosts. */
export async function registerMissionCommands(host: MissionCommandHost, deps: ToolDeps, availableModels?: () => Promise<readonly MissionPolicyModel[]>, preparation?: PreparationPort, syncPermissions?: (teamId: string) => Promise<void>): Promise<MissionCommandRegistration | undefined> {
  if (!host.command) return undefined
  return host.command.transform(editor => {
    editor.add({
      name: "ensemble-mission",
      description: "Prepare/configure a mission, approve with start, or close completed work without deleting resources.",
      execute: async input => {
        checkToolIsolation(deps.registry, deps.tracker, "team_create", input.sessionID, deps.db)
        const command = parseMissionCommand(input.prompt.text)
        if (command.action === "close") {
          const closed = await closeMission(deps, input.sessionID)
          await host.session.prompt({ ...input.prompt, sessionID: input.sessionID,
            delivery: input.delivery, resume: false,
            text: `Mission ${closed.alreadyClosed ? "already closed" : "closed"}: archived without deleting files, worktrees, branches or history. No tasks cancelled and no worker aborted. Native permission restoration verified where supported.` })
          return
        }
        if (command.action === "prepare" && command.preparation) {
          await deliverPreparation(host, deps, input, command, preparation)
          return
        }
        if (command.action === "prepare") {
          const mission = await prepareMission(deps, input.sessionID, command.text)
          const proposal = openMissionConfiguration(deps, mission.teamId, input.sessionID, true)
          await healDraftClassification(deps, proposal)
          await deliverProposal(host, deps, proposal, { ...input.prompt, sessionID: input.sessionID, delivery: input.delivery,
            text: `${formatProposal(deps, proposal)}\n\nPrepare a bounded plan using this project's instructions. No particular planner profile or agent sequence is required. ${proposal.policy.version !== 1 ? "Default catalogue execution needs no difficulty scores or classifier. Use classification only when explicitly requested." : "Evaluate complexity and risk separately using the mission criteria."} You may publish proposed tasks, but no Ensemble worker or classifier can start before approval. Present the actual policy and task preview to the user; invite chat corrections or the user's /ensemble-mission start command. Do not invoke start on the user's behalf. ${QA_CONFIG_GUIDANCE}\n${AUTONOMY_CONFIG_GUIDANCE}` })
          return
        }
        const team = findTeamBySession(deps.db, deps.registry, input.sessionID)
        if (!team || team.role !== "lead") throw new Error("Only the lead of a prepared mission can use config or start")
        if (command.action === "config") {
          const proposal = openMissionConfiguration(deps, team.teamId, input.sessionID, true)
          await healDraftClassification(deps, proposal)
          const instructions = command.text
            ? `User corrections (not execution approval):\n${command.text}\n\nUpdate only this mission's draft to represent these corrections. Classification corrections belong in a top-level "classification" object of the draft; config applies it and strips it from the policy. Never add fields outside the policy schema (${proposal.policy.version !== 1 ? `version, providers, models, startingIntelligence, classificationBeta, verification${proposal.policy.version === 3 ? ", planningIntelligenceRange" : ""}` : "version, providers, assessment, complexityBands, riskBands, groups, matrix, verification"}). Keep the policy structurally valid and providers, exact native models and variants consistent. Do not change global settings. Explain the diff and ask the user to run /ensemble-mission config again to present the edited policy before start.`
            : "Present this authoritative policy and task preview in the chat. No new execution is admitted until the user runs /ensemble-mission start. Subsequent chat corrections must be written to the mission draft and presented again with config; do not keep them only in context."
          await deliverProposal(host, deps, proposal, { ...input.prompt, sessionID: input.sessionID, delivery: input.delivery, resume: Boolean(command.text), text: `${formatProposal(deps, proposal)}\n\n${instructions}\n${QA_CONFIG_GUIDANCE}\n${AUTONOMY_CONFIG_GUIDANCE}` }, !command.text)
          return
        }
        if (!availableModels) throw new Error("Native model catalogue API unavailable; mission cannot be approved on this host")
        const presented = getPresentedMission(deps, team.teamId, input.sessionID)
        const approved = approveMission(deps, team.teamId, input.sessionID, await availableModels(), presented)
        await syncPermissions?.(approved.teamId)
        if (!presented.approved) {
          void classifyBoardTasks(deps, team.teamId).then(() => pumpTeam(deps, team.teamId)).catch(error => { log(`mission-policy:start-failed ${String(error)}`) })
          void pumpTeam(deps, team.teamId)
        }
        try { await host.session.prompt({ ...input.prompt, sessionID: input.sessionID, delivery: input.delivery,
          resume: !presented.approved,
          text: `Mission policy approved: revision ${approved.revision}, hash ${approved.hash}.\nObjective: ${approved.objective}\nPolicy: ${approved.policyPath}\nContinue the mission using the approved ${approved.policy.version !== 1 ? "catalogue policy; workers choose their implementation reasoning within its bounds" : "grid"} and project verification requirements. Model, variant and provider choices are enforced by Ensemble; use only authorized execution_decisions, not spawn/message overrides. Retain task ownership and integration barriers, and report evidence and limitations.\n${missionReportingInstructions(join(dirname(approved.policyPath), "reports"))}` }) } catch (error) {
          throw new Error(`Mission policy remains approved (v${approved.revision}); supervisor message delivery failed. Check the session/status before explicitly resuming in chat: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
  })
}

async function deliverProposal(host: MissionCommandHost, deps: ToolDeps, proposal: MissionPolicySnapshot, input: Parameters<MissionCommandHost["session"]["prompt"]>[0], present = true): Promise<void> {
  try {
    await host.session.prompt(input)
    if (present) markMissionPresented(deps.db, proposal)
  } catch (error) {
    deps.db.run("UPDATE mission_policy SET presented_hash = NULL, time_updated = MAX(time_updated + 1, ?) WHERE team_id = ? AND time_updated = ? AND presented_hash = ?",
      [Date.now(), proposal.teamId, proposal.presentationToken, proposal.hash])
    throw error
  }
}

/** Apply a classification block extracted from the draft; any failure becomes a draft note. */
async function healDraftClassification(deps: ToolDeps, proposal: MissionPolicySnapshot): Promise<void> {
  if (!proposal.classificationOverride) return
  try {
    const applied = await applyMissionClassification(deps, proposal.teamId, proposal.classificationOverride)
    proposal.warnings.push(`Draft classification applied: method ${applied.method}; general ${applied.generalModel || "unset"}; helper ${applied.helperModel || "unset"}.`)
  } catch (error) {
    proposal.warnings.push(`Draft classification block ignored: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function classificationProposal(deps: ToolDeps, teamId: string): string[] {
  const policy = getMissionClassification(deps.db, teamId)
  if (!policy) return []
  const readiness = classificationReadiness(policy)
  const retries = policy.limits?.retries
  const maxAttempts = policy.limits?.maxAttempts
  return [
    `Classification: method ${policy.method}; helper ${policy.helperModel || "unset"}; general ${policy.generalModel || "unset"}; fallbacks ${policy.fallbacks?.length ?? 0}; retries ${retries ?? "unset"}; maxAttempts ${maxAttempts ?? "unset"}; timeoutMs ${policy.timeoutMs}.`,
    ...(readiness.ready ? [] : [
      `Classification blocked: ${readiness.reason}`,
      "Lift this block by adding a top-level \"classification\" object to the draft (for example {\"mode\":\"general\",\"generalModel\":\"provider/model\"}) and running /ensemble-mission config again; config applies it and strips it from the policy. Setting its mode to off keeps manual scores.",
    ]),
  ]
}

function formatProposal(deps: ToolDeps, proposal: MissionPolicySnapshot): string {
  const { policy } = proposal
  const autonomy = policy.autonomy
    ? [`Proposed autonomy: ${policy.autonomy.mode} (not active until user start).`, ...(policy.autonomy.instructions ?? []).map((instruction, index) => `Decision priority ${index + 1}: ${instruction}`)]
    : ["No decision delegation proposed; legacy classification resilience is not an autonomy contract."]
  if (policy.version !== 1) return [
    "Mission policy proposal — execution is paused, not approved.", `Objective: ${proposal.objective}`,
    `Draft: ${proposal.policyPath}`, `Proposal hash: ${proposal.hash}`,
    `Default planning intelligence threshold: ${policy.startingIntelligence}. Classification is opt-in.`,
    ...(policy.version === 3 ? [
      `Approved planning range: ${policy.planningIntelligenceRange?.min}–${policy.planningIntelligenceRange?.max ?? "unbounded"} (inclusive).`,
      `Explicit planning candidates: ${planningCatalogue(policy).map(model => `${model.id} (${model.reasoningEffort ?? "default"})`).join(", ")}`,
      `Automatic planning candidates: ${executionStarts(policy).map(model => `${model.id} (${model.variant ?? "default"})`).join(", ")}`,
      "The supervisor may choose an explicit planned pair within the range via execution_decisions with a reason, or authorize qualified direct code/mixed/documentation/research from the full catalogue. Planning remains the default; permissions, QA and safety gates still apply.",
    ] : []),
    verificationInstructions(policy.verification),
    ...autonomy,
    missionReportingInstructions(join(dirname(proposal.policyPath), "reports")),
    "Each task keeps the same session and model. The worker chooses its implementation reasoning and may raise or lower it within the approved catalogue.",
    ...policy.models.map(model => `${model.id} (${model.reasoningEffort ?? "default"}): intelligence ${model.intelligenceScore}, cost/task ${model.averageCostPerTask}`),
    ...classificationProposal(deps, proposal.teamId), ...proposal.warnings,
    "Current draft JSON:", "```json", JSON.stringify(policy, null, 2), "```",
  ].join("\n")
  const band = (bounds: number[], index: number): string => `${bounds[index]}–${(bounds[index + 1] ?? 101) - 1}`
  const cells = [
    `| Risk / complexity | ${policy.complexityBands.slice(0, -1).map((_, index) => band(policy.complexityBands, index)).join(" | ")} |`,
    `|---|${policy.complexityBands.slice(0, -1).map(() => "---").join("|")}|`,
    ...policy.matrix.map((groups, index) => `| ${band(policy.riskBands, index)} | ${groups.join(" | ")} |`),
  ]
  const groups = Object.entries(policy.groups).map(([name, models]) => `${name}: ${models.map(model => describeMissionModel(model)).join(" → ")}`)
  const calibration = calibrationWarnings(policy)
  const tasks = deps.db.query("SELECT id, content FROM team_task WHERE team_id = ? AND status IN ('pending', 'blocked') ORDER BY time_created, id LIMIT 50").all(proposal.teamId) as Array<{ id: string; content: string }>
  const taskPreview = tasks.map(task => {
    try {
      const route = previewMissionTask(deps.db, proposal, task.id)
      return `${task.id}: ${task.content.slice(0, 160)} | complexity ${route.complexity}, risk ${route.risk} | ${route.group} | ${describeMissionModel(route.selected)}`
    } catch (error) { return `${task.id}: BLOCKED — ${error instanceof Error ? error.message : String(error)}` }
  })
  return [
    "Mission policy proposal — execution is paused, not approved.", `Objective: ${proposal.objective}`,
    `Draft: ${proposal.policyPath}`, `Proposal hash: ${proposal.hash}`, `Allowed providers: ${policy.providers.join(", ")}`,
    ...proposal.warnings.map(warning => `Draft repair: ${warning}`),
    verificationInstructions(policy.verification),
    ...autonomy,
    missionReportingInstructions(join(dirname(proposal.policyPath), "reports")),
    "Risk and complexity remain independent integers 0–100. The first candidate is primary; alternatives are not automatic retries.",
    ...cells, ...groups, ...calibration,
    "Assessment criteria:", `Complexity: ${policy.assessment.complexity.join(" → ")}`, `Risk: ${policy.assessment.risk.join(" → ")}`,
    ...classificationProposal(deps, proposal.teamId),
    ...(taskPreview.length ? ["Task preview (same resolver as admission; at most 50 queued tasks):", ...taskPreview] : []),
    "Current draft JSON:", "```json", JSON.stringify(policy, null, 2), "```",
  ].join("\n")
}
