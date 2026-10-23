import { readFileSync } from "node:fs"
import type { Database } from "./db"
import { createExecutionPolicy, nativeExecutionCatalogue, planningCatalogue, validateExecutionPolicy, type ExecutionPolicy } from "./execution-policy"
import type { MissionPolicyModel } from "./mission-model-policy"
import { prepareMission } from "./mission-policy"
import type { RoutingModel } from "./model-router"
import { admitPreparationAgent, declaredPreparationAgents, PreparationAdmissionError, resolvePreparationAgent } from "./preparation-admission"
import { parsePreparationDocument, PreparationDocumentError } from "./preparation-document"
import { importPreparationDocument, type PreparationImportResult } from "./preparation-import"
import { PREPARATION_JSON_FALLBACK, PREPARATION_PM_INSTRUCTIONS } from "./preparation-instructions"
import { findTeamBySession, type ToolDeps } from "./types"
import { generateId } from "./util"

/** Public prompt payload. No structured-output field is added. */
export interface PreparationPromptCall {
  sessionID: string
  text: string
  delivery: "queue"
  metadata?: Record<string, unknown>
}

/** Host operations for one bounded preparation run. */
export interface PreparationPort {
  hooksReady: boolean
  confirmedStructuredOutput?: { prompt(input: PreparationPromptCall): Promise<unknown> }
  probeAgent(agent: string): Promise<"available" | "unavailable">
  describeAgent(agent: string): Promise<{ readOnly: boolean; permissions: readonly string[] }>
  nativeModels(): Promise<readonly MissionPolicyModel[]>
  createSession(input: { title: string; directory: string }): Promise<{ id: string }>
  switchAgent(input: { sessionID: string; agent: string }): Promise<void>
  switchModel(input: { sessionID: string; providerID: string; modelID: string; variant?: string }): Promise<void>
  prompt(input: PreparationPromptCall): Promise<unknown>
  wait(input: { sessionID: string }): Promise<void>
  readAssistant(input: { sessionID: string }): Promise<string>
  abort(input: { sessionID: string }): Promise<void>
}

/** Explicit prepare request after command parsing. */
export interface PreparationRequest {
  kind: "pm" | "accept"
  text: string
  pm?: string
}

/** Result returned to the lead command. */
export interface PreparationRunResult {
  teamId: string
  status: "imported" | "exhausted" | "cancelled"
  questions: Array<{ id: string; question: string }>
  mapping?: Array<{ pmId: string; taskId: string }>
  model: { id: string; variant?: string }
  agent: string
}

interface RunRow {
  id: string
  team_id: string
  session_id: string | null
  agent: string
  model_id: string
  variant: string | null
  status: "running" | "exhausted" | "imported" | "cancelled"
  supervisor_used: number
}

interface ContextRow {
  session_id: string | null
  status: string
  team_id: string
  approved_hash: string | null
  open_questions_json: string | null
}

const PREPARATION_ATTEMPTS = 6

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function modelPair(id: string, variant?: string | null): { id: string; variant?: string } {
  return variant ? { id, variant } : { id }
}

function nativeVariant(model: RoutingModel): string | undefined {
  return model.reasoningEffort && model.reasoningEffort !== "default" ? model.reasoningEffort : undefined
}

function compareEnvelope(left: RoutingModel, right: RoutingModel): number {
  return left.averageCostPerTask - right.averageCostPerTask
    || right.intelligenceScore - left.intelligenceScore
    || left.id.localeCompare(right.id)
    || (left.reasoningEffort ?? "default").localeCompare(right.reasoningEffort ?? "default")
}

function envelopeModels(policy: ExecutionPolicy): RoutingModel[] {
  const planned = planningCatalogue(policy)
  if (policy.version === 3) return planned
  return planned.filter(model => model.intelligenceScore >= policy.startingIntelligence)
}

