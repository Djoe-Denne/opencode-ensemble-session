import { CANONICAL_EFFORTS, canonicalizeVariantLabel, type CanonicalEffort } from "./variant-effort"

/** An exact native provider/model identity, optional native variant, and optional effort annotation. */
export interface MissionPolicyModel {
  id: string
  variant?: string
  /** Display annotation only. Absent on historical approved policies. Never sent as a variant. */
  effort?: CanonicalEffort
}

/** A complete, versioned risk-row/complexity-column model routing policy. */
export interface MissionModelPolicy {
  version: 1
  providers: string[]
  /** At least two nonempty assessment criteria per scoring axis. */
  assessment: { complexity: string[]; risk: string[] }
  /** Strictly increasing integer boundaries from 0 through the exclusive endpoint 101. */
  complexityBands: number[]
  /** Strictly increasing integer boundaries from 0 through the exclusive endpoint 101. */
  riskBands: number[]
  groups: Record<string, MissionPolicyModel[]>
  matrix: string[][]
}

/** A deterministic primary and ordered fallback route, with zero-based band indexes. */
export interface MissionPolicyRoute {
  group: string
  selected: MissionPolicyModel
  alternatives: MissionPolicyModel[]
  complexity: number
  risk: number
  complexityBand: number
  riskBand: number
}

function invalid(path: string, reason: string): never {
  throw new Error(`Invalid mission model policy: ${path} ${reason}`)
}

function assertObject(
  value: unknown,
  path: string,
  required: string[] = [],
  optional: string[] = [],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be an object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(path, "must be a plain object")
  }
  required.forEach((key) => {
    if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, "is required")
  })
  if (required.length === 0) return
  Object.keys(value).forEach((key) => {
    if (!required.includes(key) && !optional.includes(key)) {
      invalid(`${path}.${key}`, "is an unexpected field")
    }
  })
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array")
  if (value.length === 0) invalid(path, "must be a nonempty array")
}

function assertText(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(path, "must be a nonempty string")
  }
}

function validateCriteria(value: unknown, path: string): void {
  assertArray(value, path)
  if (value.length < 2) invalid(path, "must contain at least two criteria")
  Array.from(value).forEach((criterion, index) => {
    assertText(criterion, `${path}[${index}]`)
  })
}

function validateBands(value: unknown, path: string): asserts value is number[] {
  assertArray(value, path)
  if (value.length < 2 || value.length > 102) {
    invalid(path, "must contain between 2 and 102 boundaries")
  }
  if (value[0] !== 0 || value[value.length - 1] !== 101) {
    invalid(path, "must start at 0 and end at the exclusive boundary 101")
  }
  Array.from(value).forEach((boundary, index) => {
    if (typeof boundary !== "number" || !Number.isInteger(boundary) || boundary < 0 || boundary > 101) {
      invalid(`${path}[${index}]`, "must be an integer between 0 and 101")
    }
    const previous = value[index - 1]
    if (typeof previous === "number" && boundary <= previous) {
      invalid(`${path}[${index}]`, "must be strictly increasing, without duplicate or reversed boundaries")
    }
  })
}

