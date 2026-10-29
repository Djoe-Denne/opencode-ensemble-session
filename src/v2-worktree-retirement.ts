/** Persisted member identity and safety refs required for native retirement. */
export interface WorktreeRetirementRequest {
  directory: string
  canonicalDirectory: string
  expectedName: string
  checkoutBranch: string | null
  preservedBranch: string | null
}

/** Native public worktree operations; refresh reconciles only this project's inventory. */
export interface NativeWorktreeRetirementHost {
  list(input?: Record<string, unknown>): Promise<unknown>
  remove(input: Record<string, unknown>): Promise<unknown>
  refresh(input?: Record<string, unknown>): Promise<unknown>
}

/** Verify Git, host inventory and filesystem independently before retiring a member. */
export async function retireV2Worktree(host: NativeWorktreeRetirementHost, projectID: string | undefined, request: WorktreeRetirementRequest): Promise<void> {
  if (!projectID) throw new Error("Native project identity is required for verified worktree retirement")
  const normalize = (value: string) => {
    const result = path.resolve(value).replaceAll("\\", "/").replace(/\/$/u, "")
    return process.platform === "win32" ? result.toLowerCase() : result
  }
  const directory = path.resolve(request.directory)
  if (!path.isAbsolute(request.directory) || !isEnsembleWorktree(directory) ||
      path.basename(directory) !== request.expectedName || !request.expectedName.startsWith("ensemble-") ||
      normalize(directory) === normalize(request.canonicalDirectory)) throw new Error("Refusing worktree retirement outside the persisted member identity")
  const stat = async (name: string) => {
    try { return await lstat(name) } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
  }
  const git = async (...args: string[]) => {
    const result = await runCommand(["git", ...args], { cwd: request.canonicalDirectory })
    if (result.exitCode !== 0) throw new Error("Cannot inspect project Git state for worktree retirement")
    return result.stdout.trim()
  }
  const ref = async (branch: string | null): Promise<string | undefined> => {
    if (!branch) return undefined
    const result = await runCommand(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: request.canonicalDirectory })
    if (result.exitCode === 1) return undefined
    if (result.exitCode !== 0) throw new Error("Cannot verify retained branch identity")
    return result.stdout.trim()
  }
  const inspect = async (): Promise<WorktreeRetirementState> => {
    // lstat every ancestor: a junction/symlink must never redirect teardown.
    for (let parent = directory; ; parent = path.dirname(parent)) {
      if ((await stat(parent))?.isSymbolicLink()) throw new Error("Refusing worktree retirement through a symbolic link")
      if (parent === path.dirname(parent)) break
    }
    const inventory = await git("worktree", "list", "--porcelain", "-z")
    const entries = inventory.split("\0\0").map(block => ({
      directory: block.split("\0").find(line => line.startsWith("worktree "))?.slice(9),
      branch: block.split("\0").find(line => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//u, ""),
    }))
    const entry = entries.find(entry => entry.directory && normalize(entry.directory) === normalize(directory))
    if (entries[0]?.directory && normalize(entries[0].directory) === normalize(directory)) throw new Error("Refusing canonical checkout retirement")
    const raw = await host.list({ projectID })
    const native = Array.isArray(raw) ? raw : raw && typeof raw === "object" && "data" in raw ? raw.data : undefined
    if (!Array.isArray(native) || native.some(entry => !entry || typeof entry.directory !== "string")) throw new Error("Cannot inspect native worktree inventory")
    const info = await stat(directory)
    const contents = info?.isDirectory() ? await readdir(directory) : []
    const kind = !info ? "absent" : !info.isDirectory() ? "nonempty" : !contents.length ? "empty"
      : entry && (await stat(path.join(directory, ".git")))?.isFile() ? "worktree" : "nonempty"
    const [checkout, safety] = await Promise.all([ref(request.checkoutBranch), ref(request.preservedBranch)])
    const branchesMatch = entry
      ? Boolean(request.checkoutBranch && entry.branch === request.checkoutBranch && safety && checkout === safety && request.checkoutBranch !== request.preservedBranch)
      : !checkout || Boolean(safety && checkout === safety)
    return { owned: true, git: Boolean(entry), native: native.some(entry => normalize(entry.directory) === normalize(directory)), path: kind, branchesMatch }
  }
  await retireWorktree({ inspect,
    remove: () => host.remove({ projectID, directory, force: false }),
    refresh: () => host.refresh({ projectID }),
    removeEmpty: () => rmdir(directory),
  })
}
import { lstat, readdir, rmdir } from "node:fs/promises"
import path from "node:path"
import { runCommand } from "./process"
import { isEnsembleWorktree } from "./worktree-guard"
import { retireWorktree, type WorktreeRetirementState } from "./worktree-retirement"
