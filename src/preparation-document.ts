import { validateExecutionPolicy, validateTaskExecutionDecision, type ExecutionPolicy, type TaskExecutionDecision } from "./execution-policy"
import type { SpawnContext } from "./types"
import { parseSpawnContext } from "./session-continuity"

/** Version of the PM preparation document. */
export const PREPARATION_DOCUMENT_VERSION = 2

/** Business task types a PM may assign. Execution kinds are derived, not accepted here. */
export const PREPARATION_TASK_TYPES = ["implementation", "architecture", "documentation", "research", "review", "qa"] as const

/** Business task type stored before execution admission. */
export type PreparationTaskType = (typeof PREPARATION_TASK_TYPES)[number]

/** Commented source cited by a discovery document. */
export interface PreparationSource {
  path: string
  note: string
}

/**
 * Detailed discovery document for one task.
 * `document` is the finding itself; `sources` are the commented citations.
 */
export interface PreparationHandoff {
  document: string
  sources: PreparationSource[]
}

/** One PM task before its plugin id exists. */
export interface PreparationTask {
  id: string
  title: string
  type: PreparationTaskType
  goal: string
  dependsOn: string[]
  planning: { required: boolean; reason: string }
  acceptanceCriteria: string[]
  verification: string[]
  handoff: PreparationHandoff
  agent?: string
  context?: SpawnContext
}

/** Question returned to the supervisor, never delegated as a worker note. */
export interface PreparationQuestion {
  id: string
  question: string
  audience: "supervisor"
  blocking?: boolean
}

/** Isolated work that may proceed on separate worktrees, with a reconciliation note. */
export interface PreparationParallelGroup {
  taskIds: string[]
  reason: string
  integrationNotes: string
  isolation: "separate-worktrees"
}

/** Versioned PM preparation document. */
export interface PreparationDocument {
  version: 1 | typeof PREPARATION_DOCUMENT_VERSION
  context: string
  openQuestions: PreparationQuestion[]
  tasks: PreparationTask[]
  parallelGroups: PreparationParallelGroup[]
  readiness?: { status: "ready" | "blocked" | "incomplete"; reasons: string[]; missingInformation: string[] }
  tooling?: { catalogue: "verified" | "unverified"; unavailable: string[] }
}

/** Prepared execution boundary with no model assigned. */
export interface PreparationDisposition {
  disposition: "authorized" | "held"
  decision: TaskExecutionDecision
  reason?: string
}

const TASK_KIND: Record<PreparationTaskType, TaskExecutionDecision["kind"]> = {
  implementation: "code",
  architecture: "mixed",
  documentation: "documentation",
  research: "research",
  review: "mixed",
  qa: "mixed",
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const DOCUMENT_KEYS = ["version", "context", "openQuestions", "tasks", "parallelGroups"]
const TASK_KEYS = ["id", "title", "type", "goal", "dependsOn", "planning", "acceptanceCriteria", "verification", "handoff", "agent", "context"]
const MAX_DOCUMENT_JSON = 200_000

/** Validation failure that lists every document issue. */
export class PreparationDocumentError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(issues.join("\n"))
    this.name = "PreparationDocumentError"
    this.issues = issues
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTaskType(value: string): value is PreparationTaskType {
  return (PREPARATION_TASK_TYPES as readonly string[]).includes(value)
}

function readText(value: unknown, field: string, issues: string[], min: number, max: number): string | undefined {
  if (typeof value !== "string") {
    issues.push(`${field} must be a string`)
    return undefined
  }
  const text = value.trim()
  if (text.length < min || text.length > max) {
    issues.push(`${field} must be a string of ${min} to ${max} characters`)
    return undefined
  }
  return text
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], field: string, issues: string[]): void {
  Object.keys(record).forEach(key => {
    if (!allowed.includes(key)) issues.push(`${field}.${key} is not supported`)
  })
}

function readId(value: unknown, field: string, issues: string[]): string | undefined {
  const text = readText(value, field, issues, 1, 64)
  if (!text) return undefined
  if (!IDENTIFIER.test(text)) {
    issues.push(`${field} must be a stable identifier`)
    return undefined
  }
  return text
}

