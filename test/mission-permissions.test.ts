import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { prepareMission, openMissionConfiguration, approveMission } from "../src/mission-policy"
import { MissionPermissions, type MissionPermissionsHost } from "../src/mission-permissions"
import { setupDeps, insertMember } from "./helpers"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
const full: Rule = { action: "*", resource: "*", effect: "allow" }
const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

async function fixture() {
  const deps = setupDeps()
  deps.directory = mkdtempSync(join(tmpdir(), "ensemble-permissions-"))
  directories.push(deps.directory)
  deps.config = { ...deps.config, modelRouting: { ...deps.config.modelRouting,
    models: [{ id: "fixture/worker", intelligenceScore: 60, averageCostPerTask: 1, available: true }] } }
  const mission = await prepareMission(deps, "lead", "Complete the long-run mission")
  const edit = (mode: "long_run" | "supervised") => {
    const policy = JSON.parse(readFileSync(mission.policyPath, "utf8"))
    policy.autonomy = mode === "long_run" ? { mode, instructions: ["Choose and continue autonomously."] } : { mode }
    writeFileSync(mission.policyPath, JSON.stringify(policy))
  }
  const approve = () => { openMissionConfiguration(deps, mission.teamId, "lead"); approveMission(deps, mission.teamId, "lead") }
  const sessions = new Map<string, { agent: string; permissions: Rule[]; metadata: Record<string, unknown>; location: { directory: string } }>()
  sessions.set("lead", { agent: "orchestrator", permissions: [{ action: "browser", resource: "*", effect: "allow" }], metadata: { ownedByUser: "preserve" }, location: { directory: deps.directory } })
  const profiles = new Map<string, Rule[]>([["orchestrator", [full]], ["reviewer", [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
  ]]])
  const updates: Array<Record<string, unknown>> = []
  const host: MissionPermissionsHost = {
    session: {
      get: async input => structuredClone(sessions.get(String(input.sessionID))),
      update: async input => {
        updates.push(input)
        const session = sessions.get(String(input.sessionID))!
        if (input.permissions) session.permissions = input.permissions as Rule[]
        if (input.metadata) session.metadata = input.metadata as Record<string, unknown>
      },
    },
    agent: { get: async input => ({ permissions: profiles.get(input.agentID) }) },
  }
  const manager = new MissionPermissions(deps.db, host)
  return { ...mission, deps, edit, approve, sessions, profiles, updates, host, manager }
}

