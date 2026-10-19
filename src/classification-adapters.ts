import type { ClassificationScores, TaskClassification } from "./classification-protocol"
import { normalizeJevClassification, readClassificationOutput } from "./classification-protocol"

/** Validate the specialized x86 contract and normalize its percentage scale once. */
export function normalizeX86Classification(raw: unknown, manual: ClassificationScores = {}): TaskClassification {
  const output = readClassificationOutput(raw) as { complexity?: unknown; uncertainty?: unknown; model?: string } | null
  const percent = (key: "complexity" | "uncertainty", provided: number | undefined): number | undefined => {
    if (provided !== undefined) return undefined
    const value = output?.[key]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(`Invalid x86 ${key}: expected a finite score in [0,100]`)
    return value / 100
  }
  const result = normalizeJevClassification({ model: output?.model, answers: {
    complexity: { type: "score", score: percent("complexity", manual.complexity) },
    risk: { type: "score", score: percent("uncertainty", manual.risk) },
  } }, manual)
  return { ...result, reason: "Specialized x86 reconstruction complexity and judgement uncertainty mapped once from percentages to [0,1]; uncertainty is risk, not a success probability or a review policy." }
}

/** Parse a read-only general classifier's strictly normalized JSON result. */
export function normalizeGeneralClassification(raw: unknown, model: string, manual: ClassificationScores = {}): TaskClassification {
  const output = readClassificationOutput(raw) as { complexity?: unknown; risk?: unknown } | null
  return { ...normalizeJevClassification({ model, answers: {
    complexity: { type: "score", score: output?.complexity }, risk: { type: "score", score: output?.risk },
  } }, manual), reason: "Embedded general heuristic classifier on the explicitly authorized model; [0,1] scores retained, manual dimensions preserved." }
}
