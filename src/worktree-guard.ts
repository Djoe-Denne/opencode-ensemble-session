import { createHash } from "node:crypto"

/** True when `opencode` and `worktree` are consecutive directory segments. A filename substring does not count. */
export function isEnsembleWorktree(directory: string): boolean {
  const segments = directory.split(/[\\/]+/u).filter(segment => segment.length > 0)
  return segments.some((segment, index) => segment.toLowerCase() === "opencode" && segments[index + 1]?.toLowerCase() === "worktree")
}

/**
 * New worktree slug. It hashes the project id and omits the display name and `#`.
 * Older `ensemble-...#...` names stay readable by cleanup.
 */
export function worktreeSlug(projectId: string, teamId: string, memberName: string): string {
  const hash = createHash("sha256").update(projectId).digest("hex").slice(0, 8)
  const short = (teamId.split("_").at(-1) || teamId).replace(/[^a-z0-9]/giu, "").slice(0, 6).toLowerCase() || "team"
  const member = memberName.toLowerCase().replace(/[^a-z0-9-]/gu, "").replace(/^-+|-+$/gu, "") || "member"
  return `ensemble-${hash}-${short}-${member}`
}

/** Closed admission before promptAsync. Writers need a proved directory and branch. */
export function admitWorktree(input: { agent: string; worktree?: boolean; directory: string | null; branch: string | null }):
  { state: "off"; reason: "readonly-agent" | "flag" } | { state: "ready"; directory: string; branch: string } | { state: "failed"; reason: string } {
  if (input.agent === "plan" || input.agent === "explore") return { state: "off", reason: "readonly-agent" }
  if (input.worktree === false) return { state: "off", reason: "flag" }
  if (!input.directory || !input.branch) return { state: "failed", reason: "worktree.create did not prove a directory and branch" }
  return { state: "ready", directory: input.directory, branch: input.branch }
}

/**
 * Empty `git branch --show-current` may switch only when the expected branch already points at HEAD.
 * A different commit is a failure and is not reset.
 */
export function branchAdmission(input: { showCurrent: string; expectedBranch: string; head: string; expectedHead: string; branchExistsAtHead: boolean }):
  { action: "ok" } | { action: "switch" } | { action: "fail"; message: string } {
  if (input.showCurrent === input.expectedBranch) return { action: "ok" }
  if (!input.showCurrent && input.branchExistsAtHead && input.head === input.expectedHead) return { action: "switch" }
  return { action: "fail", message: `Refusing to reset. Expected ${input.expectedBranch} at ${input.expectedHead}; HEAD is ${input.head}.` }
}

/** Link node_modules from the canonical tree. Never plan a bun install, and never delete the canonical target. */
export function toolchainPlan(input: { canonicalNodeModules: boolean; linkPresent: boolean; worktreeDir: string; canonicalDir: string }):
  { action: "link"; from: string; to: string } | { action: "present" } | { action: "error"; message: string } {
  if (input.linkPresent) return { action: "present" }
  if (!input.canonicalNodeModules) {
    return { action: "error", message: `${input.worktreeDir} has no node_modules. Run bun install --frozen-lockfile in the worktree. Canonical ${input.canonicalDir} has none to link.` }
  }
  return { action: "link", from: input.canonicalDir, to: input.worktreeDir }
}

/** Cleanup removes the link path and never the canonical directory. */
export function toolchainCleanup(linkPath: string, canonicalDir: string): { remove: string[]; preserve: string[] } {
  return { remove: [linkPath], preserve: [canonicalDir] }
}

/** A root longer than the budget needs the first free subst letter. An empty pool refuses the long path. */
export function shortPathPlan(input: { directory: string; budget: number; freeLetters: readonly string[] }):
  { directory: string; letter?: string } | { error: string } {
  if (input.directory.length <= input.budget) return { directory: input.directory }
  const letter = input.freeLetters[0]
  if (!letter) return { error: "No subst letter is free; refusing the long worktree path" }
  return { directory: `${letter}:\\`, letter }
}

/** V1 shell.env guard. A ready member must already be in the admitted directory or its short path. */
export function assertMemberShellCwd(input: { status: string; cwd: string; expected: readonly string[] }): void {
  if (input.status !== "ready" || input.expected.length === 0) return
  const normalize = (value: string): string => value.replace(/[\\/]+$/u, "").toLowerCase()
  if (input.expected.some(directory => normalize(directory) === normalize(input.cwd))) return
  throw new Error(`Shell cwd ${input.cwd} is outside the admitted worktree. Expected ${input.expected.join(" or ")}`)
}

/**
 * The safety ref is copied from the live checkout branch.
 * Graceful shutdown records the ref without replacing the checkout name.
 */
export function preserveTransition(input: { checkoutBranch: string }): { checkoutBranch: string; preservedBranch: string; copyFrom: string } {
  return {
    checkoutBranch: input.checkoutBranch,
    preservedBranch: `ensemble/preserved/${input.checkoutBranch}`,
    copyFrom: input.checkoutBranch,
  }
}
