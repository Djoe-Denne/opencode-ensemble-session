import { readFileSync, realpathSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve } from "node:path"
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

const PREPARATION_INPUT_TEXT_LIMIT = 40000
const PREPARATION_PREPLAN_BYTE_LIMIT = PREPARATION_INPUT_TEXT_LIMIT * 4

function assertPreparationInputLength(field: string, text: string): void {
  if (text.length > PREPARATION_INPUT_TEXT_LIMIT) {
    throw new PreparationAdmissionError("mandate", `${field}: Ensemble input limit is ${PREPARATION_INPUT_TEXT_LIMIT} characters; received ${text.length}. Native fork history is not counted.`)
  }
}

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
  assertCapabilities(): Promise<void>
  probeAgent(agent: string): Promise<"available" | "unavailable">
  describeAgent(agent: string): Promise<{ readOnly: boolean; permissions: readonly string[] }>
  nativeModels(): Promise<readonly MissionPolicyModel[]>
  createSession(input: { title: string; directory: string; parentID: string; agent: string; history?: "none" | "fork" | "checkpoint"; before?: string }): Promise<{ id: string }>
  /** Replace permissions inherited from the parent with the PM agent's own rules. */
  replacePermissions(input: { sessionID: string; agent: string }): Promise<void>
  switchAgent(input: { sessionID: string; agent: string }): Promise<void>
  switchModel(input: { sessionID: string; providerID: string; modelID: string; variant?: string }): Promise<void>
  prompt(input: PreparationPromptCall): Promise<unknown>
  wait(input: { sessionID: string; signal: AbortSignal }): Promise<void>
  readAssistant(input: { sessionID: string }): Promise<string>
  abort(input: { sessionID: string }): Promise<void>
  /** Registered tools and native rules are not proof of a session-filtered catalogue. */
  inspectTools?(input: { sessionID: string; agent: string }): Promise<PreparationToolEvidence>
}

/** Observable preflight layers; the effective Code Mode catalogue is checked inside the PM. */
export interface PreparationToolEvidence {
  effectiveCatalogue: "unverified"
  registered: Array<{ id: string; action: string; permission: "allow" | "deny" | "ask" | "unverified" }>
  servers: Array<{ name: string; status: string }>
  issues: string[]
}

/** Native title of the preparatory PM session. */
export const PREPARATION_SESSION_TITLE = "Ensemble preparation PM"

/**
 * Supervisor-facing reference for one existing preparation PM session.
 * An exact native id (`ses_` plus 26 alphanumerics) is returned as its own inline code span.
 * Any other id is not promoted to that button form. An absent id returns undefined.
 */
export function preparationSessionReference(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined
  if (/^ses_[0-9A-Za-z]{26}$/.test(sessionId)) {
    return [
      "Existing preparation PM session.",
      "Tracked preparation state is not a native session status.",
      "In this current reply, reproduce the session ID as its own inline code span containing exactly the ID and no other characters:",
      `\`${sessionId}\``,
    ].join("\n")
  }
  if (/ses_[0-9A-Za-z]{26}/.test(sessionId)) return undefined
  return [
    "Existing preparation PM session.",
    "Tracked preparation state is not a native session status.",
    `Preparation PM session id: ${sessionId}`,
  ].join("\n")
}

/** Fires once the PM prompt is queued, before the host wait. */
export interface PreparationObserver {
  onReady?(notice: { sessionID: string }): void
}

/** Explicit prepare request after command parsing. */
export interface PreparationRequest {
  kind: "pm" | "accept"
  text: string
  pm?: string
  preplan?: string
  history?: "none" | "fork" | "checkpoint"
  before?: string
  resume?: boolean
}

/** Result returned to the lead command. */
export interface PreparationRunResult {
  teamId: string
  status: "imported" | "exhausted" | "cancelled" | "blocked" | "incomplete"
  questions: Array<{ id: string; question: string }>
  mapping?: PreparationImportResult["mapping"]
  parallelGroups?: PreparationImportResult["parallelGroups"]
  model: { id: string; variant?: string }
  agent: string
  issues?: string[]
  candidate?: string
  candidateTaskCount?: number
  validationHistory?: string[]
}