function modelIdentity(id: string): { providerID: string; modelID: string } {
  const slash = id.indexOf("/")
  if (slash <= 0 || slash === id.length - 1) {
    throw new PreparationAdmissionError("model", `Preparatory model ${id} is outside the approved envelope`)
  }
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown
      } catch {
        // The fenced or surrounding reply is still not one JSON object.
      }
    }
    throw new PreparationDocumentError(["Preparation document must be one JSON object"])
  }
}

function openingPrompt(mandate: string, readOnly: boolean): string {
  return [
    PREPARATION_PM_INSTRUCTIONS,
    PREPARATION_JSON_FALLBACK,
    readOnly
      ? "This preparation session is read-only. Do not write files or run mutating commands."
      : "Stay inside the selected native profile and its existing permissions.",
    `Mandate:\n${mandate}`,
  ].join("\n\n")
}

function correctionPrompt(mandate: string, issue: string): string {
  return [
    "The previous preparation document was rejected.",
    issue,
    PREPARATION_JSON_FALLBACK,
    `Mandate:\n${mandate}`,
  ].join("\n\n")
}

function runStatusError(status: string): PreparationAdmissionError {
  if (status === "imported") return new PreparationAdmissionError("imported", "A preparation document was already imported")
  if (status === "exhausted") return new PreparationAdmissionError("exhausted", "Preparation corrections are exhausted; submit one supervisor document with prepare --accept")
  return new PreparationAdmissionError("running", "A preparation session is already running")
}

function loadRun(db: Database, teamId: string): RunRow | undefined {
  return db.query("SELECT id, team_id, session_id, agent, model_id, variant, status, supervisor_used FROM preparation_run WHERE team_id = ?").get(teamId) as RunRow | undefined
}

function missionApproved(db: Database, teamId: string): boolean {
  const row = db.query("SELECT approved_hash FROM mission_policy WHERE team_id = ?").get(teamId) as { approved_hash: string | null } | undefined
  return Boolean(row?.approved_hash)
}

function lateApproval(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Initial preparation import must happen before mission start")
}

function supervisorQuestions(raw: string): string | undefined {
  try {
    const questions = JSON.parse(raw) as Array<{ id?: unknown; question?: unknown }>
    if (!Array.isArray(questions)) return undefined
    const lines = questions.flatMap(item => typeof item.id === "string" && typeof item.question === "string" ? [`- ${item.id}: ${item.question}`] : [])
    return lines.length ? `Supervisor questions:\n${lines.join("\n")}` : undefined
  } catch {
    return undefined
  }
}

function importedResult(teamId: string, agent: string, model: { id: string; variant?: string }, imported: PreparationImportResult): PreparationRunResult {
  return {
    teamId,
    status: "imported",
    agent,
    model,
    questions: imported.openQuestions.map(item => ({ id: item.id, question: item.question })),
    mapping: imported.mapping.map(item => ({ pmId: item.pmId, taskId: item.taskId })),
  }
}

function persistedExecutionPolicy(deps: ToolDeps, teamId: string): ExecutionPolicy | undefined {
  const row = deps.db.query("SELECT policy_path FROM mission_policy WHERE team_id = ?").get(teamId) as { policy_path: string } | undefined
  if (!row) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(row.policy_path, "utf8")) as unknown
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const version = (parsed as { version?: unknown }).version
  if (version !== 2 && version !== 3) return undefined
  validateExecutionPolicy(parsed)
  return parsed
}

function preparationPolicy(deps: ToolDeps, teamId: string | undefined, native: readonly MissionPolicyModel[]): ExecutionPolicy {
  if (teamId) {
    const persisted = persistedExecutionPolicy(deps, teamId)
    if (persisted) return persisted
  }
  try {
    return createExecutionPolicy(
      nativeExecutionCatalogue(deps.config.modelRouting.models, native),
      deps.config.startingIntelligence,
      deps.config.modelRouting.beta,
      deps.config.planningIntelligenceRange,
    )
  } catch (error) {
    throw new PreparationAdmissionError("model", `No preparatory model remains in the approved envelope (${messageOf(error)})`)
  }
}

async function probe(port: PreparationPort, agent: string): Promise<"available" | "unavailable"> {
  try {
    return await port.probeAgent(agent)
  } catch (error) {
    throw new PreparationAdmissionError("transport", messageOf(error))
  }
}

