import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { retireV2Worktree } from "../src/v2-worktree-retirement"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ensemble-retire-"))
  roots.push(root)
  const canonicalDirectory = join(root, "canonical space é")
  const directory = join(root, "opencode", "worktree", "project space é", "ensemble-owned")
  mkdirSync(canonicalDirectory)
  mkdirSync(directory, { recursive: true })
  execFileSync("git", ["init", "--quiet", canonicalDirectory])
  const entries = new Set([directory])
  const calls: string[] = []
  const host = {
    list: async () => ({ data: [...entries].map(directory => ({ directory, strategy: "git" })) }),
    remove: async () => { calls.push("remove"); entries.delete(directory); rmSync(directory, { recursive: true }) },
    refresh: async (input?: Record<string, unknown>) => { expect(input).toEqual({ projectID: "native-project" }); calls.push("refresh"); entries.delete(directory) },
  }
  const request = { directory, canonicalDirectory, expectedName: "ensemble-owned", checkoutBranch: null, preservedBranch: null }
  return { root, directory, entries, calls, host, request }
}

describe("V2 retirement filesystem and public inventory", () => {
  test("normal checkout removal verifies retained branch tips and all postconditions", async () => {
    const f = fixture()
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.request.canonicalDirectory, encoding: "utf8" })
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "--quiet", "-m", "initial")
    rmSync(f.directory, { recursive: true })
    git("worktree", "add", "--quiet", "-b", "checkout", f.directory)
    git("branch", "safety", "checkout")
    f.host.remove = async () => { f.calls.push("remove"); git("worktree", "remove", f.directory); f.entries.delete(f.directory) }
    const request = { ...f.request, checkoutBranch: "checkout", preservedBranch: "safety" }
    await retireV2Worktree(f.host, "native-project", request)
    expect(f.calls).toEqual(["remove"])
    expect(existsSync(f.directory)).toBe(false)
    expect(git("rev-parse", "checkout").trim()).toBe(git("rev-parse", "safety").trim())
  })

  test("a checkout branch that advanced beyond its safety ref is retained", async () => {
    const f = fixture()
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.request.canonicalDirectory, encoding: "utf8" })
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "--quiet", "-m", "initial")
    rmSync(f.directory, { recursive: true })
    git("worktree", "add", "--quiet", "-b", "checkout", f.directory)
    git("branch", "safety", "checkout")
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "--quiet", "-m", "new work"], { cwd: f.directory })
    await expect(retireV2Worktree(f.host, "native-project", { ...f.request, checkoutBranch: "checkout", preservedBranch: "safety" })).rejects.toThrow("Refusing")
    expect(f.calls).toEqual([])
    expect(existsSync(f.directory)).toBe(true)
  })

  test("a junction or symbolic path is rejected without native operations", async () => {
    const f = fixture()
    rmSync(f.directory, { recursive: true })
    symlinkSync(f.request.canonicalDirectory, f.directory, process.platform === "win32" ? "junction" : "dir")
    await expect(retireV2Worktree(f.host, "native-project", f.request)).rejects.toThrow("symbolic link")
    expect(f.calls).toEqual([])
  })
  test("an empty stale checkout reconciles through project refresh, never force removal", async () => {
    const f = fixture()
    await retireV2Worktree(f.host, "native-project", f.request)
    expect(f.calls).toEqual(["refresh"])
    expect(existsSync(f.directory)).toBe(false)
    await retireV2Worktree(f.host, "native-project", f.request)
    expect(f.calls).toEqual(["refresh"])
  })

  test("a surviving native record retains the empty directory and actionable failure", async () => {
    const f = fixture()
    f.host.refresh = async () => { f.calls.push("refresh") }
    await expect(retireV2Worktree(f.host, "native-project", f.request)).rejects.toThrow("native registration remains")
    expect(existsSync(f.directory)).toBe(true)
  })

  test("an orphan containing data is not removed", async () => {
    const f = fixture()
    writeFileSync(join(f.directory, "keep.txt"), "important")
    await expect(retireV2Worktree(f.host, "native-project", f.request)).rejects.toThrow("Refusing")
    expect(f.calls).toEqual([])
    expect(existsSync(join(f.directory, "keep.txt"))).toBe(true)
  })

  test("a foreign directory or missing project identity never enters native removal", async () => {
    const f = fixture()
    await expect(retireV2Worktree(f.host, "native-project", { ...f.request, expectedName: "another-member" })).rejects.toThrow("Refusing")
    await expect(retireV2Worktree(f.host, undefined, f.request)).rejects.toThrow("project identity")
    expect(f.calls).toEqual([])
  })
})
