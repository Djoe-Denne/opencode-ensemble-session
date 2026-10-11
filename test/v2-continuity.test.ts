import { describe, expect, test } from "bun:test"
import { createV2Continuity } from "../src/v2-continuity"
import type { V2Context } from "../src/v2-client"

function fixture() {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = []
  const info = { id: "ses_source", agent: "explore", projectID: "project", time: { created: 123 }, location: { directory: "/source" }, permissions: [] as unknown[], metadata: {} as Record<string, unknown> }
  const messages: Array<Record<string, unknown>> = []
  let compactStatus = "completed"
  const ctx = {
    session: {
      get: async () => ({ ...info }),
      active: async () => ({}),
      switchAgent: async (input: Record<string, unknown>) => { calls.push({ method: "switchAgent", input }); info.agent = String(input.agent) },
      update: async (input: Record<string, unknown>) => { calls.push({ method: "update", input }) },
      move: async (input: Record<string, unknown>) => { calls.push({ method: "move", input }); info.location = { directory: String(input.directory) } },
      interrupt: async (input: Record<string, unknown>) => { calls.push({ method: "interrupt", input }) },
      compact: async (input: Record<string, unknown>) => { calls.push({ method: "compact", input }); return { id: "msg_compact" } },
      wait: async (input: Record<string, unknown>) => { calls.push({ method: "wait", input }); messages.push({ id: "msg_compact", type: "compaction", status: compactStatus, summary: "native summary", recent: "native recent" }) },
      context: async () => messages,
      remove: async (input: Record<string, unknown>) => { calls.push({ method: "remove", input }) },
    },
    agent: { get: async ({ agentID }: { agentID: string }) => { if (agentID === "unknown") throw new Error("Unknown agent"); return { data: { id: agentID } } } },
  }
  return { ctx, info, calls, messages, failCompaction: () => { compactStatus = "failed" } }
}

