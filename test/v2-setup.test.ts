import { describe, expect, test } from "bun:test"
import { setupEnsemble, extractQuestionOutput, type V2SetupContext } from "../src/v2-setup"
import type { MissionCommandDefinition } from "../src/mission-commands"
/** Mock V2 setup context: hook registry + programmable event intake. */
function mockSetupCtx() {
  const hooks: Record<string, Array<(event: never) => unknown>> = {}
  const commands: MissionCommandDefinition[] = []
  let commandsDisposed = false
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
      get: async () => ({ id: "ses_x" }),
      context: async () => [],
      active: async () => ({}),
      hook: hook("session"),
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
}

describe("v2-setup (issue #36)", () => {
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

  test("restart retries a lost lead wake without duplicating a durable candidate or notification", async () => {
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
    await first.dispose()
    first.db.close()
    const next = mockSetupCtx()
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
    expect(event.system.length).toBe(1)
    expect(event.system[0]?.text).toContain("alpha")
    // Member sessions get the Code Mode invocation hint; leads do not.
    const memberEvent = { sessionID: "ses_alice", system: [] as Array<{ type: string; text: string }> }
    await contextHook?.(memberEvent as never)
    expect(memberEvent.system.length).toBe(2)
    expect(memberEvent.system[1]?.text).toContain("execute")
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
