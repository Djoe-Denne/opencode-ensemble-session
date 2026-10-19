import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildJevClassificationInput } from "../src/classification-protocol"

// Real public plugin API, native sessions, permission evaluation and tool hooks.
// Model and JEV responses are local fixtures: no paid external requests.
const executable = process.env.OPENCODE_TEST_BIN ?? "opencode"
const temp = process.env.OPENCODE_TEST_TMP ?? (process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? tmpdir(), "Temp", "opencode") : tmpdir())
await mkdir(temp, { recursive: true })
const base = await mkdtemp(join(temp, "ensemble-classification-"))
const root = join(base, "project")
await mkdir(root)
let requests = 0

function discoverPath(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined
  if (typeof value === "string") {
    try { return discoverPath(JSON.parse(value), depth + 1) } catch { return undefined }
  }
  if (Array.isArray(value)) return value.map(entry => discoverPath(entry, depth + 1)).find(Boolean)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.path === "string" && record.path.includes("codemode_jev_ask")) return record.path
    return Object.values(record).map(entry => discoverPath(entry, depth + 1)).find(Boolean)
  }
  return undefined
}
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { model: string; stream?: boolean; messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }
  requests++
  const messages = body.messages ?? []
  const text = JSON.stringify(messages)
  const promptText = messages.map(message => typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.map(part => (part as { text?: string }).text ?? "").join("\n") : "").join("\n")
  const general = text.includes("restricted general classification helper")
  const isTask = text.includes("restricted classification helper") || general
   const codeMode = promptText.includes("Call exactly this tool once: codemode_jev_ask")
  const toolReplies = messages.filter(message => message.role === "tool")
  // Regression spike: a Code Mode helper that keeps generating after a valid
  // tool result must not discard that result at the classifier deadline.
  if (codeMode && toolReplies.length > 0) return new Promise<Response>(() => {})
  const codeModePath = toolReplies.map(message => discoverPath(message.content)).find(Boolean)
  const called = messages.some(message => message.role === "tool")
  const toolCall = isTask && (!general || text.includes("NATIVE_GENERAL_DENIED")) && !text.includes("NATIVE_NO_CALL") && (codeMode ? !called || Boolean(codeModePath && toolReplies.length === 1) : !called)
  const marker = text.includes("NATIVE_DENIED") ? "NATIVE_DENIED" : "NATIVE_ALLOWED"
  const suffix = marker === "NATIVE_DENIED" || general ? "fixture_forbidden" : promptText.includes("Call exactly this tool once: fixture_classify_x86") ? "fixture_classify_x86" : "fixture_jev_ask"
  const tool = codeMode ? "execute" : body.tools?.find(entry => entry.function?.name?.endsWith(suffix))?.function?.name ?? suffix
  const exactInput = /Exact JSON input: ([^\n]+)/.exec(promptText)?.[1] ?? JSON.stringify(buildJevClassificationInput({ content: marker }))
  const argumentsJson = codeMode ? JSON.stringify({ code: codeModePath ? `return await ${codeModePath}(${exactInput});` : 'throw new Error("MODEL_AUTHORED_CODE_EXECUTED"); return search({query:"codemode_jev_ask",limit:1});' }) : marker === "NATIVE_DENIED" || general ? "{}" : exactInput
  const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests}`, type: "function", function: { name: tool, arguments: argumentsJson } }] } : { role: "assistant", content: general && !text.includes("NATIVE_GENERAL_DENIED") ? '{"complexity":0.48123,"risk":0.97234}' : "Fixture completed." }
  const finish = toolCall ? "tool_calls" : "stop"
  const common = { id: `chatcmpl-${requests}`, created: Math.floor(Date.now() / 1000), model: body.model }
  if (!body.stream) return Response.json({ ...common, object: "chat.completion", choices: [{ index: 0, message: delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  const chunks = [
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ]
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
} })
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reserve.port!
await reserve.stop(true)
const url = `http://127.0.0.1:${port}`
await writeFile(join(root, "opencode.json"), JSON.stringify({
  model: "classification-fixture/worker", plugins: [resolve(dirname(fileURLToPath(import.meta.url)), "classification-fixture")],
  providers: { "classification-fixture": { name: "Local classification fixture", env: ["CLASSIFICATION_FIXTURE_KEY"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${provider.url}v1` }, models: { worker: { name: "Fixture worker" } } } },
}))
const server = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, XDG_CONFIG_HOME: join(base, "config"), XDG_DATA_HOME: join(base, "data"), XDG_CACHE_HOME: join(base, "cache"),
    OPENCODE_CONFIG: join(root, "opencode.json"), ENSEMBLE_CLASSIFICATION_FIXTURE: "1", CLASSIFICATION_FIXTURE_KEY: "fixture-only" },
})
let authorization = ""
const capture = async (stream: ReadableStream<Uint8Array>) => {
  let text = ""
  for await (const chunk of stream) {
    text += new TextDecoder().decode(chunk)
    const password = /server password (\S+)/.exec(text)?.[1]
    if (password) authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  }
  return text.replace(/server password \S+/g, "server password [redacted]")
}
const stdout = capture(server.stdout)
const stderr = capture(server.stderr)
try {
  const deadline = Date.now() + 60_000
  while (true) {
    try { if (authorization && (await fetch(`${url}/api/info`, { headers: { authorization } })).ok) break } catch { /* fixture starting */ }
    if (Date.now() > deadline || server.exitCode !== null) throw new Error("Classification fixture server did not start")
    await Bun.sleep(100)
  }
  const endpoint = `${url}/api/rpc/ensemble-classification-fixture/run?location[directory]=${encodeURIComponent(root)}`
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ input: {} }), signal: AbortSignal.timeout(60_000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`Classification RPC failed (${response.status}): ${text}`)
  const result = JSON.parse(text) as { output: { checks: string[] } }
  console.log(JSON.stringify({ checks: result.output.checks, nativeChecks: result.output.checks.length, localModelRequests: requests }, null, 2))
} catch (error) {
  console.error(String(error))
  process.exitCode = 1
} finally {
  server.kill()
  await server.exited
  await provider.stop(true)
  if (process.exitCode) console.error((await stdout + await stderr).slice(-8000))
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => console.error(`Fixture retained at ${base}: ${String(error)}`))
}
