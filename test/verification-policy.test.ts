import { describe, expect, test } from "bun:test"
import { validateVerificationPolicy, verificationInstructions } from "../src/verification-policy"

describe("mission verification contract", () => {
  test("defaults to proportionate QA without a mandatory agent pipeline", () => {
    const text = verificationInstructions()
    expect(text).toContain("proportionate")
    expect(text).toContain("No mandatory QA agent pipeline")
    expect(text).toContain("Project safety and mandatory requirements still apply")
  })
  test("light and reinforced have distinct guidance and preserve explicit acceptance", () => {
    expect(verificationInstructions({ level: "light" })).toContain("Targeted checks")
    const text = verificationInstructions({ level: "reinforced", commands: ["cargo test -p api"], acceptance: ["deny unauthorized callers"] })
    expect(text).toContain("independent")
    expect(text).toContain("cargo test -p api")
    expect(text).toContain("deny unauthorized callers")
  })
  test("rejects unknown levels, automatic QA controls and malformed commands", () => {
    expect(() => validateVerificationPolicy({ level: "strictest" })).toThrow()
    expect(() => validateVerificationPolicy({ level: ["light"] })).toThrow()
    expect(() => validateVerificationPolicy({ level: "light", autoApprove: true })).toThrow()
    expect(() => validateVerificationPolicy({ level: "light", commands: [42] })).toThrow()
    expect(() => validateVerificationPolicy({ level: "light", acceptance: [""] })).toThrow()
    expect(() => validateVerificationPolicy({ level: "proportionate", commands: [] })).not.toThrow()
  })
})
