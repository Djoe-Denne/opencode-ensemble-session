import type { ToolDeps } from "./types"
import type { MissionClassificationPolicy } from "./mission-classification"
import type { ClassificationScores, TaskClassification } from "./classification-protocol"
import type { Database } from "./db"
import { CLASSIFICATION_LIMITS } from "./mission-classification"
import { buildJevClassificationInput, normalizeJevClassification } from "./classification-protocol"
import { normalizeGeneralClassification, normalizeX86Classification } from "./classification-adapters"
import { notifyLead } from "./notify"
import { generateId } from "./util"
import { assertMissionAdmission } from "./mission-policy"

/** Immutable input selected from the current task row, not the orchestrator's interpretation. */
export interface ClassificationJob {
  id: string
  token: string
  content: string
  type: string
  data: Record<string, unknown> | null
  manual: ClassificationScores
}

/** Run the mission's authorized chain with durable budgets and bounded retry/failover. */
export async function runClassification(deps: ToolDeps, teamId: string, policy: MissionClassificationPolicy, job: ClassificationJob): Promise<TaskClassification> {
  const mission = assertMissionAdmission(deps.db, teamId)
  const limits = { ...CLASSIFICATION_LIMITS, ...policy.limits }
  const specialized = policy.method === "x86" || (policy.specialized && job.type === "x86")
  const primary: Method = specialized ? { method: "x86", model: policy.helperModel, variant: policy.helperVariant, toolId: policy.x86ToolId || policy.toolId }
    : policy.method === "general" ? { method: "general", model: policy.generalModel ?? "", variant: policy.generalVariant }
    : { method: "jev", model: policy.helperModel, variant: policy.helperVariant, toolId: policy.toolId }
  // Validate task evidence before attempting any method; absence is not an outage.
  const x86Input = specialized ? validateX86Input(job.data) : undefined
  const jevInput = buildJevClassificationInput({ content: job.content, type: job.type, data: job.data }, job.manual, mission?.policy.assessment)
  const chain: Method[] = [primary, ...(policy.fallbacks ?? [])]
  let attempts = 0
  let lastError = new Error("No authorized classification method available")
  for (const method of chain) {
    for (let retry = 0; retry <= limits.retries && attempts < limits.maxAttempts; retry++) {
      if (!method.model) { lastError = new Error(`Set classification.${method.method === "general" ? "generalModel" : "helperModel"} explicitly; no classifier model has been selected`); break }
      const input = method.method === "x86" ? x86Input ?? validateX86Input(job.data) : jevInput
      const key = JSON.stringify([method.method, method.toolId ?? "", method.model, method.variant ?? ""])
      try {
        const classified = await withSlot(Math.min(limits.concurrency, deps.config.classification.limits?.concurrency ?? CLASSIFICATION_LIMITS.concurrency), async () => {
          const timeoutMs = reserve(deps, teamId, job.id, job.token, key, policy, Buffer.byteLength(JSON.stringify(input)))
          attempts++
          if (retry && limits.retryDelayMs) await new Promise(resolve => { setTimeout(resolve, Math.min(limits.retryDelayMs, timeoutMs)) })
          const lifecycle = {
            onCreated: (sessionID: string) => { deps.db.run("INSERT OR REPLACE INTO classification_helper (session_id, team_id, task_id, lease_until) VALUES (?, ?, ?, ?)", [sessionID, teamId, job.id, Date.now() + timeoutMs + 120_000]) },
            onRemoved: (sessionID: string) => { deps.db.run("DELETE FROM classification_helper WHERE session_id = ?", [sessionID]) },
            onRetained: (sessionID: string, error: unknown) => {
              deps.db.run("UPDATE classification_helper SET lease_until = ? WHERE session_id = ?", [Date.now(), sessionID])
              deps.db.run("UPDATE team SET mission_state = 'critical' WHERE id = ?", [teamId])
              incident(deps, teamId, job.id, "cleanup", key, `Retained helper ${sessionID}: ${String(error)}`)
            },
          }
          const remainingTimeout = Math.max(1, timeoutMs - (retry ? limits.retryDelayMs : 0))
          const raw = method.method === "general"
            ? await deps.classifier?.general?.({ directory: deps.directory, model: method.model, variant: method.variant, timeoutMs: remainingTimeout, input, ...lifecycle })
            : await deps.classifier?.invoke({ directory: deps.directory, model: method.model, variant: method.variant, timeoutMs: remainingTimeout, toolId: method.toolId ?? "", input, ...lifecycle })
          if (!deps.classifier || (method.method === "general" && !deps.classifier.general)) throw new Error("Native classification method unavailable")
          return method.method === "x86" ? normalizeX86Classification(raw, job.manual)
            : method.method === "general" ? normalizeGeneralClassification(raw, method.model, job.manual) : normalizeJevClassification(raw, job.manual)
        })
        updateMethod(deps.db, teamId, key, true, limits)
        if (method !== primary) incident(deps, teamId, job.id, "fallback", key, `Authorized fallback used: ${method.method} on ${method.model}; prior method: ${lastError.message}`)
        return { ...classified, method: method.method, toolId: method.toolId, classifierModel: method.model, variant: method.variant }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error
        lastError = error instanceof Error ? error : new Error(String(error))
        if (error instanceof AdmissionFailure) {
          if (error.critical) {
            deps.db.run("UPDATE team SET mission_state = ? WHERE id = ?", [policy.missionMode === "long_run" ? "critical" : "attention", teamId])
            incident(deps, teamId, job.id, "budget", key, error.message)
            throw error
          }
          break
        }
        updateMethod(deps.db, teamId, key, false, limits)
        incident(deps, teamId, job.id, "failure", key, lastError.message)
        if (/Classifier (?:hook )?cleanup failed/.test(lastError.message)) {
          deps.db.run("UPDATE team SET mission_state = 'critical' WHERE id = ?", [teamId])
          throw lastError // Never allocate another helper when cleanup safety is uncertain.
        }
      }
    }
  }
  throw lastError
}

