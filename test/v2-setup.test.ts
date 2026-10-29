import { describe, expect, spyOn, test } from "bun:test"
import { setupEnsemble, extractQuestionOutput, type V2SetupContext } from "../src/v2-setup"
import type { MissionCommandDefinition } from "../src/mission-commands"
import { createHash } from "node:crypto"
import { historicalModelPolicy, setupDeps } from "./helpers"
import { SupervisorRecovery } from "../src/supervisor-recovery"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
/** Mock V2 setup context: hook registry + programmable event intake. */
function mockSetupCtx() {
  const hooks: Record<string, Array<(event: never) => unknown>> = {}
  const commands: MissionCommandDefinition[] = []
  let commandsDisposed = false
  const nativeSessions = new Map<string, Record<string, unknown>>()
  const hook = (domain: string) => async (_name: string, cb: (event: never) => unknown) => {
    ;(hooks[domain] ??= []).push(cb)
    return { dispose: async () => undefined }
  }
  const ctx = {
    location: { directory: "/tmp/v2-setup-test" },
    options: {},
    command: { transform: async (callback: (editor: { add(definition: MissionCommandDefinition): void }) => void) => {
      callback({ add: definition => { commands.push(definition) } })
      return { dispose: async () => { commandsDisposed = true } }
    } },
    model: { list: async () => ({ data: [{ providerID: "fixture", id: "model", enabled: true, variants: [] }] }) },
    session: {
      create: async () => ({ id: "ses_new" }),
      prompt: async () => ({ id: "msg_1" }),
      synthetic: async () => ({ id: "syn_1" }),
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      interrupt: async () => undefined,
      get: async (input: Record<string, unknown>) => structuredClone(nativeSessions.get(String(input.sessionID)) ?? { id: input.sessionID, agent: "build", permissions: [], metadata: {} }),
      update: async (input: Record<string, unknown>) => { nativeSessions.set(String(input.sessionID), { agent: "build", ...input }) },
      context: async () => [],
      active: async () => ({}),
      hook: hook("session"),
    },
    permission: {
      rules: async () => undefined,
    },
    agent: { get: async () => ({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }) },
    worktree: {
      create: async () => ({ directory: "/wt/x" }),
      remove: async () => undefined,
      list: async () => [],
      refresh: async () => undefined,
    },
    event: {
      subscribe: (_opts?: unknown) => {
        void _opts
        async function* stream(): AsyncGenerator<never> {
          // Tests drive events via handle.dispatch; the live loop drains this.
        }
        return stream()
      },
    },
    tool: {
      hook: hook("tool"),
      transform: async (_cb: (editor: never) => void) => ({ dispose: async () => undefined }),
    },
    shell: { hook: hook("shell") },
  }
  return { ctx: ctx as unknown as V2SetupContext, hooks, commands, commandsDisposed: () => commandsDisposed }
}

function seedLeadAndMember(handle: Awaited<ReturnType<typeof setupEnsemble>>) {  const now = Date.now()
  handle.db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
    ["team1", "alpha", "ses_lead", now, now],
  )
  handle.db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
    ["team1", "alice", "ses_alice", now, now],
  )
  handle.registry.register("team1", "alice", "ses_alice")
  handle.db.run("INSERT OR IGNORE INTO project (id, name, path, time_created, time_updated) VALUES ('/tmp/v2-setup-test', 'fixture', '/tmp/v2-setup-test', 1, 1)")
  handle.db.run("UPDATE team SET project_id = '/tmp/v2-setup-test' WHERE id = 'team1'")
}

