import { afterEach, beforeEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { attachWorktreeBranch, deleteOwnedBranch } from "../src/worktree-branches"
import { deleteBranch, preserveBranch } from "../src/tools/merge-helper"
import { createV2Client, type V2Context } from "../src/v2-client"
import { executeTeamMerge } from "../src/tools/team-merge"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { worktreeSlug } from "../src/worktree-guard"

let root: string
let repo: string
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

beforeEach(() => {
  const temp = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? ".", "Temp", "opencode")
  mkdirSync(temp, { recursive: true })
  root = mkdtempSync(join(temp, "ensemble-branches-test-"))
  repo = join(root, "repo")
  mkdirSync(repo)
  git(repo, "init", "-b", "main")
  git(repo, "config", "user.email", "test@example.com")
  git(repo, "config", "user.name", "Test")
  git(repo, "commit", "--allow-empty", "-m", "base")
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

test("attaches a native detached worktree without changing its commit or main", async () => {
  const directory = join(root, "worker")
  const head = git(repo, "rev-parse", "HEAD")
  git(repo, "worktree", "add", "--detach", directory, "HEAD")
  const branch = await attachWorktreeBranch(directory, repo)
  expect(branch).toStartWith("ensemble-")
  expect(git(directory, "branch", "--show-current")).toBe(branch)
  expect(git(directory, "rev-parse", "HEAD")).toBe(head)
  expect(git(repo, "branch", "--show-current")).toBe("main")
})

test("does not attach the source checkout or an unrelated repository", async () => {
  await expect(attachWorktreeBranch(repo, repo)).rejects.toThrow()
  const other = join(root, "other")
  git(repo, "clone", repo, other)
  await expect(attachWorktreeBranch(other, repo)).rejects.toThrow()
  expect(git(other, "branch", "--show-current")).toBe("main")
})

test("deletes owned local and remote branches and tolerates an absent remote ref", async () => {
  const remote = join(root, "remote.git")
  git(repo, "init", "--bare", remote)
  git(repo, "remote", "add", "origin", remote)
  git(repo, "branch", "ensemble-test")
  git(repo, "push", "origin", "ensemble-test")
  expect(await deleteBranch("ensemble-test", repo)).toBe(true)
  expect(git(repo, "ls-remote", "--heads", "origin", "refs/heads/ensemble-test")).toBe("")
  expect(git(repo, "branch", "--list", "ensemble-test")).toBe("")
  git(repo, "branch", "ensemble-local-only")
  expect(await deleteOwnedBranch("ensemble-local-only", repo)).toBe(true)
  git(repo, "branch", "opencode/ensemble-legacy")
  expect(await deleteOwnedBranch("opencode/ensemble-legacy", repo)).toBe(true)
})

test("retains both references when the remote has newer work", async () => {
  const remote = join(root, "remote.git")
  git(repo, "init", "--bare", remote)
  git(repo, "remote", "add", "origin", remote)
  git(repo, "branch", "ensemble-test")
  git(repo, "push", "origin", "ensemble-test")
  git(repo, "commit", "--allow-empty", "-m", "newer remote")
  git(repo, "push", "origin", "HEAD:refs/heads/ensemble-test")
  expect(await deleteOwnedBranch("ensemble-test", repo)).toBe(false)
  expect(git(repo, "branch", "--list", "ensemble-test")).not.toBe("")
  expect(git(repo, "ls-remote", "--heads", "origin", "refs/heads/ensemble-test")).not.toBe("")
})

test("cleans a remote checkout ref after the host removed its local branch, using the safety copy", async () => {
  const remote = join(root, "remote.git")
  git(repo, "init", "--bare", remote)
  git(repo, "remote", "add", "origin", remote)
  git(repo, "branch", "ensemble-host-removed")
  git(repo, "branch", "ensemble/preserved/test/member")
  git(repo, "push", "origin", "ensemble-host-removed")
  git(repo, "branch", "-D", "ensemble-host-removed")
  expect(await deleteOwnedBranch("ensemble-host-removed", repo, "ensemble/preserved/test/member")).toBe(true)
  expect(git(repo, "ls-remote", "--heads", "origin", "refs/heads/ensemble-host-removed")).toBe("")
  expect(git(repo, "branch", "--list", "ensemble/preserved/test/member")).not.toBe("")
})

test("never deletes a shared branch or a branch still attached to a worktree", async () => {
  expect(await deleteOwnedBranch("main", repo)).toBe(false)
  git(repo, "worktree", "add", "-b", "ensemble-busy", join(root, "busy"))
  expect(await deleteOwnedBranch("ensemble-busy", repo)).toBe(false)
  expect(git(repo, "branch", "--list", "ensemble-busy")).not.toBe("")
})

test("an unreachable remote leaves the local branch available for retry", async () => {
  git(repo, "remote", "add", "origin", join(root, "missing.git"))
  git(repo, "branch", "ensemble-offline")
  writeFileSync(join(repo, "untracked.txt"), "untouched")
  expect(await deleteOwnedBranch("ensemble-offline", repo)).toBe(false)
  expect(git(repo, "branch", "--list", "ensemble-offline")).not.toBe("")
})

test("a remote rejection keeps the local branch and a later retry completes deletion", async () => {
  const remote = join(root, "remote.git")
  git(repo, "init", "--bare", remote)
  git(repo, "remote", "add", "origin", remote)
  git(repo, "branch", "ensemble-rejected")
  git(repo, "push", "origin", "ensemble-rejected")
  git(remote, "config", "receive.denyDeletes", "true")
  expect(await deleteOwnedBranch("ensemble-rejected", repo)).toBe(false)
  expect(git(repo, "branch", "--list", "ensemble-rejected")).not.toBe("")
  git(remote, "config", "receive.denyDeletes", "false")
  expect(await deleteOwnedBranch("ensemble-rejected", repo)).toBe(true)
})

test("native detached creation → agent commit → supervisor merge → local/remote branch cleanup", async () => {
  const parent = join(root, "opencode", "worktree", "fixture")
  mkdirSync(parent, { recursive: true })
  const directory = join(parent, worktreeSlug(repo, "t1", "alice"))
  const remote = join(root, "remote.git")
  git(repo, "init", "--bare", remote)
  git(repo, "remote", "add", "origin", remote)
  let registered = true
  const adapter = createV2Client({
    location: { directory: repo, project: { id: "native-fixture" } },
    session: {} as V2Context["session"],
    worktree: {
      create: async () => {
        git(repo, "worktree", "add", "--detach", directory, "HEAD")
        return { directory }
      },
      remove: async () => { git(repo, "worktree", "remove", directory); registered = false },
      list: async () => registered ? [{ directory }] : [],
      refresh: async () => undefined,
    },
  })
  const worktree = (await adapter.worktree.create({ worktreeCreateInput: { name: worktreeSlug(repo, "t1", "alice") } })).data!
  writeFileSync(join(directory, "worker.txt"), "agent contribution\n")
  git(directory, "add", "worker.txt")
  git(directory, "commit", "-m", "agent work")
  git(directory, "push", "origin", worktree.branch)
  const safety = "ensemble/preserved/integration/member"
  expect(await preserveBranch(worktree.branch, safety, repo)).toBe(true)
  const deps = setupDeps()
  deps.directory = repo
  deps.preserveBranch = preserveBranch
  deps.client.worktree = adapter.worktree
  insertTeam(deps.db, "t1", "integration", "lead")
  deps.db.run("INSERT INTO project (id, name, path, time_created, time_updated) VALUES (?, 'fixture', ?, 1, 1)", [repo, repo])
  deps.db.run("UPDATE team SET project_id = ? WHERE id = 't1'", [repo])
  insertMember(deps.db, "t1", "alice", "worker-session", "shutdown", "completed")
  deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ?, checkout_branch = ?, preserved_branch = ? WHERE name = 'alice'", [directory, worktree.branch, worktree.branch, safety])
  try {
    git(remote, "config", "receive.denyDeletes", "true")
    expect(await executeTeamMerge(deps, { member: "alice" }, "lead")).toContain("cleanup pending")
    git(remote, "config", "receive.denyDeletes", "false")
    expect(await executeTeamMerge(deps, { member: "alice" }, "lead")).toContain("Merged alice's changes")
    expect(git(repo, "branch", "--list")).toBe("* main")
    expect(git(repo, "ls-remote", "--heads", "origin")).toBe("")
    expect(git(repo, "status", "--short")).toBe("?? worker.txt")
    expect(await Bun.file(join(repo, "worker.txt")).text()).toBe("agent contribution\n")
    expect(await executeTeamCleanup(deps, { force: false }, "lead")).toContain("cleaned up")
    expect(git(repo, "branch", "--show-current")).toBe("main")
  } finally {
    deps.db.close()
  }
})
