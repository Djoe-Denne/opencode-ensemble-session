/** Verified, independent observations of a managed checkout being retired. */
export interface WorktreeRetirementState {
  owned: boolean
  git: boolean
  native: boolean
  path: "absent" | "empty" | "worktree" | "nonempty" | "symlink"
  branchesMatch: boolean
}

/** Public host operations and bounded filesystem inspection for a retirement. */
export interface WorktreeRetirementPorts {
  inspect(): Promise<WorktreeRetirementState>
  remove(): Promise<unknown>
  refresh(): Promise<unknown>
  removeEmpty(): Promise<void>
}

/** Return only bounded, redacted error identity and first-line context. */
export function retirementDiagnostic(error: unknown, member: string, step: string): string {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {}
  const clean = (text: unknown, limit: number): string => {
    if (typeof text !== "string") return ""
    const redacted = (text.slice(0, 4096).split(/[\r\n]/u)[0] ?? "")
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/giu, "[credential]")
      .replace(/\b(?:token|password|secret|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/giu, "[credential]")
      .replace(/https?:\/\/[^\s]+/giu, "[url]").replace(/\{.*\}/gu, "[details omitted]")
    return Array.from(redacted, character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character).join("").slice(0, limit)
  }
  const kind = clean(value._tag ?? value.name, 60) || "Error"
  const code = clean(value.code, 40)
  const data = value.data && typeof value.data === "object" ? value.data as Record<string, unknown> : {}
  const message = clean(typeof error === "string" ? error : value.message ?? data.message, 260) || "No safe error message available"
  const cause = value.cause && typeof value.cause === "object" ? value.cause as Record<string, unknown> : undefined
  const causeData = cause?.data && typeof cause.data === "object" ? cause.data as Record<string, unknown> : undefined
  const causeText = cause ? `; cause [${clean(cause._tag ?? cause.name, 40)}/${clean(cause.code, 30)}]: ${clean(cause.message ?? causeData?.message, 120)}` : ""
  return `${clean(member, 80)}: ${clean(step, 60)} failed [${kind}${code ? `/${code}` : ""}]: ${message}${causeText}`.slice(0, 590)
}

/** Retire a checkout only after independent Git/native/path postconditions hold. */
export async function retireWorktree(ports: WorktreeRetirementPorts): Promise<void> {
  const safe = (state: WorktreeRetirementState): void => {
    if (!state.owned || !state.branchesMatch || state.path === "symlink" || state.path === "nonempty" || (state.path === "worktree" && !state.git)) {
      throw new Error("Refusing unsafe worktree retirement: ownership, path or branch changed")
    }
  }
  let state = await ports.inspect()
  let removalFailure: unknown
  safe(state)
  if (state.git) {
    try { await ports.remove() } catch (error) { removalFailure = error }
    state = await ports.inspect()
    safe(state)
    if (state.git) throw removalFailure ?? new Error("Worktree removal returned without retiring Git registration")
  }
  if (state.native) {
    await ports.refresh()
    state = await ports.inspect()
    safe(state)
    if (state.native) throw new Error("OpenCode native registration remains after public inventory reconciliation; host idempotent retirement is required", { cause: removalFailure })
  }
  if (state.path === "empty") {
    await ports.removeEmpty()
    state = await ports.inspect()
    safe(state)
  }
  if (state.git || state.native || state.path !== "absent") throw new Error("Worktree retirement postconditions are not satisfied")
}
