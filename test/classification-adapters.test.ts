import { expect, test } from "bun:test"
import { normalizeGeneralClassification, normalizeX86Classification } from "../src/classification-adapters"

test("x86 complexity/uncertainty use the tool's percentage contract, not raw JEV evidence or confidence", () => {
  expect(normalizeX86Classification({ complexity: 42, uncertainty: 23, model: "jev", evidence: { answers: { uncertainty: { score: 0.9, confidence: 0.42 } } } })).toMatchObject({ complexity: 0.42, risk: 0.23, model: "jev" })
  expect(normalizeX86Classification({ complexity: 42 }, { risk: 0 })).toMatchObject({ complexity: 0.42, risk: 0 })
  expect(() => normalizeX86Classification({ complexity: 101, uncertainty: 0 })).toThrow("complexity")
  expect(() => normalizeX86Classification({ complexity: 0 })).toThrow("uncertainty")
})

test("general JSON uses 0..1, validates every missing dimension and preserves manual dimensions", () => {
  expect(normalizeGeneralClassification('{"complexity":0.48123,"risk":0.97234}', "chosen/model")).toMatchObject({ complexity: 0.48123, risk: 0.97234, model: "chosen/model" })
  expect(normalizeGeneralClassification({ complexity: 0 }, "chosen/model", { risk: 1 })).toMatchObject({ complexity: 0, risk: 1 })
  for (const raw of ['not JSON', '{}', '{"complexity":50,"risk":0}', '{"complexity":0,"risk":"0.5"}']) {
    expect(() => normalizeGeneralClassification(raw, "chosen/model")).toThrow()
  }
})
