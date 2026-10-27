import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PermissionDiagnostics } from "../src/permission-diagnostics"
import { insertMember, insertTeam, setupDeps } from "./helpers"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ensemble-permission-diagnostics-"))
  directories.push(root)
  const directory = join(root, "logs")
  const deps = setupDeps()
  insertTeam(deps.db, "team", "diagnostics", "lead")
  insertMember(deps.db, "team", "worker", "worker-session")
  deps.tracker.track("child", "worker-session")
  const logger = new PermissionDiagnostics({ directory, projectDirectory: "/project", db: deps.db, tracker: deps.tracker,
    now: () => new Date("2026-10-26T12:00:00.000Z") })
  logger.noteSession("child", "qa-reader")
  logger.noteTools([{ id: "serena.read", name: "read", options: { namespace: { name: "serena" }, permission: "mcp.serena.read" } }])
  const lines = () => {
    try { return readdirSync(directory).filter(file => file.endsWith(".jsonl")).flatMap(file => readFileSync(join(directory, file), "utf8").trim().split("\n").filter(Boolean)) }
    catch { return [] }
  }
  const records = () => lines().map(line => JSON.parse(line)) as Array<Record<string, unknown>>
  return { root, directory, deps, logger, lines, records }
}

function denied(id = "call1") {
  return { sessionID: "child", agent: "qa-reader", messageID: "msg1", id, tool: "serena.read", status: "error",
    input: { password: "private-input" }, error: { message: "Permission denied for secret-token-123", metadata: { token: "private-metadata" } } }
}

describe("permission failure diagnostics", () => {
  test("persists a dated JSONL incident with native identity, namespace and descendant ownership", () => {
    const f = fixture()
    f.logger.observeToolAfter(denied())
    expect(readdirSync(f.directory)).toEqual(["2026-10-26.jsonl"])
    expect(f.records()).toHaveLength(1)
    expect(f.records()[0]).toMatchObject({ version: 1, time: "2026-10-26T12:00:00.000Z", projectDirectory: "/project",
      sessionID: "child", parentSessionID: "worker-session", agent: "qa-reader", teamID: "team", ownerMemberName: "worker",
      tool: "serena.read", namespace: "serena", permissionAction: "mcp.serena.read", callID: "call1", messageID: "msg1",
      category: "permission_denied", observation: "tool_error" })
    expect(f.lines().join(" ")).not.toContain("secret-token-123")
    expect(f.lines().join(" ")).not.toContain("private-input")
    expect(f.lines().join(" ")).not.toContain("private-metadata")
  })

  test("ignores successful calls, pending authorization and unrelated failures", () => {
    const f = fixture()
    f.logger.observeToolAfter({ ...denied(), status: "completed", result: { content: "Documentation mentions permission denied" } })
    f.logger.observeToolAfter({ ...denied(), error: { message: "Waiting for user permission" } })
    f.logger.observeToolAfter({ ...denied(), error: { message: "Network timeout" } })
    expect(f.records()).toHaveLength(0)
  })

  test.each([
    ["The user rejected this tool call", "user_rejected"],
    ["EACCES: open private-path", "filesystem_access_denied"],
    ["EPERM: operation not permitted", "filesystem_access_denied"],
    ["No tool named serena.read is currently available", "tool_unavailable"],
    ["The user has specified a rule which prevents you from using this specific tool call", "permission_denied"],
    ["This action is not permitted by the agent policy", "permission_denied"],
    ["Access is denied", "permission_denied"],
  ])("categorizes %s without claiming all failures are missing MCP rights", (message, category) => {
    const f = fixture()
    f.logger.observeToolAfter({ ...denied(), error: { message } })
    expect(f.records()[0]?.category).toBe(category)
  })

  test("distinguishes external authorization from configured agent permissions", () => {
    const f = fixture()
    f.logger.observeToolAfter({ ...denied(), error: { message: "Request failed", status: 403 } })
    expect(f.records()[0]?.category).toBe("external_authorization_denied")
  })

  test("recognizes an access error wrapped in the public Tool.Error cause without retaining it", () => {
    const f = fixture()
    f.logger.observeToolAfter({ ...denied(), error: { _tag: "Tool.Error", message: "Operation failed", error: { code: "EACCES", message: "private-cause-path" } } })
    expect(f.records()[0]?.category).toBe("filesystem_access_denied")
    expect(f.lines().join(" ")).not.toContain("private-cause-path")
  })

  test("captures configured denies from final native states and deduplicates hook/event observations", () => {
    const f = fixture()
    f.logger.observeToolAfter(denied())
    const event = { type: "session.message.content.updated", location: { directory: "/project" },
      data: { sessionID: "child", messageID: "msg1", content: [{ type: "tool", id: "call1", name: "serena.read",
        state: { status: "error", input: { secret: "private" }, error: { type: "Tool.Error", message: "Permission denied" } } }] } }
    f.logger.observeNativeEvent(event)
    expect(f.records()).toHaveLength(1)
    event.data.content[0]!.id = "call2"
    f.logger.observeNativeEvent(event)
    expect(f.records()).toHaveLength(2)
    expect(f.records()[1]?.observation).toBe("native_tool_state")
    f.logger.observeNativeEvent({ ...event, location: { directory: "/unrelated-project" } })
    expect(f.records()).toHaveLength(2)
  })

  test("logs a nested Code Mode error as reported evidence, not a proven configured deny", () => {
    const f = fixture()
    f.logger.observeToolAfter({ ...denied(), tool: "execute", status: "completed", result: {
      content: JSON.stringify({ error: { message: "Permission denied secret-token-123" } }),
    } })
    expect(f.records()[0]).toMatchObject({ tool: "execute", category: "permission_denied", observation: "reported_tool_error" })
    expect(f.lines().join(" ")).not.toContain("secret-token-123")
  })

  test("records isolation denials without changing the agent or granting rights", () => {
    const f = fixture()
    f.logger.recordIsolation({ sessionID: "child", agent: "qa-reader", tool: "team_message", id: "isolation" })
    expect(f.records()[0]).toMatchObject({ category: "ensemble_isolation_denied", observation: "isolation_guard" })
    expect(f.deps.client.calls).toHaveLength(0)
  })

  test("separate attempts remain distinct and malformed event fields cannot inject log lines", () => {
    const f = fixture()
    f.logger.observeToolAfter(denied("call1"))
    f.logger.observeToolAfter(denied("call2"))
    f.logger.observeToolAfter({ ...denied("call3"), tool: "secret-token-123\nforged-line" })
    expect(f.records()).toHaveLength(3)
    expect(f.lines().join(" ")).not.toContain("forged-line")
    expect(f.lines().join(" ")).not.toContain("secret-token-123")
    expect(f.records()[0]?.incidentID).not.toBe(f.records()[1]?.incidentID)
  })

  test("logging failures never replace the original error and emit a bounded storage warning", () => {
    const f = fixture()
    const badDirectory = join(f.root, "not-a-directory")
    writeFileSync(badDirectory, "owned fixture")
    let warnings = 0
    const logger = new PermissionDiagnostics({ directory: badDirectory, projectDirectory: "/project", onWriteError: () => { warnings++ } })
    const event = denied()
    expect(() => logger.observeToolAfter(event)).not.toThrow()
    logger.observeToolAfter(denied("call2"))
    expect(warnings).toBe(1)
    expect(event.error.message).toBe("Permission denied for secret-token-123")
  })
})
