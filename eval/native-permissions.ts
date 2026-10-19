import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, posix } from "node:path"

export type NativeRequest = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>
type Rule = { action: string; resource: string; effect: "allow" | "deny" }
type Probe = { name: string; action: string; resources: string[]; agent?: string }
type Group = { name: string; permissions?: Rule[]; probes: Probe[] }
type Observation = { group: string; probe: string; sessionID: string; request: Omit<Probe, "name">; outcome: string; status?: number; response?: unknown; at: string }
type Campaign = { stop: string | null; sessions: string[]; observations: Observation[]; readbacks: unknown[] }
type NativeCall = { method: string; path: string; status?: number; at: string }
type NativeHttpFetch = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "text">>

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const dataOf = (value: unknown) => record(record(value).data)
const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "")
const failureKind = (error: unknown) => ["TimeoutError", "AbortError"].includes(String(record(error).name)) ? "timeout" : "transport-error"

/** Fail closed unless live execution, worktree isolation and owned output are explicit. */
export function validateLiveArguments(args: string[], env: Record<string, string | undefined>, cwd: string): { root: string; output: string } {
  if (!args.includes("--live") || env.ENSEMBLE_SP1_APPROVED !== "1") throw new Error("SP-1 requires explicit --live and ENSEMBLE_SP1_APPROVED=1")
  const root = normalize(cwd)
  if (!root.includes("/worktree/") || !root.endsWith("-sp1-permissions")) throw new Error("SP-1 requires its isolated worktree")
  const output = args[args.indexOf("--output") + 1]
  if (!args.includes("--output") || !output?.startsWith("docs/plans/SP-1/") || output.includes("..") || output.includes("\\") || !output.endsWith(".json")) throw new Error("SP-1 output must be a new docs/plans/SP-1/*.json file")
  return { root, output: `${root}/${output}` }
}

/** Build the bounded native-only permission experiment, without executing it. */
export function buildPermissionPlan(directory: string): Group[] {
  const root = normalize(directory)
  const outside = `${posix.dirname(root)}/sp1-outside/docs/plans/sp1-probe.md`
  const probe = (name: string, resources: string[], agent: string | undefined = "architect"): Probe => ({ name, action: "edit", resources, ...(agent ? { agent } : {}) })
  const common = [
    probe("relative-docs", ["docs/plans/sp1-probe.md"]),
    probe("relative-src", ["src/sp1-probe.ts"]),
    probe("absolute-worktree-docs", [`${root}/docs/plans/sp1-probe.md`]),
    probe("absolute-outside-docs", [outside]),
    probe("windows-separators", [`${root}/docs/plans/sp1-probe.md`.replaceAll("/", "\\")]),
    // OQ-102: API resource strings are not evidence of real file-tool canonicalization.
    probe("relative-traversal-string", ["docs/plans/../../src/sp1-probe.ts"]),
    probe("multiple-resources", ["docs/plans/sp1-probe.md", "src/sp1-probe.ts"]),
    { name: "agent-omitted", action: "edit", resources: ["docs/plans/sp1-probe.md"] },
  ]
  const deny: Rule = { action: "edit", resource: "*", effect: "deny" }
  const relative: Rule = { action: "edit", resource: "docs/plans/**", effect: "allow" }
  return [
    { name: "allow-last", permissions: [deny, relative], probes: common },
    { name: "deny-last", permissions: [relative, deny], probes: common },
    { name: "architect-baseline", probes: [
      ...common,
      ...Array.from({ length: 5 }, () => probe("architect-identical", ["docs/plans/sp1-probe.md"])),
      ...Array.from({ length: 5 }, () => probe("architect-absolute-identical", [`${root}/docs/plans/sp1-probe.md`])),
      ...Array.from({ length: 5 }, () => probe("architect-deny-identical", ["src/sp1-probe.ts"])),
    ] },
    { name: "session-allow", permissions: [{ action: "edit", resource: "*", effect: "allow" }], probes: common },
    { name: "session-deny", permissions: [deny], probes: common },
    { name: "absolute-allow", permissions: [deny, { action: "edit", resource: `${root}/docs/plans/**`, effect: "allow" }], probes: common },
    { name: "outside-allow", permissions: [deny, { action: "edit", resource: `${posix.dirname(root)}/sp1-outside/**`, effect: "allow" }], probes: common },
  ]
}