function readStringList(value: unknown, field: string, issues: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    issues.push(`${field} must contain 1 to 50 strings`)
    return undefined
  }
  const items: string[] = []
  let ok = true
  value.forEach((item, index) => {
    const text = readText(item, `${field}[${index}]`, issues, 1, 2000)
    if (!text) ok = false
    else items.push(text)
  })
  return ok ? items : undefined
}

function readIdList(value: unknown, field: string, issues: string[], allowEmpty: boolean): string[] | undefined {
  if (!Array.isArray(value) || value.length > 50 || (!allowEmpty && value.length < 1)) {
    issues.push(`${field} must contain ${allowEmpty ? "0" : "1"} to 50 identifiers`)
    return undefined
  }
  const items: string[] = []
  let ok = true
  value.forEach((item, index) => {
    const id = readId(item, `${field}[${index}]`, issues)
    if (!id) ok = false
    else items.push(id)
  })
  if (new Set(items).size !== items.length) {
    issues.push(`${field} contains duplicate ids`)
    ok = false
  }
  return ok ? items : undefined
}

function readQuestions(value: unknown, issues: string[], version: unknown): PreparationQuestion[] | undefined {
  if (!Array.isArray(value) || value.length > 50) {
    issues.push("openQuestions must contain 0 to 50 questions")
    return undefined
  }
  const questions: PreparationQuestion[] = []
  let ok = true
  const seen = new Set<string>()
  value.forEach((item, index) => {
    const field = `openQuestions[${index}]`
    if (!isRecord(item)) {
      issues.push(`${field} must be an object`)
      ok = false
      return
    }
    rejectUnknown(item, ["id", "question", "audience", ...(version === 2 ? ["blocking"] : [])], field, issues)
    if (version === 2 && typeof item.blocking !== "boolean") issues.push(`${field}.blocking must be boolean`)
    const id = readId(item.id, `${field}.id`, issues)
    const question = readText(item.question, `${field}.question`, issues, 1, 2000)
    if (item.audience !== "supervisor") issues.push(`${field}.audience must be supervisor`)
    if (!id || !question || item.audience !== "supervisor") ok = false
    if (id && seen.has(id)) {
      issues.push(`${field}.id duplicate question id`)
      ok = false
    }
    if (id) seen.add(id)
    if (id && question && item.audience === "supervisor") questions.push({ id, question, audience: "supervisor", ...(version === 2 ? { blocking: item.blocking === true } : {}) })
  })
  return ok ? questions : undefined
}

function readHandoff(value: unknown, field: string, issues: string[]): PreparationHandoff | undefined {
  if (!isRecord(value)) {
    issues.push(`${field} must be an object`)
    return undefined
  }
  rejectUnknown(value, ["document", "sources"], field, issues)
  const document = readText(value.document, `${field}.document`, issues, 1, 20000)
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 50) {
    issues.push(`${field}.sources must contain 1 to 50 commented sources`)
    return undefined
  }
  const sources: PreparationSource[] = []
  let ok = Boolean(document)
  value.sources.forEach((item, index) => {
    const sourceField = `${field}.sources[${index}]`
    if (!isRecord(item)) {
      issues.push(`${sourceField} must be an object`)
      ok = false
      return
    }
    rejectUnknown(item, ["path", "note"], sourceField, issues)
    const path = readText(item.path, `${sourceField}.path`, issues, 1, 500)
    const note = readText(item.note, `${sourceField}.note`, issues, 1, 2000)
    if (!path || !note) ok = false
    else sources.push({ path, note })
  })
  return ok && document ? { document, sources } : undefined
}

