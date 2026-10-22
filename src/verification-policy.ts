/** Mission-specific verification scope, independent of model selection and project invariants. */
export interface VerificationPolicy {
  level: "light" | "proportionate" | "reinforced"
  commands?: string[]
  acceptance?: string[]
}

/** Validate the declarative QA contract; no command is executed by this policy. */
export function validateVerificationPolicy(value: unknown): asserts value is VerificationPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("verification must be an object")
  const policy = value as Record<string, unknown>
  if (Object.keys(policy).some(key => !["level", "commands", "acceptance"].includes(key))) throw new Error("Unknown verification field")
  if (typeof policy.level !== "string" || !["light", "proportionate", "reinforced"].includes(policy.level)) throw new Error("Invalid verification level")
  ;["commands", "acceptance"].forEach(key => {
    const entries = policy[key]
    if (entries !== undefined && (!Array.isArray(entries) || entries.length > 50 || entries.some(item => typeof item !== "string" || !item.trim() || item.length > 2000))) throw new Error(`verification.${key} must contain nonempty strings (at most 50)`)
  })
}

/** Render the agreed verification scope for leads and workers. */
export function verificationInstructions(policy: VerificationPolicy = { level: "proportionate" }): string {
  validateVerificationPolicy(policy)
  const scope = {
    light: "Targeted checks for the changed behavior; no separate reviewer by default.",
    proportionate: "Choose focused checks from concrete changed risks; independent review only when it adds a distinct useful check.",
    reinforced: "Plan verification explicitly and obtain an independent review; integration evidence only for the affected boundaries.",
  }[policy.level]
  return [`Mission QA: ${policy.level}. ${scope}`,
    "No mandatory QA agent pipeline. Project safety and mandatory requirements still apply; surface conflicts for explicit user arbitration, never silently waive them.",
    "Separate blocking defects from nonblocking suggestions and out-of-scope gaps. Reuse valid evidence; do not expand testing infrastructure or scope without approval. Report unexecuted checks and existing failures accurately.",
    ...(policy.commands ?? []).map(command => `Agreed check (report its actual result): ${command}`),
    ...(policy.acceptance ?? []).map(criterion => `Acceptance: ${criterion}`),
  ].join("\n")
}
