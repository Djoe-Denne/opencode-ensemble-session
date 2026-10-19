/** Closed canonical reasoning-effort scale. Native variant ids are not rewritten into these labels. */
export const CANONICAL_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const

/** A canonical reasoning effort used for display, calibration warnings and prompts. */
export type CanonicalEffort = (typeof CANONICAL_EFFORTS)[number]

const ALIASES: Readonly<Record<string, CanonicalEffort>> = {
  default: "default",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  "extra high": "xhigh",
  "extra-high": "xhigh",
  "grok 4.7 extra high": "xhigh",
  "grok 4.6 extra high": "xhigh",
}

/**
 * Map an author label or native id onto a canonical effort.
 * Unknown strings stay unmapped so a native id is never invented.
 */
export function canonicalizeVariantLabel(raw: string): CanonicalEffort | undefined {
  return ALIASES[raw.trim().toLowerCase()]
}

/** Rank a canonical effort. Higher ranks are more effort, used only for warnings and display. */
export function canonicalRank(effort: CanonicalEffort): number {
  return CANONICAL_EFFORTS.indexOf(effort)
}

/**
 * Annotate a stored model. An omitted variant is the host default.
 * A native id that is not a known label stays `unmapped`.
 */
export function annotatedEffort(model: { variant?: string | null; effort?: string | null }): CanonicalEffort | "unmapped" {
  if (model.effort && (CANONICAL_EFFORTS as readonly string[]).includes(model.effort)) return model.effort as CanonicalEffort
  if (!model.variant) return "default"
  return canonicalizeVariantLabel(model.variant) ?? "unmapped"
}

/** Format `id (native variant, canonical effort or unmapped)` without changing the native id. */
export function describeMissionModel(model: { id: string; variant?: string | null; effort?: string | null }): string {
  return `${model.id} (${model.variant ?? "default"}, ${annotatedEffort(model)})`
}

/**
 * Warn when a higher risk or complexity band uses a lower canonical effort.
 * Unmapped efforts are skipped. The result never blocks approval.
 */
export function calibrationWarnings(policy: {
  groups: Record<string, Array<{ variant?: string | null; effort?: string | null }>>
  matrix: string[][]
}): string[] {
  const effortOf = (group: string): CanonicalEffort | undefined => {
    const first = policy.groups[group]?.[0]
    if (!first) return undefined
    const effort = annotatedEffort(first)
    return effort === "unmapped" ? undefined : effort
  }
  const warnings: string[] = []
  policy.matrix.forEach((row, riskBand) => {
    row.forEach((group, complexityBand) => {
      const here = effortOf(group)
      if (!here) return
      policy.matrix.forEach((lowerRow, lowerRisk) => {
        lowerRow.forEach((lowerGroup, lowerComplexity) => {
          const higher = (riskBand > lowerRisk && complexityBand >= lowerComplexity) || (complexityBand > lowerComplexity && riskBand >= lowerRisk)
          if (!higher) return
          const lower = effortOf(lowerGroup)
          if (!lower || canonicalRank(here) >= canonicalRank(lower)) return
          warnings.push(`Calibration warning: group ${group} at risk band ${riskBand}, complexity band ${complexityBand} uses effort ${here}, below group ${lowerGroup} (${lower}). This does not block start.`)
        })
      })
    })
  })
  return [...new Set(warnings)]
}
