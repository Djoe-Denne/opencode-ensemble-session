import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Database } from "./db"
import type { ToolDeps } from "./types"
import { findTeamBySession } from "./types"
import { executeTeamCreate } from "./tools/team-create"
import { classificationReadiness, getMissionClassification, type MissionClassificationConfig } from "./mission-classification"
import { routeMissionModel, validateMissionModelPolicy, type MissionModelPolicy, type MissionPolicyModel, type MissionPolicyRoute } from "./mission-model-policy"
import { canonicalizeVariantLabel } from "./variant-effort"

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
  policy: MissionModelPolicy
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

function requireLead(deps: ToolDeps, teamId: string, sessionId: string): void {
  const team = findTeamBySession(deps.db, deps.registry, sessionId)
  if (team?.teamId !== teamId || team.role !== "lead") throw new Error("Only the mission lead can configure or approve its policy")
}

/** Root fields the model policy schema accepts; everything else is draft noise. */
const POLICY_FIELDS = ["version", "providers", "assessment", "complexityBands", "riskBands", "groups", "matrix"]

interface DraftRead {
  policy: MissionModelPolicy
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
      if (!POLICY_FIELDS.includes(key)) {
        dirty = true
        delete draft[key]
        warnings.push(`draft.${key} was removed: the model policy accepts only ${POLICY_FIELDS.join(", ")}.`)
      }
    })
  }
  validateMissionModelPolicy(parsed)
  return { policy: parsed as MissionModelPolicy, warnings, ...(classificationOverride ? { classificationOverride } : {}), dirty }
}

function readPolicy(record: PolicyRow): MissionPolicySnapshot {
  const draft = readPolicyDraft(record)
  const hash = createHash("sha256").update(JSON.stringify(draft.policy)).digest("hex")
  return { teamId: record.team_id, policyPath: record.policy_path, objective: record.objective, revision: record.revision, policy: draft.policy, hash,
    presentationToken: record.time_updated, approved: record.approved_hash === hash, warnings: draft.warnings,
    ...(draft.classificationOverride ? { classificationOverride: draft.classificationOverride } : {}) }
}

function seedPolicy(deps: ToolDeps): MissionModelPolicy {
  if (deps.config.missionPolicy) {
    validateMissionModelPolicy(deps.config.missionPolicy)
    return structuredClone(deps.config.missionPolicy)
  }
  const models = deps.config.modelRouting.models.filter(model => model.available)
    .toSorted((a, b) => a.intelligenceScore - b.intelligenceScore || a.averageCostPerTask - b.averageCostPerTask || a.id.localeCompare(b.id) || (a.reasoningEffort ?? "").localeCompare(b.reasoningEffort ?? ""))
  if (!models.length) throw new Error("Configure missionPolicy or a nonempty modelRouting catalogue in ensemble.json before preparing a mission")
  const candidate = (index: number): MissionPolicyModel => {
    const model = models[index]
    if (!model) throw new Error("Mission catalogue is empty")
    return { id: model.id, ...(model.reasoningEffort && model.reasoningEffort !== "default" ? { variant: model.reasoningEffort } : {}) }
  }
  // Catalogue scores seed a visible draft only. Approved routing never reads them.
  const policy: MissionModelPolicy = {
    version: 1,
    providers: [...new Set(models.map(model => model.id.slice(0, model.id.indexOf("/"))))].sort(),
    assessment: {
      complexity: ["Low: local, clear requirements and established patterns.", "High: ambiguous contracts, interacting components or difficult reconstruction."],
      risk: ["Low: isolated, reversible failure with limited impact.", "High: security, persisted data, compatibility or critical correctness is at stake."],
    },
    complexityBands: [0, 34, 67, 101], riskBands: [0, 34, 67, 101],
    groups: { light: [candidate(0)], standard: [candidate(Math.floor((models.length - 1) / 2))], strong: [candidate(models.length - 1)] },
    matrix: [["light", "standard", "strong"], ["standard", "standard", "strong"], ["strong", "strong", "strong"]],
  }
  validateMissionModelPolicy(policy)
  return policy
}

