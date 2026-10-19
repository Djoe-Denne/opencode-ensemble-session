/** A host event classified without I/O. Retry stays on the admitted model. */
export type ResilienceDecision =
  | { kind: "retry" }
  | { kind: "failover"; model: { id: string; variant?: string } }
  | { kind: "stop"; reason: string }

const RETRYABLE = /HTTP\s*500|\bECONNRESET\b|server_error|Rate limit reached/iu
const SWITCH_NOW = /No automatic retry or provider switch|unavailable model|model is unavailable/iu
const AUTH_FAILURE = /provider\.auth|authentication failed|unauthorized/iu

function providerOf(id: string): string {
  return id.slice(0, Math.max(id.indexOf("/"), 0))
}

/**
 * Classify one host failure for an already admitted model.
 * The first three retryable observations stay on that model.
 * A switch consumes at most the next alternative from a different provider.
 */
export function classifyProviderEvent(input: {
  message: string
  attempt: number
  admittedProvider: string
  alternatives: ReadonlyArray<{ id: string; variant?: string }>
  failoverUsed: boolean
}): ResilienceDecision {
  if (input.failoverUsed) return { kind: "stop", reason: "A second provider switch is not allowed for this work generation" }
  const next = input.alternatives.find(model => providerOf(model.id) !== input.admittedProvider)
  if (AUTH_FAILURE.test(input.message)) {
    if (!next) return { kind: "stop", reason: "Authentication failed for the admitted provider; same-provider alternatives are not used" }
    return { kind: "failover", model: { id: next.id, ...(next.variant ? { variant: next.variant } : {}) } }
  }
  const retryable = RETRYABLE.test(input.message)
  const switchNow = SWITCH_NOW.test(input.message)
  if (retryable && input.attempt <= 3) return { kind: "retry" }
  if (switchNow || (retryable && input.attempt > 3) || input.attempt > 3) {
    if (!next) return { kind: "stop", reason: "No alternative from another provider is approved" }
    return { kind: "failover", model: { id: next.id, ...(next.variant ? { variant: next.variant } : {}) } }
  }
  return { kind: "retry" }
}
