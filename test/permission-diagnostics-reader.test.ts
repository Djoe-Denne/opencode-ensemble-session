import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionDiagnostics } from "../src/permission-diagnostics"
import { readPermissionDiagnostics } from "../src/permission-diagnostics-reader"
import { runPermissionDiagnostics } from "../src/permission-diagnostics-cli"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-permission-reader-"))
  directories.push(directory)
  let tick = 0
  const logger = new PermissionDiagnostics({ directory, projectDirectory: "/project", now: () => new Date(Date.UTC(2026, 9, 26, 12, tick++)) })
  const emit = (id: string, sessionID = "ses_worker") => logger.observeToolAfter({ sessionID, tool: "mcp.read", id, messageID: "message", agent: "reader", status: "error", error: { message: "Permission denied private-token" } })
  return { directory, emit }
}

describe("read-only permission diagnosis", () => {
  test("filters by session and project and returns the latest bounded incidents", async () => {
    const f = fixture()
    f.emit("old")
    f.emit("other-session", "ses_other")
    f.emit("new")
    const report = await readPermissionDiagnostics({ directory: f.directory, sessionID: "ses_worker", projectDirectory: "/project", limit: 1 })
    expect(report.records).toHaveLength(1)
    expect(report.records[0]?.callID).toBe("new")
    expect(report.matchingObservations).toBe(2)
    expect((await readPermissionDiagnostics({ directory: f.directory, projectDirectory: "/elsewhere" })).records).toHaveLength(0)
  })

  test("deduplicates native/hook observations and reports malformed input without leaking extra fields", async () => {
    const f = fixture()
    f.emit("one")
    const file = join(f.directory, readdirSync(f.directory)[0]!)
    const original = readFileSync(file, "utf8")
    const withPrivateFields = { ...JSON.parse(original), input: { token: "injected-secret" }, rawError: "injected-secret" }
    appendFileSync(file, `${JSON.stringify(withPrivateFields)}\n{broken\n`)
    const report = await readPermissionDiagnostics({ directory: f.directory })
    expect(report.records).toHaveLength(1)
    expect(report.matchingObservations).toBe(2)
    expect(report.malformedLines).toBe(1)
    expect(JSON.stringify(report)).not.toContain("injected-secret")
    expect(JSON.stringify(report)).not.toContain("private-token")
  })

  test("a missing journal is empty, but an unreadable directory is not reported as empty", async () => {
    const f = fixture()
    expect((await readPermissionDiagnostics({ directory: join(f.directory, "not-created") })).records).toHaveLength(0)
    const notDirectory = join(f.directory, "file")
    writeFileSync(notDirectory, "owned fixture")
    await expect(readPermissionDiagnostics({ directory: notDirectory })).rejects.toThrow("Cannot read")
    await expect(readPermissionDiagnostics({ directory: f.directory, limit: 0 })).rejects.toThrow("limit")
  })

  test("CLI gives a readable explanation and can export sanitized JSON", async () => {
    const f = fixture()
    f.emit("one")
    const output: string[] = []
    const errors: string[] = []
    const io = { out: (text: string) => { output.push(text) }, error: (text: string) => { errors.push(text) } }
    expect(await runPermissionDiagnostics(["--log-dir", f.directory, "--session", "ses_worker"], io)).toBe(0)
    expect(output.join(" ")).toContain("Permission denied")
    expect(output.join(" ")).toContain("ses_worker")
    expect(output.join(" ")).toContain("mcp.read")
    expect(output.join(" ")).not.toContain("private-token")
    output.length = 0
    expect(await runPermissionDiagnostics(["--log-dir", f.directory, "--json"], io)).toBe(0)
    expect(JSON.parse(output[0]!).records).toHaveLength(1)
    expect(errors).toHaveLength(0)
  })

  test("CLI rejects invalid flags and marks incomplete journals as partial results", async () => {
    const f = fixture()
    f.emit("one")
    appendFileSync(join(f.directory, readdirSync(f.directory)[0]!), "{broken\n")
    const output: string[] = []
    const errors: string[] = []
    const io = { out: (text: string) => { output.push(text) }, error: (text: string) => { errors.push(text) } }
    expect(await runPermissionDiagnostics(["--log-dir", f.directory, "--json"], io)).toBe(2)
    expect(JSON.parse(output[0]!).malformedLines).toBe(1)
    expect(await runPermissionDiagnostics(["--unknown"], io)).toBe(1)
    expect(errors.join(" ")).toContain("Unknown option")
    output.length = 0
    expect(await runPermissionDiagnostics(["--help"], io)).toBe(0)
    expect(output.join(" ")).toContain("--session")
  })
})