describe("v2-setup (issue #36)", () => {
  test("context synchronizes native long-run permissions and restores them after archive", async () => {
    const f = mockSetupCtx()
    const sessions = new Map<string, Record<string, unknown>>([
      ["ses_lead", { agent: "orchestrator", permissions: [], metadata: { user: true } }],
      ["ses_alice", { agent: "reviewer", permissions: [], metadata: {} }],
    ])
    const updates: string[] = []
    Object.assign(f.ctx.session, {
      get: async (input: { sessionID: string }) => structuredClone(sessions.get(input.sessionID)),
      update: async (input: { sessionID: string }) => { updates.push(input.sessionID); Object.assign(sessions.get(input.sessionID)!, input) },
    })
    Object.assign(f.ctx, { agent: { get: async () => ({ location: f.ctx.location, data: { permissions: [{ action: "read", resource: "*", effect: "ask" }, { action: "edit", resource: "*", effect: "deny" }] } }) } })
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0 })
    try {
      seedLeadAndMember(handle)
      handle.db.run("INSERT OR IGNORE INTO project (id, name, path, time_created, time_updated) VALUES (?, 'fixture', ?, 1, 1)", [f.ctx.location.directory, f.ctx.location.directory])
      handle.db.run("UPDATE team SET project_id = ? WHERE id = 'team1'", [f.ctx.location.directory])
      const deps = setupDeps()
      deps.config = { ...deps.config, modelRouting: { ...deps.config.modelRouting, models: [{ id: "fixture/worker", intelligenceScore: 60, averageCostPerTask: 1, available: true }] } }
      const policy = { ...historicalModelPolicy(deps), autonomy: { mode: "long_run", instructions: ["Continue autonomously."] } }
      const json = JSON.stringify(policy)
      const hash = createHash("sha256").update(json).digest("hex")
      handle.db.run("INSERT INTO mission_policy_revision (team_id, revision, policy_json, policy_hash, time_created) VALUES ('team1', 1, ?, ?, 1)", [json, hash])
      for (const sessionID of sessions.keys()) await f.hooks.session![0]!({ sessionID, system: [] } as never)
      expect(updates).toEqual(["ses_lead", "ses_alice"])
      expect(sessions.get("ses_lead")!.permissions).toContainEqual({ action: "*", resource: "*", effect: "allow" })
      expect(sessions.get("ses_alice")!.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
      handle.db.run("UPDATE team SET status = 'archived' WHERE id = 'team1'")
      await f.hooks.session![0]!({ sessionID: "ses_lead", system: [] } as never)
      expect(sessions.get("ses_lead")!.permissions).toEqual([])
      expect(sessions.get("ses_lead")!.metadata).toEqual({ user: true })
    } finally { await handle.dispose() }
  })

  test("journals native sub-agent MCP denials and isolation failures without changing permission decisions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ensemble-permission-integration-"))
    const f = mockSetupCtx()
    const evaluations: Array<(event: { sessionID: string; action: string; effect: string }) => void> = []
    f.ctx.permission = { hook: async (_name, cb) => { evaluations.push(cb) } }
    f.ctx.tool.list = async () => [{ id: "serena.read", input: { type: "object" }, options: { namespace: { name: "serena" } } }]
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0, permissionLogDir: directory })
    try {
      seedLeadAndMember(handle)
      await handle.dispatch({ type: "session.created", data: { sessionID: "native-child", parentID: "ses_alice" } })
      const context = { sessionID: "native-child", agent: "read-only-agent", system: [] as Array<{ type: string; text: string }> }
      await f.hooks.session![0]!(context as never)
      const pending = { sessionID: "native-child", action: "serena.read", effect: "ask" }
      evaluations.forEach(evaluate => evaluate(pending))
      expect(pending.effect).toBe("ask")
      expect(readdirSync(directory)).toHaveLength(0)
      await f.hooks.tool![1]!({ sessionID: "native-child", agent: "read-only-agent", messageID: "message", id: "call1", tool: "serena.read",
        status: "error", input: { token: "not-for-the-journal" }, error: { message: "Permission denied not-for-the-journal" } } as never)
      await handle.dispatch({ type: "session.message.content.updated", location: { directory: f.ctx.location.directory }, data: {
        sessionID: "native-child", messageID: "message", content: [{ type: "tool", name: "serena.read", id: "call2", state: {
          status: "error", error: { type: "Tool.Error", message: "Permission denied not-for-the-journal" }, input: {},
        } }],
      } })
      expect(() => f.hooks.tool![0]!({ sessionID: "native-child", agent: "read-only-agent", id: "call3", tool: "team_message" } as never)).toThrow("sub-agents")
      const raw = readdirSync(directory).filter(file => file.endsWith(".jsonl")).map(file => readFileSync(join(directory, file), "utf8")).join("")
      const records = raw.trim().split("\n").map(line => JSON.parse(line))
      expect(records).toHaveLength(3)
      expect(records[0]).toMatchObject({ sessionID: "native-child", parentSessionID: "ses_alice", agent: "read-only-agent", namespace: "serena", ownerMemberName: "alice" })
      expect(records[1]).toMatchObject({ observation: "native_tool_state", agent: "read-only-agent" })
      expect(records[2]).toMatchObject({ category: "ensemble_isolation_denied" })
      expect(raw).not.toContain("not-for-the-journal")
      expect(pending.effect).toBe("ask")
    } finally {
      await handle.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("owns a ten-minute supervisor recovery timer and disposes it with the plugin", async () => {
    const f = mockSetupCtx()
    const deliveries: Record<string, unknown>[] = []
    f.ctx.session.synthetic = async input => { deliveries.push(input); return {} }
    let permissions: unknown[] = [{}]
    f.ctx.permission = { ...f.ctx.permission, list: async () => ({ data: permissions }) }
    const interval = spyOn(globalThis, "setInterval")
    const check = spyOn(SupervisorRecovery.prototype, "check")
    const stop = spyOn(SupervisorRecovery.prototype, "stop")
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0 })
    try {
      seedLeadAndMember(handle)
      handle.db.run("INSERT OR IGNORE INTO project (id, name, path, time_created, time_updated) VALUES (?, 'Recovery fixture', ?, 1, 1)", [f.ctx.location.directory, f.ctx.location.directory])
      handle.db.run("UPDATE team SET project_id = ?, time_updated = 1", [f.ctx.location.directory])
      handle.db.run("UPDATE team_member SET time_updated = 1")
      handle.db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('stranded', 'team1', 'Resume work', 'pending', 'medium', 1, 1)")
      const recoveryTimer = interval.mock.calls.find(call => call[1] === 600_000)
      expect(recoveryTimer).toBeDefined()
      const callback = recoveryTimer![0]
      if (typeof callback !== "function") throw new Error("Recovery timer callback missing")
      callback()
      await check.mock.results.at(-1)!.value
      expect(deliveries).toHaveLength(0)
      permissions = [{ sessionID: "ses_lead" }]
      callback()
      await check.mock.results.at(-1)!.value
      expect(deliveries).toHaveLength(0)
      permissions = []
      callback()
      await check.mock.results.at(-1)!.value
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]).toMatchObject({ sessionID: "ses_lead" })
    } finally {
      await handle.dispose()
      try { expect(stop).toHaveBeenCalledTimes(1) } finally {
        interval.mockRestore()
        check.mockRestore()
        stop.mockRestore()
      }
    }
  })

  test("approved autonomy is a stable final system block for lead, workers and compaction", async () => {
    const f = mockSetupCtx()
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0 })
    try {
      seedLeadAndMember(handle)
      const prefix = { type: "text", text: "Stable host instructions" }
      const before = { sessionID: "ses_lead", system: [prefix] }
      await f.hooks.session![0]!(before as never)
      expect(before.system.some(part => part.text.includes("Approved long-run autonomy"))).toBe(false)
      expect(before.system.at(-1)!.text).toContain("In both supervised and long_run")
      expect(before.system[0]).toBe(prefix)
      const policyDeps = setupDeps()
      policyDeps.config = { ...policyDeps.config, modelRouting: { ...policyDeps.config.modelRouting,
        models: [{ id: "fixture/worker", intelligenceScore: 60, averageCostPerTask: 1, available: true }] } }
      const policy = { ...historicalModelPolicy(policyDeps), autonomy: { mode: "long_run", instructions: ["Choose quality and fidelity to the plan."] } }
      const json = JSON.stringify(policy)
      handle.db.run("INSERT INTO mission_policy_revision (team_id, revision, policy_hash, policy_json, time_created) VALUES ('team1', 1, ?, ?, 1)", [createHash("sha256").update(json).digest("hex"), json])
      const tails: string[] = []
      for (const sessionID of ["ses_lead", "ses_alice"]) {
        for (const hook of f.hooks.session!) {
          const event = { sessionID, system: [prefix] }
          await hook!(event as never)
          expect(event.system[0]).toBe(prefix)
          const tail = event.system.at(-1)!.text
          expect(tail).toContain("Approved long-run autonomy")
          expect(tail).toContain("Choose quality and fidelity to the plan.")
          expect(event.system.filter(part => part.text.includes("Approved long-run autonomy"))).toHaveLength(1)
          tails.push(tail)
        }
      }
      expect(new Set(tails).size).toBe(1)
      handle.db.run("UPDATE team SET mission_state = 'critical'")
      const resumed = { sessionID: "ses_alice", system: [prefix] }
      await f.hooks.session![0]!(resumed as never)
      expect(resumed.system.at(-1)!.text).toBe(tails[0]!)
    } finally {
      await handle.dispose()
    }
  })

  test("permission evaluation and context hints preserve the final-response profile", async () => {
    const f = mockSetupCtx()
    const evaluators: Array<(event: { sessionID: string; action: string; effect: string }) => void> = []
    f.ctx.permission = { hook: async (_name, cb) => { evaluators.push(cb) } }
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.db.run("UPDATE team_member SET report_mode = 'final_response'")
    for (const action of ["execute", "team_message", "team_tasks_complete"]) {
      const event = { sessionID: "ses_alice", action, effect: "deny" }
      evaluators.forEach(cb => cb(event))
      expect(event.effect).toBe("deny")
    }
    const context = { sessionID: "ses_alice", system: [] as Array<{ type: string; text: string }> }
    await f.hooks.session![0]!(context as never)
    expect(context.system.map(part => part.text).join(" ")).not.toContain("called through the execute tool")
    await handle.dispose()
  })

  test("restricted worker final response is retrieved once without waking the worker or closing tasks", async () => {
    const f = mockSetupCtx()
    const deliveries: Record<string, unknown>[] = []
    f.ctx.session.context = async () => [{ type: "assistant", id: "native-final", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 }, content: [{ type: "text", text: "Review candidate" }] }]
    f.ctx.session.synthetic = async input => { deliveries.push(input); return {} }
    f.ctx.session.prompt = async input => { deliveries.push(input); return {} }
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.db.run("UPDATE team_member SET report_mode = 'final_response'")
    await handle.dispatch({ type: "session.execution.succeeded", data: { sessionID: "ses_alice" } })
    await handle.dispatch({ type: "session.execution.succeeded", data: { sessionID: "ses_alice" } })
    expect(handle.db.query("SELECT COUNT(*) AS c FROM member_result").get()).toEqual({ c: 1 })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.sessionID).toBe("ses_lead")
    await handle.dispose()
  })

  test("failed execution preserves failure and never asks the worker to report a successful completion", async () => {
    const f = mockSetupCtx()
    const prompts: Record<string, unknown>[] = []
    f.ctx.session.prompt = async input => { prompts.push(input); return {} }
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    await handle.dispatch({ type: "session.execution.failed", data: { sessionID: "ses_alice", error: { message: "cancelled" } } })
    await handle.dispatch({ type: "session.status", data: { sessionID: "ses_alice", status: "idle" } })
    expect(handle.db.query("SELECT execution_status FROM team_member WHERE name = 'alice'").get()).toEqual({ execution_status: "failed" })
    expect(prompts.filter(prompt => prompt.sessionID === "ses_alice")).toHaveLength(0)
    expect(handle.db.query("SELECT COUNT(*) AS c FROM member_result").get()).toEqual({ c: 0 })
    await handle.dispose()
  })

  test("a final response persisted after the idle event is still recovered on succeeded", async () => {
    const f = mockSetupCtx()
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.db.run("UPDATE team_member SET report_mode = 'final_response'")
    await handle.dispatch({ type: "session.idle", data: { sessionID: "ses_alice" } })
    f.ctx.session.context = async () => [{ type: "assistant", id: "late-final", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 }, content: [{ type: "text", text: "Late candidate" }] }]
    await handle.dispatch({ type: "session.execution.succeeded", data: { sessionID: "ses_alice" } })
    expect(handle.db.query("SELECT COUNT(*) AS c FROM member_result").get()).toEqual({ c: 1 })
    await handle.dispose()
  })

  test("graceful shutdown retains a restrictive worker's final candidate and review barrier", async () => {
    const f = mockSetupCtx()
    f.ctx.session.context = async () => [{ type: "assistant", id: "shutdown-final", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 }, content: [{ type: "text", text: "Last QA findings" }] }]
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.db.run("UPDATE team_member SET report_mode = 'final_response', status = 'shutdown_requested'")
    handle.db.run("INSERT INTO team_task (id,team_id,content,status,priority,assignee,time_created,time_updated) VALUES ('review','team1','Review','in_progress','medium','alice',1,1)")
    await handle.dispatch({ type: "session.execution.succeeded", data: { sessionID: "ses_alice" } })
    expect(handle.db.query("SELECT COUNT(*) AS c FROM member_result").get()).toEqual({ c: 1 })
    expect(handle.db.query("SELECT status FROM team_task WHERE id = 'review'").get()).toEqual({ status: "in_progress" })
    await handle.dispose()
  })

  test.each(["lost-wake", "candidate-only", "worktree-context"])("restart retries %s without duplicating a durable candidate or notification", async scenario => {
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const { rm } = await import("node:fs/promises")
    const dbPath = join(tmpdir(), `ensemble-report-restart-${crypto.randomUUID()}.db`)
    const f = mockSetupCtx()
    f.ctx.session.context = async () => [{ type: "assistant", id: "restart-final", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 }, content: [{ type: "text", text: "Durable QA candidate" }] }]
    f.ctx.session.synthetic = async () => { throw new Error("lost wake") }
    const first = await setupEnsemble(f.ctx, { dbPath, dashboardPort: 0 })
    seedLeadAndMember(first)
    first.db.run("UPDATE team_member SET report_mode = 'final_response'")
    await first.dispatch({ type: "session.execution.succeeded", data: { sessionID: "ses_alice" } })
    if (scenario === "candidate-only") first.db.run("UPDATE team_message SET read = 1, delivered = 1")
    await first.dispose()
    first.db.close()
    const next = mockSetupCtx()
    if (scenario === "worktree-context") Object.assign(next.ctx.location, { directory: "/tmp/lead-worktree", project: { id: "native-project", canonical: "/tmp/v2-setup-test" } })
    const wakes: Record<string, unknown>[] = []
    let contextInstalledAtWake = false
    next.ctx.session.synthetic = async input => {
      contextInstalledAtWake = (next.hooks.session?.length ?? 0) > 0
      wakes.push(input)
      return {}
    }
    const second = await setupEnsemble(next.ctx, { dbPath, dashboardPort: 0 })
    try {
      expect(second.db.query("SELECT COUNT(*) AS c FROM member_result").get()).toEqual({ c: 1 })
      expect(second.db.query("SELECT COUNT(*) AS c FROM team_message").get()).toEqual({ c: 1 })
      expect(wakes.filter(wake => wake.sessionID === "ses_lead")).toHaveLength(1)
      expect(contextInstalledAtWake).toBe(true)
    } finally {
      await second.dispose()
      second.db.close()
      await rm(dbPath, { force: true })
    }
  })

  test.each(["read", "superseded", "other-project"])("restart does not remind about %s results with undelivered acknowledgements", async scenario => {
    const dbPath = join(tmpdir(), `ensemble-read-report-${crypto.randomUUID()}.db`)
    const f = mockSetupCtx()
    f.ctx.session.context = async () => [{ type: "assistant", id: "read-final", finish: "stop", time: { created: Date.now() + 1, completed: Date.now() + 2 }, content: [{ type: "text", text: "Reviewed candidate" }] }]
    f.ctx.session.synthetic = async () => { throw new Error("lost wake") }
    const first = await setupEnsemble(f.ctx, { dbPath, dashboardPort: 0 })
    seedLeadAndMember(first)
    first.db.run("UPDATE team_member SET report_mode = 'final_response'")
    await first.dispatch({ type: "session.execution.succeeded", data: { sessionID: "ses_alice" } })
    const { executeTeamResults } = await import("../src/tools/team-results")
    const deps = { ...setupDeps(), db: first.db, registry: first.registry }
    expect(await executeTeamResults(deps, {}, "ses_lead")).toContain("Reviewed candidate")
    expect(await executeTeamResults(deps, {}, "ses_lead")).toBe("No unread messages.")
    expect(first.db.query("SELECT delivered, read FROM team_message").get()).toMatchObject({ delivered: 0, read: 1 })
    if (scenario === "superseded") first.db.run("UPDATE member_result SET read = 0, superseded = 1")
    if (scenario === "other-project") {
      first.db.run("UPDATE member_result SET read = 0")
      first.db.run("UPDATE team SET project_id = 'default'")
    }
    await first.dispose()
    first.db.close()
    const next = mockSetupCtx()
    const wakes: Record<string, unknown>[] = []
    next.ctx.session.synthetic = async input => { wakes.push(input); return {} }
    const second = await setupEnsemble(next.ctx, { dbPath, dashboardPort: 0 })
    try {
      expect(wakes.filter(wake => JSON.stringify(wake).includes("Undelivered team reports"))).toHaveLength(0)
    } finally { await second.dispose(); second.db.close(); rmSync(dbPath, { force: true }) }
  })

  test("registers and disposes the generic mission command through the public host API", async () => {
    const f = mockSetupCtx()
    const handle = await setupEnsemble(f.ctx, { dbPath: ":memory:", dashboardPort: 0 })
    expect(f.commands.map(command => command.name)).toEqual(["ensemble-mission"])
    await handle.dispose()
    expect(f.commandsDisposed()).toBe(true)
  })

  test("dispatched status events flow to member state", async () => {
    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    await handle.dispatch({ type: "session.status", data: { sessionID: "ses_alice", status: "idle" } })
    const row = handle.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as {
      status: string
    }
    expect(row.status).toBe("ready")
    await handle.dispose()
  })

  test("tool execute.before blocks team tools for sub-agents", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.tracker.track("ses_child", "ses_alice")
    const before = hooks["tool"]?.[0]
    expect(before).toBeDefined()
    let blocked: unknown = null
    try {
      await before?.({
        tool: "team_message",
        sessionID: "ses_child",
        input: { to: "lead", text: "hi" },
      } as never)
    } catch (err) {
      blocked = err
    }
    expect(String(blocked)).toContain("sub-agents")
    await handle.dispose()
  })

  test("tool execute.after enriches shell arg-fumble errors (issue #39)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const after = hooks["tool"]?.[1]
    expect(after).toBeDefined()
    const original = 'Invalid arguments for tool "shell":\n- command: Missing key'
    const event = {
      tool: "shell",
      sessionID: "ses_alice",
      input: { cmd: "git remote -v 2>&1", description: "Check happy remotes again" },
      status: "error",
      error: { message: original },
    }
    await after?.(event as never)
    const message = (event.error as { message: string }).message
    expect(message).toContain(original)
    expect(message).toContain('"cmd"')
    expect(message).toContain('"command"')
    await handle.dispose()
  })

  test("tool execute.after leaves non-fumble errors untouched (issue #39)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const after = hooks["tool"]?.[1]
    const original = "Command timed out after 120000ms"
    const event = {
      tool: "shell",
      sessionID: "ses_alice",
      input: { command: "sleep 999" },
      status: "error",
      error: { message: original },
    }
    await after?.(event as never)
    expect((event.error as { message: string }).message).toBe(original)
    await handle.dispose()
  })

  test("shell hook is registered (per-session env unavailable on V2 — see OQ-V2-shell)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const shellHook = hooks["shell"]?.[0]
    expect(shellHook).toBeDefined()
    const event = { sessionID: "ses_lead", env: {} as Record<string, string | undefined> }
    await shellHook?.(event as never)
    expect(event.env["ENSEMBLE_TEAM"]).toBeUndefined()
    await handle.dispose()
  })

  test("session context hook appends team system prompt for team sessions", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const sessionHooks = hooks["session"] ?? []
    expect(sessionHooks.length).toBeGreaterThan(0)
    const contextHook = sessionHooks[0]
    const event = { sessionID: "ses_lead", system: [] as Array<{ type: string; text: string }> }
    await contextHook?.(event as never)
    expect(event.system.length).toBe(2)
    expect(event.system[0]?.text).toContain("alpha")
    expect(event.system.at(-1)?.text).toContain("Mission decision boundaries")
    // Member sessions get the Code Mode invocation hint; leads do not.
    const memberEvent = { sessionID: "ses_alice", system: [] as Array<{ type: string; text: string }> }
    await contextHook?.(memberEvent as never)
    expect(memberEvent.system.length).toBe(3)
    expect(memberEvent.system[1]?.text).toContain("execute")
    expect(memberEvent.system.at(-1)?.text).toContain("Mission decision boundaries")
    await handle.dispose()
  })

  test("dashboard serves team state on the configured port", async () => {    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 47999 })
    seedLeadAndMember(handle)
    const res = await fetch("http://localhost:47999/api/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ensemble?: boolean }
    expect(body.ensemble).toBe(true)
    const teams = (await (await fetch("http://localhost:47999/api/state")).json()) as {
      teams?: unknown[]
    }
    expect(teams.teams?.length).toBe(1)
    await handle.dispose()
  })

  test("extractQuestionOutput reads string and part-array results", () => {
    expect(extractQuestionOutput({ content: "Approve purge abc123" })).toBe("Approve purge abc123")
    expect(
      extractQuestionOutput({ content: [{ type: "text", text: "yes" }, { type: "other" }] }),
    ).toBe("yes")
    expect(extractQuestionOutput(undefined)).toBe("")
  })

  test("context hook blocks native auto-wakes while an inherited spawn is being prepared", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    handle.db.run("INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES ('pending-team', 'pending-team', 'ses_lead', 'active', 0, 0, 0)")
    handle.db.run("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, spawn_pending, time_created, time_updated) VALUES ('pending-team', 'pending', 'ses_pending', 'build', 'busy', 'starting', 1, 0, 0)")
    const context = hooks["session"]![0]!
    expect(() => context({ sessionID: "ses_pending", system: [] } as never)).toThrow("initialization")
    handle.db.run("UPDATE team_member SET spawn_pending = 2 WHERE session_id = 'ses_pending'")
    expect(() => context({ sessionID: "ses_pending", system: [], messages: [] } as never)).toThrow("initialization")
    expect(() => context({ sessionID: "ses_pending", system: [], messages: [{ content: "[Ensemble task ses_pending]" }] } as never)).not.toThrow()
    await handle.dispose()
    handle.db.close()
  })

  test("setup rehydrates registry and nudges already-idle silent members", async () => {
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dbPath = join(tmpdir(), `ensemble-rehydrate-${Date.now()}.db`)
    // Seed a file DB directly (simulates state from before a restart).
    const { createDb } = await import("../src/db")
    const seed = createDb(dbPath)
    const now = Date.now()
    seed.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
      ["team1", "alpha", "ses_lead", now, now],
    )
    seed.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'ready', 'idle', ?, ?)",
      ["team1", "alice", "ses_alice", now, now],
    )
    seed.close()

    const prompts: unknown[] = []
    const { ctx } = mockSetupCtx()
    const session = ctx.session as unknown as {
      prompt: (input: unknown) => Promise<unknown>
    }
    session.prompt = async (input: unknown) => {
      prompts.push(input)
      return { id: "msg_1" }
    }
    const handle = await setupEnsemble(ctx, { dbPath, dashboardPort: 0 })
    // Registry rehydrated from SQLite despite the fresh process.
    expect(handle.registry.getBySession("ses_alice")?.memberName).toBe("alice")
    // Already-idle silent member got its one nudge on startup.
    const nudges = prompts.filter((p) => JSON.stringify(p).includes("did not report"))
    expect(nudges.length).toBe(1)
    expect(JSON.stringify(nudges[0])).toContain("ses_alice")
    await handle.dispose()
    handle.db.close()
    // A second setup (hot-reload) must NOT nudge again within the hour.
    const prompts2: unknown[] = []
    const { ctx: ctxReload } = mockSetupCtx()
    const sessionReload = ctxReload.session as unknown as {
      prompt: (input: unknown) => Promise<unknown>
    }
    sessionReload.prompt = async (input: unknown) => {
      prompts2.push(input)
      return { id: "msg_1" }
    }
    const handle2 = await setupEnsemble(ctxReload, { dbPath, dashboardPort: 0 })
    expect(prompts2.filter((p) => JSON.stringify(p).includes("did not report")).length).toBe(0)
    await handle2.dispose()
    handle2.db.close()
    const { rm } = await import("node:fs/promises")
    await rm(dbPath, { force: true })
  })
})
