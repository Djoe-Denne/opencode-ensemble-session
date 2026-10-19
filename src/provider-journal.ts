import type { Database } from "./db"
import { classifyProviderEvent, type ResilienceDecision } from "./provider-resilience"

function providerOf(id: string): string {
  return id.slice(0, Math.max(id.indexOf("/"), 0))
}

function alternativesOf(routing: string | null): Array<{ id: string; variant?: string }> {
  if (!routing) return []
  try {
    const parsed = JSON.parse(routing) as { alternatives?: unknown; fallback?: unknown }
    const list = Array.isArray(parsed.alternatives) ? parsed.alternatives : parsed.fallback ? [parsed.fallback] : []
    return list.flatMap(item => {
      if (!item || typeof item !== "object") return []
      const record = item as { id?: unknown; variant?: unknown }
      if (typeof record.id !== "string") return []
      return [typeof record.variant === "string" ? { id: record.id, variant: record.variant } : { id: record.id }]
    })
  } catch {
    return []
  }
}

/**
 * Persist one host failure and, at most once per work generation, pin another approved provider.
 * The same-model ceiling stays in {@link classifyProviderEvent}. Authentication may fail over
 * only to a different provider. The native pin itself is the caller's `switchModel`.
 */
export function observeProviderRetry(db: Database, input: {
  teamId: string
  memberName: string
  message: string
  attempt: number
}): ResilienceDecision {
  const member = db.query("SELECT model, model_variant, model_routing, report_started_at FROM team_member WHERE team_id = ? AND name = ?")
    .get(input.teamId, input.memberName) as { model: string | null; model_variant: string | null; model_routing: string | null; report_started_at: number } | null
  const task = db.query("SELECT id FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress' ORDER BY time_updated DESC LIMIT 1")
    .get(input.teamId, input.memberName) as { id: string } | null
  const failoverUsed = Boolean(db.query(
    `SELECT a.id FROM member_provider_attempt a
     JOIN team_member m ON m.team_id = a.team_id AND m.name = a.member_name
     WHERE a.team_id = ? AND a.member_name = ? AND a.kind = 'failover' AND a.time_created >= m.report_started_at
     LIMIT 1`,
  ).get(input.teamId, input.memberName))
  const decision = classifyProviderEvent({
    message: input.message,
    attempt: input.attempt,
    admittedProvider: providerOf(member?.model ?? ""),
    alternatives: alternativesOf(member?.model_routing ?? null),
    failoverUsed,
  })
  const chosen = decision.kind === "failover"
    ? decision.model
    : { id: member?.model ?? "", ...(member?.model_variant ? { variant: member.model_variant } : {}) }
  const provider = providerOf(chosen.id) || providerOf(member?.model ?? "") || "unknown"
  db.run(
    `INSERT INTO member_provider_attempt (team_id, member_name, task_id, kind, provider, model, variant, detail, time_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.teamId,
      input.memberName,
      task?.id ?? null,
      decision.kind,
      provider,
      chosen.id || "unknown",
      chosen.variant ?? null,
      decision.kind === "stop" ? decision.reason : input.message,
      Date.now(),
    ],
  )
  if (decision.kind === "failover") {
    db.run("UPDATE team_member SET model = ?, model_variant = ? WHERE team_id = ? AND name = ?",
      [decision.model.id, decision.model.variant ?? null, input.teamId, input.memberName])
  }
  return decision
}
