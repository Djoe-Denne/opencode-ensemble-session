import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Database } from "./db"
import type { ToolDeps } from "./types"
import { findTeamBySession } from "./types"
import { executeTeamCreate } from "./tools/team-create"
import { classificationReadiness, getMissionClassification, type MissionClassificationConfig } from "./mission-classification"
import { routeMissionModel, validateMissionModelPolicy, type MissionModelPolicy, type MissionPolicyModel } from "./mission-model-policy"
import { canonicalizeVariantLabel } from "./variant-effort"
import { createExecutionPolicy, nativeExecutionCatalogue, planningCatalogue, routeExecution, validateExecutionPolicy, validateTaskExecutionDecision, type AuthorizedTaskExecution, type ExecutionPolicy, type TaskModelRoute } from "./execution-policy"
import { routeNormalizedModel } from "./model-router"
import { verificationInstructions } from "./verification-policy"

type ModelPolicy = MissionModelPolicy | ExecutionPolicy

function validatePolicy(value: unknown): asserts value is ModelPolicy {
  if (value && typeof value === "object" && "version" in value && (value.version === 2 || value.version === 3)) validateExecutionPolicy(value)
  else validateMissionModelPolicy(value)
}

/** A persisted mission proposal, isolated from legacy teams. */
export interface MissionProposal {
  teamId: string
  policyPath: string
}

/** A versioned policy presentation or approval. */
export interface MissionPolicySnapshot extends MissionProposal {
  hash: string
  revision: number
  objective: string
  policy: ModelPolicy
  presentationToken: number
  approved: boolean
  /** Non-schema content removed from the draft, plus any draft repairs. */
  warnings: string[]
  /** Classification block extracted from the draft; consumed by the config command. */
  classificationOverride?: Partial<MissionClassificationConfig>
}

interface PolicyRow {
  team_id: string
  policy_path: string
  objective: string
  presented_hash: string | null
  approved_hash: string | null
  approved_json: string | null
  revision: number
  time_updated: number
}

function row(db: Database, teamId: string): PolicyRow | undefined {
  return db.query("SELECT * FROM mission_policy WHERE team_id = ?").get(teamId) as PolicyRow | undefined
}

function directSnapshot(db: Database, teamId: string): MissionPolicySnapshot | undefined {
  const revision = db.query("SELECT revision, policy_hash, policy_json FROM mission_policy_revision WHERE team_id = ? ORDER BY revision DESC LIMIT 1")
    .get(teamId) as { revision: number; policy_hash: string; policy_json: string } | null
  if (!revision) return undefined
  const policy: unknown = JSON.parse(revision.policy_json)
  if (!policy || typeof policy !== "object" || !("version" in policy) || (policy.version !== 2 && policy.version !== 3)) return undefined
  validateExecutionPolicy(policy)
  if (createHash("sha256").update(revision.policy_json).digest("hex") !== revision.policy_hash) throw new Error("Execution policy integrity mismatch")
  return { teamId, policyPath: "ensemble.json (frozen at team creation)", objective: "", hash: revision.policy_hash,
    revision: revision.revision, policy, presentationToken: 0, approved: true, warnings: [] }
}

function requireLead(deps: ToolDeps, teamId: string, sessionId: string): void {
  const team = findTeamBySession(deps.db, deps.registry, sessionId)
  if (team?.teamId !== teamId || team.role !== "lead") throw new Error("Only the mission lead can configure or approve its policy")
}

/** Root fields the model policy schema accepts; everything else is draft noise. */
const POLICY_FIELDS = ["version", "providers", "assessment", "complexityBands", "riskBands", "groups", "matrix", "verification"]

interface DraftRead {
  policy: ModelPolicy
  warnings: string[]
  classificationOverride?: Partial<MissionClassificationConfig>
  dirty: boolean
}

/**
 * Read a draft tolerantly. A top-level `classification` object is extracted for
 * the legitimate classifier-update path (config shape or frozen shape; a
 * `limits.timeoutMs` is hoisted). Unknown root fields are dropped. Both produce
 * warnings instead of failures, so a draft edit can never brick the mission.
 * The remaining policy still validates strictly.
 */
