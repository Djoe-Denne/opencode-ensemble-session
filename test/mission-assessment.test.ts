import { describe, expect, test } from "bun:test"
import { buildJevClassificationInput } from "../src/classification-protocol"

describe("mission-specific assessment rubric", () => {
  const rubric = {
    complexity: ["Low: isolated cache key change.", "High: distributed cache coherency and difficult reconstruction."],
    risk: ["Low: disposable cache entry.", "High: persisted data corruption or leaked credentials."],
  }

  test("passes the frozen mission criteria to the evaluator without changing the score protocol", () => {
    const input = buildJevClassificationInput({ content: "Fix cache" }, {}, rubric)
    expect(input.questions).toMatchObject({
      complexity: { type: "score", criteria: rubric.complexity },
      risk: { type: "score", criteria: rubric.risk },
    })
  })

  test("keeps manual dimensions out and rejects unusable rubrics", () => {
    const input = buildJevClassificationInput({}, { complexity: 0.5 }, rubric)
    expect(Object.keys(input.questions as object)).toEqual(["risk"])
    expect(() => buildJevClassificationInput({}, {}, { ...rubric, risk: ["Only one endpoint"] })).toThrow("criteria")
  })
})