interface Method { method: "jev" | "general" | "x86"; model: string; variant?: string; toolId?: string }
interface MethodState { failures: number; openUntil: number; rechecks: number }
interface Runtime { calls: number; bytes: number; started: number; methods: Record<string, MethodState> }

class AdmissionFailure extends Error {
  constructor(message: string, readonly critical = false) { super(message) }
}

function runtime(db: Database, teamId: string): Runtime {
  const row = db.query("SELECT classification_runtime FROM team WHERE id = ?").get(teamId) as { classification_runtime: string | null } | null
  return row?.classification_runtime ? JSON.parse(row.classification_runtime) as Runtime : { calls: 0, bytes: 0, started: Date.now(), methods: {} }
}

function reserve(deps: ToolDeps, teamId: string, taskId: string, token: string, key: string, policy: MissionClassificationPolicy, bytes: number): number {
  assertMissionAdmission(deps.db, teamId)
  const limits = { ...CLASSIFICATION_LIMITS, ...policy.limits }
  return deps.db.transaction(() => {
    const team = deps.db.query("SELECT status, mission_state, classification_policy FROM team WHERE id = ?").get(teamId) as { status: string; mission_state: string; classification_policy: string } | null
    if (team?.status !== "active" || team.mission_state === "critical" || team.classification_policy !== JSON.stringify(policy)) throw new AdmissionFailure("Classification admission changed; discard this evaluation")
    const task = deps.db.query("SELECT classification_attempts, classification_token, classification_status FROM team_task WHERE id = ? AND team_id = ?").get(taskId, teamId) as { classification_attempts: number; classification_token: string | null; classification_status: string } | null
    if (task?.classification_token !== token || task.classification_status !== "running") throw new AdmissionFailure("Classification admission token changed; discard this evaluation")
    if (task.classification_attempts >= limits.maxAttempts) throw new AdmissionFailure("Task classification attempt budget exhausted")
    const state = runtime(deps.db, teamId)
    const remaining = limits.maxDurationMs - (Date.now() - state.started)
    if (state.calls >= limits.maxCalls || state.bytes + bytes > limits.maxInputBytes || remaining <= 0) throw new AdmissionFailure("Classification hard call/time/input-volume budget exhausted", true)
    const method = state.methods[key]
    if (method && method.failures >= limits.circuitThreshold) {
      if (method.openUntil > Date.now() || method.rechecks >= limits.maxCircuitRechecks) throw new AdmissionFailure("Classifier circuit open; authorized fallback required")
      method.rechecks++
      // A half-open reservation permits only one probe, including across sessions.
      method.openUntil = Date.now() + limits.circuitCooldownMs
    }
    state.calls++
    state.bytes += bytes
    deps.db.run("UPDATE team SET classification_runtime = ? WHERE id = ?", [JSON.stringify(state), teamId])
    deps.db.run("UPDATE team_task SET classification_attempts = classification_attempts + 1 WHERE id = ? AND team_id = ?", [taskId, teamId])
    return Math.min(policy.timeoutMs, remaining)
  })()
}

function updateMethod(db: Database, teamId: string, key: string, success: boolean, limits: Required<import("./mission-classification").ClassificationLimits>): void {
  db.transaction(() => {
    const state = runtime(db, teamId)
    const previous = state.methods[key] ?? { failures: 0, openUntil: 0, rechecks: 0 }
    state.methods[key] = success ? { failures: 0, openUntil: 0, rechecks: previous.rechecks } : { ...previous, failures: previous.failures + 1, openUntil: previous.failures + 1 >= limits.circuitThreshold ? Date.now() + limits.circuitCooldownMs : 0 }
    db.run("UPDATE team SET classification_runtime = ? WHERE id = ?", [JSON.stringify(state), teamId])
  })()
}

function incident(deps: ToolDeps, teamId: string, taskId: string, kind: string, method: string, detail: string): void {
  const text = detail.slice(0, 2000)
  deps.db.run("INSERT INTO classification_incident (id, team_id, task_id, kind, method, detail, time_created) VALUES (?, ?, ?, ?, ?, ?, ?)", [generateId("incident"), teamId, taskId, kind, method, text, Date.now()])
  if (["fallback", "budget", "cleanup"].includes(kind)) notifyLead(deps.client, deps.db, teamId, `Classification ${kind} for task ${taskId}: ${text}`)
}

function validateX86Input(data: Record<string, unknown> | null): Record<string, unknown> {
  if (!data || typeof data.assembly !== "string" || !data.assembly.trim() || !["x86-32", "x86-64"].includes(String(data.architecture))) throw new Error("x86 classification requires assembly and architecture (x86-32 or x86-64); missing evidence cannot be invented")
  if (data.metadata !== undefined && (!data.metadata || typeof data.metadata !== "object" || Array.isArray(data.metadata))) throw new Error("x86 metadata must be an object")
  return { assembly: data.assembly, architecture: data.architecture, ...(data.metadata !== undefined ? { metadata: data.metadata } : {}) }
}

interface Slots { active: number; waiting: Array<() => void> }
const slots: Slots = { active: 0, waiting: [] }

async function withSlot<T>(capacity: number, work: () => Promise<T>): Promise<T> {
  const state = slots
  while (state.active >= capacity) await new Promise<void>(resolve => { state.waiting.push(resolve) })
  state.active++
  try { return await work() } finally {
    state.active--
    state.waiting.shift()?.()
  }
}