describe("V2 native continuity adapter", () => {
  test("uses the native fork when exposed; never reads/rebuilds messages", async () => {
    const { ctx, calls } = fixture()
    Object.assign(ctx.session, { fork: async (input: Record<string, unknown>) => { calls.push({ method: "fork", input }); return { id: "ses_child" } } })
    const native = createV2Continuity(ctx as unknown as V2Context, { discoverBridge: async () => { throw new Error("native fork must not discover HTTP") } })
    expect(await native.fork({ sessionID: "ses_source", before: "msg_C" })).toEqual({ id: "ses_child" })
    expect(calls).toEqual([{ method: "fork", input: { sessionID: "ses_source", before: "msg_C" } }])
  })
  test("missing fork capability is explicit, without native create fallback", async () => {
    await expect(createV2Continuity(fixture().ctx as unknown as V2Context, { discoverBridge: async () => undefined }).fork({ sessionID: "ses_source" })).rejects.toThrow("v2ApiUrl")
  })
  test("discovered authentication failure refuses fork without POST", async () => {
    const { ctx } = fixture()
    let writes = 0
    const native = createV2Continuity(ctx as unknown as V2Context, {
      discoverBridge: async () => ({ apiUrl: "http://127.0.0.1:41037" }),
      fetch: (async (_url, init) => { if (init?.method === "POST") writes++; return new Response(null, { status: 401 }) }) as typeof fetch,
    })
    await expect(native.fork({ sessionID: "ses_source" })).rejects.toThrow("HTTP 401")
    expect(writes).toBe(0)
  })
  test("compaction active fallback uses the authenticated discovered server", async () => {
    const { ctx, info } = fixture()
    Reflect.deleteProperty(ctx.session, "active")
    const routes: string[] = []
    const native = createV2Continuity(ctx as unknown as V2Context, {
      discoverBridge: async () => ({ apiUrl: "http://127.0.0.1:41037", authorization: "Basic fixture" }),
      fetch: (async (url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Basic fixture")
        routes.push(new URL(String(url)).pathname)
        return Response.json({ data: String(url).endsWith("/active") ? {} : info })
      }) as typeof fetch,
    })
    await native.compact({ sessionID: info.id })
    expect(routes).toEqual(["/api/session/ses_source", "/api/session/active"])
  })
  test("discovers authenticated shared service without explicit configuration", async () => {
    const { ctx, info } = fixture()
    const requests: Array<{ url: string; auth: string | null }> = []
    const native = createV2Continuity(ctx as unknown as V2Context, {
      discoverBridge: async () => ({ apiUrl: "http://127.0.0.1:41037", authorization: "Basic fixture" }),
      fetch: (async (url, init) => {
        requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") })
        return Response.json({ data: init?.method === "POST" ? { id: "ses_child", fork: { sessionID: info.id } } : info })
      }) as typeof fetch,
    })
    expect(await native.fork({ sessionID: info.id })).toEqual({ id: "ses_child" })
    expect(requests).toHaveLength(2)
    expect(requests.every(r => r.auth === "Basic fixture")).toBe(true)
    expect(requests[1]?.url).toBe("http://127.0.0.1:41037/api/session/ses_source/fork")
  })
  test("discovered wrong server fails before POST", async () => {
    const { ctx, info } = fixture()
    let writes = 0
    const native = createV2Continuity(ctx as unknown as V2Context, {
      discoverBridge: async () => ({ apiUrl: "http://127.0.0.1:41037" }),
      fetch: (async (_url, init) => {
        if (init?.method === "POST") writes++
        return Response.json({ data: { ...info, projectID: "other" } })
      }) as typeof fetch,
    })
    await expect(native.fork({ sessionID: info.id })).rejects.toThrow("v2ApiUrl must address the same OpenCode server/source session")
    expect(writes).toBe(0)
  })
  test("explicit URL never receives discovered credentials", async () => {
    const { ctx, info } = fixture()
    let discovered = false
    const native = createV2Continuity(ctx as unknown as V2Context, {
      apiUrl: "http://explicit.invalid", authorization: "Bearer explicit",
      discoverBridge: async () => { discovered = true; throw new Error("must not discover") },
      fetch: (async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit")
        return Response.json({ data: init?.method === "POST" ? { id: "ses_child", fork: { sessionID: info.id } } : info })
      }) as typeof fetch,
    })
    expect(await native.fork({ sessionID: info.id })).toEqual({ id: "ses_child" })
    expect(discovered).toBe(false)
  })
  test("discovery errors do not leak credentials", async () => {
    const native = createV2Continuity(fixture().ctx as unknown as V2Context, {
      discoverBridge: async () => { throw new Error("SECRET fixture credentials") },
    })
    await expect(native.fork({ sessionID: "ses_source" })).rejects.toThrow("Cannot discover")
    await expect(native.fork({ sessionID: "ses_source" })).rejects.not.toThrow("SECRET")
  })
  test("HTTP fork checks source identity and sends before, using configured authentication", async () => {
    const { ctx, info } = fixture()
    const requests: Array<{ url: string; method: string; auth: string | null; body: unknown }> = []
    const server = Bun.serve({ port: 0, fetch: async request => {
      requests.push({ url: request.url, method: request.method, auth: request.headers.get("authorization"), body: request.method === "POST" ? await request.json() : null })
      return Response.json({ data: request.method === "POST" ? { id: "ses_child", fork: { sessionID: info.id } } : info })
    } })
    try {
      const native = createV2Continuity(ctx as unknown as V2Context, { apiUrl: server.url.toString(), authorization: "Bearer fixture" })
      expect((await native.fork({ sessionID: info.id, before: "msg_C" })).id).toBe("ses_child")
      expect(requests.map(r => r.method)).toEqual(["GET", "POST"])
      expect(requests[1]).toMatchObject({ auth: "Bearer fixture", body: { before: "msg_C" } })
      expect(requests[1]?.url).toContain("/api/session/ses_source/fork")
    } finally { await server.stop(true) }
  })
  test("wrong server/source identity fails before HTTP fork", async () => {
    const { ctx, info } = fixture()
    let writes = 0
    const server = Bun.serve({ port: 0, fetch: request => { if (request.method === "POST") writes++; return Response.json({ data: { ...info, projectID: "other" } }) } })
    try {
      await expect(createV2Continuity(ctx as unknown as V2Context, { apiUrl: server.url.toString() }).fork({ sessionID: info.id })).rejects.toThrow("same")
      expect(writes).toBe(0)
    } finally { await server.stop(true) }
  })
  test("move verifies isolation, awaits the native boundary and checks actual directory", async () => {
    const { ctx, calls } = fixture()
    const checked: string[][] = []
    await createV2Continuity(ctx as unknown as V2Context, { verifyMove: async (a, b) => { checked.push([a, b]) } }).move({ sessionID: "ses_child", directory: "/worktree" })
    expect(checked).toEqual([["/source", "/worktree"]])
    expect(calls.map(c => c.method)).toEqual(["move", "interrupt", "wait"])
    expect(calls[0]?.input).toEqual({ sessionID: "ses_child", directory: "/worktree", delivery: "steer" })
    expect(calls[1]?.input).toEqual({ sessionID: "ses_child", resume: true })
  })
  test("dirty or divergent source is never moved", async () => {
    const { ctx, calls } = fixture()
    await expect(createV2Continuity(ctx as unknown as V2Context, { verifyMove: async () => { throw new Error("Non-transferable source changes") } }).move({ sessionID: "ses_child", directory: "/worktree" })).rejects.toThrow("Non-transferable")
    expect(calls).toHaveLength(0)
  })
  test("successful compaction requires the admitted durable checkpoint to be completed", async () => {
    const { ctx, calls } = fixture()
    await createV2Continuity(ctx as unknown as V2Context).compact({ sessionID: "ses_source" })
    expect(calls.map(c => c.method)).toEqual(["compact", "wait"])
  })
  test("idle does not imply compaction success", async () => {
    const f = fixture()
    f.failCompaction()
    await expect(createV2Continuity(f.ctx as unknown as V2Context).compact({ sessionID: "ses_source" })).rejects.toThrow("compaction")
  })
  test("busy source cannot be compacted by a waiting spawn", async () => {
    const { ctx, calls } = fixture()
    ctx.session.active = async () => ({ ses_source: { type: "running" } })
    await expect(createV2Continuity(ctx as unknown as V2Context).compact({ sessionID: "ses_source" })).rejects.toThrow("idle")
    expect(calls).toHaveLength(0)
  })
  test("unknown handoff agent does not mutate a session", async () => {
    const { ctx, calls } = fixture()
    await expect(createV2Continuity(ctx as unknown as V2Context).switchAgent({ sessionID: "ses_source", agent: "unknown" })).rejects.toThrow("Unknown agent")
    expect(calls).toHaveLength(0)
  })
  test("an initializing fork settles its agent wake before task admission", async () => {
    const { ctx, calls } = fixture()
    await createV2Continuity(ctx as unknown as V2Context).switchAgent({ sessionID: "ses_child", agent: "build", initializing: true })
    expect(calls.map(call => call.method)).toEqual(["switchAgent", "wait"])
  })
  test("handoff removes only owned overrides, preserving user session permissions", async () => {
    const { ctx, info, calls } = fixture()
    const owned = { action: "edit", resource: "*", effect: "deny" }
    const user = { action: "shell", resource: "git push *", effect: "deny" }
    info.permissions = [user, owned]
    info.metadata = { "ensemble.permissions": [owned], custom: "keep" }
    await createV2Continuity(ctx as unknown as V2Context).switchAgent({ sessionID: "ses_source", agent: "architect" })
    const update = calls.find(c => c.method === "update")?.input
    expect(update?.permissions).toContainEqual(user)
    expect(update?.permissions).not.toContainEqual(owned)
    expect(update?.metadata).toMatchObject({ custom: "keep" })
    expect(calls.some(c => c.method === "move" || c.method === "wait")).toBe(false)
  })
})
