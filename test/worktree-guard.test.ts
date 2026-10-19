import { describe, expect, test } from "bun:test"
import { admitWorktree, assertMemberShellCwd, branchAdmission, isEnsembleWorktree, preserveTransition, shortPathPlan, toolchainCleanup, toolchainPlan, worktreeSlug } from "../src/worktree-guard"

describe("worktree admission", () => {
  test("fails a writer when create returns no directory and does not describe a shared directory", () => {
    const admitted = admitWorktree({ agent: "build", directory: null, branch: null })
    expect(admitted.state).toBe("failed")
    expect(JSON.stringify(admitted)).not.toContain("shared directory")
    expect(JSON.stringify(admitted)).not.toContain("spawned")
  })

  test("keeps a read-only agent and an explicit flag off", () => {
    expect(admitWorktree({ agent: "explore", worktree: false, directory: null, branch: null })).toEqual({ state: "off", reason: "readonly-agent" })
    expect(admitWorktree({ agent: "build", worktree: false, directory: null, branch: null })).toEqual({ state: "off", reason: "flag" })
  })

  test("recognizes worktree directory segments on Windows and ignores a filename substring", () => {
    expect(isEnsembleWorktree("C:\\Users\\x\\.local\\share\\opencode\\worktree\\abc\\ensemble-team-alice")).toBe(true)
    expect(isEnsembleWorktree("C:/Users/x/repositories/my-project")).toBe(false)
    expect(isEnsembleWorktree("C:/Users/x/my-opencode/worktree-notes.txt")).toBe(false)
    expect(isEnsembleWorktree("/home/user/.local/share/opencode/worktree/abc123/ensemble-team-alice")).toBe(true)
  })

  test("switches only when the expected branch already matches HEAD", () => {
    expect(branchAdmission({ showCurrent: "", expectedBranch: "ensemble-alice", head: "abc", expectedHead: "abc", branchExistsAtHead: true }).action).toBe("switch")
    const failed = branchAdmission({ showCurrent: "", expectedBranch: "ensemble-alice", head: "abc", expectedHead: "def", branchExistsAtHead: false })
    expect(failed.action).toBe("fail")
    if (failed.action === "fail") expect(failed.message).toContain("def")
  })

  test("copies the safety ref from the live checkout branch", () => {
    const transition = preserveTransition({ checkoutBranch: "ensemble-alice" })
    expect(transition.checkoutBranch).toBe("ensemble-alice")
    expect(transition.copyFrom).toBe("ensemble-alice")
    expect(transition.copyFrom).not.toContain("ensemble/preserved/")
  })

  test("plans a node_modules link and never deletes the canonical tree", () => {
    expect(toolchainPlan({ canonicalNodeModules: true, linkPresent: false, worktreeDir: "/wt", canonicalDir: "/repo" }).action).toBe("link")
    const missing = toolchainPlan({ canonicalNodeModules: false, linkPresent: false, worktreeDir: "/wt", canonicalDir: "/repo" })
    expect(missing.action).toBe("error")
    if (missing.action === "error") {
      expect(missing.message).toContain("/wt")
      expect(missing.message).toContain("bun install --frozen-lockfile")
    }
    expect(toolchainCleanup("/wt/node_modules", "/repo/node_modules")).toEqual({ remove: ["/wt/node_modules"], preserve: ["/repo/node_modules"] })
  })

  test("uses the first free subst letter and refuses an empty pool", () => {
    const long = "C:\\" + "a".repeat(90)
    expect(shortPathPlan({ directory: long, budget: 80, freeLetters: ["S", "T"] })).toEqual({ directory: "S:\\", letter: "S" })
    expect(shortPathPlan({ directory: long, budget: 80, freeLetters: [] })).toEqual({ error: "No subst letter is free; refusing the long worktree path" })
    expect(assertMemberShellCwd.bind(undefined, { status: "ready", cwd: "/repo", expected: ["/wt"] })).toThrow("/wt")
    expect(() => assertMemberShellCwd({ status: "ready", cwd: "S:\\", expected: ["S:\\"] })).not.toThrow()
  })

  test("omits the project display name and the hash mark", () => {
    const slug = worktreeSlug("/tmp/test-project", "team_mvf7o9mu_0000_v6ro5m", "alice")
    expect(slug.startsWith("ensemble-")).toBe(true)
    expect(slug).not.toContain("#")
    expect(slug).not.toContain("mcp-lifecycle")
    expect(worktreeSlug("/tmp/other", "team_mvf7o9mu_0000_v6ro5m", "alice")).not.toBe(slug)
  })
})
