import { beforeEach, describe, expect, test } from "bun:test"
import { setupDeps, insertTeam } from "./helpers"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { executeTeamTasksList } from "../src/tools/team-tasks-list"
import { executeTeamMessage } from "../src/tools/team-message"
import { dispatchNextTask, pumpTeam } from "../src/dispatch"
import { createV2Client } from "../src/v2-client"

describe("complexity/risk routing integration", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "routing-team", "routing", "routing-lead")
    deps.config.modelRouting = { beta: 0.35, models: [
      { id: "cheap/free", intelligenceScore: 38, averageCostPerTask: 0, available: true },
      { id: "strong/model", reasoningEffort: "high", intelligenceScore: 54, averageCostPerTask: 1, available: true },
      { id: "other/model", reasoningEffort: "medium", intelligenceScore: 54, averageCostPerTask: 2, available: true },
    ] }
    deps.config.modelsByAgent = { build: "configured/model" }
  })

  function delivery() {
    return deps.client.calls.find(c => c.method === "session.promptAsync")?.args[0]
  }

  test("scores route before configured models, persist variant/fallback, and explain the choice", async () => {
    const result = await executeTeamSpawn(deps, { name: "worker", prompt: "work", worktree: false, complexity: 100, risk: 0 }, "routing-lead")
    expect(delivery()).toMatchObject({ model: { providerID: "strong", modelID: "model" }, variant: "high" })
    const row = deps.db.query("SELECT * FROM team_member WHERE name = 'worker'").get() as Record<string, unknown>
    expect(row.model).toBe("strong/model")
    expect(row.model_variant).toBe("high")
    expect(JSON.parse(row.model_routing as string)).toMatchObject({ fallback: { id: "other/model" }, requiredIntelligence: 54 })
    expect(result).toContain("cheapest")
    expect(result).toContain("other/model")
  })

  test("an explicit model wins even with no available routing candidate; explicit variant is passed", async () => {
    deps.config.modelRouting.models = deps.config.modelRouting.models.map(m => ({ ...m, available: false }))
    await executeTeamSpawn(deps, { name: "worker", prompt: "work", worktree: false, complexity: 100, model: "lead/chosen", variant: "medium" }, "routing-lead")
    expect(delivery()).toMatchObject({ model: { providerID: "lead", modelID: "chosen" }, variant: "medium" })
    expect(delivery()).not.toHaveProperty("model_routing")
  })

  test("no scores retains configured selection even when a catalogue is present", async () => {
    await executeTeamSpawn(deps, { name: "worker", prompt: "work", worktree: false }, "routing-lead")
    expect(delivery()).toMatchObject({ model: { providerID: "configured", modelID: "model" } })
    expect(delivery()).not.toHaveProperty("variant")
  })

  test("an empty catalogue falls through to Ensemble configuration, then the OpenCode default", async () => {
    deps.config.modelRouting.models = []
    await executeTeamSpawn(deps, { name: "first", prompt: "work", worktree: false, complexity: 40 }, "routing-lead")
    expect(delivery()).toMatchObject({ model: { providerID: "configured", modelID: "model" } })
    deps.config.modelsByAgent = {}
    deps.client.calls.length = 0
    await executeTeamSpawn(deps, { name: "second", prompt: "work", worktree: false, risk: 30 }, "routing-lead")
    expect(delivery()).not.toHaveProperty("model")
  })

  test("invalid scores or no available candidates reject before creating resources", async () => {
    await expect(executeTeamSpawn(deps, { name: "worker", prompt: "work", complexity: 101 }, "routing-lead")).rejects.toThrow("complexity")
    expect(deps.client.calls).toHaveLength(0)
    deps.config.modelRouting.models = deps.config.modelRouting.models.map(m => ({ ...m, available: false }))
    await expect(executeTeamSpawn(deps, { name: "worker", prompt: "work", complexity: 50 }, "routing-lead")).rejects.toThrow("available")
    expect(deps.client.calls).toHaveLength(0)
  })

  test("claim_task scores are persisted, displayed and routed; spawn scores can override them", async () => {
    await executeTeamTasksAdd(deps, { tasks: [{ content: "hard work", priority: "high", complexity: 100, risk: 90 }] }, "routing-lead")
    const task = deps.db.query("SELECT * FROM team_task").get() as Record<string, unknown>
    expect(task).toMatchObject({ complexity: 100, risk: 90 })
    expect(await executeTeamTasksList(deps, "routing-lead")).toContain("complexity:100 risk:90")
    await executeTeamSpawn(deps, { name: "worker", prompt: "work", worktree: false, claim_task: task.id as string }, "routing-lead")
    expect(delivery()).toMatchObject({ variant: "high" })
    await executeTeamTasksAdd(deps, { tasks: [{ content: "also hard", priority: "high", complexity: 100, risk: 90 }] }, "routing-lead")
    const second = deps.db.query("SELECT id FROM team_task WHERE content = 'also hard'").get() as { id: string }
    deps.client.calls.length = 0
    await executeTeamSpawn(deps, { name: "second", prompt: "work", worktree: false, claim_task: second.id, complexity: 0, risk: 0 }, "routing-lead")
    expect(delivery()).toMatchObject({ model: { providerID: "cheap", modelID: "free" } })
  })

  test("invalid task scores reject the whole batch before any task is inserted", async () => {
    await expect(executeTeamTasksAdd(deps, { tasks: [
      { content: "valid", priority: "medium", complexity: 20 },
      { content: "invalid", priority: "medium", risk: -1 },
    ] }, "routing-lead")).rejects.toThrow("risk")
    expect(deps.db.query("SELECT id FROM team_task").all()).toHaveLength(0)
  })

  test("auto-scale passes through claim_task routing", async () => {
    await executeTeamTasksAdd(deps, { tasks: [{ content: "hard", priority: "high", complexity: 100 }] }, "routing-lead")
    deps.config.autoScale = true
    deps.config.maxActiveMembers = 1
    await pumpTeam(deps, "routing-team")
    expect(delivery()).toMatchObject({ model: { providerID: "strong", modelID: "model" }, variant: "high" })
  })

  test("dispatch preserves a routed member's reasoning variant on later tasks", async () => {
    await executeTeamSpawn(deps, { name: "worker", prompt: "work", worktree: false, complexity: 100 }, "routing-lead")
    deps.db.run("UPDATE team_member SET status = 'ready' WHERE name = 'worker'")
    await executeTeamTasksAdd(deps, { tasks: [{ content: "next", priority: "medium" }] }, "routing-lead")
    deps.client.calls.length = 0
    deps.config.autoDispatch = true
    expect(dispatchNextTask(deps, "routing-team", "worker")).not.toBeNull()
    expect(delivery()).toMatchObject({ variant: "high" })
  })

  test("later manual model overrides clear stale routed variants and provenance", async () => {
    await executeTeamSpawn(deps, { name: "worker", prompt: "work", worktree: false, complexity: 100 }, "routing-lead")
    await executeTeamMessage(deps, { to: "worker", model: "manual/model" }, "routing-lead")
    const row = deps.db.query("SELECT * FROM team_member WHERE name = 'worker'").get() as Record<string, unknown>
    expect(row).toMatchObject({ model: "manual/model", model_variant: null, model_routing: null })
  })

  test("V2 adapter binds the selected reasoning variant through native switchModel", async () => {
    const calls: Array<{ name: string; input: unknown }> = []
    const ctx = {
      session: {
        create: async () => ({ id: "child" }), prompt: async (input: unknown) => { calls.push({ name: "prompt", input }) },
        switchAgent: async () => {}, switchModel: async (input: unknown) => { calls.push({ name: "switchModel", input }) },
        interrupt: async () => {}, get: async () => ({}), context: async () => [], active: async () => ({}), synthetic: async () => {},
      },
      worktree: { create: async () => ({ directory: "test" }), remove: async () => {}, list: async () => [], refresh: async () => {} },
    }
    const client = createV2Client(ctx)
    await client.session.promptAsync({ sessionID: "child", model: { providerID: "strong", modelID: "model" }, variant: "high", parts: [{ type: "text", text: "work" }] })
    expect(calls[0]).toEqual({ name: "switchModel", input: { sessionID: "child", model: { providerID: "strong", id: "model", variant: "high" } } })
    expect(calls[1]?.name).toBe("prompt")
  })
})
