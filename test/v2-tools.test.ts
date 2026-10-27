import { describe, expect, test } from "bun:test"
import { createDb } from "../src/db"
import { MemberRegistry, DescendantTracker, PendingPurgeApprovals } from "../src/state"
import { DEFAULT_CONFIG } from "../src/config"
import { ProgressTracker } from "../src/progress"
import { createV2Client } from "../src/v2-client"
import { registerV2Tools, normalizePriority, type V2ToolDef } from "../src/v2-tools"
import type { ToolDeps } from "../src/types"

const TOOL_NAMES = [
  "team_create",
  "team_spawn",
  "team_handoff",
  "team_message",
  "team_broadcast",
  "team_tasks_list",
  "team_tasks_add",
  "team_tasks_complete",
  "team_claim",
  "team_results",
  "team_shutdown",
  "team_cleanup",
  "team_merge",
  "team_status",
  "team_view",
]

function mockDeps() {
  const client = createV2Client({
    session: {
      create: async () => ({ id: "ses_new" }),
      prompt: async () => ({ id: "msg_1" }),
      synthetic: async () => ({ id: "syn_1" }),
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      interrupt: async () => undefined,
      get: async () => ({ id: "ses_x" }),
      context: async () => [],
      active: async () => ({}),
    },
    permission: {
      rules: async () => undefined,
    },
    worktree: {
      create: async () => ({ directory: "/wt/x" }),
      remove: async () => undefined,
      list: async () => [],
      refresh: async () => undefined,
    },
  })
  const deps: ToolDeps = {
    db: createDb(":memory:"),
    registry: new MemberRegistry(),
    tracker: new DescendantTracker(),
    purgeApprovals: new PendingPurgeApprovals(),
    client,
    directory: "/tmp/v2-tools-test",
    config: { ...DEFAULT_CONFIG },
    progressTracker: new ProgressTracker(),
  }
  return deps
}

function mockToolDomain() {
  const defs: V2ToolDef[] = []
  return {
    defs,
    domain: {
      transform: async (cb: (editor: { add(def: V2ToolDef): void }) => void) => {
        cb({ add: (def) => defs.push(def) })
        return { dispose: async () => undefined }
      },
    },
  }
}

