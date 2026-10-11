import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { basename, join } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { setupEnsemble, type V2SetupContext } from "../../src/v2-setup"
import { createV2Client, type V2Context } from "../../src/v2-client"
import { DEFAULT_CONFIG } from "../../src/config"
import { PendingPurgeApprovals, MemberRegistry } from "../../src/state"
import { createDb } from "../../src/db"
import { rehydrateRegistry } from "../../src/recovery"
import { ProgressTracker } from "../../src/progress"
import { executeTeamCreate } from "../../src/tools/team-create"
import { executeTeamSpawn } from "../../src/tools/team-spawn"
import { executeTeamHandoff } from "../../src/tools/team-handoff"
import { executeTeamTasksAdd } from "../../src/tools/team-tasks-add"
import { executeTeamShutdown } from "../../src/tools/team-shutdown"
import { executeTeamMerge } from "../../src/tools/team-merge"
import { recoverSessionContinuity } from "../../src/session-continuity"
import { runCommand } from "../../src/process"
import { initLog } from "../../src/log"
import type { ToolDeps } from "../../src/types"

const contract = Rpc.define({ id: "ensemble-native-fixture", methods: {
  run: { input: { type: "object", properties: { authorization: { type: "string" } }, required: ["authorization"], additionalProperties: false }, output: { type: "object", properties: {
    checks: { type: "array", items: { type: "string" } },
    workers: { type: "array", items: { type: "object", properties: { sessionID: { type: "string" }, directory: { type: "string" } }, required: ["sessionID", "directory"] } },
    failedForks: { type: "array", items: { type: "string" } },
  }, required: ["checks", "workers", "failedForks"] } },
}, events: {} })