describe("native long-run mission permissions", () => {
  test("inherited worker admission receives access after isolation, never during preparation", async () => {
    const f = await fixture()
    insertMember(f.deps.db, f.teamId, "worker", "worker")
    f.sessions.set("worker", { agent: "reviewer", permissions: [], metadata: {}, location: { directory: f.deps.directory } })
    f.edit("long_run"); f.approve()
    f.deps.db.run("UPDATE team_member SET spawn_pending = 1 WHERE team_id = ?", [f.teamId])
    await f.manager.syncSession(f.teamId, "worker")
    expect(f.updates).toHaveLength(0)
    f.deps.db.run("UPDATE team_member SET spawn_pending = 2 WHERE team_id = ?", [f.teamId])
    await f.manager.syncSession(f.teamId, "worker")
    expect(f.sessions.get("worker")!.permissions).toContainEqual({ action: "read", resource: "*.env", effect: "allow" })
  })

  test("cleanup restores every owned session before archive, including stopped workers", async () => {
    const f = await fixture()
    insertMember(f.deps.db, f.teamId, "worker", "worker")
    f.sessions.set("worker", { agent: "reviewer", permissions: [], metadata: {}, location: { directory: f.deps.directory } })
    f.edit("long_run"); f.approve()
    await f.manager.syncTeam(f.teamId)
    f.deps.db.run("UPDATE team_member SET status = 'shutdown' WHERE team_id = ?", [f.teamId])
    await f.manager.syncTeam(f.teamId, true)
    expect(f.sessions.get("lead")!.permissions).not.toContainEqual(full)
    expect(f.sessions.get("worker")!.permissions).toEqual([])
  })

  test("only approved autonomy grants full lead access and keeps unrelated metadata", async () => {
    const f = await fixture()
    f.edit("long_run")
    await f.manager.syncSession(f.teamId, "lead")
    expect(f.updates).toHaveLength(0)
    f.approve()
    await f.manager.syncSession(f.teamId, "lead")
    expect(f.sessions.get("lead")!.permissions).toContainEqual(full)
    expect(f.sessions.get("lead")!.metadata.ownedByUser).toBe("preserve")
    expect(f.sessions.get("lead")!.metadata["ensemble.longRunPermissions"]).toBeDefined()
    await f.manager.syncSession(f.teamId, "lead")
    expect(f.updates).toHaveLength(1)
  })

  test("survives draft edits and restart, and restores the exact baseline after revocation", async () => {
    const f = await fixture()
    const original = structuredClone(f.sessions.get("lead")!)
    f.edit("long_run"); f.approve()
    await f.manager.syncSession(f.teamId, "lead")
    f.edit("supervised")
    await new MissionPermissions(f.deps.db, f.host).syncSession(f.teamId, "lead")
    expect(f.sessions.get("lead")!.permissions).toContainEqual(full)
    f.approve()
    await f.manager.syncTeam(f.teamId)
    expect(f.sessions.get("lead")).toEqual(original)
  })

  test("keeps explicit session denies while removing routine permission questions", async () => {
    const f = await fixture()
    const deny: Rule = { action: "edit", resource: "protected/*", effect: "deny" }
    f.sessions.get("lead")!.permissions.push(deny)
    f.edit("long_run"); f.approve()
    await f.manager.syncSession(f.teamId, "lead")
    expect(f.sessions.get("lead")!.permissions.at(-1)).toEqual(deny)
  })

  test("workers keep profile restrictions, reporting grants and planning denies", async () => {
    const f = await fixture()
    insertMember(f.deps.db, f.teamId, "reviewer", "worker")
    const grants: Rule[] = [{ action: "team_message", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "deny" }]
    f.sessions.set("worker", { agent: "reviewer", permissions: grants, metadata: {}, location: { directory: f.deps.directory } })
    f.edit("long_run"); f.approve()
    await f.manager.syncTeam(f.teamId)
    const rules = f.sessions.get("worker")!.permissions
    expect(rules).not.toContainEqual(full)
    expect(rules).toContainEqual({ action: "read", resource: "*.env", effect: "allow" })
    expect(rules).toContainEqual(grants[0]!)
    expect(rules.at(-1)).toEqual(grants[1]!)
  })

  test("workers drop inherited full access but preserve resource-scoped overlays", async () => {
    const f = await fixture()
    insertMember(f.deps.db, f.teamId, "reviewer", "worker")
    const scoped: Rule = { action: "*", resource: "mission/*", effect: "allow" }
    f.sessions.set("worker", { agent: "reviewer", permissions: [full, scoped], metadata: {}, location: { directory: f.deps.directory } })
    f.edit("long_run"); f.approve()
    await f.manager.syncSession(f.teamId, "worker")
    expect(f.sessions.get("worker")!.permissions).not.toContainEqual(full)
    expect(f.sessions.get("worker")!.permissions).toContainEqual(scoped)
  })

  test("a native profile change replaces old role rules instead of freezing them", async () => {
    const f = await fixture()
    insertMember(f.deps.db, f.teamId, "author", "worker")
    f.sessions.set("worker", { agent: "reviewer", permissions: [], metadata: {}, location: { directory: f.deps.directory } })
    f.edit("long_run"); f.approve()
    await f.manager.syncSession(f.teamId, "worker")
    f.profiles.set("author", [full])
    f.sessions.get("worker")!.agent = "author"
    f.sessions.get("worker")!.permissions = []
    await f.manager.syncSession(f.teamId, "worker")
    expect(f.sessions.get("worker")!.permissions).toEqual([full])
  })

  test("never grants helpers and restores owned overrides after team cleanup", async () => {
    const f = await fixture()
    f.sessions.set("helper", { agent: "reviewer", permissions: [], metadata: {}, location: { directory: f.deps.directory } })
    f.edit("long_run"); f.approve()
    await f.manager.syncSession(f.teamId, "helper")
    expect(f.updates).toHaveLength(0)
    await f.manager.syncSession(f.teamId, "lead")
    f.deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", [f.teamId])
    await f.manager.syncSession(undefined, "lead")
    expect(f.sessions.get("lead")!.permissions).not.toContainEqual(full)
    expect(f.sessions.get("lead")!.metadata["ensemble.longRunPermissions"]).toBeUndefined()
  })

  test("preserves appended user denies when restoring access", async () => {
    const f = await fixture()
    f.edit("long_run"); f.approve()
    await f.manager.syncSession(f.teamId, "lead")
    const deny: Rule = { action: "shell", resource: "git push *", effect: "deny" }
    f.sessions.get("lead")!.permissions.push(deny)
    f.edit("supervised"); f.approve()
    await f.manager.syncSession(f.teamId, "lead")
    expect(f.sessions.get("lead")!.permissions.at(-1)).toEqual(deny)
    expect(f.sessions.get("lead")!.permissions).not.toContainEqual(full)
  })

  test("a failed native write remains an error and is retryable without another approval", async () => {
    const f = await fixture()
    f.edit("long_run"); f.approve()
    const update = f.host.session.update!
    f.host.session.update = async () => { throw new Error("native write failed") }
    await expect(f.manager.syncSession(f.teamId, "lead")).rejects.toThrow("native write failed")
    expect(f.sessions.get("lead")!.metadata["ensemble.longRunPermissions"]).toBeUndefined()
    f.host.session.update = update
    await f.manager.syncSession(f.teamId, "lead")
    expect(f.sessions.get("lead")!.permissions).toContainEqual(full)
  })

  test("supervised missions never change session permissions", async () => {
    const f = await fixture()
    f.edit("supervised"); f.approve()
    await f.manager.syncTeam(f.teamId)
    expect(f.updates).toHaveLength(0)
  })
})
