import { describe, expect, test } from "bun:test"
import {
  assertNativeHostIdentity,
  buildPermissionPlan,
  classifyPermissionResponse,
  createPermissionTransport,
  parsePermissionHttpResponse,
  runPermissionPlan,
  validateLiveArguments,
  validateNativeEndpoint,
  type NativeRequest,
} from "../eval/native-permissions"

const root = "C:/scratch/ensemble-sp1-permissions"

describe("SP-1 native permission probe (no network on import)", () => {
  test("requires explicit live approval, the isolated worktree and an owned evidence output", () => {
    expect(() => validateLiveArguments([], {}, root)).toThrow("explicit")
    expect(() => validateLiveArguments(["--live"], { ENSEMBLE_SP1_APPROVED: "1" }, "C:/canonical")).toThrow("worktree")
    const worktree = "C:/worktree/ensemble-example-sp1-permissions"
    expect(() => validateLiveArguments(["--live", "--output", "../outside.json"], { ENSEMBLE_SP1_APPROVED: "1" }, worktree)).toThrow("output")
    expect(validateLiveArguments(["--live", "--output", "docs/plans/SP-1/native.json"], { ENSEMBLE_SP1_APPROVED: "1" }, worktree)).toEqual({ root: worktree, output: `${worktree}/docs/plans/SP-1/native.json` })
  })
  test("plans bounded opposing rule order, relative, absolute and outside-root resources", () => {
    const plan = buildPermissionPlan(root)
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.length).toBeLessThanOrEqual(12)
    expect(plan.flatMap((group) => group.probes).length).toBeLessThanOrEqual(120)
    const allowLast = plan.find((group) => group.name === "allow-last")
    const denyLast = plan.find((group) => group.name === "deny-last")
    expect(allowLast?.permissions).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "docs/plans/**", effect: "allow" },
    ])
    expect(denyLast?.permissions).toEqual(allowLast?.permissions?.toReversed())
    const resources = plan.flatMap((group) => group.probes.flatMap((probe) => probe.resources))
    expect(resources).toContain("docs/plans/sp1-probe.md")
    expect(resources).toContain(`${root}/docs/plans/sp1-probe.md`)
    expect(resources).toContain("C:/scratch/sp1-outside/docs/plans/sp1-probe.md")
    expect(resources).toContain("docs/plans/../../src/sp1-probe.ts")
    expect(plan.some((group) => group.probes.some((probe) => probe.resources.length > 1))).toBe(true)
  })

  test("repeats the exact architect request at least five times in the same group", () => {
    const baseline = buildPermissionPlan(root).find((group) => group.name === "architect-baseline")
    const repeats = baseline?.probes.filter((probe) => probe.name === "architect-identical") ?? []
    expect(repeats).toHaveLength(5)
    expect(new Set(repeats.map((probe) => JSON.stringify(probe))).size).toBe(1)
    expect(repeats[0]?.agent).toBe("architect")
  })

  test("never labels ask, transport or malformed HTTP success as deny", () => {
    expect(classifyPermissionResponse(200, { data: { id: "perm_1", effect: "allow" } })).toBe("allow")
    expect(classifyPermissionResponse(200, { data: { id: "perm_1", effect: "deny" } })).toBe("deny")
    expect(classifyPermissionResponse(200, { data: { id: "perm_1", effect: "ask" } })).toBe("ask")
    expect(classifyPermissionResponse(403, { error: "denied" })).toBe("http-error")
    expect(classifyPermissionResponse(200, { data: { effect: "allow" } })).toBe("protocol-error")
  })

  test("rejects non-string native effects instead of coercing arrays into decisions", () => {
    const effects: unknown[] = [["allow"], ["deny"], ["ask"], {}, 42, false, null]
    effects.forEach((effect) => {
      expect(classifyPermissionResponse(200, { data: { id: "perm_malformed", effect } })).toBe("protocol-error")
    })
  })

  test("preserves HTTP versus protocol errors when a response is not JSON", () => {
    const success = parsePermissionHttpResponse(200, "<html>not JSON</html>")
    expect(success).toEqual({ status: 200, body: "<html>not JSON</html>" })
    expect(classifyPermissionResponse(success.status, success.body)).toBe("protocol-error")
    const failure = parsePermissionHttpResponse(503, "Service unavailable")
    expect(failure).toEqual({ status: 503, body: "Service unavailable" })
    expect(classifyPermissionResponse(failure.status, failure.body)).toBe("http-error")
    const body = { data: { id: "perm_valid", effect: "allow" } }
    expect(parsePermissionHttpResponse(200, JSON.stringify(body))).toEqual({ status: 200, body })
  })

  test("requires explicit local endpoint and PID without reading a registration file", () => {
    const args = ["--service-url", "http://127.0.0.1:41037/", "--service-pid", "51636"]
    expect(validateNativeEndpoint(args, {})).toEqual({ url: "http://127.0.0.1:41037", pid: 51636 })
    expect(validateNativeEndpoint(args, { ENSEMBLE_SP1_PASSWORD: "test-password" }).authorization)
      .toBe(`Basic ${Buffer.from("opencode:test-password").toString("base64")}`)
    expect(() => validateNativeEndpoint([], {})).toThrow("service URL")
    expect(() => validateNativeEndpoint(["--service-url", "http://example.com", "--service-pid", "51636"], {})).toThrow("loopback")
    expect(() => validateNativeEndpoint(["--service-url", "http://user:password@127.0.0.1:41037", "--service-pid", "51636"], {})).toThrow("credentials")
    expect(() => validateNativeEndpoint(["--service-url", "http://127.0.0.1:41037"], {})).toThrow("service PID")
    expect(() => validateNativeEndpoint(["--service-url", "http://127.0.0.1:41037", "--service-pid", "0"], {})).toThrow("service PID")
  })

  test("checks the public host version and PID before admitting a live campaign", () => {
    expect(() => assertNativeHostIdentity({ version: "2.0.32", pid: 51636 }, 51636)).not.toThrow()
    expect(() => assertNativeHostIdentity({ version: "2.0.33", pid: 51636 }, 51636)).toThrow("version")
    expect(() => assertNativeHostIdentity({ version: "2.0.32", pid: 99999 }, 51636)).toThrow("PID")
    expect(() => assertNativeHostIdentity({ version: "2.0.32" }, 51636)).toThrow("PID")
  })

  test("the live HTTP transport refuses 307/308 without following the redirect", async () => {
    await Promise.all([307, 308].map(async (status) => {
      const seen: Array<{ url: string; init: RequestInit }> = []
      const calls: Array<{ method: string; path: string; status?: number; at: string }> = []
      const request = createPermissionTransport({ root, url: "http://127.0.0.1:41037", calls }, async (url, init) => {
        seen.push({ url, init })
        return new Response("redirect", { status, headers: { location: "https://unapproved.invalid/api/session" } })
      })
      const result = await request("POST", "/api/session", { title: "scratch" })
      expect(seen).toHaveLength(1)
      expect(seen[0]?.init.redirect).toBe("manual")
      expect(seen[0]?.init.method).toBe("POST")
      expect(result).toEqual({ status, body: { error: "redirect-refused" } })
      expect(calls[0]?.status).toBe(status)
      expect(classifyPermissionResponse(result.status, result.body)).toBe("http-error")
    }))
  })

  test("the live HTTP transport enforces owned endpoints before invoking fetch", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const replies = [
      new Response(JSON.stringify({ data: { id: "ses_owned" } }), { status: 200 }),
      new Response(JSON.stringify({ data: { id: "perm_owned", effect: "allow" } }), { status: 200 }),
    ]
    const request = createPermissionTransport({ root, url: "http://127.0.0.1:41037", authorization: "Basic fake-auth" }, async (url, init) => {
      seen.push({ url, init })
      const reply = replies.shift()
      if (!reply) throw new Error("unexpected request")
      return reply
    })
    await expect(request("POST", "/api/session/ses_foreign/permission", {})).rejects.toThrow("unowned")
    expect(seen).toHaveLength(0)
    await request("POST", "/api/session", { title: "scratch" })
    const result = await request("POST", "/api/session/ses_owned/permission", { action: "edit", resources: ["docs/plans/probe.md"] })
    expect(classifyPermissionResponse(result.status, result.body)).toBe("allow")
    expect(seen.map((call) => call.init.redirect)).toEqual(["manual", "manual"])
    expect(new Headers(seen[0]?.init.headers).get("authorization")).toBe("Basic fake-auth")
    await expect(request("DELETE", "/api/session/ses_owned")).rejects.toThrow("unapproved")
    expect(seen).toHaveLength(2)
  })

  test("the live HTTP transport preserves non-JSON HTTP and protocol outcomes", async () => {
    await Promise.all([200, 503].map(async (status) => {
      const replies = [
        new Response(JSON.stringify({ data: { id: "ses_owned" } }), { status: 200 }),
        new Response("not JSON", { status }),
      ]
      const request = createPermissionTransport({ root, url: "http://127.0.0.1:41037" }, async () => {
        const reply = replies.shift()
        if (!reply) throw new Error("unexpected request")
        return reply
      })
      await request("POST", "/api/session", { title: "scratch" })
      const result = await request("POST", "/api/session/ses_owned/permission", { action: "edit", resources: ["docs/plans/probe.md"] })
      expect(result).toEqual({ status, body: "not JSON" })
      expect(classifyPermissionResponse(result.status, result.body)).toBe(status === 200 ? "protocol-error" : "http-error")
    }))
  })

  test("reads back native location, stops on ask, retains manifest, and never prompts or aborts", async () => {
    const calls: string[] = []
    const request: NativeRequest = async (method, path) => {
      calls.push(`${method} ${path}`)
      if (path === "/api/session") return { status: 200, body: { data: { id: "ses_scratch" } } }
      if (method === "GET") return { status: 200, body: { data: { id: "ses_scratch", agent: "architect", location: { directory: root } } } }
      if (path.endsWith("/permission")) return { status: 200, body: { data: { id: "perm_ask", effect: "ask" } } }
      return { status: 200, body: { data: {} } }
    }
    const result = await runPermissionPlan(request, root, "test-run", buildPermissionPlan(root))
    expect(result.stop).toBe("ask")
    expect(result.sessions).toHaveLength(1)
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]?.outcome).toBe("ask")
    expect(calls.some((call) => /prompt|abort|DELETE/.test(call))).toBe(false)
    expect(calls.filter((call) => call.endsWith("/permission"))).toHaveLength(1)
  })

  test("does not probe a session whose native location differs from the approved worktree", async () => {
    const calls: string[] = []
    const request: NativeRequest = async (method, path) => {
      calls.push(`${method} ${path}`)
      if (path === "/api/session") return { status: 200, body: { data: { id: "ses_scratch" } } }
      return { status: 200, body: { data: { id: "ses_scratch", agent: "architect", location: { directory: "C:/canonical" } } } }
    }
    const result = await runPermissionPlan(request, root, "test-run", buildPermissionPlan(root))
    expect(result.stop).toBe("location-mismatch")
    expect(result.sessions).toHaveLength(1)
    expect(calls.some((call) => call.endsWith("/permission"))).toBe(false)
  })

  test("records allow and deny as native decisions, with identical repetition bodies", async () => {
    const bodies: unknown[] = []
    const request: NativeRequest = async (method, path, body) => {
      if (path === "/api/session") return { status: 200, body: { data: { id: "ses_scratch" } } }
      if (method === "GET") return { status: 200, body: { data: { id: "ses_scratch", agent: "architect", location: { directory: root } } } }
      bodies.push(body)
      return { status: 200, body: { data: { id: `perm_${bodies.length}`, effect: bodies.length === 2 ? "deny" : "allow" } } }
    }
    const baseline = buildPermissionPlan(root).filter((group) => group.name === "architect-baseline")
    const result = await runPermissionPlan(request, root, "test-run", baseline)
    expect(result.stop).toBeNull()
    expect(result.observations.some((entry) => entry.outcome === "deny")).toBe(true)
    const repeated = result.observations.filter((entry) => entry.probe === "architect-identical")
    expect(repeated).toHaveLength(5)
    expect(new Set(repeated.map((entry) => JSON.stringify(entry.request))).size).toBe(1)
  })

  test("stops on transport failure and checkpoints the owned session before probing", async () => {
    const checkpoints: string[][] = []
    const request: NativeRequest = async (method, path) => {
      if (path === "/api/session") return { status: 200, body: { data: { id: "ses_scratch" } } }
      if (method === "GET") return { status: 200, body: { data: { id: "ses_scratch", agent: "architect", location: { directory: root } } } }
      throw new Error("transport unavailable")
    }
    const result = await runPermissionPlan(request, root, "test-run", buildPermissionPlan(root), async (state) => {
      checkpoints.push([...state.sessions])
    })
    expect(result.stop).toBe("transport-error")
    expect(result.observations[0]?.outcome).toBe("transport-error")
    expect(checkpoints[0]).toEqual(["ses_scratch"])
  })

  test("rejects an oversized plan before creating any native session", async () => {
    const plan = buildPermissionPlan(root)
    const group = plan[0]
    if (!group) throw new Error("missing test group")
    const request: NativeRequest = async () => { throw new Error("must not request") }
    await expect(runPermissionPlan(request, root, "test-run", Array.from({ length: 13 }, () => group))).rejects.toThrow("limit")
  })

  test("distinguishes a request timeout from an ordinary transport failure", async () => {
    const request: NativeRequest = async (method, path) => {
      if (path === "/api/session") return { status: 200, body: { data: { id: "ses_scratch" } } }
      if (method === "GET") return { status: 200, body: { data: { id: "ses_scratch", agent: "architect", location: { directory: root } } } }
      throw new DOMException("bounded timeout", "TimeoutError")
    }
    const result = await runPermissionPlan(request, root, "test-run", buildPermissionPlan(root))
    expect(result.stop).toBe("timeout")
    expect(result.observations[0]?.outcome).toBe("timeout")
  })
})
