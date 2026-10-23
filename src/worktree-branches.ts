import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { runCommand } from "./process"

function canonical(path: string): string {
  const value = realpathSync(resolve(path)).replaceAll("\\", "/")
  return process.platform === "win32" ? value.toLowerCase() : value
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(`Git ${args[0]} failed while managing an Ensemble branch`)
  return result.stdout.trim()
}

/** Attach a fresh, verified host worktree to a unique branch without moving HEAD. */
export async function attachWorktreeBranch(directory: string, source: string): Promise<string> {
  if (canonical(directory) === canonical(source)) throw new Error("Refusing to attach the source checkout")
  const common = await git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")
  const sourceCommon = await git(source, "rev-parse", "--path-format=absolute", "--git-common-dir")
  if (canonical(common) !== canonical(sourceCommon)) throw new Error("Worktree belongs to another repository")
  const entries = (await git(source, "worktree", "list", "--porcelain", "-z")).split("\0")
  if (!entries.some(entry => entry.startsWith("worktree ") && canonical(entry.slice(9)) === canonical(directory))) {
    throw new Error("Directory is not a registered worktree")
  }
  const current = await git(directory, "branch", "--show-current")
  if (current) throw new Error("Refusing to replace an existing checkout branch")
  const head = await git(directory, "rev-parse", "--verify", "HEAD")
  const branch = `ensemble-${randomUUID()}`
  await git(directory, "switch", "-c", branch, head)
  if (await git(directory, "branch", "--show-current") !== branch || await git(directory, "rev-parse", "HEAD") !== head) {
    throw new Error("Worktree branch attachment could not be verified")
  }
  return branch
}

/** Delete an owned branch locally and on configured remotes without deleting newer remote work. */
export async function deleteOwnedBranch(branch: string, cwd: string, safetyBranch?: string): Promise<boolean> {
  if (!["ensemble-", "ensemble/preserved/", "opencode/ensemble-"].some(prefix => branch.startsWith(prefix))) return false
  try {
    await git(cwd, "check-ref-format", `refs/heads/${branch}`)
    const ref = `refs/heads/${branch}`
    const local = await runCommand(["git", "show-ref", "--verify", "--quiet", ref], { cwd })
    if (local.exitCode !== 0 && local.exitCode !== 1) return false
    const exists = local.exitCode === 0
    if (!exists && !safetyBranch?.startsWith("ensemble/preserved/")) return false
    const tip = await git(cwd, "rev-parse", "--verify", exists ? ref : `refs/heads/${safetyBranch}`)
    if (safetyBranch && await git(cwd, "rev-parse", "--verify", `refs/heads/${safetyBranch}`) !== tip) return false
    const worktrees = (await git(cwd, "worktree", "list", "--porcelain", "-z")).split("\0")
    if (worktrees.includes(`branch ${ref}`)) return false
    const remotes = (await git(cwd, "remote")).split("\n").filter(Boolean)
    // Inspect all remotes before changing any; never infer absence from a failed lookup.
    const published: string[] = []
    for (const remote of remotes) {
      const rows = await git(cwd, "ls-remote", "--heads", "--", remote, ref)
      if (!rows) continue
      if (rows.split(/\r?\n/u).some(row => row !== `${tip}\t${ref}`)) return false
      published.push(remote)
    }
    for (const remote of published) {
      await git(cwd, "push", `--force-with-lease=${ref}:${tip}`, "--", remote, `:${ref}`)
    }
    // A concurrent local update must not be removed either. update-ref uses a CAS.
    if (exists) await git(cwd, "update-ref", "-d", ref, tip)
    return true
  } catch {
    return false
  }
}
