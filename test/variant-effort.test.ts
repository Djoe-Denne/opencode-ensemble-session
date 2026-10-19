import { describe, expect, test } from "bun:test"
import { calibrationWarnings, canonicalRank, canonicalizeVariantLabel, describeMissionModel } from "../src/variant-effort"

describe("canonical variant effort", () => {
  test("maps known labels and leaves unknown native ids unmapped", () => {
    expect(canonicalizeVariantLabel("xhigh")).toBe("xhigh")
    expect(canonicalizeVariantLabel("max")).toBe("max")
    expect(canonicalizeVariantLabel("Grok 4.7 Extra High")).toBe("xhigh")
    expect(canonicalizeVariantLabel("high")).toBe("high")
    expect(canonicalizeVariantLabel("not-a-variant")).toBeUndefined()
    expect(canonicalRank("xhigh")).toBeLessThan(canonicalRank("max"))
  })

  test("describes an omitted variant as the host default and an unknown id as unmapped", () => {
    expect(describeMissionModel({ id: "openai/gpt-6.1-sol", variant: "xhigh" })).toBe("openai/gpt-6.1-sol (xhigh, xhigh)")
    expect(describeMissionModel({ id: "openai/gpt-6.1-sol" })).toBe("openai/gpt-6.1-sol (default, default)")
    expect(describeMissionModel({ id: "opencode-go/grok-4.7", variant: "not-a-variant" })).toBe("opencode-go/grok-4.7 (not-a-variant, unmapped)")
  })

  test("warns on a higher band with a lower canonical effort and does not throw", () => {
    const warnings = calibrationWarnings({
      groups: {
        light: [{ variant: "xhigh" }],
        strong: [{ variant: "low" }],
      },
      matrix: [["light", "strong"], ["strong", "strong"]],
    })
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.join("\n")).toContain("does not block start")
    expect(calibrationWarnings({
      groups: { light: [{ variant: "low" }], strong: [{ variant: "xhigh" }] },
      matrix: [["light", "strong"], ["strong", "strong"]],
    })).toEqual([])
  })
})