function readTask(value: unknown, index: number, issues: string[]): PreparationTask | undefined {
  const field = `tasks[${index}]`
  if (!isRecord(value)) {
    issues.push(`${field} must be an object`)
    return undefined
  }
  rejectUnknown(value, TASK_KEYS, field, issues)
  const id = readId(value.id, `${field}.id`, issues)
  const title = readText(value.title, `${field}.title`, issues, 1, 200)
  const goal = readText(value.goal, `${field}.goal`, issues, 1, 4000)
  const dependsOn = readIdList(value.dependsOn, `${field}.dependsOn`, issues, true)
  const acceptanceCriteria = readStringList(value.acceptanceCriteria, `${field}.acceptanceCriteria`, issues)
  const verification = readStringList(value.verification, `${field}.verification`, issues)
  const handoff = readHandoff(value.handoff, `${field}.handoff`, issues)
  const agent = value.agent === undefined ? undefined : readText(value.agent, `${field}.agent`, issues, 1, 200)
  let context: SpawnContext | undefined
  if (value.context !== undefined) {
    try { context = parseSpawnContext(value.context) }
    catch (error) { issues.push(`${field}.context: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const type = typeof value.type === "string" && isTaskType(value.type) ? value.type : undefined
  if (!type) issues.push(`${field}.type must be one of ${PREPARATION_TASK_TYPES.join(", ")}`)
  let planning: PreparationTask["planning"] | undefined
  if (!isRecord(value.planning)) issues.push(`${field}.planning must be an object`)
  else {
    rejectUnknown(value.planning, ["required", "reason"], `${field}.planning`, issues)
    const reason = readText(value.planning.reason, `${field}.planning.reason`, issues, 1, 2000)
    if (typeof value.planning.required !== "boolean") issues.push(`${field}.planning.required must be a boolean`)
    if (typeof value.planning.required === "boolean" && reason) planning = { required: value.planning.required, reason }
  }
  if (!id || !title || !type || !goal || !dependsOn || !planning || !acceptanceCriteria || !verification || !handoff) return undefined
  return { id, title, type, goal, dependsOn, planning, acceptanceCriteria, verification, handoff, ...(agent ? { agent } : {}), ...(context ? { context } : {}) }
}

function readTasks(value: unknown, issues: string[]): { ok: boolean; tasks: PreparationTask[] } {
  if (!Array.isArray(value) || value.length > 100) {
    issues.push("tasks must contain 0 to 100 tasks")
    return { ok: false, tasks: [] }
  }
  const tasks: PreparationTask[] = []
  const seen = new Set<string>()
  let ok = true
  value.forEach((item, index) => {
    const task = readTask(item, index, issues)
    if (!task) {
      ok = false
      return
    }
    if (seen.has(task.id)) {
      issues.push(`tasks[${index}].id duplicate task id ${task.id}`)
      ok = false
      return
    }
    seen.add(task.id)
    tasks.push(task)
  })
  return { ok, tasks }
}

function findCycle(tasks: readonly PreparationTask[]): string[] | undefined {
  const ids = new Set(tasks.map(task => task.id))
  const deps = new Map(tasks.map(task => [task.id, task.dependsOn.filter(id => ids.has(id))]))
  const done = new Set<string>()
  const visit = (id: string, stack: readonly string[]): string[] | undefined => {
    if (stack.includes(id)) return [...stack.slice(stack.indexOf(id)), id]
    if (done.has(id)) return undefined
    const cycle = (deps.get(id) ?? []).reduce<string[] | undefined>((found, dep) => found ?? visit(dep, [...stack, id]), undefined)
    done.add(id)
    return cycle
  }
  return tasks.reduce<string[] | undefined>((found, task) => found ?? visit(task.id, []), undefined)
}

function checkGraph(tasks: readonly PreparationTask[], issues: string[]): void {
  const ids = new Set(tasks.map(task => task.id))
  const unknown = [...new Set(tasks.flatMap(task => task.dependsOn.filter(id => !ids.has(id))))]
  if (unknown.length) issues.push(`tasks.dependsOn: unknown task ids ${unknown.join(", ")}`)
  const cycle = findCycle(tasks)
  if (cycle) issues.push(`tasks: dependency cycle ${cycle.join(" -> ")}`)
}

function dependentPair(group: readonly string[], tasks: readonly PreparationTask[]): [string, string] | undefined {
  const members = new Set(group)
  const deps = new Map(tasks.map(task => [task.id, task.dependsOn]))
  const walk = (id: string, seen: Set<string>): string | undefined => (deps.get(id) ?? []).reduce<string | undefined>((found, dep) => {
    if (found || seen.has(dep)) return found
    if (members.has(dep)) return dep
    seen.add(dep)
    return walk(dep, seen)
  }, undefined)
  return group.reduce<[string, string] | undefined>((found, id) => {
    if (found) return found
    const other = walk(id, new Set([id]))
    return other ? [id, other] : undefined
  }, undefined)
}

function readGroups(value: unknown, issues: string[], tasks: readonly PreparationTask[] | undefined): PreparationParallelGroup[] | undefined {
  if (!Array.isArray(value) || value.length > 50) {
    issues.push("parallelGroups must contain 0 to 50 groups")
    return undefined
  }
  const taskIds = tasks ? new Set(tasks.map(task => task.id)) : undefined
  const groups: PreparationParallelGroup[] = []
  let ok = true
  value.forEach((item, index) => {
    const field = `parallelGroups[${index}]`
    if (!isRecord(item)) {
      issues.push(`${field} must be an object`)
      ok = false
      return
    }
    rejectUnknown(item, ["taskIds", "reason", "integrationNotes", "isolation"], field, issues)
    const taskList = readIdList(item.taskIds, `${field}.taskIds`, issues, false)
    const reason = readText(item.reason, `${field}.reason`, issues, 1, 2000)
    const integrationNotes = readText(item.integrationNotes, `${field}.integrationNotes`, issues, 1, 4000)
    if (item.isolation !== "separate-worktrees") issues.push(`${field}.isolation must be separate-worktrees`)
    const known = !taskIds || taskList?.every(id => taskIds.has(id))
    if (taskIds && taskList?.some(id => !taskIds.has(id))) issues.push(`${field}.taskIds contains an unknown task id`)
    const coupled = tasks && taskList ? dependentPair(taskList, tasks) : undefined
    if (coupled) issues.push(`${field}.taskIds couples dependent tasks ${coupled[0]} and ${coupled[1]}`)
    if (!taskList || !reason || !integrationNotes || item.isolation !== "separate-worktrees" || !known || coupled) ok = false
    else groups.push({ taskIds: taskList, reason, integrationNotes, isolation: "separate-worktrees" })
  })
  return ok ? groups : undefined
}

/**
 * Parse and normalize a PM preparation document.
 * Questions stay addressed to the supervisor.
 * Parallel groups name separate worktrees and cannot contain tasks that depend on each other.
 */
export function parsePreparationDocument(value: unknown): PreparationDocument {
  let encoded = ""
  try {
    encoded = JSON.stringify(value) ?? ""
  } catch {
    throw new PreparationDocumentError(["Preparation document must be JSON-serializable"])
  }
  if (encoded.length > MAX_DOCUMENT_JSON) throw new PreparationDocumentError(["Preparation document exceeds 200000 characters"])
  if (!isRecord(value)) throw new PreparationDocumentError(["Preparation document must be an object"])
  const issues: string[] = []
  rejectUnknown(value, [...DOCUMENT_KEYS, ...(value.version === 2 ? ["readiness", "tooling"] : [])], "document", issues)
  if (value.version !== 1 && value.version !== PREPARATION_DOCUMENT_VERSION) issues.push("version must be 1 or 2")
  const context = readText(value.context, "context", issues, 1, 20000)
  const openQuestions = readQuestions(value.openQuestions, issues, value.version)
  let readiness: PreparationDocument["readiness"]
  let tooling: PreparationDocument["tooling"]
  if (value.version === 2) {
    const ready = isRecord(value.readiness) ? value.readiness : {}
    const tools = isRecord(value.tooling) ? value.tooling : {}
    rejectUnknown(ready, ["status", "reasons", "missingInformation"], "readiness", issues)
    rejectUnknown(tools, ["catalogue", "unavailable"], "tooling", issues)
    const list = (input: unknown, field: string): string[] => {
      if (!Array.isArray(input) || input.length > 50 || input.some(item => typeof item !== "string" || !item.trim() || item.length > 2000)) {
        issues.push(`${field} must contain 0 to 50 nonempty strings of at most 2000 characters`)
        return []
      }
      return input.map(item => String(item).trim())
    }
    const reasons = list(ready.reasons, "readiness.reasons")
    const missingInformation = list(ready.missingInformation, "readiness.missingInformation")
    const unavailable = list(tools.unavailable, "tooling.unavailable")
    if (ready.status !== "ready" && ready.status !== "blocked" && ready.status !== "incomplete") issues.push("readiness.status must be ready, blocked, or incomplete")
    else {
      readiness = { status: ready.status, reasons, missingInformation }
      if (ready.status !== "ready" && !reasons.length) issues.push("Non-ready preparation requires readiness.reasons")
      if (ready.status === "ready") {
        if (reasons.length) issues.push("readiness.reasons must be empty when status is ready; put positive justifications in context. If these are actual blockers, keep them and use blocked or incomplete instead.")
        if (missingInformation.length) issues.push("readiness.missingInformation must be empty when status is ready; unresolved required information needs blocked or incomplete readiness.")
        if (openQuestions?.some(question => question.blocking)) issues.push("openQuestions contains blocking questions while readiness.status is ready; resolve them or use blocked or incomplete readiness.")
      }
      if (ready.status === "ready" && (tools.catalogue !== "verified" || unavailable.length)) issues.push("ready preparation requires verified tooling without unavailable capabilities")
    }
    if (tools.catalogue !== "verified" && tools.catalogue !== "unverified") issues.push("tooling.catalogue must be verified or unverified")
    else tooling = { catalogue: tools.catalogue, unavailable }
  }
  const parsedTasks = readTasks(value.tasks, issues)
  if (parsedTasks.ok) checkGraph(parsedTasks.tasks, issues)
  const parallelGroups = readGroups(value.parallelGroups, issues, parsedTasks.ok ? parsedTasks.tasks : undefined)
  if (issues.length || !context || !openQuestions || !parsedTasks.ok || !parallelGroups) {
    throw new PreparationDocumentError(issues.length ? issues : ["Preparation document is invalid"])
  }
  return { version: value.version === 2 ? 2 : 1, context, openQuestions, tasks: parsedTasks.tasks, parallelGroups, ...(readiness ? { readiness } : {}), ...(tooling ? { tooling } : {}) }
}

/**
 * Map planning.required to planned or direct.
 * The kind comes from the business type. No model, variant, or routing reason is assigned.
 */
export function preparationExecutionDecision(task: PreparationTask): TaskExecutionDecision {
  const kind = TASK_KIND[task.type]
  if (!kind || typeof task.planning?.required !== "boolean") throw new Error("Unsupported preparation task")
  return { mode: task.planning.required ? "planned" : "direct", kind }
}

/**
 * Authorize a preparation decision only when the current policy already allows it.
 * Version 2 direct work outside documentation or research is held unchanged. The policy is not widened.
 */
export function authorizePreparationDecision(policy: ExecutionPolicy | undefined, decision: TaskExecutionDecision): PreparationDisposition {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) throw new Error("Invalid task execution decision")
  const forbidden = Object.keys(decision).filter(key => !["mode", "kind"].includes(key))
  if (forbidden.some(key => ["model", "variant", "reason"].includes(key))) throw new Error("Preparation decisions cannot assign a model, variant, or routing reason")
  if (forbidden.length) throw new Error(`Preparation decisions cannot include ${forbidden.join(", ")}`)
  const isolated: TaskExecutionDecision = { mode: decision.mode, kind: decision.kind }
  validateTaskExecutionDecision(isolated)
  if (policy) validateExecutionPolicy(policy)
  const v2Direct = !policy || policy.version === 2
  const qualified = isolated.kind === "documentation" || isolated.kind === "research"
  const restricted = isolated.mode === "direct" && (isolated.kind === "unspecified" || (v2Direct && !qualified))
  if (!restricted) {
    if (policy) validateTaskExecutionDecision(isolated, policy)
    return { disposition: "authorized", decision: isolated }
  }
  let reason = "Direct execution requires a qualified kind; version 2 is restricted to documentation or research"
  if (policy) {
    let failed = false
    try {
      validateTaskExecutionDecision(isolated, policy)
    } catch (error) {
      failed = true
      if (!(error instanceof Error) || !/version 2|qualified kind/i.test(error.message)) throw error
      reason = error.message
    }
    if (!failed) throw new Error("Direct preparation decision was accepted by a policy that should have held it")
  }
  return { disposition: "held", decision: isolated, reason }
}

/**
 * Render the worker-visible task text, including the full discovery document.
 * This is plugin-persisted content, not a file written by a read-only PM.
 */
export function renderPreparationTask(task: PreparationTask): string {
  return [
    task.title,
    "",
    `Type: ${task.type}`,
    `Goal: ${task.goal}`,
    `Planning: ${task.planning.required ? "required" : "direct"}`,
    `Planning reason: ${task.planning.reason}`,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map(item => `- ${item}`),
    "",
    "Verification:",
    ...task.verification.map(item => `- ${item}`),
    "",
    "Discovery document:",
    task.handoff.document,
    "",
    "Sources:",
    ...task.handoff.sources.map(source => `- ${source.path}: ${source.note}`),
  ].join("\n")
}