/** Distinguish native policy decisions from ask and protocol/HTTP failures. */
export function classifyPermissionResponse(status: number, body: unknown): string {
  if (status !== 200) return "http-error"
  // OQ-101: the public result must have data.id/effect; incompatible hosts stop, never deny.
  const data = dataOf(body)
  if (typeof data.id !== "string" || typeof data.effect !== "string") return "protocol-error"
  return ["allow", "deny", "ask"].includes(data.effect) ? data.effect : "protocol-error"
}

/** Parse a permission response without confusing malformed JSON with transport failure. */
export function parsePermissionHttpResponse(status: number, text: string): { status: number; body: unknown } {
  try {
    const body: unknown = JSON.parse(text)
    return { status, body }
  } catch {
    return { status, body: text }
  }
}

/** Validate an explicit public endpoint without service discovery or process startup. */
export function validateNativeEndpoint(args: string[], env: Record<string, string | undefined>): { url: string; pid: number; authorization?: string } {
  const argument = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  const value = argument("--service-url")
  if (!value) throw new Error("SP-1 requires an explicit public --service-url service URL")
  const parsed = (() => {
    try { return new URL(value) }
    catch { return undefined }
  })()
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("SP-1 requires a loopback service URL")
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("SP-1 requires a root service URL without embedded credentials, query or fragment")
  }
  const pid = Number(argument("--service-pid"))
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("SP-1 requires an explicit positive service PID via --service-pid")
  const password = env.ENSEMBLE_SP1_PASSWORD
  return {
    url: parsed.origin,
    pid,
    ...(password !== undefined ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}),
  }
}

/** Reject a different host version or process before a live campaign can create sessions. */
export function assertNativeHostIdentity(info: unknown, pid: number): void {
  const data = record(info)
  if (data.version !== "2.0.32") throw new Error("SP-1 requires reapproval for a different native host version")
  if (data.pid !== pid) throw new Error("SP-1 native host PID differs from the explicitly approved process")
}

/** Build the live allowlisted transport with an injectable HTTP boundary for offline tests. */
export function createPermissionTransport(options: { root: string; url: string; authorization?: string; calls?: NativeCall[] }, transport: NativeHttpFetch): NativeRequest {
  const { root, url, authorization } = options
  const calls = options.calls ?? []
  const owned = new Set<string>()
  return async (method, path, body) => {
    const read = method === "GET" && ["/api/info", "/openapi.json", "/api/config", "/api/agent/architect", ...Array.from(owned, (id) => `/api/session/${id}`)].includes(path)
    const write = method === "POST" && (path === "/api/session" || Array.from(owned).some((id) => path === `/api/session/${id}/permission`))
    if (!read && !write) throw new Error("SP-1 refused an unowned or unapproved endpoint")
    const call: NativeCall = { method, path, at: new Date().toISOString() }
    calls.push(call)
    const response = await transport(`${url}${path}?location[directory]=${encodeURIComponent(root)}`, {
      method, redirect: "manual",
      headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5_000),
    })
    call.status = response.status
    if (response.status >= 300 && response.status < 400) {
      return { status: response.status, body: { error: "redirect-refused" } }
    }
    const parsed = parsePermissionHttpResponse(response.status, await response.text())
    if (path === "/api/session" && method === "POST" && response.status === 200) {
      const id = dataOf(parsed.body).id
      if (typeof id === "string") owned.add(id)
    }
    return parsed
  }
}