/** Prepare a new mission without admitting execution or overwriting an existing team. */
export async function prepareMission(deps: ToolDeps, sessionId: string, objective: string): Promise<MissionProposal> {
  if (!objective.trim()) throw new Error("A mission objective is required")
  if (findTeamBySession(deps.db, deps.registry, sessionId)) throw new Error("This session already belongs to a team; configure that mission or use a new session")
  const policy = seedPolicy(deps)
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
  Object.values(snapshot.policy.groups).flat().forEach(assertModel)
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
  const previous = record.approved_json ? JSON.parse(record.approved_json) as MissionModelPolicy : undefined
  if (previous !== undefined) validateMissionModelPolicy(previous)
  const rubricChanged = previous !== undefined && JSON.stringify(previous.assessment) !== JSON.stringify(snapshot.policy.assessment)
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
  if (!record) return undefined
  if (!record.approved_hash) throw new Error("Mission policy is not approved; use /ensemble-mission config then start")
  const snapshot = readPolicy(record)
  if (snapshot.hash !== record.approved_hash) throw new Error("Mission policy changed after approval; run /ensemble-mission config then start")
  return snapshot
}

/** Whether a team uses explicit mission policy rather than legacy assignment. */
export function hasMissionPolicy(db: Database, teamId: string): boolean {
  return Boolean(row(db, teamId))
}

/** Describe durable policy and admission state without copying rules into context. */
export function missionPolicySummary(db: Database, teamId: string): string | undefined {
  const record = row(db, teamId)
  if (!record) return undefined
  let state = "draft (not approved)"
  if (record.approved_hash) {
    try { assertMissionAdmission(db, teamId); state = `approved v${record.revision}` } catch (error) {
      state = `blocked (${error instanceof Error ? error.message : String(error)})`
    }
  }
  return `Mission policy: ${state}; deterministic complexity/risk grid; file=${record.policy_path}. Use /ensemble-mission config then /ensemble-mission start. New admission is gated in code; already-admitted tasks retain their policy revision. Do not override models or retain corrections only in conversation.`
}

/** Resolve complete recorded scores, refusing to replace task scores at spawn. */
export function routeMissionTask(db: Database, teamId: string, taskId?: string, scores: { complexity?: number; risk?: number } = {}): (MissionPolicyRoute & { policyRevision: number; policyHash: string }) | undefined {
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
export function previewMissionTask(db: Database, snapshot: MissionPolicySnapshot, taskId?: string, scores: { complexity?: number; risk?: number } = {}): MissionPolicyRoute {
  const task = taskId ? db.query("SELECT complexity, risk, classification_result FROM team_task WHERE id = ? AND team_id = ?").get(taskId, snapshot.teamId) as
    { complexity: number | null; risk: number | null; classification_result: string | null } | null : undefined
  if (taskId && !task) throw new Error(`Task ${taskId} not found in this mission`)
  const classified = task?.classification_result ? JSON.parse(task.classification_result) as { complexity?: unknown; risk?: unknown } : undefined
  const complexity = task ? task.complexity ?? normalizedScore(classified?.complexity, "complexity") : scores.complexity
  const risk = task ? task.risk ?? normalizedScore(classified?.risk, "risk") : scores.risk
  if (task && ((scores.complexity !== undefined && scores.complexity !== complexity) || (scores.risk !== undefined && scores.risk !== risk))) throw new Error("Mission spawn scores cannot override recorded task scores")
  if (complexity === undefined || risk === undefined) throw new Error("Mission execution requires both complexity and risk; missing scores never default to zero")
  return routeMissionModel(snapshot.policy, { complexity, risk })
}

/** Persist a task's exact model, native variant and approved policy provenance. */
export function saveMissionTaskRoute(db: Database, teamId: string, taskId: string, assignee: string, route: NonNullable<ReturnType<typeof routeMissionTask>>): void {
  const json = JSON.stringify(route)
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
    if (!Number.isInteger(route.policyRevision) || typeof route.complexity !== "number" || typeof route.risk !== "number") throw new Error("missing revision or scores")
    const revision = db.query("SELECT policy_hash, policy_json FROM mission_policy_revision WHERE team_id = ? AND revision = ?").get(teamId, route.policyRevision ?? 0) as
      { policy_hash: string; policy_json: string } | null
    if (!revision || revision.policy_hash !== route.policyHash) throw new Error("unknown approved revision")
    const policy: unknown = JSON.parse(revision.policy_json)
    validateMissionModelPolicy(policy)
    if (createHash("sha256").update(JSON.stringify(policy)).digest("hex") !== revision.policy_hash) throw new Error("approved revision integrity mismatch")
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