function readPolicyDraft(record: PolicyRow): DraftRead {
  if (statSync(record.policy_path).size > 256_000) throw new Error("Mission policy file exceeds 256 KB")
  const parsed: unknown = JSON.parse(readFileSync(record.policy_path, "utf8"))
  const warnings: string[] = []
  let classificationOverride: Partial<MissionClassificationConfig> | undefined
  let dirty = false
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const draft = parsed as Record<string, unknown>
    const classification = draft.classification
    if (classification !== undefined) {
      dirty = true
      delete draft.classification
      if (classification && typeof classification === "object" && !Array.isArray(classification)) {
        const block = { ...(classification as Record<string, unknown>) }
        if (typeof block.method === "string" && block.mode === undefined) block.mode = block.method === "manual" ? "off" : block.method
        const limits = block.limits !== null && typeof block.limits === "object" && !Array.isArray(block.limits)
          ? block.limits as Record<string, unknown> : undefined
        if (limits && limits.timeoutMs !== undefined) {
          if (block.timeoutMs === undefined) block.timeoutMs = limits.timeoutMs
          delete limits.timeoutMs
        }
        classificationOverride = block as Partial<MissionClassificationConfig>
      } else {
        warnings.push("draft.classification was ignored: it must be an object with mode/generalModel/helperModel fields.")
      }
    }
    Object.keys(draft).forEach(key => {
      if (!(draft.version === 2 || draft.version === 3 ? ["version", "providers", "models", "startingIntelligence", "classificationBeta", "verification", ...(draft.version === 3 ? ["planningIntelligenceRange"] : [])] : POLICY_FIELDS).includes(key)) {
        dirty = true
        delete draft[key]
        warnings.push(`draft.${key} was removed: the model policy accepts only ${POLICY_FIELDS.join(", ")}.`)
      }
    })
  }
  validatePolicy(parsed)
  return { policy: parsed, warnings, ...(classificationOverride ? { classificationOverride } : {}), dirty }
}

function readPolicy(record: PolicyRow): MissionPolicySnapshot {
  const draft = readPolicyDraft(record)
  const hash = createHash("sha256").update(JSON.stringify(draft.policy)).digest("hex")
  return { teamId: record.team_id, policyPath: record.policy_path, objective: record.objective, revision: record.revision, policy: draft.policy, hash,
    presentationToken: record.time_updated, approved: record.approved_hash === hash, warnings: draft.warnings,
    ...(draft.classificationOverride ? { classificationOverride: draft.classificationOverride } : {}) }
}

async function seedPolicy(deps: ToolDeps): Promise<ModelPolicy> {
  if (deps.config.missionPolicy) {
    validateMissionModelPolicy(deps.config.missionPolicy)
    return structuredClone(deps.config.missionPolicy)
  }
  const models = deps.nativeModels ? nativeExecutionCatalogue(deps.config.modelRouting.models, await deps.nativeModels()) : deps.config.modelRouting.models
  return createExecutionPolicy(models, deps.config.startingIntelligence, deps.config.modelRouting.beta, deps.config.planningIntelligenceRange)
}