interface RunRow {
  id: string
  team_id: string
  session_id: string | null
  agent: string
  model_id: string
  variant: string | null
  mandate: string
  status: "running" | "exhausted" | "imported" | "cancelled"
  supervisor_used: number
  candidate_json: string | null
  errors_json: string | null
  dossier_json: string | null
  dossier_hash: string | null
  readiness: "ready" | "blocked" | "incomplete" | null
  preflight_json: string | null
  resume_notes_json: string | null
}

interface ContextRow {
  session_id: string | null
  status: string
  team_id: string
  mandate: string | null
  candidate_json: string | null
  errors_json: string | null
  approved_hash: string | null
  open_questions_json: string | null
  parallel_groups_json: string | null
  dossier_json: string | null
  dossier_hash: string | null
  preflight_json: string | null
  resume_notes_json: string | null
}

const PREPARATION_ATTEMPTS = 6
const NO_ASSISTANT_REPLY = "Preparation received no new assistant reply"
const activePreparationLoops = new Set<string>()

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

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Parse one JSON document, or the single fenced block that contains it. Prose around a bare object is rejected. */
function parseJson(text: string): unknown {
  const trimmed = text.trim()
  const whole = tryParse(trimmed)
  if (whole !== undefined) return whole
  const fence = trimmed.match(/```(?:json)?[^\n]*\n([\s\S]*?)\n```/)
  const fenced = fence?.[1] ? tryParse(fence[1].trim()) : undefined
  if (fenced !== undefined) return fenced
  throw new PreparationDocumentError(["Preparation document must be one JSON object"])
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

function correctionPrompt(mandate: string, issue: string, candidate: string): string {
  return [
    "The previous preparation document was rejected.",
    issue,
    "Rejected candidate:",
    candidate,
    "Correct only the reported validation issues. Preserve the existing task breakdown, dependencies and verification unless a concrete substantive defect requires changing them. Do not invent blockers or discard the plan merely because its JSON was rejected. A format error does not establish a missing requirement; keep any real blockers explicit and distinguish preparation blockers from future execution gates.",
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
  return db.query("SELECT * FROM preparation_run WHERE team_id = ?").get(teamId) as RunRow | undefined
}

function preparationDossier(deps: ToolDeps, teamId: string | undefined, supervisorSessionID: string, request: PreparationRequest, businessProfilesHash: string): { json: string; hash: string; mandate: string } {
  if (request.history === "checkpoint" && !request.before) throw new PreparationAdmissionError("mandate", "Preparation checkpoint requires --before")
  if (request.before && request.history !== "checkpoint") throw new PreparationAdmissionError("mandate", "Preparation --before requires checkpoint history")
  const objective = (teamId ? storedObjective(deps.db, teamId) : request.text).trim()
  if (!objective) throw new PreparationAdmissionError("mandate", "prepare requires a mandate to open a mission draft")
  assertPreparationInputLength("Preparation mandate", request.text)
  assertPreparationInputLength("Stored mission objective", objective)
  let preplan: { path: string; content: string; hash: string } | undefined
  if (request.preplan) {
    try {
      const root = realpathSync(deps.directory)
      const file = realpathSync(resolve(root, request.preplan))
      const local = relative(root, file)
      if (local === ".." || local.startsWith("../") || local.startsWith("..\\") || isAbsolute(local)) throw new Error("outside project")
      if (!statSync(file).isFile() || statSync(file).size > PREPARATION_PREPLAN_BYTE_LIMIT) throw new Error(`Ensemble requires a file of at most ${PREPARATION_PREPLAN_BYTE_LIMIT} bytes`)
      const content = readFileSync(file, "utf8")
      if (!content.trim()) throw new Error("must contain non-whitespace text")
      assertPreparationInputLength("Preparation preplan", content)
      preplan = { path: local, content, hash: createHash("sha256").update(content).digest("hex") }
    } catch (error) { throw new PreparationAdmissionError("mandate", `Preparation preplan: ${messageOf(error)}`) }
  }
  const json = JSON.stringify({ version: 1, objective, instructions: teamId ? request.text.trim() : "", supervisorSessionID,
    directory: deps.directory, businessProfilesHash, history: request.history ?? "none", ...(request.before ? { before: request.before } : {}),
    constraints: "Discovery only; no implementation, no board mutation, no execution approval. Follow AGENTS.md and the native PM permissions.",
    ...(preplan ? { preplan } : {}),
  })
  const hash = createHash("sha256").update(json).digest("hex")
  const mandate = resolveMandate(deps.db, teamId, request.text)
  return { json, hash, mandate }
}

function dossierPrompt(run: Pick<RunRow, "dossier_json" | "dossier_hash" | "preflight_json" | "resume_notes_json"> | undefined, mandate: string): string {
  if (!run?.dossier_json) return mandate
  if (createHash("sha256").update(run.dossier_json).digest("hex") !== run.dossier_hash) throw new Error("Frozen preparation dossier hash mismatch")
  const dossier = JSON.parse(run.dossier_json) as { preplan?: { content: string } }
  const notes = readIssues(run.resume_notes_json)
  return `${mandate}\n\nFrozen preparation dossier (SHA-256 ${run.dossier_hash}):\n${run.dossier_json}${dossier.preplan ? `\n\nPreplan:\n${dossier.preplan.content}` : ""}${run.preflight_json ? `\n\nPreflight evidence (registered tools and declared rules, NOT the session-filtered Code Mode catalogue):\n${run.preflight_json}` : ""}${notes.length ? `\n\nSupervisor clarifications on explicit resume:\n${notes.join("\n\n")}` : ""}`
}

function readIssues(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : []
  } catch {
    return []
  }
}

function storedObjective(db: Database, teamId: string): string {
  const row = db.query("SELECT objective FROM mission_policy WHERE team_id = ?").get(teamId) as { objective: string } | undefined
  return row?.objective.trim() ?? ""
}

function resolveMandate(db: Database, teamId: string | undefined, text: string): string {
  const explicit = text.trim()
  const objective = teamId ? storedObjective(db, teamId) : ""
  if (explicit && objective) return `Mission objective:\n${objective}\n\nAdditional mandate:\n${explicit}`
  if (explicit) return explicit
  if (objective) return objective
  throw new PreparationAdmissionError("mandate", "prepare requires a mandate to open a mission draft")
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
    mapping: imported.mapping,
    parallelGroups: imported.parallelGroups,
  }
}

