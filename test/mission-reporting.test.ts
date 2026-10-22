import { describe, expect, test } from "bun:test"
import { missionReportingInstructions } from "../src/mission-reporting"

describe("supervisor checkpoint reporting", () => {
  test("requires a contextual report before every user question, not a new approval per stage", () => {
    const text = missionReportingInstructions(".opencode/missions/t1/reports")
    expect(text).toContain("Before every user question")
    expect(text).toContain("Markdown by default")
    expect(text).toContain(".opencode/missions/t1/reports")
    expect(text).toContain("options, tradeoffs and recommendation")
    expect(text).toContain("does not require a new approval")
    expect(text).toContain("not per tool call")
  })

  test("Canvas requires an owned backend and a verified reachable URL, otherwise use Markdown", () => {
    const text = missionReportingInstructions("reports")
    expect(text).toContain("start or reuse an owned local preview backend")
    expect(text).toContain("loopback")
    expect(text).toContain("HTTP response and report content")
    expect(text).toContain("PID/handle")
    expect(text).toContain("keep it available while the user decides")
    expect(text).toContain("fall back to Markdown")
  })

  test("preserves evidence, permissions and privacy when reporting is blocked", () => {
    const text = missionReportingInstructions("reports")
    expect(text).toContain("present the Markdown inline before asking")
    expect(text).toContain("never bypass permissions")
    expect(text).toContain("redact secrets")
    expect(text).toContain("Do not rerun checks merely to populate a report")
    expect(text).toContain("not proof of acceptance")
  })
})
