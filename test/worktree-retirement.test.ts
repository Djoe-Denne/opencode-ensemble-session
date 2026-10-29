import { describe, expect, test } from "bun:test"
import { retireWorktree, retirementDiagnostic, type WorktreeRetirementState } from "../src/worktree-retirement"

function fixture(initial: Partial<WorktreeRetirementState> = {}) {
  const state: WorktreeRetirementState = { owned: true, git: true, native: true, path: "worktree", branchesMatch: true, ...initial }
  const events: string[] = []
  const ports = {
    inspect: async () => { events.push("inspect"); return { ...state } },
    remove: async () => { events.push("remove"); state.git = false; state.native = false; state.path = "absent" },
    refresh: async () => { events.push("refresh"); state.native = false },
    removeEmpty: async () => { events.push("rmdir-empty"); state.path = "absent" },
  }
  return { state, events, ports }
}

describe("verified worktree retirement", () => {
  test("diagnostics retain error identity and stage without dumping credentials or raw requests", () => {
    const error = Object.assign(new Error("cannot remove token=supersecret Authorization: Bearer secret-value\nrequest: private body"), { code: "EBUSY", request: { password: "private" } })
    const text = retirementDiagnostic(error, "worker", "worktree-retire")
    expect(text).toContain("worker")
    expect(text).toContain("worktree-retire")
    expect(text).toContain("EBUSY")
    expect(text).not.toContain("supersecret")
    expect(text).not.toContain("secret-value")
    expect(text).not.toContain("private")
    expect(text.length).toBeLessThan(600)
  })

  test("native tagged errors keep their nested safe message", () => {
    expect(retirementDiagnostic({ _tag: "WorktreeError", data: { message: "Worktree directory unavailable", forceRequired: null } }, "worker", "worktree-retire"))
      .toContain("Worktree directory unavailable")
  })
  test("normal removal is verified before returning", async () => {
    const f = fixture()
    await retireWorktree(f.ports)
    expect(f.events).toEqual(["inspect", "remove", "inspect"])
  })

  test("partial Git removal reconciles native inventory and removes only the empty owned directory", async () => {
    const f = fixture()
    f.ports.remove = async () => { f.events.push("remove"); f.state.git = false; f.state.path = "empty"; throw new Error("worktree already gone") }
    await retireWorktree(f.ports)
    expect(f.events).toEqual(["inspect", "remove", "inspect", "refresh", "inspect", "rmdir-empty", "inspect"])
    await retireWorktree(f.ports)
    expect(f.events.filter(e => e === "remove")).toHaveLength(1)
  })

  test("already absent Git/native/path is a no-op", async () => {
    const f = fixture({ git: false, native: false, path: "absent" })
    await retireWorktree(f.ports)
    expect(f.events).toEqual(["inspect"])
  })

  test("stale native registration uses public reconciliation without repeating a completed Git removal", async () => {
    const f = fixture({ git: false, path: "empty" })
    await retireWorktree(f.ports)
    expect(f.events).not.toContain("remove")
    expect(f.state).toMatchObject({ git: false, native: false, path: "absent" })
  })

  test("a native record that survives refresh is not reported as success", async () => {
    const f = fixture({ git: false, path: "empty" })
    f.ports.refresh = async () => { f.events.push("refresh") }
    await expect(retireWorktree(f.ports)).rejects.toThrow("native registration remains")
    expect(f.events).not.toContain("rmdir-empty")
  })

  test("partial-removal failure identity survives a nonconvergent reconciliation", async () => {
    const f = fixture()
    f.ports.remove = async () => { f.state.git = false; f.state.path = "empty"; throw Object.assign(new Error("initial host failure"), { code: "EBUSY" }) }
    f.ports.refresh = async () => undefined
    let diagnostic = ""
    try { await retireWorktree(f.ports) } catch (error) { diagnostic = retirementDiagnostic(error, "worker", "worktree-retire") }
    expect(diagnostic).toContain("native registration remains")
    expect(diagnostic).toContain("EBUSY")
    expect(diagnostic).toContain("initial host failure")
  })

  test.each([
    { owned: false }, { path: "nonempty" as const, git: false }, { path: "symlink" as const }, { branchesMatch: false },
  ])("rejects unsafe state %j before mutation", async unsafe => {
    const f = fixture(unsafe)
    await expect(retireWorktree(f.ports)).rejects.toThrow("Refusing")
    expect(f.events).toEqual(["inspect"])
  })

  test("an inspection failure never becomes absence", async () => {
    const f = fixture()
    f.ports.inspect = async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }) }
    await expect(retireWorktree(f.ports)).rejects.toThrow("permission denied")
    expect(f.events).toEqual([])
  })

  test("a host error that leaves Git intact remains an error", async () => {
    const f = fixture()
    f.ports.remove = async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }) }
    await expect(retireWorktree(f.ports)).rejects.toThrow("locked")
    expect(f.events).not.toContain("refresh")
  })
})
