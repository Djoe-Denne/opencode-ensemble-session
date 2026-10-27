import type { PermissionIncident } from "./permission-diagnostics"
import { defaultPermissionLogDirectory, PERMISSION_INCIDENT_CATEGORIES } from "./permission-diagnostics"
import { readdir } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { join, resolve } from "node:path"

/** Read-only selection of the most recent local incidents. */
export interface PermissionDiagnosticQuery {
  directory?: string
  sessionID?: string
  projectDirectory?: string
  limit?: number
}

/** Malformed or unreadable input is reported instead of silently proving absence. */
export interface PermissionDiagnosticReport {
  directory: string
  records: PermissionIncident[]
  matchingObservations: number
  malformedLines: number
  unreadableFiles: number
}

/** Stream local JSONL journals without executing or returning arbitrary log contents. */
export async function readPermissionDiagnostics(query: PermissionDiagnosticQuery = {}): Promise<PermissionDiagnosticReport> {
  const limit = query.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be an integer between 1 and 1000")
  const directory = query.directory ?? defaultPermissionLogDirectory()
  const report: PermissionDiagnosticReport = { directory, records: [], matchingObservations: 0, malformedLines: 0, unreadableFiles: 0 }
  const files = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw new Error("Cannot read the permission diagnostic directory")
  })
  const latest = new Map<string, PermissionIncident>()
  for (const file of files.filter(file => file.isFile() && /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.jsonl$/u.test(file.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const stream = createReadStream(join(directory, file.name), { encoding: "utf8" })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        const incident = decode(line)
        if (!incident) { report.malformedLines++; continue }
        if (query.sessionID && incident.sessionID !== query.sessionID) continue
        if (query.projectDirectory && directoryKey(incident.projectDirectory) !== directoryKey(query.projectDirectory)) continue
        report.matchingObservations++
        latest.set(incident.incidentID, incident)
        if (latest.size > limit) {
          const oldest = [...latest.values()].sort((a, b) => a.time.localeCompare(b.time) || a.incidentID.localeCompare(b.incidentID))[0]
          if (oldest) latest.delete(oldest.incidentID)
        }
      }
    } catch { report.unreadableFiles++ } finally {
      lines.close()
      stream.destroy()
    }
  }
  report.records = [...latest.values()].sort((a, b) => b.time.localeCompare(a.time) || a.incidentID.localeCompare(b.incidentID))
  return report
}

function directoryKey(directory: string): string {
  const path = resolve(directory)
  return process.platform === "win32" ? path.toLowerCase() : path
}

function decode(line: string): PermissionIncident | undefined {
  if (line.length > 65536) return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const value = parsed as Record<string, unknown>
    const required = ["incidentID", "time", "projectDirectory", "sessionID", "tool", "category", "observation", "errorFingerprint"]
    const optional = ["parentSessionID", "agent", "teamID", "ownerMemberName", "namespace", "permissionAction", "callID", "messageID"]
    if (value.version !== 1 || required.some(key => typeof value[key] !== "string" || !value[key] || (value[key] as string).length > 4096)) return undefined
    if (optional.some(key => value[key] !== null && (typeof value[key] !== "string" || !/^[a-zA-Z0-9_.:/@+-]{1,200}$/u.test(value[key] as string)))) return undefined
    if (!(PERMISSION_INCIDENT_CATEGORIES as readonly unknown[]).includes(value.category)) return undefined
    if (!["tool_error", "native_tool_state", "reported_tool_error", "isolation_guard"].includes(value.observation as string)) return undefined
    if (!Number.isFinite(Date.parse(value.time as string)) || !/^[a-f0-9]{64}$/u.test(value.errorFingerprint as string)) return undefined
    // Whitelist output fields even if a journal was manually extended with sensitive data.
    return Object.fromEntries(["version", ...required, ...optional].map(key => [key, value[key]])) as unknown as PermissionIncident
  } catch { return undefined }
}