async function admitNativePm(deps: ToolDeps, request: PreparationRequest, port: PreparationPort): Promise<{ agent: string; readOnly: boolean }> {
  const profiles = deps.config.businessProfiles
  const requested = request.pm?.trim()
  const declared = requested ? [requested] : declaredPreparationAgents(profiles)
  const available: string[] = []
  for (const candidate of declared) {
    const status = await probe(port, candidate)
    if (status === "available") available.push(candidate)
  }
  const agent = resolvePreparationAgent({ ...(requested ? { requested } : {}), profiles, nativeAgents: available })
  let facts: { readOnly: boolean; permissions: readonly string[] }
  try {
    facts = await port.describeAgent(agent)
  } catch (error) {
    throw new PreparationAdmissionError("transport", messageOf(error))
  }
  const admitted = admitPreparationAgent({
    requested: agent,
    profiles,
    nativeAgents: available,
    readOnly: facts.readOnly,
    permissions: facts.permissions,
  })
  return { agent: admitted.agent, readOnly: admitted.readOnly }
}

async function nativeCatalogue(port: PreparationPort): Promise<readonly MissionPolicyModel[]> {
  try {
    return await port.nativeModels()
  } catch (error) {
    throw new PreparationAdmissionError("transport", messageOf(error))
  }
}

function claimRun(deps: ToolDeps, teamId: string, agent: string, model: { id: string; variant?: string }, mandate: string): string {
  const current = loadRun(deps.db, teamId)
  if (current && current.status !== "cancelled") throw runStatusError(current.status)
  if (current?.status === "cancelled") deps.db.run("DELETE FROM preparation_run WHERE id = ? AND status = 'cancelled'", [current.id])
  const now = Date.now()
  const id = generateId("prun")
  try {
    deps.db.run(`INSERT INTO preparation_run (
      id, team_id, session_id, agent, model_id, variant, mandate, status, attempts,
      supervisor_used, candidate_json, errors_json, time_created, time_updated
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'running', 0, 0, ?, '[]', ?, ?)`, [
      id, teamId, agent, model.id, model.variant ?? null, mandate, JSON.stringify(model), now, now,
    ])
  } catch (error) {
    if (!(error instanceof Error) || !/UNIQUE constraint failed/i.test(error.message)) throw error
    const raced = loadRun(deps.db, teamId)
    throw runStatusError(raced?.status ?? "running")
  }
  return id
}

async function cancelRun(deps: ToolDeps, port: PreparationPort, runId: string, sessionId: string, teamId: string, agent: string, model: { id: string; variant?: string }): Promise<PreparationRunResult> {
  await port.abort({ sessionID: sessionId })
  deps.db.run("UPDATE preparation_run SET status = 'cancelled', time_updated = ? WHERE id = ?", [Date.now(), runId])
  return { teamId, status: "cancelled", questions: [], agent, model }
}

async function importReply(deps: ToolDeps, port: PreparationPort, runId: string, sessionId: string, teamId: string, agent: string, model: { id: string; variant?: string }, policy: ExecutionPolicy, reply: string): Promise<PreparationRunResult | undefined> {
  if (missionApproved(deps.db, teamId)) return cancelRun(deps, port, runId, sessionId, teamId, agent, model)
  try {
    const document = parsePreparationDocument(parseJson(reply))
    if (missionApproved(deps.db, teamId)) return cancelRun(deps, port, runId, sessionId, teamId, agent, model)
    const imported = importPreparationDocument(deps.db, teamId, document, policy)
    const saved = deps.db.run("UPDATE preparation_run SET status = 'imported', time_updated = ? WHERE id = ? AND status = 'running'", [Date.now(), runId])
    if (saved.changes !== 1) {
      if (missionApproved(deps.db, teamId)) return cancelRun(deps, port, runId, sessionId, teamId, agent, model)
      throw new PreparationAdmissionError("imported", "A preparation document was already imported")
    }
    return importedResult(teamId, agent, model, imported)
  } catch (error) {
    if (lateApproval(error) || missionApproved(deps.db, teamId)) return cancelRun(deps, port, runId, sessionId, teamId, agent, model)
    if (error instanceof PreparationDocumentError) return undefined
    throw error
  }
}

