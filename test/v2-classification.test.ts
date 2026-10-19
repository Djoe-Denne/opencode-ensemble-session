import { describe, expect, test } from "bun:test"
import { invokeNativeClassifier, invokeNativeGeneralClassifier, removeNativeClassificationHelper, type ClassificationToolEvent, type V2ClassificationContext } from "../src/v2-classification"
import { buildJevClassificationInput } from "../src/classification-protocol"

function fixture() {
  const calls: Array<{ method: string; input?: unknown }> = []
  const hooks = new Map<string, (event: ClassificationToolEvent) => void>()
  const payload = buildJevClassificationInput({ content: "task" })
  const result = { output: { model: "jev", answers: { complexity: { type: "score", score: 0.4 }, risk: { type: "score", score: 0.2 } } } }
  const ctx: V2ClassificationContext = {
    session: {
      create: async input => { calls.push({ method: "create", input }); return { id: "helper" } },
      prompt: async input => { calls.push({ method: "prompt", input }) },
      switchModel: async input => { calls.push({ method: "model", input }) },
      switchAgent: async () => {}, interrupt: async () => {}, get: async () => ({}), context: async () => [], active: async () => ({}), synthetic: async () => {},
      wait: async () => {
        hooks.get("execute.before")?.({ sessionID: "helper", tool: "jev_ask", input: payload })
        hooks.get("execute.after")?.({ sessionID: "helper", tool: "jev_ask", status: "completed", result })
      },
      remove: async input => { calls.push({ method: "remove", input }) },
    },
    permission: {
      rules: async input => { calls.push({ method: "permissions", input }) },
      hook: async (_name, callback) => {
        const allowed = { sessionID: "helper", action: "jev_ask", effect: "deny" }
        callback(allowed)
        expect(allowed.effect).toBe("allow")
        const other = { sessionID: "other", action: "shell", effect: "allow" }
        callback(other)
        expect(other.effect).toBe("allow")
        return { dispose: async () => {} }
      },
    },
    tool: {
      list: async () => [{ id: "jev_ask", input: {}, options: { codemode: false } }],
      hook: async (name, callback) => { hooks.set(name, callback); return { dispose: async () => { hooks.delete(name) } } },
    },
    worktree: { create: async () => ({ directory: "unused" }), remove: async () => {}, list: async () => [], refresh: async () => {} },
  }
  const request = { directory: "fixture", model: "fixture/worker", toolId: "jev_ask", input: payload, timeoutMs: 2000 }
  return { ctx, calls, hooks, request, result }
}

