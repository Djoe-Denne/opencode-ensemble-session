import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { invokeNativeClassifier, invokeNativeGeneralClassifier, removeNativeClassificationHelper, type V2ClassificationContext } from "../../src/v2-classification"
import { normalizeGeneralClassification } from "../../src/classification-adapters"
import { buildJevClassificationInput, discoverJevTool, normalizeJevClassification } from "../../src/classification-protocol"
import { createDb } from "../../src/db"
import { createV2Client } from "../../src/v2-client"
import { DEFAULT_CONFIG } from "../../src/config"
import { MemberRegistry, DescendantTracker, PendingPurgeApprovals } from "../../src/state"
import { ProgressTracker } from "../../src/progress"
import { executeTeamCreate } from "../../src/tools/team-create"
import { executeTeamTasksAdd } from "../../src/tools/team-tasks-add"
import { classifyBoardTasks } from "../../src/board-classification"
import { claimTask } from "../../src/tools/team-claim"
import type { ToolDeps } from "../../src/types"

const contract = Rpc.define({ id: "ensemble-classification-fixture", methods: {
  run: { input: { type: "object", properties: {}, additionalProperties: false }, output: {
    type: "object", properties: { checks: { type: "array", items: { type: "string" } } }, required: ["checks"],
  } },
}, events: {} })

