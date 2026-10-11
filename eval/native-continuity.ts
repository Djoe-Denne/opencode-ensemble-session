import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Real OpenCode server, native plugin context, Git worktrees and SQLite. Only the
// model's HTTP responses are deterministic fixtures; no session/history mocks.
const executable = process.env.OPENCODE_TEST_BIN ?? "opencode"
const temp = process.env.OPENCODE_TEST_TMP ?? (process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? tmpdir(), "Temp", "opencode") : tmpdir())
await mkdir(temp, { recursive: true })
const base = await mkdtemp(join(temp, "ensemble-native-"))
const root = join(base, "project")
await mkdir(root)
const git = async (...args: string[]) => {
  const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (await process.exited !== 0) throw new Error(await new Response(process.stderr).text())
}
const modelRequests: Array<{ model: string; kind: string; sessionID: string | null; directory: string; hasDelta: boolean }> = []
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { model: string; stream?: boolean; messages?: unknown[] }
  const kind = request.headers.get("x-ensemble-fixture-kind") ?? "primary"
  modelRequests.push({ model: body.model, kind, sessionID: request.headers.get("x-ensemble-fixture-session"), directory: decodeURIComponent(request.headers.get("x-ensemble-fixture-directory") ?? ""), hasDelta: request.headers.get("x-ensemble-fixture-delta") === "1" })
  // Canned model response to OpenCode's own summary prompt. The native engine
  // validates, persists and projects this checkpoint (including its recent tail).
  const text = kind === "compaction" ? [
    "## Objective", "- Exercise native continuity.", "## Requirements", "- Preserve source research.",
    "## Decisions", "- Use isolated teammates.", "## Work State", "### Completed", "- Shared research COMMON_A COMMON_B COMMON_C.",
    "### Active", "- Implementation.", "### Blocked", "- (none)", "## Next Move", "1. Continue the assigned task.",
    "## Relevant Files", "- (none)", "## Important Context", "- NATIVE_FIXTURE_SUMMARY: common research is complete.",
  ].join("\n") : "Fixture turn completed."
  const common = { id: `chatcmpl-${modelRequests.length}`, created: Math.floor(Date.now() / 1000), model: body.model }
  if (!body.stream) return Response.json({ ...common, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  const chunks = [
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ]
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
} })
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reserve.port!
await reserve.stop(true)
const url = `http://127.0.0.1:${port}`
await writeFile(join(root, "opencode.json"), JSON.stringify({
  model: "ensemble-fixture/worker",
  plugins: [resolve(dirname(fileURLToPath(import.meta.url)), "native-fixture")],
  providers: { "ensemble-fixture": { name: "Deterministic native test fixture", env: ["ENSEMBLE_FIXTURE_KEY"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${provider.url}v1` }, models: { scout: { name: "Fixture scout" }, architect: { name: "Fixture architect" }, worker: { name: "Fixture worker" } } } },
  agents: {
    explore: { model: "ensemble-fixture/scout", system: "NATIVE_SCOUT_SYSTEM" },
    plan: { model: "ensemble-fixture/architect", system: "NATIVE_ARCHITECT_SYSTEM" },
    build: { model: "ensemble-fixture/worker", system: "NATIVE_WORKER_SYSTEM" },
  },
}, null, 2))
await writeFile(join(root, ".gitignore"), ".opencode/\n")
await writeFile(join(root, "tracked.txt"), "fixture base\n")
await git("init")
await git("add", ".")
await git("-c", "user.name=Ensemble Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Native continuity fixture")
const server = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root, stdout: "pipe", stderr: "pipe",
  env: { ...process.env, XDG_CONFIG_HOME: join(base, "config"), XDG_DATA_HOME: join(base, "data"), XDG_CACHE_HOME: join(base, "cache"),
    OPENCODE_CONFIG: join(root, "opencode.json"), ENSEMBLE_FIXTURE_KEY: "fixture-only",
    OPENCODE_ENSEMBLE_V2_API_URL: url, ENSEMBLE_NATIVE_ROOT: root, ENSEMBLE_NATIVE_DB: join(base, "ensemble.db") },
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
    try { if (authorization && (await fetch(`${url}/api/info`, { headers: { authorization } })).ok) break } catch { /* server starting */ }
    if (Date.now() > deadline || server.exitCode !== null) throw new Error("Native server did not start")
    await Bun.sleep(100)
  }
  // Resolve the location, loading the fixture's native plugin/RPC.
  const endpoint = `${url}/api/rpc/ensemble-native-fixture/run?location[directory]=${encodeURIComponent(root)}`
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ input: { authorization } }), signal: AbortSignal.timeout(180_000) })
  const text = await response.text()
  if (!response.ok) {
    const plugins = await fetch(`${url}/api/plugin?location[directory]=${encodeURIComponent(root)}`, { headers: { authorization } })
    const list = await plugins.json() as { data: Array<{ id: string; state: { status: string } }> }
    throw new Error(`Native RPC failed (${response.status}): ${text}\nPlugins: ${JSON.stringify(list.data.filter(plugin => plugin.id.includes("fixture") || plugin.state.status !== "active"))}`)
  }
  const result = JSON.parse(text) as { output: { checks: string[]; workers: Array<{ sessionID: string; directory: string }>; failedForks: string[] } }
  for (const worker of result.output.workers) {
    const requests = modelRequests.filter(request => request.kind === "primary" && request.sessionID === worker.sessionID)
    if (!requests.length || requests.some(request => request.directory !== worker.directory || !request.hasDelta)) throw new Error(`Premature native execution: ${JSON.stringify(requests)}`)
  }
  result.output.checks.push("all three workers execute only after binding their worktree and admitting their task delta")
  if (modelRequests.some(request => result.output.failedForks.includes(request.sessionID ?? ""))) throw new Error("Failed fork executed a model before initialization completed")
  result.output.checks.push("failed forks never execute a model at the source directory")
  console.log(JSON.stringify({ nativeChecks: result.output.checks.length, checks: result.output.checks, modelRequests: modelRequests.length }, null, 2))
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
