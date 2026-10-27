import { describe, expect, test } from "bun:test"
import { missionReportingInstructions } from "../src/mission-reporting"

describe("supervisor checkpoint reporting", () => {
  test("makes the report and question understandable without internal reasoning or prior reports", () => {
    const text = missionReportingInstructions("reports")
    expect(text).toContain("plain, natural language")
    expect(text).toContain("has not read earlier reports")
    expect(text).toContain("internal reasoning")
    expect(text).toContain("self-contained")
    expect(text).toContain("concrete problem")
    expect(text).toContain("why their decision is needed")
    expect(text).toContain("a report link is supplementary")
    expect(text).toContain("do not create a question just to fill a report")
  })

  test("keeps task codes and jargon out of the user decision and explains unavoidable terminology", () => {
    const text = missionReportingInstructions("reports")
    expect(text).toContain("descriptive task names before internal IDs")
    expect(text).toContain("Never use a bare task/acceptance code")
    expect(text).toContain("question-tool payload")
    expect(text).toContain("option labels")
    expect(text).toContain("brief optional glossary")
    expect(text).toContain("first use")
    expect(text).toContain("do not glue words together")
    expect(text).toContain("technical appendix")
  })

  test("preserves decision consequences and evidence limits instead of oversimplifying", () => {
    const text = missionReportingInstructions("reports")
    expect(text).toContain("what changes and what stays unchanged")
    expect(text).toContain("risk, time/cost if known")
    expect(text).toContain("including refusing or deferring")
    expect(text).toContain("concise evidence-based reason")
    expect(text).toContain("Do not invent timings, costs or test results")
    expect(text).toContain("observed facts, hypotheses and estimates")
    expect(text).toContain("material scope, safety or authorization limits")
    expect(text).toContain("Preserve exact approval/denial labels")
  })

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