export default Plugin.define({
  id: "ensemble-native-fixture",
  async setup(ctx) {
    const root = process.env.ENSEMBLE_NATIVE_ROOT
    const dbPath = process.env.ENSEMBLE_NATIVE_DB
    if (!root || !dbPath) throw new Error("This fixture must be launched by eval/native-continuity.ts")
    const native = ctx as unknown as V2Context
    initLog({ app: { log: async ({ message }: { message: string }) => { console.log(message) } } })
    const handle = await setupEnsemble(ctx as unknown as V2SetupContext, { dbPath, dashboardPort: 0 })
    const deps: ToolDeps = { db: handle.db, registry: handle.registry, tracker: handle.tracker,
      purgeApprovals: new PendingPurgeApprovals(), progressTracker: new ProgressTracker(),
      directory: root, config: { ...DEFAULT_CONFIG }, client: createV2Client(native, { apiUrl: process.env.OPENCODE_ENSEMBLE_V2_API_URL }) }
    const turns: Array<{ sessionID: string; agent: string; model: string; system: string }> = []
    const hasDelta = new Map<string, boolean>()
    await ctx.session.hook("context", event => {
      turns.push({ sessionID: event.sessionID, agent: event.agent, model: event.model.id, system: JSON.stringify(event.system) })
      hasDelta.set(event.sessionID, JSON.stringify(event.messages).includes("DELTA_"))
    })
    await ctx.session.hook("model.request", event => {
      event.headers["x-ensemble-fixture-kind"] = event.kind
      event.headers["x-ensemble-fixture-session"] = event.sessionID
      event.headers["x-ensemble-fixture-directory"] = encodeURIComponent(ctx.location.directory)
      event.headers["x-ensemble-fixture-delta"] = hasDelta.get(event.sessionID) ? "1" : "0"
    })
    // A real Git strategy registered through the public plugin API; no mocked worktrees.
    await ctx.worktree.transform(editor => editor.add({
      id: "ensemble-native-test-git",
      async create(input) {
        const branch = `fixture-${basename(input.directory)}`
        const result = await runCommand(["git", "worktree", "add", "-b", branch, input.directory, input.branch ?? "HEAD"], { cwd: input.sourceDirectory })
        if (result.exitCode !== 0) throw new Error(result.stderr)
        return { directory: input.directory }
      },
      async remove(input) {
        const branch = await runCommand(["git", "branch", "--show-current"], { cwd: input.directory })
        const result = await runCommand(["git", "worktree", "remove", input.directory], { cwd: root })
        if (result.exitCode !== 0) throw new Error(result.stderr)
        if (branch.stdout.trim().startsWith("fixture-")) await runCommand(["git", "branch", "-D", branch.stdout.trim()], { cwd: root })
      },
      async list() { return [{ directory: root, type: "root" as const }] },
    }))
    await ctx.rpc.register(contract, { run: async input => {
      if (!input || typeof input !== "object" || !("authorization" in input) || typeof input.authorization !== "string") {
        throw new Error("Native fixture requires an authorization header")
      }
      const authorization = input.authorization
      deps.client = createV2Client(native, { apiUrl: process.env.OPENCODE_ENSEMBLE_V2_API_URL, authorization })
      const admissions = new Map<string, Promise<unknown>>()
      const promptAsync = deps.client.session.promptAsync
      deps.client.session.promptAsync = options => {
        const admitted = promptAsync(options)
        admissions.set(options.sessionID, admitted)
        return admitted
      }
      const checks: string[] = []
      const check = (name: string, value: unknown) => { if (!value) throw new Error(`Native continuity check failed: ${name}`); checks.push(name) }
      const sessionIDs = new Set<string>()
      const worktrees = new Set<string>()
      const workers: Array<{ sessionID: string; directory: string }> = []
      const failedForks: string[] = []
      const nativeFork = deps.client.continuity!.fork
      let lastFork = ""
      deps.client.continuity!.fork = async input => {
        const child = await nativeFork(input)
        lastFork = child.id
        sessionIDs.add(child.id)
        return child
      }
      const history = async (id: string) => JSON.stringify(await native.session.context({ sessionID: id }))
      const wait = async (id: string) => {
        // Observe admission in the harness; the production spawn remains fire-and-forget.
        await admissions.get(id)
        await native.session.wait!({ sessionID: id }, { signal: AbortSignal.timeout(30_000) })
      }
      const member = (name: string) => {
        const row = deps.db.query("SELECT session_id, worktree_dir FROM team_member WHERE name = ?").get(name) as { session_id: string; worktree_dir: string | null }
        if (!row) throw new Error(`Missing native teammate ${name}`)
        sessionIDs.add(row.session_id)
        if (row.worktree_dir) worktrees.add(row.worktree_dir)
        return row
      }
      let leadID = ""
      try {
        const lead = await native.session.create({ agent: "build", title: "Ensemble native fixture lead", location: { directory: root } })
        leadID = lead.id
        sessionIDs.add(lead.id)
        await executeTeamCreate(deps, { name: "native-continuity" }, lead.id)
        await executeTeamSpawn(deps, { name: "scout", agent: "explore", worktree: false, prompt: "COMMON_A" }, lead.id)
        const scout = member("scout").session_id
        await wait(scout)
        for (const text of ["COMMON_B", "COMMON_C"]) { await native.session.prompt({ sessionID: scout, text }); await wait(scout) }
        check("fresh scout completed real native turns", (await history(scout)).includes("COMMON_C"))
        const selectedModel = turns.at(-1)?.model
        await executeTeamHandoff(deps, { agent: "plan" }, scout)
        await native.session.prompt({ sessionID: scout, text: "ARCHITECT_D" })
        await wait(scout)
        check("handoff keeps session and subsequent native turn uses plan", turns.some(turn => turn.sessionID === scout && turn.agent === "plan"))
        check("handoff applies target system prompt and preserves native selected-model semantics", turns.some(turn => turn.sessionID === scout && turn.agent === "plan" && turn.model === selectedModel && turn.system.includes("NATIVE_ARCHITECT_SYSTEM")))
        await native.session.prompt({ sessionID: scout, text: "ARCHITECT_E" })
        await wait(scout)
        const sourceContext = await native.session.context({ sessionID: scout }) as Array<{ id: string; type: string }>
        const boundary = sourceContext.find(message => message.type === "user" && JSON.stringify(message).includes("ARCHITECT_D"))?.id
        check("native checkpoint message exists", boundary)
        await executeTeamTasksAdd(deps, { tasks: ["parser", "renderer", "tests"].map(content => ({ content, priority: "medium" })) }, lead.id)
        const tasks = deps.db.query("SELECT id, content FROM team_task").all() as Array<{ id: string; content: string }>
        for (const task of tasks) {
          await executeTeamSpawn(deps, { name: task.content, agent: "build", prompt: `DELTA_${task.content}`, claim_task: task.id, context: { mode: "fork", from: "scout" } }, lead.id)
          const child = member(task.content)
          await wait(child.session_id)
          const text = await history(child.session_id)
          const info = await native.session.get({ sessionID: child.session_id }) as { agent: string; location: { directory: string }; fork?: { sessionID: string } }
          check(`${task.content}: projected A/B/C/D/E inherited`, ["COMMON_A", "COMMON_B", "COMMON_C", "ARCHITECT_D", "ARCHITECT_E"].every(token => text.includes(token)))
          check(`${task.content}: task delta appended`, text.includes(`DELTA_${task.content}`))
          check(`${task.content}: native agent and source relationship`, info.agent === "build" && info.fork?.sessionID === scout)
          check(`${task.content}: actual worktree directory binding`, info.location.directory === child.worktree_dir)
          workers.push({ sessionID: child.session_id, directory: child.worktree_dir! })
        }
        check("three different native sessions/worktrees", sessionIDs.size === 5 && worktrees.size === 3)
        const parser = member("parser").session_id
        await native.session.prompt({ sessionID: parser, text: "ONLY_PARSER_LATER" })
        await wait(parser)
        check("subsequent histories are independent", !(await history(scout)).includes("ONLY_PARSER_LATER") && !(await history(member("renderer").session_id)).includes("ONLY_PARSER_LATER"))
        await executeTeamSpawn(deps, { name: "checkpoint", agent: "build", prompt: "CHECKPOINT_DELTA", context: { mode: "checkpoint", from: "scout", messageID: boundary } }, lead.id)
        const checkpoint = member("checkpoint").session_id
        await wait(checkpoint)
        const bounded = await history(checkpoint)
        check("checkpoint includes C and excludes native before=D and later E", bounded.includes("COMMON_C") && !bounded.includes("ARCHITECT_D") && !bounded.includes("ARCHITECT_E"))
        await executeTeamSpawn(deps, { name: "reviewer", agent: "explore", worktree: false, prompt: "INDEPENDENT_REVIEW", context: { mode: "fresh" } }, lead.id)
        const reviewer = member("reviewer").session_id
        await wait(reviewer)
        check("fresh reviewer has no source history", !(await history(reviewer)).includes("COMMON_A"))
        await executeTeamSpawn(deps, { name: "compact", agent: "build", prompt: "COMPACT_DELTA", context: { mode: "compact_fork", from: "scout" } }, lead.id)
        const compact = member("compact").session_id
        await wait(compact)
        const compacted = await native.session.context({ sessionID: compact }) as Array<{ type: string; status?: string; summary?: string; recent?: string }>
        const durable = compacted.find(message => message.type === "compaction" && message.status === "completed")
        check("durable native compaction inherited including native recent context", durable?.summary?.includes("NATIVE_FIXTURE_SUMMARY") && typeof durable.recent === "string")
        // Simulate losing the admission ACK and reopening Ensemble's SQLite state.
        deps.db.run("UPDATE team_member SET spawn_pending = 1 WHERE name = 'compact'")
        const reopened = createDb(dbPath)
        try {
          const restarted = { ...deps, db: reopened, registry: new MemberRegistry() }
          await recoverSessionContinuity(restarted)
          rehydrateRegistry(reopened, restarted.registry)
          check("SQLite reopen/recovery adopts admitted worker and retains provenance", restarted.registry.getBySession(compact)?.memberName === "compact" && (reopened.query("SELECT source_session_id FROM team_member WHERE name = 'compact'").get() as { source_session_id: string }).source_session_id === scout)
        } finally { reopened.close() }
        deps.db.run("UPDATE team_member SET status = 'shutdown' WHERE name = 'scout'")
        await executeTeamSpawn(deps, { name: "finished-source", agent: "build", prompt: "FINISHED_SOURCE_DELTA", context: { mode: "fork", from: "scout" } }, lead.id)
        const finished = member("finished-source").session_id
        await wait(finished)
        check("finished member still supplies persisted native history", (await history(finished)).includes("NATIVE_FIXTURE_SUMMARY"))
        let invalidCheckpoint = false
        try { await executeTeamSpawn(deps, { name: "invalid-checkpoint", agent: "build", prompt: "must fail", context: { mode: "checkpoint", from: "scout", messageID: "msg_missing" } }, lead.id) }
        catch { invalidCheckpoint = true }
        check("nonexistent native checkpoint fails explicitly", invalidCheckpoint)
        const tracked = join(root, "tracked.txt")
        const original = await readFile(tracked, "utf8")
        await writeFile(tracked, "SOURCE_DIRTY_DO_NOT_TRANSFER")
        try {
          const before = await runCommand(["git", "worktree", "list", "--porcelain"], { cwd: root })
          let rejected = false
          try { await executeTeamSpawn(deps, { name: "dirty", agent: "build", prompt: "must fail", context: { mode: "fork", from: "scout" } }, lead.id) }
          catch (error) { rejected = String(error).includes("Non-transferable") }
          check("dirty source is rejected explicitly and remains untouched", rejected && await readFile(tracked, "utf8") === "SOURCE_DIRTY_DO_NOT_TRANSFER")
          check("failed native move leaves no registered teammate", !deps.db.query("SELECT name FROM team_member WHERE name = 'dirty'").get())
          const after = await runCommand(["git", "worktree", "list", "--porcelain"], { cwd: root })
          let removed = false
          try { await native.session.get({ sessionID: lastFork }) } catch { removed = true }
          check("failed spawn leaves no native session or Git worktree orphan", removed && before.stdout === after.stdout)
          failedForks.push(lastFork)
        } finally { await writeFile(tracked, original) }
        const parserDirectory = member("parser").worktree_dir!
        await writeFile(join(parserDirectory, "tracked.txt"), "committed source-only change")
        await runCommand(["git", "add", "tracked.txt"], { cwd: parserDirectory })
        await runCommand(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "source-only commit"], { cwd: parserDirectory })
        let divergent = false
        try { await executeTeamSpawn(deps, { name: "divergent", agent: "build", prompt: "must fail", context: { mode: "fork", from: "parser" } }, lead.id) }
        catch (error) { divergent = String(error).includes("different commits") }
        check("unmerged teammate branch is not silently copied or omitted", divergent)
        failedForks.push(lastFork)
        await executeTeamShutdown(deps, { member: "parser", force: true }, lead.id)
        const preserved = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'parser'").get() as { worktree_branch: string }).worktree_branch
        check("existing shutdown preserves inherited worker's committed branch", preserved.startsWith("ensemble/preserved/") && (await runCommand(["git", "show-ref", "--verify", `refs/heads/${preserved}`], { cwd: root })).exitCode === 0)
        await executeTeamMerge(deps, { member: "parser" }, lead.id)
        check("existing team_merge integrates the inherited worker's commit", await readFile(tracked, "utf8") === "committed source-only change")
        return { checks, workers, failedForks }
      } catch (error) {
        console.error(`Native fixture failed after ${checks.length} checks: ${error instanceof Error ? error.stack : String(error)}`)
        console.error(JSON.stringify(error))
        console.error("Native turns: " + JSON.stringify(turns.map(turn => ({ agent: turn.agent, model: turn.model, architectSystem: turn.system.includes("NATIVE_ARCHITECT_SYSTEM") }))))
        const failedCompaction = /Native compaction (msg_\w+)/.exec(String(error))?.[1]
        if (failedCompaction) {
          const scout = member("scout").session_id
          console.error("Compaction context: " + JSON.stringify((await native.session.context({ sessionID: scout })).map(message => {
            const item = message as Record<string, unknown>
            return { id: item.id, type: item.type, status: item.status }
          })))
          const response = await fetch(`${process.env.OPENCODE_ENSEMBLE_V2_API_URL}/api/session/${scout}/message/${failedCompaction}`, { headers: { authorization } })
          console.error("Compaction record: " + await response.text())
        }
        throw error
      } finally {
        // Forks are related by fork.sessionID, not parentID: remove each owned child explicitly.
        for (const sessionID of [...sessionIDs].reverse()) await native.session.remove!({ sessionID }).catch(() => undefined)
        for (const directory of worktrees) await deps.client.worktree.remove({ worktreeRemoveInput: { directory } }).catch(() => undefined)
        if (leadID) deps.db.run("UPDATE team SET status = 'archived' WHERE lead_session_id = ?", [leadID])
      }
    } })
    return async () => { await handle.dispose(); handle.db.close() }
  },
})
