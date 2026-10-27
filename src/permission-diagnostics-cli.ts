import { readPermissionDiagnostics, type PermissionDiagnosticQuery } from "./permission-diagnostics-reader"

interface DiagnosticIO {
  out(text: string): void
  error(text: string): void
}

/** Read-only CLI; returns an exit code and never changes a permission or replays a tool call. */
export async function runPermissionDiagnostics(args: readonly string[], io: DiagnosticIO = { out: console.log, error: console.error }): Promise<number> {
  const help = "Permission diagnostics (read-only)\n--session <sessionID>  --project <directory>  --limit <1..1000>\n--log-dir <directory>  --json  --help\nNo permission is changed and no failed call is retried."
  try {
    const query: PermissionDiagnosticQuery = {}
    let json = false
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]
      if (flag === "--") continue
      if (flag === "--help") { io.out(help); return 0 }
      if (flag === "--json") { json = true; continue }
      if (!["--session", "--project", "--limit", "--log-dir"].includes(flag ?? "")) throw new Error("Unknown option. Use --help for supported filters.")
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
      if (flag === "--session") query.sessionID = value
      if (flag === "--project") query.projectDirectory = value
      if (flag === "--log-dir") query.directory = value
      if (flag === "--limit") query.limit = /^[0-9]+$/u.test(value) ? Number(value) : Number.NaN
    }
    const report = await readPermissionDiagnostics(query)
    if (json) io.out(JSON.stringify(report, null, 2))
    else {
      const categories = {
        permission_denied: "Permission denied (the precise rule is not established)",
        user_rejected: "The user rejected the action",
        filesystem_access_denied: "The operating system refused file access",
        external_authorization_denied: "An external service refused authorization (401/403)",
        tool_unavailable: "Tool unavailable (not necessarily a permission problem)",
        ensemble_isolation_denied: "Ensemble blocked a team tool in a nested sub-agent",
      }
      io.out(`Permission journal: ${JSON.stringify(report.directory)}\n${report.records.length} recent incidents shown; ${report.matchingObservations} matching observations.`)
      report.records.forEach(record => {
        io.out(`${record.time} — ${categories[record.category]}\n  Tool: ${JSON.stringify(record.tool)}; namespace: ${JSON.stringify(record.namespace)}; agent: ${JSON.stringify(record.agent)}\n  Session: ${JSON.stringify(record.sessionID)}; parent: ${JSON.stringify(record.parentSessionID)}; call: ${JSON.stringify(record.callID)}\n  Project: ${JSON.stringify(record.projectDirectory)}; observation: ${record.observation}${record.observation === "reported_tool_error" ? " (reported by a wrapper, not independently confirmed)" : ""}`)
      })
      if (!report.records.length) io.out("No matching incidents were found. This is not proof that no unobserved failure occurred.")
      if (report.malformedLines || report.unreadableFiles) io.out(`Partial results: ${report.malformedLines} malformed lines; ${report.unreadableFiles} unreadable files.`)
      io.out("Arguments, resource values and raw errors are not recorded. Use the session/call IDs to inspect the native history and relevant agent policy; these symptoms do not justify granting broader permissions.")
    }
    return report.malformedLines || report.unreadableFiles ? 2 : 0
  } catch (error) {
    io.error(error instanceof Error ? error.message : "Permission diagnosis failed")
    return 1
  }
}

if (import.meta.main) process.exitCode = await runPermissionDiagnostics(process.argv.slice(2))