async function boundedLoop(deps: ToolDeps, port: PreparationPort, runId: string, sessionId: string, teamId: string, agent: string, model: { id: string; variant?: string }, policy: ExecutionPolicy, mandate: string, readOnly: boolean): Promise<PreparationRunResult> {
  const issues: string[] = []
  for (const attempt of [1, 2, 3, 4, 5, 6] as const) {
    const text = attempt === 1 ? openingPrompt(mandate, readOnly) : correctionPrompt(mandate, issues[issues.length - 1] ?? "Preparation document is invalid")
    deps.db.run("UPDATE preparation_run SET attempts = ?, errors_json = ?, time_updated = ? WHERE id = ?", [attempt, JSON.stringify(issues), Date.now(), runId])
    await port.prompt({ sessionID: sessionId, text, delivery: "queue" })
    await port.wait({ sessionID: sessionId })
    const reply = await port.readAssistant({ sessionID: sessionId })
    const imported = await importReply(deps, port, runId, sessionId, teamId, agent, model, policy, reply)
    if (imported) return imported
    const latest = issues.length
    if (issues.length === latest) {
      try {
        parsePreparationDocument(parseJson(reply))
      } catch (error) {
        issues.push(error instanceof PreparationDocumentError ? error.message : messageOf(error))
      }
    }
    if (attempt === PREPARATION_ATTEMPTS) break
  }
  deps.db.run("UPDATE preparation_run SET status = 'exhausted', attempts = ?, errors_json = ?, time_updated = ? WHERE id = ? AND status = 'running'", [PREPARATION_ATTEMPTS, JSON.stringify(issues), Date.now(), runId])
  return { teamId, status: "exhausted", questions: [], agent, model }
}

async function acceptPreparation(deps: ToolDeps, sessionId: string, request: PreparationRequest, port: PreparationPort): Promise<PreparationRunResult> {
  if (!port.hooksReady) throw new PreparationAdmissionError("hooks", "Preparation hooks are not ready")
  const team = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!team || team.role !== "lead") throw new PreparationAdmissionError("lead", "Only the mission lead can accept a preparation document")
  const run = loadRun(deps.db, team.teamId)
  if (!run || run.status !== "exhausted" || run.supervisor_used) {
    throw new PreparationAdmissionError("accept", "prepare --accept is available once, after the initial reply and five PM corrections")
  }
  if (missionApproved(deps.db, team.teamId)) throw new PreparationAdmissionError("approved", "This mission is already approved")
  const native = await nativeCatalogue(port)
  const policy = preparationPolicy(deps, team.teamId, native)
  const model = modelPair(run.model_id, run.variant)
  let imported: PreparationImportResult
  try {
    imported = importPreparationDocument(deps.db, team.teamId, parseJson(request.text), policy)
  } catch (error) {
    if (lateApproval(error) || missionApproved(deps.db, team.teamId)) {
      return { teamId: team.teamId, status: "cancelled", questions: [], agent: run.agent, model }
    }
    throw error
  }
  const saved = deps.db.run("UPDATE preparation_run SET status = 'imported', supervisor_used = 1, time_updated = ? WHERE id = ? AND status = 'exhausted' AND supervisor_used = 0", [Date.now(), run.id])
  if (saved.changes !== 1) throw new PreparationAdmissionError("accept", "prepare --accept was already used for this mission")
  return importedResult(team.teamId, run.agent, model, imported)
}

