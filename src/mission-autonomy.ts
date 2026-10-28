import type { Database } from "./db"
import { createHash } from "node:crypto"

/** User-delegated decision priorities, approved with the mission rather than its classifier. */
export interface MissionAutonomyPolicy {
  mode: "supervised" | "long_run"
  instructions?: string[]
}

/** Validate an autonomy proposal before it can enter the approved policy. */
export function validateMissionAutonomyPolicy(value: unknown): asserts value is MissionAutonomyPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("autonomy must be an object")
  const policy = value as Record<string, unknown>
  if (Object.keys(policy).some(key => !["mode", "instructions"].includes(key))) throw new Error("Unknown autonomy field")
  if (policy.mode !== "supervised" && policy.mode !== "long_run") throw new Error("Invalid autonomy.mode")
  const instructions = policy.instructions
  if (instructions !== undefined && (!Array.isArray(instructions) || instructions.length > 50 || instructions.some(item => typeof item !== "string" || !item.trim() || item.length > 2000))) {
    throw new Error("autonomy.instructions must contain nonempty strings (at most 50, 2000 characters each)")
  }
  if (policy.mode === "long_run" && (!Array.isArray(instructions) || !instructions.length)) throw new Error("long_run autonomy requires user decision instructions")
}

/** Read the last approved delegation, independently of draft edits and classification. */
export function getApprovedMissionAutonomy(db: Database, teamId: string): MissionAutonomyPolicy | undefined {
  // Revisions are written only by approval (or explicit direct-team creation).
  // Never read the mutable draft or classification settings here. Configuration
  // pauses new admission but does not revoke the last approved worker contract.
  const revision = db.query("SELECT policy_json, policy_hash FROM mission_policy_revision WHERE team_id = ? ORDER BY revision DESC LIMIT 1")
    .get(teamId) as { policy_json: string; policy_hash: string } | null
  if (!revision) return undefined
  if (createHash("sha256").update(revision.policy_json).digest("hex") !== revision.policy_hash) throw new Error("Mission autonomy policy integrity mismatch")
  const policy = JSON.parse(revision.policy_json) as { autonomy?: unknown }
  if (policy.autonomy === undefined) return undefined
  validateMissionAutonomyPolicy(policy.autonomy)
  return policy.autonomy
}

/** Render only the last approved autonomy contract as a stable system-prompt suffix. */
export function buildMissionAutonomyPrompt(db: Database, teamId: string): string {
  const autonomy = getApprovedMissionAutonomy(db, teamId)
  if (autonomy?.mode !== "long_run") return ""
  return [
    "[Approved long-run autonomy]",
    "The user delegates decisions within the mission mandate according to these approved priorities, in their stated order:",
    ...(autonomy.instructions ?? []).map((instruction, index) => `${index + 1}. ${instruction}`),
    "Decide technical and organizational choices yourself when these priorities provide a reasonable basis. Do not ask for confirmation of routine choices, implementation details, or merely because several options or uncertainty remain. Prefer reversible assumptions consistent with the mandate; record consequential decisions and their rationale briefly, then continue without waiting for validation.",
    "Necessary technical decisions and operational validations within the approved mandate are delegated by default, not just implementation details. Contract ratification, SDK publication, Kind operations and comparable steps are not categorical exceptions or automatic user-approval gates. Check their prerequisites and existing authority, perform authorized steps and continue without a new go. Progress reports are informational, not permission requests.",
    "Before escalating, check existing instructions, authorization already granted, its effective delivery to workers, and safe alternatives. A delivery failure or a changed implementation detail is not by itself a new authorization requirement.",
    "Escalate only when no reasonable compliant decision remains: a consequential dilemma that cannot be resolved through research, tests, existing instructions or reasonable assumptions; materially conflicting instructions; indispensable missing authority or access; an irreversible action outside the delegated mandate; or an impossible objective. Technical difficulty alone is not a reason to ask. Explain the specific missing authority or unresolved decision and the smallest input needed, not merely an operation category; continue independent work where safe.",
    "Preserve native permissions, explicit prohibitions, approved budget limits, QA, admission and safety gates. This contract does not authorize scope expansion, waive mandatory checks, or reset a critical stop. Do not invent extra approval gates for choices already delegated.",
    "Determine existing authorization from the approved objective, mandate and decision delegation, not from whether every necessary step was enumerated in the plan. Necessary architectural and contract decisions within that mandate are delegated too. This does not authorize a change to the mission objective or work outside the mandate. The initial config/start approval and required model/QA policy revisions remain binding; domain contract ratification is not itself such a policy revision.",
    "Workers apply these priorities within their assigned scope and profile; send unresolved boundaries to the lead through their permitted reporting channel. The lead resolves them within this delegation before asking the user. Restricted/final-response workers retain their reporting mode and do not gain tools or permissions.",
    "[/Approved long-run autonomy]",
  ].join("\n")
}

/** Render the shared decision boundaries followed by any approved long-run priorities. */
export function buildMissionDecisionPrompt(db: Database, teamId: string): string {
  if (!db.query("SELECT id FROM team WHERE id = ?").get(teamId)) return ""
  const decisions = [
    "[Mission decision boundaries]",
    "In both supervised and long_run, decide routine technical and organizational choices within the authorized phase, assigned scope and existing plan. Use the user's stated priorities and verified evidence; resolve ordinary disagreements between worker proposals yourself. Supervised does not mean asking for approval at every step.",
    "Do not enter standby merely because a milestone, checkpoint, review or QA step is complete, a worker finished, or the next phase is important. Inform the user and continue the next authorized step when prerequisites are satisfied; a progress report is not a request for a new go. Check remaining tasks and reports when no worker is active. Wait for active prerequisite work when necessary, not for an invented user approval.",
    "Ask the user before an architectural change not already authorized by the mandate, or a change to the mission objective. Architectural changes materially alter system boundaries, component responsibilities, public or persisted contracts, storage design, or trust/security boundaries. Local implementation choices, private helper refactors and compatible bug fixes are not architectural changes by themselves. Check the existing approval and plan before escalating an architectural step already authorized there.",
    "Other legitimate pauses are an explicit user hold, a required config/start approval or policy revision, an indispensable missing permission/access/budget, a genuine unresolved contradiction, or a mandatory safety/QA gate. Explain the exact boundary, continue independent authorized work where safe, and never treat this guidance as permission to bypass native permissions, read-only preparation, budget limits or explicit prohibitions.",
    "Workers decide within their assigned scope and report unresolved boundaries to the lead through their permitted reporting channel. An explicit plan_approval requires the lead's approval, not a new user go unless the user/project expressly requires that. Review and integrate results as required; workers still stop after their assigned deliverable under their reporting mode. The lead owns continued mission coordination and closure.",
    "[/Mission decision boundaries]",
  ].join("\n")
  return [decisions, buildMissionAutonomyPrompt(db, teamId)].filter(Boolean).join("\n\n")
}