function validateModel(value: unknown, path: string, providers: Set<string>): asserts value is MissionPolicyModel {
  assertObject(value, path, ["id"], ["variant", "effort"])
  assertText(value.id, `${path}.id`)
  const separator = value.id.indexOf("/")
  if (separator < 1 || separator === value.id.length - 1 || /[\s#]/u.test(value.id)) {
    invalid(`${path}.id`, "must use native provider/model format; supply variant as a separate field")
  }
  const provider = value.id.slice(0, separator)
  if (!providers.has(provider)) {
    invalid(`${path}.id`, `uses unauthorized provider ${JSON.stringify(provider)}`)
  }
  if (value.variant !== undefined) assertText(value.variant, `${path}.variant`)
  if (value.effort !== undefined) {
    if (!(CANONICAL_EFFORTS as readonly string[]).includes(value.effort as string)) {
      invalid(`${path}.effort`, "must be default, low, medium, high, xhigh or max")
    }
    if (typeof value.variant === "string") {
      const labeled = canonicalizeVariantLabel(value.variant)
      if (labeled && labeled !== value.effort) {
        invalid(`${path}.effort`, `must match the canonical effort ${labeled} of variant ${JSON.stringify(value.variant)}`)
      }
    }
  }
}

/** Validate an unknown mission policy, throwing a descriptive error on invalid input. */
export function validateMissionModelPolicy(policy: unknown): asserts policy is MissionModelPolicy {
  assertObject(policy, "policy", [
    "version", "providers", "assessment", "complexityBands", "riskBands", "groups", "matrix",
  ])
  if (policy.version !== 1) invalid("policy.version", "must be 1")

  assertArray(policy.providers, "policy.providers")
  const providers = new Set<string>()
  Array.from(policy.providers).forEach((provider, index) => {
    const path = `policy.providers[${index}]`
    assertText(provider, path)
    if (/[\s/]/u.test(provider)) invalid(path, "must be a native provider ID without whitespace or a slash")
    providers.add(provider)
  })

  assertObject(policy.assessment, "policy.assessment", ["complexity", "risk"])
  validateCriteria(policy.assessment.complexity, "policy.assessment.complexity")
  validateCriteria(policy.assessment.risk, "policy.assessment.risk")
  validateBands(policy.complexityBands, "policy.complexityBands")
  validateBands(policy.riskBands, "policy.riskBands")

  assertObject(policy.groups, "policy.groups")
  const groups = policy.groups
  const entries = Object.entries(groups)
  if (entries.length === 0) invalid("policy.groups", "must be a nonempty object")
  entries.forEach(([group, candidates]) => {
    assertText(group, "policy.groups group name")
    const path = `policy.groups[${JSON.stringify(group)}]`
    assertArray(candidates, path)
    const identities = new Set<string>()
    Array.from(candidates).forEach((candidate, index) => {
      const candidatePath = `${path}[${index}]`
      validateModel(candidate, candidatePath, providers)
      const identity = JSON.stringify([candidate.id, candidate.variant ?? null])
      if (identities.has(identity)) invalid(candidatePath, "duplicates an exact model/variant identity in this group")
      identities.add(identity)
    })
  })

  assertArray(policy.matrix, "policy.matrix")
  const rows = policy.riskBands.length - 1
  const columns = policy.complexityBands.length - 1
  if (policy.matrix.length !== rows) invalid("policy.matrix", `must have exactly ${rows} risk rows`)
  Array.from(policy.matrix).forEach((row, riskIndex) => {
    const path = `policy.matrix[${riskIndex}]`
    assertArray(row, path)
    if (row.length !== columns) invalid(path, `must have exactly ${columns} complexity columns`)
    Array.from(row).forEach((group, complexityIndex) => {
      const cell = `${path}[${complexityIndex}]`
      assertText(group, cell)
      if (!Object.hasOwn(groups, group)) invalid(cell, `references unknown group ${JSON.stringify(group)}`)
    })
  })
}

function validateScore(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    invalid(path, "must be an integer between 0 and 100")
  }
}

/**
 * Validate and resolve explicit integer scores through left-inclusive, right-exclusive bands.
 * Always returns the first configured candidate, then the remaining candidates in their original
 * order. Candidate copies keep the returned route independent from the policy's mutable objects.
 */
export function routeMissionModel(
  policy: MissionModelPolicy,
  scores: { complexity: number; risk: number },
): MissionPolicyRoute {
  validateMissionModelPolicy(policy)
  assertObject(scores, "scores")
  validateScore(scores.complexity, "scores.complexity")
  validateScore(scores.risk, "scores.risk")
  const { complexity, risk } = scores
  const complexityBand = policy.complexityBands.findIndex((boundary) => complexity < boundary) - 1
  const riskBand = policy.riskBands.findIndex((boundary) => risk < boundary) - 1
  const group = policy.matrix[riskBand]?.[complexityBand]
  if (group === undefined) invalid("policy.matrix", "does not cover the supplied scores")
  const candidates = policy.groups[group]
  if (!candidates?.[0]) invalid(`policy.groups[${JSON.stringify(group)}]`, "has no primary candidate")
  return {
    group,
    selected: { ...candidates[0] },
    alternatives: candidates.slice(1).map((candidate) => ({ ...candidate })),
    complexity,
    risk,
    complexityBand,
    riskBand,
  }
}