/** Prepare a new mission without admitting execution or overwriting an existing team. */
export async function prepareMission(deps: ToolDeps, sessionId: string, objective: string): Promise<MissionProposal> {
  if (!objective.trim()) throw new Error("A mission objective is required")
  if (findTeamBySession(deps.db, deps.registry, sessionId)) throw new Error("This session already belongs to a team; configure that mission or use a new session")
  const policy = await seedPolicy(deps)
  let proposal: MissionProposal | undefined
  await executeTeamCreate(deps, { name: `mission-${createHash("sha256").update(`${sessionId}:${Date.now()}`).digest("hex").slice(0, 16)}` }, sessionId, teamId => {
    const policyPath = join(deps.directory, ".opencode", "missions", teamId, "model-policy.json")
    // The team and its fail-closed gate commit together, with the exact ID
    // allocated by team_create. No permissive legacy-team interval exists.
    deps.db.run("INSERT INTO mission_policy (team_id, objective, policy_path, time_updated) VALUES (?, ?, ?, ?)",
      [teamId, objective.trim(), policyPath, Date.now()])
    proposal = { teamId, policyPath }
  })
  if (!proposal) throw new Error("Mission team creation failed")
  const created = proposal as MissionProposal
  mkdirSync(join(deps.directory, ".opencode", "missions", created.teamId), { recursive: true })
  writeFileSync(created.policyPath, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx" })
  return created
}

/** Present a policy revision and pause future admission until explicit approval. */
export function openMissionConfiguration(deps: ToolDeps, teamId: string, sessionId: string, deferPresentation = false): MissionPolicySnapshot {
  requireLead(deps, teamId, sessionId)
  const record = row(deps.db, teamId)
  if (!record) throw new Error("This legacy team has no mission policy; prepare a mission in a new session")
  // Pause even if the edited proposal is malformed. Existing workers retain
  // their recorded policy revision; no new task is admitted until approval.
  deps.db.run("UPDATE mission_policy SET approved_hash = NULL, presented_hash = NULL, time_updated = MAX(time_updated + 1, ?) WHERE team_id = ?", [Date.now(), teamId])
  const current = row(deps.db, teamId)
  if (!current) throw new Error("Mission policy disappeared during configuration")
  const draft = readPolicyDraft(current)
  if (draft.dirty) {
    // Rewrite the draft without the extracted or dropped content so the file on
    // disk always matches the presented hash and can never re-brick config.
    writeFileSync(current.policy_path, `${JSON.stringify(draft.policy, null, 2)}\n`)
  }
  const snapshot = readPolicy(current)
  snapshot.warnings = [...draft.warnings]
  if (draft.classificationOverride) snapshot.classificationOverride = draft.classificationOverride
  if (!deferPresentation) markMissionPresented(deps.db, snapshot)
  return snapshot
}

/** Commit a successfully delivered preview only if its configuration is still current. */
export function markMissionPresented(db: Database, snapshot: MissionPolicySnapshot): void {
  const record = row(db, snapshot.teamId)
  if (!record || record.time_updated !== snapshot.presentationToken) return
  if (readPolicy(record).hash !== snapshot.hash) throw new Error("Mission policy changed during presentation; run config again")
  db.run("UPDATE mission_policy SET presented_hash = ? WHERE team_id = ? AND time_updated = ? AND approved_hash IS NULL AND presented_hash IS NULL",
    [snapshot.hash, snapshot.teamId, snapshot.presentationToken])
}

/** Approve the exact previously presented policy; not exposed as a team tool. */
export function approveMission(deps: ToolDeps, teamId: string, sessionId: string, availableModels?: readonly MissionPolicyModel[], expected?: MissionPolicySnapshot): MissionPolicySnapshot {
  requireLead(deps, teamId, sessionId)
  const record = row(deps.db, teamId)
  if (!record?.presented_hash) throw new Error("Run /ensemble-mission config to present a policy before start")
  if (expected && (record.time_updated !== expected.presentationToken || record.revision !== expected.revision || record.presented_hash !== expected.hash)) {
    throw new Error("Mission configuration changed while start was pending; present config and start again")
  }
  const snapshot = readPolicy(record)
  if (snapshot.classificationOverride) throw new Error("The draft carries an unapplied classification block; run /ensemble-mission config again to apply and present it")
  if (snapshot.hash !== record.presented_hash) throw new Error("Mission policy changed; run /ensemble-mission config again before start")
  const available = availableModels ?? deps.config.modelRouting.models.filter(model => model.available).map(model => ({ id: model.id,
    ...(model.reasoningEffort && model.reasoningEffort !== "default" ? { variant: model.reasoningEffort } : {}) }))
  const assertModel = (model: MissionPolicyModel): void => {
    if (!snapshot.policy.providers.includes(model.id.slice(0, model.id.indexOf("/")))) throw new Error(`Model ${model.id} uses a provider not authorized for this mission`)
    const native = available.filter(candidate => candidate.id === model.id)
    if (!native.some(candidate => candidate.variant === model.variant)) {
      const ids = native.map(candidate => candidate.variant ?? "default")
      const alias = model.variant ? canonicalizeVariantLabel(model.variant) : undefined
      const aliasNote = alias ? ` Canonical effort for this label is ${alias}; that alias is not sent to the host unless the same string is a native variant id.` : ""
      throw new Error(`Mission model/variant unavailable: ${model.id} (${model.variant ?? "default"}). Native variant ids: ${ids.join(", ") || "none"}.${aliasNote}`)
    }
    if (deps.config.modelRouting.models.some(candidate => candidate.id === model.id && (candidate.reasoningEffort === "default" ? undefined : candidate.reasoningEffort) === model.variant && !candidate.available)) {
      throw new Error(`Mission model/variant disabled by the operator: ${model.id}`)
    }
  }
  const candidates = snapshot.policy.version !== 1
    ? snapshot.policy.models.map(model => ({ id: model.id, ...(model.reasoningEffort && model.reasoningEffort !== "default" ? { variant: model.reasoningEffort } : {}) }))
    : Object.values(snapshot.policy.groups).flat()
  candidates.forEach(assertModel)
  const classifier = getMissionClassification(deps.db, teamId)
  if (classifier && (classifier.method !== "manual" || classifier.specialized)) {
    const id = classifier.method === "general" ? classifier.generalModel : classifier.helperModel
    const variant = classifier.method === "general" ? classifier.generalVariant : classifier.helperVariant
    if (id) assertModel({ id, ...(variant ? { variant } : {}) })
    ;(classifier.fallbacks ?? []).forEach(fallback => { assertModel({ id: fallback.model, ...(fallback.variant ? { variant: fallback.variant } : {}) }) })
  }
  const readiness = classificationReadiness(classifier)
  if (!readiness.ready) throw new Error(readiness.reason)
  if (record.approved_hash === snapshot.hash) return { ...snapshot, approved: true }
  const latest = deps.db.query("SELECT revision, policy_hash, policy_json FROM mission_policy_revision WHERE team_id = ? ORDER BY revision DESC LIMIT 1")
    .get(teamId) as { revision: number; policy_hash: string; policy_json: string } | null
  if (latest?.policy_hash === snapshot.hash) {
    const restored = deps.db.run("UPDATE mission_policy SET approved_hash = ?, approved_json = ?, time_updated = MAX(time_updated + 1, ?) WHERE team_id = ? AND presented_hash = ? AND revision = ? AND time_updated = ?",
      [snapshot.hash, latest.policy_json, Date.now(), teamId, snapshot.hash, record.revision, record.time_updated])
    if (!restored.changes) throw new Error("Mission policy approval raced with another configuration; run config again")
    return { ...snapshot, revision: latest.revision, approved: true }
  }
  const previous: unknown = record.approved_json ? JSON.parse(record.approved_json) : undefined
  if (previous !== undefined) validatePolicy(previous)
  const rubricChanged = previous !== undefined && JSON.stringify(previous.version === 1 ? previous.assessment : undefined) !== JSON.stringify(snapshot.policy.version === 1 ? snapshot.policy.assessment : undefined)
  const revision = record.revision + 1
  deps.db.transaction(() => {
    deps.db.run("INSERT INTO mission_policy_revision (team_id, revision, policy_hash, policy_json, time_created) VALUES (?, ?, ?, ?, ?)",
      [teamId, revision, snapshot.hash, JSON.stringify(snapshot.policy), Date.now()])
    const updated = deps.db.run("UPDATE mission_policy SET approved_hash = ?, approved_json = ?, revision = ?, time_updated = MAX(time_updated + 1, ?) WHERE team_id = ? AND presented_hash = ? AND revision = ? AND time_updated = ?",
      [snapshot.hash, JSON.stringify(snapshot.policy), revision, Date.now(), teamId, snapshot.hash, record.revision, record.time_updated])
    if (!updated.changes) throw new Error("Mission policy approval raced with another configuration; run config again")
    if (rubricChanged && classifier && (classifier.method !== "manual" || classifier.specialized)) {
      // Old in-flight tokens cannot publish scores under a newly approved rubric.
      // Re-evaluate only unassigned work; never reset aggregate mission budgets
      // or disturb a running worker's already-admitted policy revision.
      deps.db.run("UPDATE team_task SET classification_status = CASE WHEN ? = 'manual' AND NOT (? = 1 AND task_type = 'x86') THEN 'not_required' ELSE 'pending' END, classification_result = NULL, classification_token = NULL, classification_until = NULL, classification_error = NULL, classification_attempts = 0 WHERE team_id = ? AND status IN ('pending', 'blocked') AND assignee IS NULL AND (complexity IS NULL OR risk IS NULL)",
        [classifier.method, classifier.specialized ? 1 : 0, teamId])
    }
  })()
  return { ...snapshot, revision, approved: true }
}

/** Read a currently presented policy without opening a new configuration generation. */
export function getPresentedMission(deps: ToolDeps, teamId: string, sessionId: string): MissionPolicySnapshot {
  requireLead(deps, teamId, sessionId)
  const record = row(deps.db, teamId)
  if (!record?.presented_hash) throw new Error("Run /ensemble-mission config before start")
  const snapshot = readPolicy(record)
  if (snapshot.classificationOverride) throw new Error("The draft carries an unapplied classification block; run /ensemble-mission config again to apply and present it")
  if (snapshot.hash !== record.presented_hash) throw new Error("Mission policy changed; run config before start")
  return snapshot
}

/** Reject new execution for draft or modified policies; legacy teams remain compatible. */
export function assertMissionAdmission(db: Database, teamId: string): MissionPolicySnapshot | undefined {
  const record = row(db, teamId)
  if (!record) return directSnapshot(db, teamId)
  if (!record.approved_hash) throw new Error("Mission policy is not approved; use /ensemble-mission config then start")
  const snapshot = readPolicy(record)
  if (snapshot.hash !== record.approved_hash) throw new Error("Mission policy changed after approval; run /ensemble-mission config then start")
  return snapshot
}

/** Whether a team has an approved mission or a catalogue snapshot frozen at direct creation. */
export function hasMissionPolicy(db: Database, teamId: string): boolean {
  return Boolean(row(db, teamId) || directSnapshot(db, teamId))
}

/** Describe durable policy and admission state without copying rules into context. */
export function missionPolicySummary(db: Database, teamId: string): string | undefined {
  const record = row(db, teamId)
  if (!record) {
    const direct = directSnapshot(db, teamId)
    return direct ? `Task execution: frozen catalogue; strong planning start, autonomous reasoning on the same model. Classification is opt-in. ${verificationInstructions(direct.policy.verification)}` : undefined
  }
  let state = "draft (not approved)"
  if (record.approved_hash) {
    try { assertMissionAdmission(db, teamId); state = `approved v${record.revision}` } catch (error) {
      state = `blocked (${error instanceof Error ? error.message : String(error)})`
    }
  }
  const verification = record.approved_json ? verificationInstructions((JSON.parse(record.approved_json) as ModelPolicy).verification) : "QA scope is proposed in /ensemble-mission config."
  return `Mission policy: ${state}; file=${record.policy_path}. Use /ensemble-mission config then /ensemble-mission start. New admission is gated in code; already-admitted tasks retain their policy revision. Follow the admitted task's execution policy; do not substitute an unapproved model. ${verification}`
}

/** Resolve a score-free planning start or explicitly supplied classification, without overriding task scores. */
export function routeMissionTask(db: Database, teamId: string, taskId?: string, scores: { complexity?: number; risk?: number } = {}): (TaskModelRoute & { policyRevision: number; policyHash: string }) | undefined {
  const snapshot = assertMissionAdmission(db, teamId)
  if (!snapshot) return undefined
  return { ...previewMissionTask(db, snapshot, taskId, scores), policyRevision: snapshot.revision, policyHash: snapshot.hash }
}

function normalizedScore(value: unknown, dimension: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Classifier ${dimension} must be a finite normalized score from 0 to 1`)
  const scaled = value * 100
  const integer = Math.round(scaled)
  // Snap binary multiplication noise only (e.g. 0.28 * 100 > 28 by one ULP).
  // Truly fractional percentages still round up; raw classifier data is retained.
  const stable = Math.abs(scaled - integer) <= 4 * Number.EPSILON * Math.abs(scaled) ? integer : scaled
  return Math.ceil(stable)
}

/** Preview using the same score normalization and pure resolver as real admission. */
export function previewMissionTask(db: Database, snapshot: MissionPolicySnapshot, taskId?: string, scores: { complexity?: number; risk?: number } = {}): TaskModelRoute {
  const task = taskId ? db.query("SELECT complexity, risk, classification_result, execution_request, execution_decision FROM team_task WHERE id = ? AND team_id = ?").get(taskId, snapshot.teamId) as
    { complexity: number | null; risk: number | null; classification_result: string | null; execution_request: string | null; execution_decision: string | null } | null : undefined
  if (taskId && !task) throw new Error(`Task ${taskId} not found in this mission`)
  const authorization = task?.execution_decision ? JSON.parse(task.execution_decision) as AuthorizedTaskExecution : undefined
  if (task?.execution_request && !authorization) throw new Error("Task execution proposal requires a supervisor decision before admission")
  if (authorization) {
    validateTaskExecutionDecision(authorization, snapshot.policy.version !== 1 ? snapshot.policy : undefined)
    if (snapshot.policy.version === 1 && (authorization.model !== undefined || authorization.variant !== undefined)) throw new Error("Explicit execution choices require an approved catalogue policy")
    const lead = db.query("SELECT lead_session_id FROM team WHERE id = ?").get(snapshot.teamId) as { lead_session_id: string }
    if (authorization.authorizedBy !== lead.lead_session_id) throw new Error("Task execution requires supervisor authorization")
    if (authorization.mode === "direct") {
      if (snapshot.policy.version === 1) throw new Error("Direct tasks require an approved execution catalogue")
      if (scores.complexity !== undefined || scores.risk !== undefined) throw new Error("Direct execution does not accept score overrides")
      return routeExecution(snapshot.policy, `${snapshot.teamId}:${taskId}:${snapshot.hash}`, undefined, authorization)
    }
  }
  const classified = task?.classification_result ? JSON.parse(task.classification_result) as { complexity?: unknown; risk?: unknown } : undefined
  const complexity = task ? task.complexity ?? normalizedScore(classified?.complexity, "complexity") : scores.complexity
  const risk = task ? task.risk ?? normalizedScore(classified?.risk, "risk") : scores.risk
  if (task && ((scores.complexity !== undefined && scores.complexity !== complexity) || (scores.risk !== undefined && scores.risk !== risk))) throw new Error("Mission spawn scores cannot override recorded task scores")
  if (snapshot.policy.version !== 1) {
    const policy = snapshot.policy
    const classifier = getMissionClassification(db, snapshot.teamId)
    const needsScores = classifier && (classifier.method !== "manual" || classifier.specialized)
    if ((needsScores || complexity !== undefined || risk !== undefined) && (complexity === undefined || risk === undefined)) throw new Error("Explicit classification requires both complexity and risk")
    const selected = !authorization?.model && complexity !== undefined && risk !== undefined
      ? routeNormalizedModel({ models: planningCatalogue(policy), beta: policy.classificationBeta, complexity: complexity / 100, risk: risk / 100 }).selected
      : undefined
    const route = routeExecution(policy, `${snapshot.teamId}:${taskId ?? "standalone"}:${snapshot.hash}`,
      selected ? { id: selected.id, ...(selected.reasoningEffort && selected.reasoningEffort !== "default" ? { variant: selected.reasoningEffort } : {}) } : undefined, authorization)
    return { ...route, ...(complexity !== undefined ? { complexity, risk } : {}) }
  }
  if (complexity === undefined || risk === undefined) throw new Error("Mission execution requires both complexity and risk; missing scores never default to zero")
  return routeMissionModel(snapshot.policy, { complexity, risk })
}

/** Persist a task's exact model, native variant and approved policy provenance. */
export function saveMissionTaskRoute(db: Database, teamId: string, taskId: string, assignee: string, route: NonNullable<ReturnType<typeof routeMissionTask>>): void {
  // A fresh claim must not accept a late native completion from a previous claim.
  const json = JSON.stringify("execution" in route ? { ...route, assignmentID: randomUUID() } : route)
  db.run("UPDATE team_task SET model_routing = ? WHERE id = ? AND team_id = ?", [json, taskId, teamId])
  db.run("UPDATE team_member SET model = ?, model_variant = ?, model_routing = ? WHERE team_id = ? AND name = ?",
    [route.selected.id, route.selected.variant ?? null, json, teamId, assignee])
}

/** Verify every governed delivery against its admitted, immutable policy revision. */
export function assertMissionMemberModel(db: Database, teamId: string, stored: { model: string | null; model_variant: string | null; model_routing: string | null } | null, memberName?: string): void {
  if (!hasMissionPolicy(db, teamId)) return
  try {
    if (!stored?.model || !stored.model_routing) throw new Error("missing model or routing record")
    const route = JSON.parse(stored.model_routing) as Partial<NonNullable<ReturnType<typeof routeMissionTask>>>
    if (!Number.isInteger(route.policyRevision)) throw new Error("missing revision")
    const revision = db.query("SELECT policy_hash, policy_json FROM mission_policy_revision WHERE team_id = ? AND revision = ?").get(teamId, route.policyRevision ?? 0) as
      { policy_hash: string; policy_json: string } | null
    if (!revision || revision.policy_hash !== route.policyHash) throw new Error("unknown approved revision")
    const policy: unknown = JSON.parse(revision.policy_json)
    validatePolicy(policy)
    if (createHash("sha256").update(JSON.stringify(policy)).digest("hex") !== revision.policy_hash) throw new Error("approved revision integrity mismatch")
    if (policy.version !== 1) {
      if (!("execution" in route) || !route.execution || route.execution.applying) throw new Error("execution transition is pending or missing")
      if (route.selected?.id !== stored.model) throw new Error("task model changed")
      if (policy.version === 3) {
        const authorization = "authorization" in route ? route.authorization : undefined
        if (authorization) {
          const lead = db.query("SELECT lead_session_id FROM team WHERE id=?").get(teamId) as { lead_session_id: string }
          if (authorization.authorizedBy !== lead.lead_session_id) throw new Error("task selection lacks supervisor authorization")
        }
        const initial = routeExecution(policy, "provenance-check", route.selected, authorization)
        if (initial.selected.id !== route.selected.id || initial.selected.variant !== route.selected.variant) throw new Error("initial task selection disagrees with its authorization")
      }
      if (route.execution.variant !== (stored.model_variant ?? undefined) || !policy.models.some(model => model.id === stored.model && (model.reasoningEffort === "default" ? undefined : model.reasoningEffort) === (stored.model_variant ?? undefined))) throw new Error("reasoning is outside the approved catalogue")
      return
    }
    if (typeof route.complexity !== "number" || typeof route.risk !== "number") throw new Error("missing scores")
    const expected = routeMissionModel(policy, { complexity: route.complexity, risk: route.risk })
    const routeAgrees = route.group === expected.group && route.selected?.id === expected.selected.id && route.selected.variant === expected.selected.variant
    const modelAgrees = stored.model === expected.selected.id && (stored.model_variant ?? undefined) === expected.selected.variant
    if (!routeAgrees || !modelAgrees) {
      const alternative = expected.alternatives.some(model => model.id === stored.model && (model.variant ?? undefined) === (stored.model_variant ?? undefined))
      const journal = alternative && memberName
        ? db.query("SELECT id FROM member_provider_attempt WHERE team_id = ? AND member_name = ? AND kind = 'failover' AND model = ? AND ((variant IS NULL AND ? IS NULL) OR variant = ?) LIMIT 1")
          .get(teamId, memberName, stored.model, stored.model_variant, stored.model_variant)
        : null
      if (!routeAgrees || !journal) throw new Error("stored model or variant disagrees with its approved cell")
    }
  } catch (error) { throw new Error(`Mission model provenance invalid: ${error instanceof Error ? error.message : String(error)}`) }
}
