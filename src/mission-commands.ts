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
import { executePreparation, type PreparationPort, type PreparationRunResult } from "./preparation-runtime"

const QA_CONFIG_GUIDANCE = 'Discuss mission QA interactively: light (targeted checks), proportionate (risk-based checks; default), or reinforced (explicit verification plan and independent review). Offer the current/default choice for confirmation, not a new questionnaire per task. Ask only for consequential commands and acceptance criteria. Persist corrections in verification: { level, commands?, acceptance? } before presenting config again. Project safety/mandatory rules cannot be silently waived; surface conflicts for explicit arbitration. Do not impose a fixed QA agent pipeline.'

/** A generic mission command; project workflows remain in project instructions. */
export interface MissionCommand {
  action: "prepare" | "config" | "start"
  text: string
  preparation?: { kind: "pm" | "accept"; pm?: string }
}

function parsePrepareRequest(text: string): MissionCommand {
  const rest = text.slice("prepare".length).trim()
  const tokens = rest.split(/\s+/).filter(token => token.length > 0)
  const acceptAt = tokens.indexOf("--accept")
  const pmAt = tokens.indexOf("--pm")
  if (acceptAt >= 0 && pmAt >= 0) throw new Error("prepare --pm and prepare --accept are exclusive")
  if (acceptAt === 0) {
    const json = rest.slice("--accept".length).trim()
    if (!json) throw new Error("prepare --accept requires the supervisor JSON")
    return { action: "prepare", text: json, preparation: { kind: "accept" } }
  }
  if (pmAt === 0) {
    const pm = tokens[1]
    const mandate = tokens.slice(2).join(" ")
    if (!pm || pm.startsWith("--") || !mandate) throw new Error("prepare --pm requires an agent and a mandate")
    return { action: "prepare", text: mandate, preparation: { kind: "pm", pm } }
  }
  if (!rest) throw new Error("prepare requires a mandate")
  return { action: "prepare", text: rest, preparation: { kind: "pm" } }
}

/** Parse the single command namespace without interpreting user preferences. */
export function parseMissionCommand(input: string): MissionCommand {
  const text = input.trim()
  if (!text) throw new Error("Provide a mission objective, config, or start")
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
  if (result.status === "cancelled") return "Preparation stopped because the mission is already approved. No document was imported."
  if (result.status === "exhausted") return "Preparation used the initial reply and five corrections without a valid document. Submit one correction with /ensemble-mission prepare --accept <json>."
  const questions = result.questions.map(item => `- ${item.id}: ${item.question}`).join("\n")
  const tasks = (result.mapping ?? []).map(item => `- ${item.pmId} → ${item.taskId}`).join("\n")
  return [`Preparation imported for ${result.agent} on ${result.model.id}.`, "Supervisor questions:", questions || "- none", "Imported tasks:", tasks || "- none"].join("\n")
}

async function deliverPreparation(host: MissionCommandHost, deps: ToolDeps, input: MissionCommandInvocation, command: MissionCommand, preparation: PreparationPort | undefined): Promise<void> {
  const request = command.preparation
  if (!request) return
  if (!preparation) throw new Error("Preparation runtime is not available on this host")
  try {
    const result = await executePreparation(deps, input.sessionID, { kind: request.kind, text: command.text, ...(request.pm ? { pm: request.pm } : {}) }, preparation)
    await host.session.prompt({ ...input.prompt, sessionID: input.sessionID, delivery: input.delivery, text: formatPreparation(result) })
  } catch (error) {
    if (!(error instanceof PreparationAdmissionError)) throw error
    await host.session.prompt({ ...input.prompt, sessionID: input.sessionID, delivery: input.delivery, text: error.message })
  }
}

/** Register the generic mission command on supported V2 hosts. */
export async function registerMissionCommands(host: MissionCommandHost, deps: ToolDeps, availableModels?: () => Promise<readonly MissionPolicyModel[]>, preparation?: PreparationPort): Promise<MissionCommandRegistration | undefined> {
  if (!host.command) return undefined
  return host.command.transform(editor => {
    editor.add({
      name: "ensemble-mission",
      description: "Prepare a mission, configure providers/models in chat, then explicitly approve with start.",
      execute: async input => {
        checkToolIsolation(deps.registry, deps.tracker, "team_create", input.sessionID, deps.db)
        const command = parseMissionCommand(input.prompt.text)
        if (command.action === "prepare" && command.preparation) {
          await deliverPreparation(host, deps, input, command, preparation)
          return
        }
        if (command.action === "prepare") {
          const mission = await prepareMission(deps, input.sessionID, command.text)
          const proposal = openMissionConfiguration(deps, mission.teamId, input.sessionID, true)
          await healDraftClassification(deps, proposal)
          await deliverProposal(host, deps, proposal, { ...input.prompt, sessionID: input.sessionID, delivery: input.delivery,
            text: `${formatProposal(deps, proposal)}\n\nPrepare a bounded plan using this project's instructions. No particular planner profile or agent sequence is required. ${proposal.policy.version !== 1 ? "Default catalogue execution needs no difficulty scores or classifier. Use classification only when explicitly requested." : "Evaluate complexity and risk separately using the mission criteria."} You may publish proposed tasks, but no Ensemble worker or classifier can start before approval. Present the actual policy and task preview to the user; invite chat corrections or the user's /ensemble-mission start command. Do not invoke start on the user's behalf. ${QA_CONFIG_GUIDANCE}` })
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
          await deliverProposal(host, deps, proposal, { ...input.prompt, sessionID: input.sessionID, delivery: input.delivery, resume: Boolean(command.text), text: `${formatProposal(deps, proposal)}\n\n${instructions}\n${QA_CONFIG_GUIDANCE}` }, !command.text)
          return
        }
        if (!availableModels) throw new Error("Native model catalogue API unavailable; mission cannot be approved on this host")
        const presented = getPresentedMission(deps, team.teamId, input.sessionID)
        const approved = approveMission(deps, team.teamId, input.sessionID, await availableModels(), presented)
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
    missionReportingInstructions(join(dirname(proposal.policyPath), "reports")),
    "Risk and complexity remain independent integers 0–100. The first candidate is primary; alternatives are not automatic retries.",
    ...cells, ...groups, ...calibration,
    "Assessment criteria:", `Complexity: ${policy.assessment.complexity.join(" → ")}`, `Risk: ${policy.assessment.risk.join(" → ")}`,
    ...classificationProposal(deps, proposal.teamId),
    ...(taskPreview.length ? ["Task preview (same resolver as admission; at most 50 queued tasks):", ...taskPreview] : []),
    "Current draft JSON:", "```json", JSON.stringify(policy, null, 2), "```",
  ].join("\n")
}
