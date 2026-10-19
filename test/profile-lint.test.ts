import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { lintAgentProfile, type ProfileFinding } from "../src/profile-lint"

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "profiles", name), "utf8")
const ids = (findings: ProfileFinding[], id: ProfileFinding["id"]): ProfileFinding[] => findings.filter(finding => finding.id === id)

describe("profile lint", () => {
  test("flags a deny-all collaborator and accepts the same text as restrictive", () => {
    const denied = lintAgentProfile(fixture("deny-all.md"))
    const missing = ids(denied, "missing-ensemble-tools")
    expect(missing).toHaveLength(1)
    expect(missing[0]?.message).toContain("team_message")
    expect(missing[0]?.message).toContain("team_tasks_complete")
    expect(denied.some(finding => finding.id === "relative-glob" && finding.severity === "error")).toBe(false)

    const restrictive = lintAgentProfile(fixture("restrictive.md"))
    expect(ids(restrictive, "missing-ensemble-tools")).toHaveLength(0)
    expect(ids(restrictive, "restrictive-profile")).toHaveLength(1)
  })

  test("rejects a relative edit glob and a later deny, and accepts an anchored glob", () => {
    const shadowed = lintAgentProfile(fixture("shadowed-edit.md"))
    expect(ids(shadowed, "relative-glob").some(finding => finding.severity === "error")).toBe(true)
    expect(ids(shadowed, "allow-shadowed-by-deny")).toHaveLength(1)
    expect(ids(lintAgentProfile(fixture("anchored-edit.md")), "relative-glob")).toHaveLength(0)
  })

  test("warns on a coded model and only conflicts when the body id differs", () => {
    const conflict = lintAgentProfile(fixture("model-conflict.md"))
    expect(ids(conflict, "coded-model")).toHaveLength(1)
    expect(ids(conflict, "model-order-conflict")).toHaveLength(1)
    const same = lintAgentProfile(`---\nmodel: openai/gpt-6.1-sol#xhigh\n---\nUse openai/gpt-6.1-sol.\n`)
    expect(ids(same, "coded-model")).toHaveLength(1)
    expect(ids(same, "model-order-conflict")).toHaveLength(0)
  })

  test("flags a Code Mode ban and ignores a shell-only sentence", () => {
    expect(ids(lintAgentProfile(fixture("execute-conflict.md")), "execute-body-conflict")).toHaveLength(1)
    expect(ids(lintAgentProfile(fixture("shell-only.md")), "execute-body-conflict")).toHaveLength(0)
  })

  test("warns when a directory read has no glob allow", () => {
    const findings = lintAgentProfile(fixture("listing-gap.md"))
    expect(ids(findings, "listing-gap")).toHaveLength(1)
    expect(ids(findings, "relative-glob").every(finding => finding.severity === "warning")).toBe(true)
  })

  test("accepts the collaborator template and reports a truncated frontmatter without throwing", () => {
    const collaborator = lintAgentProfile(fixture("collaborator.md"))
    expect(collaborator.filter(finding => finding.severity !== "info")).toEqual([])
    expect(() => lintAgentProfile(fixture("truncated.md"))).not.toThrow()
    expect(lintAgentProfile(fixture("truncated.md"))).toEqual([
      { id: "unparseable", severity: "error", message: "Agent frontmatter has no closing fence" },
    ])
  })

  test("notes env denies that differ only by case", () => {
    const findings = lintAgentProfile(`---\npermissions:\n  - { action: read, resource: ".env", effect: deny }\n  - { action: read, resource: ".ENV", effect: deny }\n---\n\nStop.\n`)
    expect(ids(findings, "env-case-duplication")).toHaveLength(1)
  })
})