describe("native classification bridge", () => {
  test("the explicitly chosen general classifier uses a fresh session with all tools denied", async () => {
    const f = fixture()
    f.ctx.permission!.hook = async (_name, callback) => {
      const event = { sessionID: "other", action: "execute", effect: "allow" }
      callback(event)
      expect(event.effect).toBe("allow")
      return { dispose: async () => {} }
    }
    f.ctx.session.wait = async () => {}
    f.ctx.session.context = async () => [{ type: "user", text: '{"complexity":1}' }, { type: "assistant", content: [{ type: "text", text: '{"complexity":0.4,"risk":0.2}' }] }]
    expect(await invokeNativeGeneralClassifier(f.ctx, f.request)).toBe('{"complexity":0.4,"risk":0.2}')
    expect(f.calls.find(call => call.method === "create")?.input).toMatchObject({ permissions: [{ action: "*", resource: "*", effect: "deny" }] })
    expect(f.calls.at(-1)?.method).toBe("remove")
  })
  test("general classification rejects tools, empty assistant results and missing native capabilities", async () => {
    for (const kind of ["tool", "permission", "empty", "capability"]) {
      const f = fixture()
      f.ctx.permission!.hook = async (_name, callback) => {
        if (kind === "permission") {
          const event = { sessionID: "helper", action: "shell", effect: "allow" }
          callback(event)
          expect(event.effect).toBe("deny")
        }
        return { dispose: async () => {} }
      }
      f.ctx.session.wait = async () => { if (kind === "tool") f.hooks.get("execute.before")?.({ sessionID: "helper", tool: "execute" }) }
      if (kind === "capability") f.ctx.session.wait = undefined
      await expect(invokeNativeGeneralClassifier(f.ctx, f.request)).rejects.toThrow()
      if (kind !== "capability") expect(f.calls.at(-1)?.method).toBe("remove")
    }
  })
  test("uses a fresh restricted native session, selected model and execution evidence; cleans it up", async () => {
    const f = fixture()
    expect(await invokeNativeClassifier(f.ctx, { ...f.request, variant: "medium" })).toEqual(f.result)
    expect(f.calls.find(c => c.method === "create")?.input).not.toHaveProperty("parentID")
    expect(f.calls.find(c => c.method === "create")?.input).toMatchObject({ permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "execute", resource: "*", effect: "allow" },
      { action: "jev_ask", resource: "*", effect: "allow" },
    ] })
    expect(f.calls.find(c => c.method === "model")?.input).toMatchObject({ model: { providerID: "fixture", id: "worker", variant: "medium" } })
    expect(f.calls.at(-1)?.method).toBe("remove")
    expect(f.hooks.size).toBe(0)
  })
  test("a completed native tool does not wait for helper narration to end", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => {
      f.hooks.get("execute.before")?.({ sessionID: "helper", tool: "jev_ask", input: f.request.input })
      f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "jev_ask", status: "completed", result: f.result })
      return new Promise(() => {})
    }
    expect(await invokeNativeClassifier(f.ctx, { ...f.request, timeoutMs: 30 })).toEqual(f.result)
    expect(f.calls.at(-1)?.method).toBe("remove")
    expect(f.hooks.size).toBe(0)
  })
  test("Code Mode completion waits for the enclosing dispatcher but not further helper reasoning", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => {
      f.hooks.get("execute.before")?.({ sessionID: "helper", tool: "execute", input: { code: "ignored" } })
      f.hooks.get("execute.before")?.({ sessionID: "helper", tool: "jev_ask", input: f.request.input })
      f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "jev_ask", status: "completed", result: f.result })
      await Promise.resolve()
      expect(f.calls.at(-1)?.method).not.toBe("remove")
      f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "execute", status: "completed", result: f.result })
      return new Promise(() => {})
    }
    expect(await invokeNativeClassifier(f.ctx, { ...f.request, timeoutMs: 30 })).toEqual(f.result)
    expect(f.calls.at(-1)?.method).toBe("remove")
  })
  test("an enclosing dispatcher failure rejects even after its native classifier completed", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => {
      f.hooks.get("execute.before")?.({ sessionID: "helper", tool: "execute", input: { code: "ignored" } })
      f.hooks.get("execute.before")?.({ sessionID: "helper", tool: "jev_ask", input: f.request.input })
      f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "jev_ask", status: "completed", result: f.result })
      f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "execute", status: "error", error: { message: "Dispatcher lost its result" } })
      return new Promise(() => {})
    }
    const error = await invokeNativeClassifier(f.ctx, { ...f.request, timeoutMs: 30 }).then(() => new Error("Expected classifier failure"), (error: unknown) => error as Error)
    expect(error.message).toContain("Dispatcher lost its result")
    expect(error.message).not.toContain("Classifier timeout")
    expect(f.calls.at(-1)?.method).toBe("remove")
  })
  test("does not accept assistant text as proof that a tool ran", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => {}
    await expect(invokeNativeClassifier(f.ctx, f.request)).rejects.toThrow("execution evidence")
    expect(f.calls.at(-1)?.method).toBe("remove")
  })
  test("captures native failure and dispatcher errors before deleting a failed helper", async () => {
    const f = fixture()
    f.ctx.session.get = async () => { f.calls.push({ method: "read-outcome" }); return { outcome: "failed" } }
    f.ctx.session.context = async () => {
      f.calls.push({ method: "read-errors" })
      return [{ type: "assistant", error: { type: "provider", message: "Provider rejected tool schema", response: { body: "secret-response" } }, content: [] }]
    }
    f.ctx.session.wait = async () => {
      f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "execute", status: "error", error: { message: "Code Mode dispatcher failed" } })
    }
    const error = await invokeNativeClassifier(f.ctx, f.request).then(() => new Error("Expected classifier failure"), (error: unknown) => error as Error)
    expect(error.message).toContain('"outcome":"failed"')
    expect(error.message).toContain("Provider rejected tool schema")
    expect(error.message).toContain("Code Mode dispatcher failed")
    expect(error.message).not.toContain("secret-response")
    expect(f.calls.map(call => call.method).slice(-3)).toEqual(["read-outcome", "read-errors", "remove"])
  })
  test("timeout diagnostics identify the phase and do not prevent cleanup when readback hangs", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => new Promise(() => {})
    f.ctx.session.get = async () => new Promise(() => {})
    f.ctx.session.context = async () => new Promise(() => {})
    const error = await invokeNativeClassifier(f.ctx, { ...f.request, timeoutMs: 5 }).then(() => new Error("Expected classifier failure"), (error: unknown) => error as Error)
    expect(error.message).toContain("Classifier timeout")
    expect(error.message).toContain('"phase":"wait"')
    expect(f.calls.at(-1)?.method).toBe("remove")
  })
  test("persisted native diagnostics redact basic authorization and quoted credential fields", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => { throw new Error('Provider rejected request Authorization: Basic c2VjcmV0LWF1dGg=; {"api_key":"secret-api", "password":"secret phrase", "token":"secret-token"}; Bearer secret-bearer') }
    const error = await invokeNativeClassifier(f.ctx, f.request).then(() => new Error("Expected classifier failure"), (error: unknown) => error as Error)
    expect(error.message).toContain("Provider rejected request")
    expect(error.message).toContain("[redacted]")
    for (const secret of ["c2VjcmV0LWF1dGg=", "secret-api", "secret phrase", "secret-token", "secret-bearer"]) expect(error.message).not.toContain(secret)
  })
  test("native diagnostics retain safe model and progress metadata when no tool has run", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => {}
    f.ctx.session.get = async () => ({ model: { providerID: "fixture", id: "worker", variant: "high" }, agent: "build", tokens: { input: 17, output: 0 }, time: { created: 12, updated: 18 }, providerSecret: "ignored-secret" })
    f.ctx.session.context = async () => [{ type: "user", content: [{ type: "text", text: "ignored-prompt" }] }]
    const error = await invokeNativeClassifier(f.ctx, f.request).then(() => new Error("Expected classifier failure"), (error: unknown) => error as Error)
    expect(error.message).toContain('"model":{"providerID":"fixture","id":"worker","variant":"high"}')
    expect(error.message).toContain('"tokens":{"input":17,"output":0}')
    expect(error.message).toContain('"messages":1')
    expect(error.message).not.toContain("ignored-secret")
    expect(error.message).not.toContain("ignored-prompt")
  })
  test("Code Mode error envelopes preserve dispatcher failures even when execute is marked completed", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => {
      f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "execute", status: "completed", result: {
        output: { output: "Unknown tool 'jev_ask.call'", error: true },
        content: [{ type: "text", text: "Unknown tool 'jev_ask.call'" }], metadata: { error: true },
      } })
    }
    await expect(invokeNativeClassifier(f.ctx, f.request)).rejects.toThrow("Unknown tool 'jev_ask.call'")
    expect(f.calls.at(-1)?.method).toBe("remove")
  })
  test("general classification rejects native failure even when assistant JSON exists", async () => {
    const f = fixture()
    f.ctx.permission!.hook = async () => ({ dispose: async () => {} })
    f.ctx.session.wait = async () => {}
    f.ctx.session.get = async () => ({ outcome: "failed" })
    f.ctx.session.context = async () => [{ type: "assistant", content: [{ type: "text", text: '{"complexity":0.4}' }], error: { message: "Provider stream failed" } }]
    await expect(invokeNativeGeneralClassifier(f.ctx, f.request)).rejects.toThrow("Provider stream failed")
    expect(f.calls.at(-1)?.method).toBe("remove")
  })
  test("blocks unrelated tools, changed inputs and duplicate invocations", async () => {
    for (const kind of ["unrelated", "changed", "duplicate"]) {
      const f = fixture()
      f.ctx.session.wait = async () => {
        const event = { sessionID: "helper", tool: kind === "unrelated" ? "shell" : "jev_ask", input: kind === "changed" ? {} : f.request.input }
        f.hooks.get("execute.before")?.(event)
        if (kind === "duplicate") f.hooks.get("execute.before")?.(event)
      }
      await expect(invokeNativeClassifier(f.ctx, f.request)).rejects.toThrow("Classifier")
      expect(f.calls.at(-1)?.method).toBe("remove")
      expect(f.hooks.size).toBe(0)
    }
  })
  test("wait failures release the helper without aborting any team member", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => { throw new Error("timeout") }
    await expect(invokeNativeClassifier(f.ctx, f.request)).rejects.toThrow("timeout")
    expect(f.calls.filter(c => c.method === "remove")).toHaveLength(1)
    expect(f.calls.some(c => c.method === "abort")).toBe(false)
  })
  test("missing native capabilities or missing tools fail before allocating a session", async () => {
    for (const absent of ["permissions", "wait", "tool"]) {
      const f = fixture()
      if (absent === "permissions") f.ctx.permission = undefined
      if (absent === "wait") f.ctx.session.wait = undefined
      if (absent === "tool") f.ctx.tool.list = async () => []
      await expect(invokeNativeClassifier(f.ctx, f.request)).rejects.toThrow()
      expect(f.calls).toHaveLength(0)
    }
  })
  test("cleanup failures name the retained native session", async () => {
    const f = fixture()
    f.ctx.session.remove = async () => { throw new Error("offline") }
    await expect(invokeNativeClassifier(f.ctx, f.request)).rejects.toThrow("helper")
    expect(f.hooks.size).toBe(2)
    expect(() => f.hooks.get("execute.before")?.({ sessionID: "helper", tool: "shell" })).toThrow("unrelated")
  })
  test("one Code Mode dispatch discovers and invokes the exact approved tool even if the helper stops afterwards", async () => {
    const f = fixture()
    let invocations = 0
    f.ctx.session.wait = async () => {
      const originalInput = { code: 'return fetch("https://untrusted.invalid")' }
      const first: ClassificationToolEvent = { sessionID: "helper", tool: "execute", input: originalInput }
      f.hooks.get("execute.before")?.(first)
      expect(first.input).toBe(originalInput)
      const code = originalInput.code
      expect(code).not.toContain("untrusted.invalid")
      const search = (input: unknown) => { expect(input).toEqual({ query: "jev_ask", limit: 1 }); return { items: [{ path: 'tools.router["jev_ask"]' }] } }
      const tools = { router: { jev_ask: async (input: unknown) => {
        invocations++
        f.hooks.get("execute.before")?.({ sessionID: "helper", tool: "jev_ask", input })
        f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "jev_ask", status: "completed", result: f.result })
        return f.result
      } } }
      // Execute only bridge-generated code, never the model-authored input above.
      const result = await new Function("search", "tools", `return (async () => { ${code} })();`)(search, tools)
      f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "execute", status: "completed", result })
    }
    expect(await invokeNativeClassifier(f.ctx, f.request)).toEqual(f.result)
    expect(invocations).toBe(1)
  })
  test("Code Mode helpers receive no task payload while the native classifier still gets the exact approved input", async () => {
    const f = fixture()
    const input = buildJevClassificationInput({ content: "CLASSIFIER_ONLY_SENSITIVE_PAYLOAD" })
    f.ctx.tool.list = async () => [{ id: "jev_ask", input: {}, options: { codemode: true } }]
    f.ctx.session.wait = async () => {
      const event = { sessionID: "helper", tool: "execute", input: { code: "ignored" } }
      f.hooks.get("execute.before")?.(event)
      const tools = { jev_ask: async (approved: unknown) => {
        expect(approved).toEqual(input)
        f.hooks.get("execute.before")?.({ sessionID: "helper", tool: "jev_ask", input: approved })
        f.hooks.get("execute.after")?.({ sessionID: "helper", tool: "jev_ask", status: "completed", result: f.result })
        return f.result
      } }
      await new Function("search", "tools", `return (async () => { ${event.input.code} })();`)(() => ({ items: [{ path: "tools.jev_ask" }] }), tools)
    }
    expect(await invokeNativeClassifier(f.ctx, { ...f.request, input })).toEqual(f.result)
    const prompt = (f.calls.find(call => call.method === "prompt")?.input as { text: string }).text
    expect(prompt).not.toContain("CLASSIFIER_ONLY_SENSITIVE_PAYLOAD")
    expect(prompt).not.toContain("Exact JSON input")
    expect(prompt).toContain("execute exactly once")
    expect(prompt.length).toBeLessThan(1500)
  })
  test("the deterministic dispatcher rejects malformed catalogue paths without evaluating them", async () => {
    const f = fixture()
    f.ctx.session.wait = async () => {
      const event: ClassificationToolEvent = { sessionID: "helper", tool: "execute", input: { code: "ignored" } }
      f.hooks.get("execute.before")?.(event)
      const code = (event.input as { code: string }).code
      const search = () => ({ items: [{ path: 'tools.jev_ask);fetch("https://untrusted.invalid")' }] })
      await new Function("search", "tools", `return (async () => { ${code} })();`)(search, {})
    }
    await expect(invokeNativeClassifier(f.ctx, f.request)).rejects.toThrow("catalogue path")
    expect(f.calls.at(-1)?.method).toBe("remove")
  })
  test("a tool failure retains its cause, and a denied extra call invalidates even an earlier valid score", async () => {
    const failure = fixture()
    failure.ctx.session.wait = async () => {
      failure.hooks.get("execute.before")?.({ sessionID: "helper", tool: "jev_ask", input: failure.request.input })
      failure.hooks.get("execute.after")?.({ sessionID: "helper", tool: "jev_ask", status: "error", error: { message: "backend model disappeared" } })
    }
    await expect(invokeNativeClassifier(failure.ctx, failure.request)).rejects.toThrow("backend model disappeared")
    const extra = fixture()
    const wait = extra.ctx.session.wait!
    extra.ctx.session.wait = async input => {
      await wait(input)
      try { extra.hooks.get("execute.before")?.({ sessionID: "helper", tool: "shell" }) } catch { /* native tool loop reports errors without throwing wait */ }
    }
    await expect(invokeNativeClassifier(extra.ctx, extra.request)).rejects.toThrow("unrelated")
    const permission = fixture()
    permission.ctx.permission!.hook = async (_name, callback) => {
      const event = { sessionID: "helper", action: "shell", effect: "allow" }
      callback(event)
      expect(event.effect).toBe("deny")
      return { dispose: async () => {} }
    }
    await expect(invokeNativeClassifier(permission.ctx, permission.request)).rejects.toThrow("unrelated action")
  })
  test("invalid helper model or timeout rejects before allocation", async () => {
    const f = fixture()
    await expect(invokeNativeClassifier(f.ctx, { ...f.request, model: "invalid" })).rejects.toThrow("model")
    await expect(invokeNativeClassifier(f.ctx, { ...f.request, timeoutMs: 0 })).rejects.toThrow("timeoutMs")
    expect(f.calls).toHaveLength(0)
  })
  test("the deadline covers discovery, setup and wait even if a host ignores cancellation", async () => {
    for (const stage of ["discovery", "model", "wait"]) {
      const f = fixture()
      const pause = () => new Promise<void>(resolve => { setTimeout(resolve, 40) })
      if (stage === "discovery") { const list = f.ctx.tool.list; f.ctx.tool.list = async () => { await pause(); return list() } }
      if (stage === "model") f.ctx.session.switchModel = pause
      if (stage === "wait") { const wait = f.ctx.session.wait!; f.ctx.session.wait = async input => { await pause(); return wait(input) } }
      await expect(invokeNativeClassifier(f.ctx, { ...f.request, timeoutMs: 5 })).rejects.toThrow("timeout")
      if (stage !== "discovery") expect(f.calls.at(-1)?.method).toBe("remove")
    }
  })
  test("helper creation/removal provenance is reported and late-created helpers are removed", async () => {
    const f = fixture()
    const resources: string[] = []
    const removed: string[] = []
    f.ctx.session.create = async () => { await new Promise(resolve => { setTimeout(resolve, 30) }); return { id: "late-helper" } }
    await expect(invokeNativeClassifier(f.ctx, { ...f.request, timeoutMs: 5, onCreated: id => { resources.push(id) }, onRemoved: id => { removed.push(id) } })).rejects.toThrow("timeout")
    await new Promise(resolve => { setTimeout(resolve, 40) })
    expect(resources).toEqual(["late-helper"])
    expect(removed).toEqual(["late-helper"])
    expect(f.calls.some(call => call.method === "prompt")).toBe(false)
  })
  test("tool hook disposal failures still remove the helper", async () => {
    const f = fixture()
    const hook = f.ctx.tool.hook
    f.ctx.tool.hook = async (name, callback) => {
      const registration = await hook(name, callback)
      return { dispose: async () => { await registration.dispose(); throw new Error("dispose") } }
    }
    await expect(invokeNativeClassifier(f.ctx, f.request)).rejects.toThrow("hook cleanup")
    expect(f.calls.at(-1)?.method).toBe("remove")
  })
  test("recovery accepts a verified absent helper but never treats transport failures as absence", async () => {
    const f = fixture()
    f.ctx.session.remove = async () => { throw { _tag: "Session.NotFoundError", sessionID: "helper" } }
    await expect(removeNativeClassificationHelper(f.ctx, "helper")).resolves.toBeUndefined()
    f.ctx.session.remove = async () => { throw new Error("offline") }
    await expect(removeNativeClassificationHelper(f.ctx, "helper")).rejects.toThrow("offline")
  })
})
