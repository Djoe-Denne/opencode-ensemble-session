import { createHash } from "node:crypto"
import type { Database } from "./db"
import { validateExecutionPolicy, validateTaskExecutionDecision, type ExecutionPolicy, type TaskExecutionDecision } from "./execution-policy"
import {
  authorizePreparationDecision,
  parsePreparationDocument,
  PreparationDocumentError,
  preparationExecutionDecision,
  renderPreparationTask,
  type PreparationDocument,
  type PreparationParallelGroup,
  type PreparationQuestion,
  type PreparationTask,
} from "./preparation-document"
import { generateId } from "./util"

/** One PM id mapped to the plugin task id created for it. */
export interface PreparationImportMapping {
  pmId: string
  taskId: string
  disposition: "authorized" | "held"
  mode: TaskExecutionDecision["mode"]
  kind: TaskExecutionDecision["kind"]
  holdReason?: string
}

/** Result of an initial preparation import. Replays return the original ids. */
export interface PreparationImportResult {
  importId: string
  replayed: boolean
  documentHash: string
  openQuestions: PreparationQuestion[]
  parallelGroups: PreparationParallelGroup[]
  mapping: PreparationImportMapping[]
}

interface ImportHead {
  id: string
  document_hash: string
  policy_hash: string
  open_questions_json: string
  parallel_groups_json: string
}

interface StoredTask {
  pm_id: string
  task_id: string
  disposition: string
  decision_json: string
  hold_reason: string | null
}

interface DecidedTask {
  task: PreparationTask
  decision: TaskExecutionDecision
  disposition: "authorized" | "held"
  holdReason?: string
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function documentHash(document: PreparationDocument): string {
  return createHash("sha256").update(canonicalJson(document)).digest("hex")
}

function policyFingerprint(policy: ExecutionPolicy | undefined): string {
  if (!policy) return ""
  validateExecutionPolicy(policy)
  const canonical = {
    version: policy.version,
    providers: [...policy.providers].sort(),
    startingIntelligence: policy.startingIntelligence,
    classificationBeta: policy.classificationBeta,
    models: policy.models.map(model => ({
      id: model.id,
      provider: model.provider ?? null,
      reasoningEffort: model.reasoningEffort ?? null,
      intelligenceScore: model.intelligenceScore,
      averageCostPerTask: model.averageCostPerTask,
      available: model.available,
      cursorBenchCostPerTask: model.cursorBenchCostPerTask ?? null,
      paidFallback: model.paidFallback ?? null,
      level: model.level ?? null,
      usage: model.usage ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id) || String(left.reasoningEffort).localeCompare(String(right.reasoningEffort))),
    verification: policy.verification ?? null,
    planningIntelligenceRange: policy.planningIntelligenceRange ?? null,
  }
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex")
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}

function headOf(db: Database, teamId: string): ImportHead | undefined {
  return db.query("SELECT id, document_hash, policy_hash, open_questions_json, parallel_groups_json FROM preparation_import WHERE team_id = ?").get(teamId) as ImportHead | undefined
}

function assertSameDocument(existing: ImportHead, hash: string): void {
  if (existing.document_hash !== hash) throw new Error("A different preparation document was already imported for this mission")
}

function storedJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error("Preparation import record is corrupt")
  }
}