function pausedResult(run: RunRow): PreparationRunResult {
  const document = parsePreparationDocument(parseJson(run.candidate_json ?? ""))
  return { teamId: run.team_id, agent: run.agent, model: modelPair(run.model_id, run.variant),
    status: run.readiness === "blocked" ? "blocked" : "incomplete", candidate: run.candidate_json ?? "",
    candidateTaskCount: document.tasks.length, validationHistory: readIssues(run.errors_json),
    questions: document.openQuestions.map(item => ({ id: item.id, question: item.question })),
    issues: document.readiness ? [...document.readiness.reasons, ...document.readiness.missingInformation] : ["Legacy v1 has no readiness or tooling evidence. Return an explicit version 2 document."],
  }
}

const DECISION_KINDS = ["documentation", "research", "code", "mixed", "unspecified"] as const

function persistedPreparation(db: Database, teamId: string): PreparationImportResult | undefined {
  const head = db.query("SELECT id, document_hash, open_questions_json, parallel_groups_json FROM preparation_import WHERE team_id = ?").get(teamId) as {
    id: string
    document_hash: string
    open_questions_json: string
    parallel_groups_json: string
  } | undefined
  if (!head) return undefined
  const rows = db.query("SELECT pm_id, task_id, disposition, decision_json, hold_reason FROM preparation_task WHERE import_id = ? ORDER BY position ASC").all(head.id) as Array<{
    pm_id: string
    task_id: string
    disposition: string
    decision_json: string
    hold_reason: string | null
  }>
  return {
    importId: head.id,
    replayed: true,
    documentHash: head.document_hash,
    openQuestions: JSON.parse(head.open_questions_json) as PreparationImportResult["openQuestions"],
    parallelGroups: JSON.parse(head.parallel_groups_json) as PreparationImportResult["parallelGroups"],
    mapping: rows.map(row => {
      const decision = JSON.parse(row.decision_json) as { mode?: unknown; kind?: unknown }
      const kind = DECISION_KINDS.find(item => item === decision.kind)
      if ((row.disposition !== "authorized" && row.disposition !== "held") || (decision.mode !== "planned" && decision.mode !== "direct") || !kind) {
        throw new Error("Preparation import record is corrupt")
      }
      return {
        pmId: row.pm_id,
        taskId: row.task_id,
        disposition: row.disposition,
        mode: decision.mode,
        kind,
        ...(row.hold_reason ? { holdReason: row.hold_reason } : {}),
      }
    }),
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

async function admitNativePm(deps: ToolDeps, request: PreparationRequest, port: PreparationPort): Promise<{ agent: string; readOnly: boolean; profilesHash: string }> {
  const profiles = (() => {
    try { return deps.loadPreparationProfiles?.() ?? deps.config.businessProfiles }
    catch (error) { throw new PreparationAdmissionError("category", messageOf(error)) }
  })()
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
  return { agent: admitted.agent, readOnly: admitted.readOnly, profilesHash: createHash("sha256").update(JSON.stringify(profiles)).digest("hex") }
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
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'running', 0, 0, NULL, '[]', ?, ?)`, [
      id, teamId, agent, model.id, model.variant ?? null, mandate, now, now,
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
    if (document.version === 1 || document.readiness?.status !== "ready") {
      const readiness = document.readiness?.status === "blocked" ? "blocked" : "incomplete"
      deps.db.run("UPDATE preparation_run SET readiness = ?, candidate_json = ?, time_updated = ? WHERE id = ? AND status = 'running'", [readiness, reply, Date.now(), runId])
      const run = loadRun(deps.db, teamId)
      if (!run) throw new Error("Preparation run disappeared")
      return pausedResult(run)
    }
    const imported = importPreparationDocument(deps.db, teamId, document, policy)
    const saved = deps.db.run("UPDATE preparation_run SET status = 'imported', readiness = 'ready', time_updated = ? WHERE id = ? AND status = 'running'", [Date.now(), runId])
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

function documentIssue(reply: string): string | undefined {
  try {
    parsePreparationDocument(parseJson(reply))
  } catch (error) {
    return error instanceof PreparationDocumentError ? error.message : messageOf(error)
  }
  return undefined
}

async function boundedLoop(deps: ToolDeps, port: PreparationPort, runId: string, sessionId: string, teamId: string, agent: string, model: { id: string; variant?: string }, policy: ExecutionPolicy, mandate: string, readOnly: boolean, hooks?: PreparationObserver, initialize?: () => Promise<void>): Promise<PreparationRunResult> {
  if (activePreparationLoops.has(runId)) throw runStatusError("running")
  activePreparationLoops.add(runId)
  try {
    if (initialize) await initialize()
    return await runBoundedLoop(deps, port, runId, sessionId, teamId, agent, model, policy, mandate, readOnly, hooks)
  } finally {
    activePreparationLoops.delete(runId)
  }
}

async function recordPreflight(deps: ToolDeps, port: PreparationPort, runId: string, sessionId: string, agent: string): Promise<void> {
  const evidence = port.inspectTools ? await port.inspectTools({ sessionID: sessionId, agent }) : { effectiveCatalogue: "unverified", registered: [], servers: [], issues: ["Host has no preflight inspection API"] }
  deps.db.run("UPDATE preparation_run SET preflight_json = ? WHERE id = ?", [JSON.stringify(evidence), runId])
}

async function runBoundedLoop(deps: ToolDeps, port: PreparationPort, runId: string, sessionId: string, teamId: string, agent: string, model: { id: string; variant?: string }, policy: ExecutionPolicy, mandate: string, readOnly: boolean, hooks?: PreparationObserver): Promise<PreparationRunResult> {
  const current = loadRun(deps.db, teamId)
  let issues = readIssues(current?.errors_json ?? null)
  let candidate = current?.candidate_json ?? ""
  let pendingIssue = candidate.trim() ? documentIssue(candidate) : undefined
  let announced = false
  while (issues.length < PREPARATION_ATTEMPTS) {
    const mandateText = dossierPrompt(current, mandate)
    const text = pendingIssue
      ? correctionPrompt(mandateText, pendingIssue, candidate)
      : openingPrompt(candidate.trim() ? `${mandateText}\n\nResume the schema-valid preparation using the supervisor clarifications above. Reassess its readiness and current blockers; this candidate was not rejected. Historical schema errors are already resolved and are not new blockers.\n\nPrevious schema-valid candidate (not execution approval):\n${candidate}` : mandateText, readOnly)
    await port.prompt({ sessionID: sessionId, text, delivery: "queue" })
    if (!announced) {
      announced = true
      hooks?.onReady?.({ sessionID: sessionId })
    }
    await port.wait({ sessionID: sessionId, signal: new AbortController().signal })
    const reply = await port.readAssistant({ sessionID: sessionId })
    if (!reply.trim()) throw new Error(NO_ASSISTANT_REPLY)
    const imported = await importReply(deps, port, runId, sessionId, teamId, agent, model, policy, reply)
    if (imported) return imported
    candidate = reply
    pendingIssue = documentIssue(reply) ?? "Preparation document is invalid"
    issues = [...issues, pendingIssue]
    deps.db.run("UPDATE preparation_run SET attempts = ?, errors_json = ?, candidate_json = ?, time_updated = ? WHERE id = ? AND status = 'running'", [
      issues.length, JSON.stringify(issues), candidate, Date.now(), runId,
    ])
  }
  deps.db.run("UPDATE preparation_run SET status = 'exhausted', attempts = ?, errors_json = ?, candidate_json = ?, time_updated = ? WHERE id = ? AND status = 'running'", [
    issues.length, JSON.stringify(issues), candidate || null, Date.now(), runId,
  ])
  return { teamId, status: "exhausted", questions: [], agent, model, issues, ...(candidate ? { candidate } : {}) }
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
    if (error instanceof PreparationDocumentError) throw new PreparationAdmissionError("accept", error.message)
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

async function attachSession(deps: ToolDeps, port: PreparationPort, runId: string, agent: string, model: { id: string; variant?: string }, discardOnFailure: boolean, parentID: string): Promise<string> {
  let createdId: string | undefined
  try {
    const run = deps.db.query("SELECT * FROM preparation_run WHERE id = ?").get(runId) as RunRow | undefined
    const dossier = run?.dossier_json ? JSON.parse(run.dossier_json) as { history?: "none" | "fork" | "checkpoint"; before?: string } : undefined
    const created = await port.createSession({ title: PREPARATION_SESSION_TITLE, directory: deps.directory, parentID, agent,
      ...(dossier?.history && dossier.history !== "none" ? { history: dossier.history, ...(dossier.before ? { before: dossier.before } : {}) } : {}),
    })
    createdId = created.id
    deps.db.run("UPDATE preparation_run SET session_id = ?, time_updated = ? WHERE id = ?", [created.id, Date.now(), runId])
    await port.switchAgent({ sessionID: created.id, agent })
    const identity = modelIdentity(model.id)
    await port.switchModel({
      sessionID: created.id,
      providerID: identity.providerID,
      modelID: identity.modelID,
      ...(model.variant ? { variant: model.variant } : {}),
    })
    await port.replacePermissions({ sessionID: created.id, agent })
    await recordPreflight(deps, port, runId, created.id, agent)
    return created.id
  } catch (error) {
    if (createdId) await port.abort({ sessionID: createdId }).catch(() => undefined)
    if (discardOnFailure) deps.db.run("DELETE FROM preparation_run WHERE id = ? AND status = 'running'", [runId])
    throw error instanceof PreparationAdmissionError ? error : new PreparationAdmissionError("transport", messageOf(error))
  }
}

function finishImported(deps: ToolDeps, run: RunRow, imported: PreparationImportResult): PreparationRunResult {
  if (run.status === "running") {
    const saved = deps.db.run("UPDATE preparation_run SET status = 'imported', time_updated = ? WHERE id = ? AND status = 'running'", [Date.now(), run.id])
    if (saved.changes !== 1 && loadRun(deps.db, run.team_id)?.status !== "imported") {
      throw new PreparationAdmissionError("imported", "A preparation document was already imported")
    }
  }
  return importedResult(run.team_id, run.agent, modelPair(run.model_id, run.variant), imported)
}

/** Run admission, the bounded PM loop, or the one supervisor correction. */
export async function executePreparation(deps: ToolDeps, sessionId: string, request: PreparationRequest, port: PreparationPort, hooks?: PreparationObserver): Promise<PreparationRunResult> {
  if (request.kind === "accept") return acceptPreparation(deps, sessionId, request, port)
  const existing = findTeamBySession(deps.db, deps.registry, sessionId)
  if (existing && existing.role !== "lead") throw new PreparationAdmissionError("lead", "Only the mission lead can run preparation")
  const existingRun = existing ? loadRun(deps.db, existing.teamId) : undefined
  if (existing && existingRun && existingRun.status !== "cancelled") {
    const stored = persistedPreparation(deps.db, existing.teamId)
    if (stored && (existingRun.status === "imported" || existingRun.status === "running")) return finishImported(deps, existingRun, stored)
  }
  if (!port.hooksReady) throw new PreparationAdmissionError("hooks", "Preparation hooks are not ready")
  await port.assertCapabilities()
  if (existing && missionApproved(deps.db, existing.teamId)) throw new PreparationAdmissionError("approved", "This mission is already approved")
  if (existing && existingRun && existingRun.status !== "cancelled") {
    if (existingRun.status === "exhausted") throw runStatusError(existingRun.status)
    if (existingRun.status === "running") {
      if (existingRun.dossier_json && (request.preplan || request.history || request.before || request.pm && request.pm !== existingRun.agent)) throw new Error("Preparation dossier is frozen; context or PM cannot be replaced")
      if (existingRun.dossier_json && request.text.trim() && !request.resume) {
        const dossier = JSON.parse(existingRun.dossier_json) as { instructions: string; objective: string }
        if (request.text.trim() !== (dossier.instructions || dossier.objective)) throw new Error("Preparation mandate is frozen; resolve blockers with explicit --resume clarification")
      }
      if (existingRun.readiness === "blocked" || existingRun.readiness === "incomplete") {
        if (!request.resume) return pausedResult(existingRun)
        if (activePreparationLoops.has(existingRun.id)) throw runStatusError("running")
      } else if (request.resume) throw new Error("--resume requires a blocked or incomplete preparation")
      const facts = await port.describeAgent(existingRun.agent)
      const native = await nativeCatalogue(port)
      const policy = preparationPolicy(deps, existing.teamId, native)
      const model = modelPair(existingRun.model_id, existingRun.variant)
      const prepared = existingRun.session_id ?? await attachSession(deps, port, existingRun.id, existingRun.agent, model, false, sessionId)
      const initialize = request.resume ? async () => {
        assertPreparationInputLength("Resume clarification", request.text)
        const notes = [...readIssues(existingRun.resume_notes_json), ...(request.text.trim() ? [request.text.trim()] : [])]
        await port.replacePermissions({ sessionID: prepared, agent: existingRun.agent })
        await recordPreflight(deps, port, existingRun.id, prepared, existingRun.agent)
        const saved = deps.db.run("UPDATE preparation_run SET readiness = NULL, resume_notes_json = ?, time_updated = ? WHERE id = ? AND status = 'running' AND readiness IN ('blocked', 'incomplete')", [JSON.stringify(notes), Date.now(), existingRun.id])
        if (saved.changes !== 1) throw runStatusError("running")
      } : undefined
      return boundedLoop(deps, port, existingRun.id, prepared, existing.teamId, existingRun.agent, model, policy, existingRun.mandate, facts.readOnly, hooks, initialize)
    }
  }
  if (request.resume) throw new Error("--resume requires a blocked or incomplete preparation")
  const admitted = await admitNativePm(deps, request, port)
  const dossier = preparationDossier(deps, existing?.teamId, sessionId, request, admitted.profilesHash)
  const mandate = dossier.mandate
  const native = await nativeCatalogue(port)
  const policy = preparationPolicy(deps, existing?.teamId, native)
  const model = selectPreparationModel(policy, native)
  const teamId = existing?.teamId ?? (await prepareMission(deps, sessionId, mandate)).teamId
  const runId = claimRun(deps, teamId, admitted.agent, model, mandate)
  deps.db.run("UPDATE preparation_run SET dossier_json = ?, dossier_hash = ? WHERE id = ?", [dossier.json, dossier.hash, runId])
  const createdId = await attachSession(deps, port, runId, admitted.agent, model, true, sessionId)
  return boundedLoop(deps, port, runId, createdId, teamId, admitted.agent, model, policy, mandate, admitted.readOnly, hooks)
}

function decisionSuffix(raw: string): string {
  try {
    const decision = JSON.parse(raw) as { mode?: unknown; kind?: unknown }
    return typeof decision.mode === "string" && typeof decision.kind === "string" ? `; ${decision.mode}/${decision.kind}` : ""
  } catch {
    return ""
  }
}

function parallelGroupLines(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(item => {
      if (!item || typeof item !== "object") return []
      const group = item as { taskIds?: unknown; reason?: unknown; integrationNotes?: unknown; isolation?: unknown }
      const taskIds = Array.isArray(group.taskIds) ? group.taskIds.filter((id): id is string => typeof id === "string").join(", ") : ""
      const reason = typeof group.reason === "string" ? group.reason.trim() : ""
      const notes = typeof group.integrationNotes === "string" ? group.integrationNotes.trim() : ""
      const isolation = typeof group.isolation === "string" ? group.isolation.trim() : ""
      if (!taskIds && !reason && !notes && !isolation) return []
      const body = [reason, notes].filter(part => part.length > 0).join(" ")
      return [`- ${taskIds} (${isolation}): ${body}`.trim()]
    })
  } catch {
    return []
  }
}

function pmContext(row: ContextRow): string {
  const issues = readIssues(row.errors_json)
  return [
    PREPARATION_PM_INSTRUCTIONS,
    `Mandate:\n${dossierPrompt(row, row.mandate ?? "")}`,
    ...(issues.length ? [`Rejected issues:\n${issues.join("\n")}`] : []),
    ...(row.candidate_json ? [`Previous candidate (not execution approval):\n${row.candidate_json}`] : []),
  ].join("\n\n")
}

function leadContext(db: Database, row: ContextRow): string {
  const questions = row.open_questions_json ? supervisorQuestions(row.open_questions_json) : undefined
  const tasks = db.query("SELECT pm_id, task_id, disposition, hold_reason, decision_json FROM preparation_task WHERE team_id = ? ORDER BY position ASC").all(row.team_id) as Array<{
    pm_id: string
    task_id: string
    disposition: string
    hold_reason: string | null
    decision_json: string
  }>
  const groups = parallelGroupLines(row.parallel_groups_json)
  const reference = preparationSessionReference(row.session_id)
  return [
    ...(reference ? [reference] : []),
    `Tracked preparation record: ${row.status}. That record is not a native session status.`,
    `Mandate:\n${dossierPrompt(row, row.mandate ?? "")}`,
    questions ?? "Supervisor questions:\n- none",
    "Imported tasks:",
    ...(tasks.length ? tasks.map(task => `- ${task.pm_id} → ${task.task_id} (${task.disposition}${task.hold_reason ? `: ${task.hold_reason}` : ""}${decisionSuffix(task.decision_json)})`) : ["- none"]),
    ...(groups.length ? ["Parallel groups:", ...groups] : []),
  ].join("\n")
}

/** Contract text for a preparation session or its lead, omitted after approval. */
export function preparationContextText(db: Database, sessionId: string): string | undefined {
  const row = db.query(`SELECT r.session_id, CASE WHEN r.status = 'running' THEN COALESCE(r.readiness, r.status) ELSE r.status END AS status, r.team_id, r.mandate, r.candidate_json, r.errors_json,
    r.dossier_json, r.dossier_hash, r.preflight_json, r.resume_notes_json, p.approved_hash, i.open_questions_json, i.parallel_groups_json
    FROM preparation_run r
    JOIN mission_policy p ON p.team_id = r.team_id
    LEFT JOIN preparation_import i ON i.team_id = r.team_id
    WHERE r.session_id = ? OR r.team_id IN (SELECT id FROM team WHERE lead_session_id = ? AND status = 'active')
    ORDER BY r.time_updated DESC LIMIT 1`).get(sessionId, sessionId) as ContextRow | undefined
  if (!row || row.status === "cancelled" || row.approved_hash) return undefined
  if (row.session_id === sessionId) return pmContext(row)
  if (!["imported", "ready", "running", "exhausted", "blocked", "incomplete"].includes(row.status)) return undefined
  if (!row.session_id && row.status !== "imported") return undefined
  const lead = db.query("SELECT id FROM team WHERE id = ? AND lead_session_id = ? AND status = 'active'").get(row.team_id, sessionId) as { id: string } | undefined
  return lead ? leadContext(db, row) : undefined
}