async function run(defs: V2ToolDef[], name: string, input: unknown, sessionID: string) {
  const def = defs.find((d) => d.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return def.execute(input, { sessionID })
}

describe("v2-tools (issue #36, DRY: same execute fns as V1)", () => {
  test("task context is exposed and preserved by the V2 normalizer", async () => {
    const { defs, domain } = mockToolDomain()
    const deps = mockDeps()
    await registerV2Tools(domain, deps)
    await run(defs, "team_create", { name: "context-board" }, "context-lead")
    expect(defs.find(def => def.name === "team_tasks_add")?.input).toMatchObject({ properties: { tasks: { items: { properties: {
      context: { properties: { mode: { enum: ["fresh", "fork", "checkpoint", "compact_fork"] } }, required: ["mode"], additionalProperties: false },
    } } } } })
    await run(defs, "team_tasks_add", { tasks: [{ content: "Independent review", agent: "qa", context: { mode: "fresh" } }] }, "context-lead")
    expect(deps.db.query("SELECT agent, spawn_context FROM team_task").get()).toEqual({ agent: "qa", spawn_context: '{"mode":"fresh"}' })
    await expect(run(defs, "team_tasks_add", { tasks: [{ content: "Invalid", context: null }] }, "context-lead")).rejects.toThrow(/context/)
  })

  test("planned model selection and its reason survive the V2 schema and normalizer", async () => {
    const { defs, domain } = mockToolDomain()
    const deps = mockDeps()
    Object.assign(deps.config, { planningIntelligenceRange: { min: 35 }, modelRouting: { beta: 0.35, models: [
      { id: "fixture/luna", intelligenceScore: 40, averageCostPerTask: 1, available: true },
      { id: "fixture/strong", intelligenceScore: 60, averageCostPerTask: 2, available: true },
    ] } })
    deps.nativeModels = async () => [{ id: "fixture/luna" }, { id: "fixture/strong" }]
    await registerV2Tools(domain, deps)
    await run(defs, "team_create", { name: "planning-selection" }, "lead")
    expect(defs.find(def => def.name === "team_tasks_add")?.input).toMatchObject({ properties: {
      execution_decisions: { items: { properties: { reason: { type: "string" } } } },
      tasks: { items: { properties: { execution: { properties: { reason: { type: "string" } } } } } },
    } })
    await run(defs, "team_tasks_add", { tasks: [{ content: "Simple task", execution: { mode: "planned", kind: "code", model: "fixture/luna", reason: "User request" } }] }, "lead")
    const task = deps.db.query("SELECT id, execution_decision FROM team_task").get() as { id: string; execution_decision: string }
    expect(JSON.parse(task.execution_decision)).toMatchObject({ model: "fixture/luna", reason: "User request", authorizedBy: "lead" })
    await run(defs, "team_tasks_add", { tasks: [], execution_decisions: [{ task_id: task.id, mode: "planned", kind: "code", model: "fixture/luna", reason: "Confirmed user request" }] }, "lead")
    const updated = deps.db.query("SELECT execution_decision FROM team_task").get() as { execution_decision: string }
    expect(JSON.parse(updated.execution_decision).reason).toBe("Confirmed user request")
  })
  test("task execution proposals and supervisor decisions survive the V2 schema/normalizer", async () => {
    const { defs, domain } = mockToolDomain()
    const deps = mockDeps()
    await registerV2Tools(domain, deps)
    await run(defs, "team_create", { name: "execution-proposal" }, "lead")
    const definition = defs.find(def => def.name === "team_tasks_add")
    expect(definition?.input).toMatchObject({ properties: {
      execution_decisions: { type: "array", items: { required: ["task_id", "mode", "kind"] } },
      tasks: { items: { properties: { execution: { required: ["mode", "kind"] } } } },
    } })
    await run(defs, "team_tasks_add", { tasks: [{ content: "Plan docs", execution: { mode: "planned", kind: "documentation" } }] }, "lead")
    const task = deps.db.query("SELECT id, execution_request FROM team_task").get() as { id: string; execution_request: string }
    expect(JSON.parse(task.execution_request)).toMatchObject({ mode: "planned", kind: "documentation" })
    await run(defs, "team_tasks_add", { tasks: [], execution_decisions: [{ task_id: task.id, mode: "planned", kind: "mixed" }] }, "lead")
    const decision = deps.db.query("SELECT execution_decision FROM team_task").get() as { execution_decision: string }
    expect(JSON.parse(decision.execution_decision)).toMatchObject({ mode: "planned", kind: "mixed", authorizedBy: "lead" })
  })
  test("all 15 tools register with descriptions and input schemas", async () => {
    const { defs, domain } = mockToolDomain()
    await registerV2Tools(domain, mockDeps())
    expect(defs.map((d) => d.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.input).toMatchObject({ type: "object" })
    }
  })

  test("spawn exposes one structured opt-in context strategy", async () => {
    const { defs, domain } = mockToolDomain()
    await registerV2Tools(domain, mockDeps())
    const spawn = defs.find(d => d.name === "team_spawn")!
    expect((spawn.input.properties as Record<string, unknown>).context).toMatchObject({
      type: "object", required: ["mode"], additionalProperties: false,
      properties: { mode: { enum: ["fresh", "fork", "checkpoint", "compact_fork"] } },
    })
  })

  test("routing dimensions have integer bounds on both tool schemas and tasks retain zero scores", async () => {
    const { defs, domain } = mockToolDomain()
    const deps = mockDeps()
    await registerV2Tools(domain, deps)
    const spawn = defs.find(d => d.name === "team_spawn")!
    expect(spawn.input.properties).toMatchObject({
      complexity: { type: "integer", minimum: 0, maximum: 100 },
      risk: { type: "integer", minimum: 0, maximum: 100 },
      variant: { type: "string" },
    })
    const add = defs.find(d => d.name === "team_tasks_add")!
    expect(add.input.properties).toMatchObject({ tasks: { items: { properties: {
      complexity: { type: "integer", minimum: 0, maximum: 100 },
      risk: { type: "integer", minimum: 0, maximum: 100 },
    } } } })
    await run(defs, "team_create", { name: "scored" }, "lead")
    await run(defs, "team_tasks_add", { tasks: [{ content: "zero", complexity: 0, risk: 0 }] }, "lead")
    expect(deps.db.query("SELECT complexity, risk FROM team_task").get()).toMatchObject({ complexity: 0, risk: 0 })
    await expect(run(defs, "team_tasks_add", { tasks: [{ content: "bad", risk: 101 }] }, "lead")).rejects.toThrow("risk")
  })

  test("create → tasks_add (no priority) → list defaults priority to medium", async () => {
    const { defs, domain } = mockToolDomain()
    const deps = mockDeps()
    await registerV2Tools(domain, deps)
    const created = await run(defs, "team_create", { name: "alpha" }, "ses_lead")
    expect(created.content).toContain("alpha")
    await run(
      defs,
      "team_tasks_add",
      { tasks: [{ content: "do work" }] },
      "ses_lead",
    )
    const list = await run(defs, "team_tasks_list", {}, "ses_lead")
    expect(list.content).toContain("do work")
    const taskRow = deps.db.query("SELECT priority FROM team_task").get() as { priority: string }
    expect(taskRow.priority).toBe("medium")
    const status = await run(defs, "team_status", {}, "ses_lead")
    expect(status.content).toContain("alpha")
  })

  test("plan approval for an unspawned recipient is rejected", async () => {
    const { defs, domain } = mockToolDomain()
    await registerV2Tools(domain, mockDeps())
    await run(defs, "team_create", { name: "alpha" }, "ses_lead")
    let error: unknown = null
    try {
      await run(defs, "team_message", { to: "ghost", text: "hi", approve: true }, "ses_lead")
    } catch (err) {
      error = err
    }
    expect(String(error)).toContain("ghost")
  })

  test("priority enum is declared and invalid values are rejected", async () => {
    const { defs, domain } = mockToolDomain()
    await registerV2Tools(domain, mockDeps())
    const add = defs.find((d) => d.name === "team_tasks_add")
    const tasks = (add?.input.properties as Record<string, unknown>)["tasks"] as {
      items: { properties: { priority: unknown } }
    }
    expect(tasks.items.properties.priority).toMatchObject({ enum: ["high", "medium", "low"] })
    expect(normalizePriority(undefined)).toBe("medium")
    expect(normalizePriority("high")).toBe("high")
    await run(defs, "team_create", { name: "alpha" }, "ses_lead")
    let error: unknown = null
    try {
      await run(defs, "team_tasks_add", { tasks: [{ content: "x", priority: "urgent" }] }, "ses_lead")
    } catch (err) {
      error = err
    }
    expect(String(error)).toContain('Invalid priority "urgent"')
  })
})