/** Execute only the supplied scratch-session plan, never prompts or aborts. */
export async function runPermissionPlan(request: NativeRequest, root: string, runID: string, plan: Group[], checkpoint: (state: Campaign) => Promise<void> = async () => {}): Promise<Campaign> {
  if (plan.length > 12 || plan.flatMap((group) => group.probes).length > 120) throw new Error("SP-1 campaign limit exceeded")
  const state: Campaign = { stop: null, sessions: [], observations: [], readbacks: [] }
  const deadline = Date.now() + 300_000
  await plan.reduce(async (previous, group) => {
    await previous
    if (state.stop) return
    if (Date.now() >= deadline) { state.stop = "deadline"; return }
    try {
      const created = await request("POST", "/api/session", {
        title: `ENSEMBLE_SP1_${runID}_${group.name}`, agent: "architect", location: { directory: root },
        metadata: { "ensemble.sp1": { runID, group: group.name, scratch: true } },
        ...(group.permissions ? { permissions: group.permissions } : {}),
      })
      const id = dataOf(created.body).id
      if (created.status !== 200 || typeof id !== "string") { state.stop = "create-error"; return }
      state.sessions.push(id)
      await checkpoint(state)
      const readback = await request("GET", `/api/session/${id}`)
      const info = dataOf(readback.body)
      state.readbacks.push({ group: group.name, status: readback.status, body: readback.body })
      if (readback.status !== 200 || info.id !== id || info.agent !== "architect" || normalize(String(record(info.location).directory)) !== normalize(root)) {
        state.stop = "location-mismatch"
        return
      }
      await group.probes.reduce(async (prior, probe) => {
        await prior
        if (state.stop) return
        if (Date.now() >= deadline) { state.stop = "deadline"; return }
        const { name, ...body } = probe
        const observation: Observation = { group: group.name, probe: name, sessionID: id, request: body, outcome: "transport-error", at: new Date().toISOString() }
        try {
          const response = await request("POST", `/api/session/${id}/permission`, body)
          Object.assign(observation, { status: response.status, response: response.body, outcome: classifyPermissionResponse(response.status, response.body) })
        } catch (error) { observation.outcome = failureKind(error) }
        state.observations.push(observation)
        if (!["allow", "deny"].includes(observation.outcome)) state.stop = observation.outcome
        await checkpoint(state)
      }, Promise.resolve())
    } catch (error) { state.stop = failureKind(error) }
    await checkpoint(state)
  }, Promise.resolve())
  return state
}

const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")