export default Plugin.define({
  id: "ensemble-classification-fixture",
  async setup(ctx) {
    if (!process.env.ENSEMBLE_CLASSIFICATION_FIXTURE) throw new Error("Launch this fixture through eval/native-classification.ts")
    let invocations = 0
    let forbiddenInvocations = 0
    let codeModeInvocations = 0
    let codeModeInput: unknown
    await ctx.tool.transform(editor => {
      editor.add({ name: "fixture_jev_ask", description: "Deterministic JEV contract fixture", options: { codemode: false },
        input: { type: "object", properties: { state: {}, questions: { type: "object" } }, required: ["state", "questions"] },
        execute: async input => {
          invocations++
          if (JSON.stringify(input).includes("NATIVE_BACKEND_GONE")) throw new Error("Fixture JEV backend disappeared")
          return { content: JSON.stringify({ model: "jev-fixture", answers: {
            complexity: { type: "score", score: 0.481, confidence: 0.02 },
            risk: { type: "score", score: 0.972, confidence: 0.94 },
          } }) }
        },
      })
      editor.add({ name: "fixture_forbidden", description: "Must never execute inside the classifier", options: { codemode: false },
        input: { type: "object", properties: {} }, execute: async () => { forbiddenInvocations++; return { content: "unsafe" } },
      })
      editor.add({ name: "fixture_classify_x86", description: "Specialized x86 contract fixture", options: { codemode: false },
        input: { type: "object", properties: { assembly: { type: "string" }, architecture: { type: "string", enum: ["x86-32", "x86-64"] } }, required: ["assembly", "architecture"] },
        execute: async () => ({ content: JSON.stringify({ complexity: 42, uncertainty: 23, model: "x86-fixture" }) }),
      })
    })
    await ctx.rpc.register(contract, { run: async () => {
      const checks: string[] = []
      const check = (label: string, valid: boolean) => { if (!valid) { console.error(`Classification spike failed: ${label}`); throw new Error(`Classification spike failed: ${label}`) } checks.push(label) }
      const native = ctx as unknown as V2ClassificationContext
      const tool = discoverJevTool(await ctx.tool.list())
      check("public discovery finds the effective JEV tool contract", tool?.id.endsWith("fixture_jev_ask") === true)
      const sessions = new Set<string>()
      const created = await ctx.session.hook("context", event => { if (event.model.providerID === "classification-fixture") sessions.add(event.sessionID) })
      try {
        if (!tool) throw new Error("Missing native fixture tool")
        const request = { directory: ctx.location.directory, toolId: tool.id, model: "classification-fixture/worker", timeoutMs: 10_000 }
        const raw = await invokeNativeClassifier(native, { ...request, input: buildJevClassificationInput({ content: "NATIVE_ALLOWED" }) })
        const parsed = normalizeJevClassification(raw)
        check("native execution returns unrounded 0..1 scores", parsed.complexity === 0.481 && parsed.risk === 0.972)
        check("the native classifier tool executes exactly once", invocations === 1)
        let denied = false
        try { await invokeNativeClassifier(native, { ...request, input: buildJevClassificationInput({ content: "NATIVE_DENIED" }) }) }
        catch { denied = true }
        check("an unrelated tool cannot execute through the native permission pipeline", denied && forbiddenInvocations === 0)
        let evidenceRequired = false
        try { await invokeNativeClassifier(native, { ...request, input: buildJevClassificationInput({ content: "NATIVE_NO_CALL" }) }) }
        catch { evidenceRequired = true }
        check("model-authored classification without a real call is rejected", evidenceRequired && invocations === 1)
        const gone = await Promise.all([...sessions].map(async sessionID => {
          try { await ctx.session.get({ sessionID }); return false } catch { return true }
        }))
        check("all three transient helper sessions are removed", sessions.size === 3 && gone.every(Boolean))
        await ctx.tool.transform(editor => editor.add({ name: "codemode_jev_ask", description: "Code Mode JEV classification fixture", options: { codemode: true },
          input: { type: "object", properties: { state: {}, questions: { type: "object" } }, required: ["state", "questions"] },
          execute: async input => { codeModeInvocations++; codeModeInput = input; return { content: JSON.stringify({ model: "jev-fixture", answers: { complexity: { type: "score", score: 0.481 }, risk: { type: "score", score: 0.972 } } }) } },
        }))
        const codeModeTool = discoverJevTool(await ctx.tool.list(), "codemode_jev_ask")
        if (!codeModeTool) throw new Error("Missing Code Mode fixture tool")
        const dispatchTrace: unknown[] = []
        const dispatchObserver = await ctx.tool.hook("execute.after", event => {
          if (event.tool === "execute") dispatchTrace.push({ input: event.input, status: event.status, ...(event.status === "completed" ? { result: event.result } : { error: event.error }) })
        })
        const codeModeRaw = await invokeNativeClassifier(native, { ...request, toolId: codeModeTool.id, input: buildJevClassificationInput({ content: "NATIVE_CODEMODE" }) }).catch(error => {
          console.error(`Native dispatcher trace: ${JSON.stringify(dispatchTrace)}`)
          throw error
        }).finally(() => dispatchObserver.dispose())
        check("Code Mode discovery and nested execution provide native tool evidence", codeModeInvocations === 1 && normalizeJevClassification(codeModeRaw).complexity === 0.481)
        check("a single native dispatcher rewrites model-authored JavaScript before execution", dispatchTrace.length === 1 && !JSON.stringify(dispatchTrace).includes("MODEL_AUTHORED_CODE_EXECUTED"))
        check("the native Code Mode classifier receives its approved payload from the bridge", JSON.stringify(codeModeInput) === JSON.stringify(buildJevClassificationInput({ content: "NATIVE_CODEMODE" })))
        checks.push("completed native dispatch does not wait for a stalled helper continuation")
        const codeModeSession = [...sessions].at(-1)
        let removed = false
        try { await ctx.session.get({ sessionID: codeModeSession! }) } catch { removed = true }
        check("the Code Mode helper is cleaned up", removed)
        await removeNativeClassificationHelper(native, codeModeSession!)
        checks.push("helper removal is idempotent when the resource is already absent")
        const generalRaw = await invokeNativeGeneralClassifier(native, { directory: ctx.location.directory, model: request.model, input: buildJevClassificationInput({ content: "NATIVE_GENERAL" }), timeoutMs: 10_000 })
        const generalResult = normalizeGeneralClassification(generalRaw, request.model)
        check("embedded general classification returns normalized scores on the explicitly selected model", generalResult.complexity === 0.48123 && generalResult.risk === 0.97234)
        let generalDenied = false
        try { await invokeNativeGeneralClassifier(native, { directory: ctx.location.directory, model: request.model, input: buildJevClassificationInput({ content: "NATIVE_GENERAL_DENIED" }), timeoutMs: 10_000 }) } catch { generalDenied = true }
        check("embedded general sessions cannot execute tools", generalDenied && forbiddenInvocations === 0)
        const db = createDb(":memory:")
        const lead = await ctx.session.create({ title: "Classification board fixture", location: { directory: ctx.location.directory } })
        try {
          const deps: ToolDeps = { db, registry: new MemberRegistry(), tracker: new DescendantTracker(), purgeApprovals: new PendingPurgeApprovals(), progressTracker: new ProgressTracker(),
            directory: ctx.location.directory, client: createV2Client(native), config: { ...DEFAULT_CONFIG, classification: { ...DEFAULT_CONFIG.classification, helperModel: request.model, toolId: codeModeTool.id } },
            classifier: { list: () => ctx.tool.list(), invoke: input => invokeNativeClassifier(native, input), general: input => invokeNativeGeneralClassifier(native, input) } }
          await executeTeamCreate(deps, { name: "native-classification" }, lead.id)
          await executeTeamTasksAdd(deps, { tasks: [{ content: "NATIVE_CODEMODE", priority: "medium" }] }, lead.id)
          await classifyBoardTasks(deps, (db.query("SELECT id FROM team").get() as { id: string }).id)
          const task = db.query("SELECT * FROM team_task").get() as { id: string; team_id: string; classification_status: string; classification_result: string }
          const scored = JSON.parse(task.classification_result) as { complexity: number; risk: number }
          check("board classification persists native Code Mode scores without a percentage conversion", task.classification_status === "completed" && scored.complexity === 0.481 && scored.risk === 0.972)
          check("classified board tasks become atomically claimable", claimTask(db, task.team_id, task.id, "fixture-worker") === "NATIVE_CODEMODE")
          const fallbackLead = await ctx.session.create({ title: "Fallback fixture", location: { directory: ctx.location.directory } })
          try {
            await executeTeamCreate(deps, { name: "fallback-mission", mission_mode: "long_run", classification: { mode: "jev", toolId: "fixture_jev_ask", fallbacks: [{ method: "general", model: request.model }] } }, fallbackLead.id)
            const fallbackTeam = (db.query("SELECT id FROM team WHERE name = 'fallback-mission'").get() as { id: string }).id
            await executeTeamTasksAdd(deps, { tasks: [{ content: "NATIVE_BACKEND_GONE", priority: "medium" }] }, fallbackLead.id)
            await classifyBoardTasks(deps, fallbackTeam)
            const fallback = db.query("SELECT classification_result FROM team_task WHERE team_id = ?").get(fallbackTeam) as { classification_result: string }
            check("a disappeared JEV backend uses only the authorized general fallback and records it", JSON.parse(fallback.classification_result).method === "general" && db.query("SELECT id FROM classification_incident WHERE team_id = ? AND kind = 'fallback'").all(fallbackTeam).length === 1)
          } finally { await ctx.session.remove({ sessionID: fallbackLead.id }) }
          const x86Lead = await ctx.session.create({ title: "x86 fixture", location: { directory: ctx.location.directory } })
          try {
            await executeTeamCreate(deps, { name: "x86-mission", classification: { mode: "x86", x86ToolId: "fixture_classify_x86" } }, x86Lead.id)
            const x86Team = (db.query("SELECT id FROM team WHERE name = 'x86-mission'").get() as { id: string }).id
            await executeTeamTasksAdd(deps, { tasks: [{ content: "NATIVE_X86", priority: "medium", task_type: "x86", classification_input: { assembly: "ret", architecture: "x86-64" } }] }, x86Lead.id)
            await classifyBoardTasks(deps, x86Team)
            const x86 = db.query("SELECT classification_result FROM team_task WHERE team_id = ?").get(x86Team) as { classification_result: string }
            check("native x86 reconstruction complexity and uncertainty map to normalized complexity/risk", JSON.parse(x86.classification_result).complexity === 0.42 && JSON.parse(x86.classification_result).risk === 0.23)
          } finally { await ctx.session.remove({ sessionID: x86Lead.id }) }
          await ctx.tool.transform(editor => { editor.remove("fixture_jev_ask"); editor.remove("codemode_jev_ask") })
          check("JEV absence is detected rather than assumed", discoverJevTool(await ctx.tool.list()) === undefined)
          const generalLead = await ctx.session.create({ title: "No-JEV fixture", location: { directory: ctx.location.directory } })
          try {
            await executeTeamCreate(deps, { name: "general-mission", classification: { mode: "auto", toolId: "", generalModel: request.model } }, generalLead.id)
            const generalTeam = (db.query("SELECT id FROM team WHERE name = 'general-mission'").get() as { id: string }).id
            await executeTeamTasksAdd(deps, { tasks: [{ content: "NATIVE_GENERAL", priority: "medium" }] }, generalLead.id)
            await classifyBoardTasks(deps, generalTeam)
            const general = db.query("SELECT classification_result FROM team_task WHERE team_id = ?").get(generalTeam) as { classification_result: string }
            check("a real mission without JEV classifies on its explicitly chosen general model", JSON.parse(general.classification_result).method === "general")
          } finally { await ctx.session.remove({ sessionID: generalLead.id }) }
          check("native board helpers leave no retained resource records", db.query("SELECT session_id FROM classification_helper").all().length === 0)
        } finally { await ctx.session.remove({ sessionID: lead.id }); db.close() }
        return { checks }
      } catch (error) {
        console.error(`Classification fixture after ${checks.length} checks: ${error instanceof Error ? error.stack : String(error)}`)
        throw error
      } finally { await created.dispose() }
    } })
  },
})