function storedDecision(raw: string): TaskExecutionDecision {
  const parsed: unknown = storedJson<unknown>(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Preparation import record is corrupt")
  const record = parsed as { mode?: unknown; kind?: unknown }
  const decision = { mode: record.mode, kind: record.kind }
  validateTaskExecutionDecision(decision)
  return decision
}

function mappingOf(row: StoredTask): PreparationImportMapping {
  if (row.disposition !== "authorized" && row.disposition !== "held") throw new Error("Preparation import record is corrupt")
  const decision = storedDecision(row.decision_json)
  return {
    pmId: row.pm_id,
    taskId: row.task_id,
    disposition: row.disposition,
    mode: decision.mode,
    kind: decision.kind,
    ...(row.hold_reason ? { holdReason: row.hold_reason } : {}),
  }
}

function resultOf(db: Database, existing: ImportHead, hash: string, replayed: boolean): PreparationImportResult {
  const rows = db.query("SELECT pm_id, task_id, disposition, decision_json, hold_reason FROM preparation_task WHERE import_id = ? ORDER BY position ASC").all(existing.id) as StoredTask[]
  return {
    importId: existing.id,
    replayed,
    documentHash: hash,
    openQuestions: storedJson<PreparationQuestion[]>(existing.open_questions_json),
    parallelGroups: storedJson<PreparationParallelGroup[]>(existing.parallel_groups_json),
    mapping: rows.map(mappingOf),
  }
}

function replay(db: Database, existing: ImportHead, hash: string): PreparationImportResult {
  assertSameDocument(existing, hash)
  return resultOf(db, existing, hash, true)
}

function requirePersisted(db: Database, sql: string, params: readonly unknown[]): void {
  if (db.run(sql, params).changes !== 1) throw new Error("Preparation import did not persist")
}

function decisionsFor(document: PreparationDocument, policy: ExecutionPolicy | undefined): DecidedTask[] {
  return document.tasks.map(task => {
    const decision = preparationExecutionDecision(task)
    const disposition = authorizePreparationDecision(policy, decision)
    return { task, decision: disposition.decision, disposition: disposition.disposition, ...(disposition.reason ? { holdReason: disposition.reason } : {}) }
  })
}

function persistPreparedTask(db: Database, teamId: string, importId: string, item: DecidedTask, position: number, taskId: string, dependsOn: readonly string[], authorizedBy: string, now: number): void {
  const request = JSON.stringify({ mode: item.decision.mode, kind: item.decision.kind })
  const authorized = item.disposition === "authorized"
    ? JSON.stringify({ mode: item.decision.mode, kind: item.decision.kind, authorizedBy })
    : null
  requirePersisted(db, `INSERT INTO team_task (
      id, team_id, content, status, priority, depends_on, time_created, time_updated, execution_request, execution_decision
    ) VALUES (?, ?, ?, ?, 'medium', ?, ?, ?, ?, ?)`, [
    taskId, teamId, renderPreparationTask(item.task), dependsOn.length ? "blocked" : "pending",
    dependsOn.length ? JSON.stringify(dependsOn) : null, now, now, request, authorized,
  ])
  requirePersisted(db, `INSERT INTO preparation_task (
      import_id, team_id, pm_id, task_id, position, task_type, goal, planning_required, planning_reason,
      acceptance_json, verification_json, handoff_json, disposition, decision_json, hold_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    importId, teamId, item.task.id, taskId, position, item.task.type, item.task.goal,
    item.task.planning.required ? 1 : 0, item.task.planning.reason,
    JSON.stringify(item.task.acceptanceCriteria), JSON.stringify(item.task.verification), JSON.stringify(item.task.handoff),
    item.disposition, request, item.holdReason ?? null,
  ])
}

function writeImport(db: Database, teamId: string, document: PreparationDocument, decided: readonly DecidedTask[], hash: string, policyHash: string): PreparationImportResult {
  const team = db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamId) as { lead_session_id: string } | undefined
  if (!team) throw new Error("Preparation import requires an existing mission team")
  const mission = db.query("SELECT approved_hash FROM mission_policy WHERE team_id = ?").get(teamId) as { approved_hash: string | null } | undefined
  if (!mission) throw new Error("Preparation import requires a mission draft")
  const existing = headOf(db, teamId)
  if (existing) return replay(db, existing, hash)
  if (document.version !== 2 || document.readiness?.status !== "ready") throw new PreparationDocumentError(["New preparation imports require an explicit ready version 2 document"])
  if (mission.approved_hash) throw new Error("Initial preparation import must happen before mission start")

  const importId = generateId("prep")
  const now = Date.now()
  const taskIds = new Map(decided.map(item => [item.task.id, generateId("task")]))
  requirePersisted(db, `INSERT INTO preparation_import (
      id, team_id, document_hash, policy_hash, document_json, context, open_questions_json, parallel_groups_json, time_created
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    importId, teamId, hash, policyHash, canonicalJson(document), document.context,
    JSON.stringify(document.openQuestions), JSON.stringify(document.parallelGroups), now,
  ])
  decided.forEach((item, position) => {
    const taskId = taskIds.get(item.task.id)
    if (!taskId) throw new Error(`Preparation import lost task id ${item.task.id}`)
    const dependsOn = item.task.dependsOn.map(pmId => {
      const real = taskIds.get(pmId)
      if (!real) throw new Error(`Preparation import lost dependency ${pmId}`)
      return real
    })
    persistPreparedTask(db, teamId, importId, item, position, taskId, dependsOn, team.lead_session_id, now)
  })
  const stored = headOf(db, teamId)
  if (!stored) throw new Error("Preparation import disappeared before commit")
  return resultOf(db, stored, hash, false)
}

/**
 * Validate a preparation document and import it once, before mission start.
 * The same team and canonical document replay the persisted ids and decisions.
 * That replay does not read, fingerprint, or reauthorize the supplied policy.
 * policy_hash remains the audit of the first import. Nothing is spawned or admitted.
 */
export function importPreparationDocument(db: Database, teamId: string, value: unknown, policy?: ExecutionPolicy): PreparationImportResult {
  const document = parsePreparationDocument(value)
  const hash = documentHash(document)
  const existing = headOf(db, teamId)
  if (existing) return replay(db, existing, hash)
  const policyHash = policyFingerprint(policy)
  try {
    return db.transaction(() => writeImport(db, teamId, document, decisionsFor(document, policy), hash, policyHash))()
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error
    const raced = headOf(db, teamId)
    if (!raced) throw error
    return replay(db, raced, hash)
  }
}