async function live(): Promise<void> {
  const args = process.argv.slice(2)
  const { root, output } = validateLiveArguments(args, process.env, process.cwd())
  const { url, pid, authorization } = validateNativeEndpoint(args, process.env)
  if (await Bun.file(output).exists()) throw new Error("SP-1 refuses to overwrite native evidence")
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root })
    if (result.exitCode !== 0) throw new Error("SP-1 git preflight failed")
    return result.stdout.toString().trim()
  }
  const head = git(["rev-parse", "HEAD"])
  const branch = git(["branch", "--show-current"])
  if (!branch.endsWith("-sp1-permissions") || normalize(git(["rev-parse", "--show-toplevel"])) !== root) throw new Error("SP-1 git/worktree mismatch")
  git(["merge-base", "--is-ancestor", "e446c88003c43be7b7848835a6d79953b3460d25", "HEAD"])
  const calls: NativeCall[] = []
  const request = createPermissionTransport({ root, url, ...(authorization ? { authorization } : {}), calls }, fetch)
  const requireGet = async (path: string) => {
    const response = await request("GET", path)
    if (response.status !== 200) throw new Error(`SP-1 GET failed: ${path} HTTP ${response.status}`)
    return response.body
  }
  const info = await requireGet("/api/info")
  assertNativeHostIdentity(info, pid)
  const spec = record(await requireGet("/openapi.json"))
  const paths = record(spec.paths)
  const configBefore = hash(await requireGet("/api/config"))
  const agentBefore = await requireGet("/api/agent/architect")
  const agentHash = hash(agentBefore)
  const agent = dataOf(agentBefore)
  if (agent.id !== "architect" || !Array.isArray(agent.permissions)) throw new Error("SP-1 architect preflight failed")
  const sdkPath = `${root}/node_modules/@opencode/plugin/dist/promise/permission.d.ts`
  const sdk = await Bun.file(sdkPath).text()
  const runID = new Date().toISOString().replaceAll(":", "-")
  const scratch = `${root}/.opencode/sp1-permissions-${runID}`
  await mkdir(scratch, { recursive: true })
  const plan = buildPermissionPlan(root)
  const proof = {
    kind: "SP-1-native-permissions", startedAt: new Date().toISOString(), finishedAt: "", root, head, branch, url, info,
    configBefore, configAfter: "", agentHashBefore: agentHash, agentHashAfter: "", agentPermissions: agent.permissions,
    sdk: { path: sdkPath, sha256: hash(sdk), evaluation: sdk.split("\n").filter((line) => /PermissionEvaluation|readonly (sessionID|agent|action|resources|metadata|source)|effect:|evaluate:/.test(line)) },
    openapi: { sha256: hash(spec), permissionCreate: record(paths["/api/session/{sessionID}/permission"]).post, sessionUpdate: record(paths["/api/session/{sessionID}"]).patch },
    runID, plan, calls, campaign: null as Campaign | null, finalSessions: [] as unknown[],
    cleanup: "retained-scratch-sessions; cleanup-not-supported; inspect finalSessions for native state; no archive/abort/remove/saved/global changes",
    limitations: ["No inference, prompt or Code Mode execution authorized", "SDK resources[] is a type contract, not an observed hook event", "String-only permission requests do not demonstrate actual file-tool normalization or confinement"],
  }
  const checkpoint = async (campaign: Campaign) => { await Bun.write(`${scratch}/manifest.json`, JSON.stringify({ ...proof, campaign }, null, 2)) }
  proof.campaign = await runPermissionPlan(request, root, runID, plan, checkpoint)
  await proof.campaign.sessions.reduce(async (previous, id) => {
    await previous
    try { proof.finalSessions.push({ sessionID: id, readback: await request("GET", `/api/session/${id}`), at: new Date().toISOString() }) }
    catch (error) { proof.finalSessions.push({ sessionID: id, outcome: failureKind(error) }) }
  }, Promise.resolve())
  try {
    proof.configAfter = hash(await requireGet("/api/config"))
    proof.agentHashAfter = hash(await requireGet("/api/agent/architect"))
    if (proof.configBefore !== proof.configAfter || proof.agentHashBefore !== proof.agentHashAfter) proof.campaign.stop ??= "context-changed"
  } catch { proof.campaign.stop ??= "postflight-transport-error" }
  proof.finishedAt = new Date().toISOString()
  await checkpoint(proof.campaign)
  await mkdir(dirname(output), { recursive: true })
  await Bun.write(output, `${JSON.stringify(proof, null, 2)}\n`)
  console.log(JSON.stringify({ output, manifest: `${scratch}/manifest.json`, sessions: proof.campaign.sessions.length, permissionRequests: proof.campaign.observations.length, stop: proof.campaign.stop, outcomes: proof.campaign.observations.reduce<Record<string, number>>((totals, observation) => ({ ...totals, [observation.outcome]: (totals[observation.outcome] ?? 0) + 1 }), {}) }, null, 2))
  if (proof.campaign.stop) process.exitCode = 1
}

if (import.meta.main) {
  live().catch(() => { console.error("SP-1 stopped: preflight or evidence failure; inspect the owned manifest, no retry was attempted"); process.exitCode = 1 })
}