/** Choose the preparatory model from the applicable envelope and the native catalogue. */
export function selectPreparationModel(policy: unknown, native: readonly MissionPolicyModel[]): { id: string; variant?: string } {
  let execution: ExecutionPolicy
  try {
    validateExecutionPolicy(policy)
    execution = policy
  } catch (error) {
    throw new PreparationAdmissionError("model", `Preparation model is outside the approved envelope (${messageOf(error)})`)
  }
  const selected = [...envelopeModels(execution)].sort(compareEnvelope).map(model => modelPair(model.id, nativeVariant(model))).find(pair => native.some(candidate => candidate.id === pair.id && candidate.variant === pair.variant))
  if (!selected) throw new PreparationAdmissionError("model", "No native preparatory model remains in the approved envelope")
  return selected
}

/** Run admission, the bounded PM loop, or the one supervisor correction. */
export async function executePreparation(deps: ToolDeps, sessionId: string, request: PreparationRequest, port: PreparationPort): Promise<PreparationRunResult> {
  if (request.kind === "accept") return acceptPreparation(deps, sessionId, request, port)
  if (!port.hooksReady) throw new PreparationAdmissionError("hooks", "Preparation hooks are not ready")
  const admitted = await admitNativePm(deps, request, port)
  const existing = findTeamBySession(deps.db, deps.registry, sessionId)
  if (existing && existing.role !== "lead") throw new PreparationAdmissionError("lead", "Only the mission lead can run preparation")
  if (existing && missionApproved(deps.db, existing.teamId)) throw new PreparationAdmissionError("approved", "This mission is already approved")
  const existingRun = existing ? loadRun(deps.db, existing.teamId) : undefined
  if (existingRun && existingRun.status !== "cancelled") throw runStatusError(existingRun.status)
  const native = await nativeCatalogue(port)
  const policy = preparationPolicy(deps, existing?.teamId, native)
  const model = selectPreparationModel(policy, native)
  const teamId = existing?.teamId ?? (await prepareMission(deps, sessionId, request.text)).teamId
  const runId = claimRun(deps, teamId, admitted.agent, model, request.text)
  let createdId: string | undefined
  try {
    const created = await port.createSession({ title: "Ensemble preparation", directory: deps.directory })
    createdId = created.id
    deps.db.run("UPDATE preparation_run SET session_id = ?, time_updated = ? WHERE id = ?", [created.id, Date.now(), runId])
    await port.switchAgent({ sessionID: created.id, agent: admitted.agent })
    const identity = modelIdentity(model.id)
    await port.switchModel({
      sessionID: created.id,
      providerID: identity.providerID,
      modelID: identity.modelID,
      ...(model.variant ? { variant: model.variant } : {}),
    })
  } catch (error) {
    if (createdId) await port.abort({ sessionID: createdId }).catch(() => undefined)
    deps.db.run("DELETE FROM preparation_run WHERE id = ? AND status = 'running'", [runId])
    throw error
  }
  if (!createdId) throw new PreparationAdmissionError("transport", "Preparation session was not created")
  return boundedLoop(deps, port, runId, createdId, teamId, admitted.agent, model, policy, request.text, admitted.readOnly)
}

/** Contract text for a preparation session or its lead, omitted after approval. */
export function preparationContextText(db: Database, sessionId: string): string | undefined {
  const row = db.query(`SELECT r.session_id, r.status, r.team_id, p.approved_hash, i.open_questions_json
    FROM preparation_run r
    JOIN mission_policy p ON p.team_id = r.team_id
    LEFT JOIN preparation_import i ON i.team_id = r.team_id
    WHERE r.session_id = ? OR r.team_id IN (SELECT id FROM team WHERE lead_session_id = ? AND status = 'active')
    ORDER BY r.time_updated DESC LIMIT 1`).get(sessionId, sessionId) as ContextRow | undefined
  if (!row || row.status === "cancelled" || row.approved_hash) return undefined
  if (row.session_id === sessionId && (row.status === "running" || row.status === "exhausted" || row.status === "imported")) return PREPARATION_PM_INSTRUCTIONS
  if (row.status !== "imported" || !row.open_questions_json) return undefined
  const lead = db.query("SELECT id FROM team WHERE id = ? AND lead_session_id = ? AND status = 'active'").get(row.team_id, sessionId) as { id: string } | undefined
  return lead ? supervisorQuestions(row.open_questions_json) : undefined
}
