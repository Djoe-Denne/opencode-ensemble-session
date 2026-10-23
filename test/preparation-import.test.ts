import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createExecutionPolicy, validateExecutionPolicy, type ExecutionPolicy } from "../src/execution-policy"
import type { RoutingModel } from "../src/model-router"
import { importPreparationDocument } from "../src/preparation-import"
import { PreparationDocumentError } from "../src/preparation-document"
import { applyMigrations, MIGRATIONS } from "../src/schema"
import type { Database as EnsembleDatabase } from "../src/db"
import { insertTeam, setupDb } from "./helpers"

const models: RoutingModel[] = [
  { id: "cursor/grok-4.7", reasoningEffort: "Grok 4.7 Extra High", intelligenceScore: 46, averageCostPerTask: 1, available: true },
]

function policies(): { v2: ExecutionPolicy; v3: ExecutionPolicy } {
  return {
    v2: createExecutionPolicy(models, 46),
    v3: createExecutionPolicy(models, 46, 0.35, { min: 40 }),
  }
}

function discovery(topic: string): string {
  return [
    `${topic} was checked against the current plugin sources before this task was cut.`,
    "The boundary stays inside this task: no command, hook, or spawn change belongs here.",
    "Evidence is limited to the cited files and the tests named in verification.",
    "Unrelated modules were not modified, and no execution is admitted before start.",
    "The next owner implements only the stated goal and returns a new documentary handoff.",
  ].join(" ")
}

function task(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Title ${id}`,
    type: "implementation",
    goal: `Goal ${id}`,
    dependsOn: [],
    planning: { required: true, reason: `Plan ${id} before changing the boundary.` },
    acceptanceCriteria: [`Accepted ${id} when the cited behavior holds.`],
    verification: [`Verify ${id} with the focused test and the project gate.`],
    handoff: {
      document: discovery(`Task ${id}`),
      sources: [{ path: `src/${id}.ts`, note: `Shows the symbols owned by ${id}.` }],
    },
    ...overrides,
  }
}

function document(tasks: Array<Record<string, unknown>> = [
  task("plan"),
  task("build", { dependsOn: ["plan"], planning: { required: false, reason: "Implement the accepted contract." } }),
], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    context: "Shared context for the initial preparation import.",
    openQuestions: [{ id: "q1", question: "Which boundary owns the schema?", audience: "supervisor" }],
    tasks,
    parallelGroups: [{
      taskIds: ["plan"],
      reason: "Planning does not share files with another writer.",
      integrationNotes: "Reconcile on the lead branch after each isolated worktree lands.",
      isolation: "separate-worktrees",
    }],
    ...overrides,
  }
}

function draft(db: EnsembleDatabase, id = "team-1"): string {
  insertTeam(db, id, id, "lead-session")
  db.run(
    "INSERT INTO mission_policy (team_id, objective, policy_path, time_updated) VALUES (?, 'objective', ?, ?)",
    [id, `/tmp/${id}/model-policy.json`, 1],
  )
  return id
}

function count(db: EnsembleDatabase, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  return row.c
}

describe("preparation import", () => {
  test("imports a valid document once and replays the same task ids", () => {
    const db = setupDb()
    const teamId = draft(db)
    const { v2 } = policies()
    const raw = document()
    const first = importPreparationDocument(db, teamId, raw, v2)
    const reordered = {
      parallelGroups: raw.parallelGroups,
      tasks: raw.tasks,
      openQuestions: raw.openQuestions,
      context: "  Shared context for the initial preparation import.  ",
      version: 1,
    }
    const second = importPreparationDocument(db, teamId, reordered, v2)

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.mapping).toEqual(first.mapping)
    expect(second.documentHash).toBe(first.documentHash)
    expect(second.openQuestions).toEqual(first.openQuestions)
    expect(count(db, "preparation_import")).toBe(1)
    expect(count(db, "team_task")).toBe(2)
    expect(count(db, "team_member")).toBe(0)

    const plan = first.mapping.find(item => item.pmId === "plan")
    const build = first.mapping.find(item => item.pmId === "build")
    if (!plan || !build) throw new Error("expected both mapped tasks")
    expect(plan).toMatchObject({ mode: "planned", kind: "code", disposition: "authorized" })
    expect(build).toMatchObject({ mode: "direct", kind: "code", disposition: "held" })
    expect(build.holdReason).toMatch(/version 2/i)
    expect(JSON.stringify(build)).not.toMatch(/cursor\/grok|variant/)

    const planRow = db.query("SELECT status, depends_on, assignee, execution_decision, execution_request, model_routing, content FROM team_task WHERE id = ?").get(plan.taskId) as {
      status: string
      depends_on: string | null
      assignee: string | null
      execution_decision: string | null
      execution_request: string | null
      model_routing: string | null
      content: string
    }
    const buildRow = db.query("SELECT status, depends_on, execution_decision, execution_request FROM team_task WHERE id = ?").get(build.taskId) as {
      status: string
      depends_on: string | null
      execution_decision: string | null
      execution_request: string | null
    }
    expect(planRow.status).toBe("pending")
    expect(planRow.depends_on).toBeNull()
    expect(planRow.assignee).toBeNull()
    expect(planRow.model_routing).toBeNull()
    expect(JSON.parse(planRow.execution_decision ?? "")).toEqual({ mode: "planned", kind: "code", authorizedBy: "lead-session" })
    expect(JSON.parse(planRow.execution_request ?? "")).toEqual({ mode: "planned", kind: "code" })
    expect(planRow.content).toContain("Discovery document:")
    expect(planRow.content).toContain("src/plan.ts: Shows the symbols owned by plan.")
    expect(buildRow.status).toBe("blocked")
    expect(JSON.parse(buildRow.depends_on ?? "[]")).toEqual([plan.taskId])
    expect(buildRow.execution_decision).toBeNull()
    expect(JSON.parse(buildRow.execution_request ?? "")).toEqual({ mode: "direct", kind: "code" })

    const stored = db.query("SELECT context, open_questions_json, parallel_groups_json FROM preparation_import WHERE team_id = ?").get(teamId) as {
      context: string
      open_questions_json: string
      parallel_groups_json: string
    }
    expect(stored.context).toBe("Shared context for the initial preparation import.")
    expect(JSON.parse(stored.open_questions_json)).toEqual([{ id: "q1", question: "Which boundary owns the schema?", audience: "supervisor" }])
    expect(JSON.parse(stored.parallel_groups_json)[0].integrationNotes).toBe("Reconcile on the lead branch after each isolated worktree lands.")
    expect(JSON.parse(stored.parallel_groups_json)[0].isolation).toBe("separate-worktrees")
    const handoff = db.query("SELECT handoff_json FROM preparation_task WHERE task_id = ?").get(plan.taskId) as { handoff_json: string }
    const storedHandoff = JSON.parse(handoff.handoff_json) as { document: string; sources: Array<{ path: string; note: string }> }
    expect(storedHandoff.document.length).toBeGreaterThanOrEqual(400)
    expect(storedHandoff.sources).toEqual([{ path: "src/plan.ts", note: "Shows the symbols owned by plan." }])
  })

  test("authorizes version 3 direct code and version 2 direct documentation without a model", () => {
    const db = setupDb()
    const teamId = draft(db)
    const { v3 } = policies()
    const imported = importPreparationDocument(db, teamId, document([
      task("code", { planning: { required: false, reason: "Version 3 can execute this directly." } }),
      task("docs", { type: "documentation", planning: { required: false, reason: "Write the notes from the citations." } }),
    ], { parallelGroups: [] }), v3)
    expect(imported.mapping.map(item => [item.pmId, item.disposition, item.mode, item.kind])).toEqual([
      ["code", "authorized", "direct", "code"],
      ["docs", "authorized", "direct", "documentation"],
    ])
    imported.mapping.forEach(item => {
      const row = db.query("SELECT execution_decision FROM team_task WHERE id = ?").get(item.taskId) as { execution_decision: string }
      const decision = JSON.parse(row.execution_decision) as { model?: string; variant?: string; authorizedBy: string }
      expect(decision.model).toBeUndefined()
      expect(decision.variant).toBeUndefined()
      expect(decision.authorizedBy).toBe("lead-session")
    })

    const other = setupDb()
    const otherTeam = draft(other, "team-2")
    const docsOnly = importPreparationDocument(other, otherTeam, document([
      task("docs", { type: "documentation", planning: { required: false, reason: "Write the notes from the citations." } }),
    ], { parallelGroups: [] }), policies().v2)
    expect(docsOnly.mapping[0]).toMatchObject({ disposition: "authorized", mode: "direct", kind: "documentation" })
  })

  test("refuses a second document, an approved mission, and a team without a draft", () => {
    const db = setupDb()
    const teamId = draft(db)
    const { v2 } = policies()
    const raw = document([task("only")], { parallelGroups: [] })
    importPreparationDocument(db, teamId, raw, v2)
    expect(() => importPreparationDocument(db, teamId, document([task("only", { goal: "Changed goal after the first import." })], { parallelGroups: [] }), v2)).toThrow(/different preparation document/i)
    expect(count(db, "team_task")).toBe(1)

    const approved = setupDb()
    const approvedTeam = draft(approved, "team-approved")
    approved.run("UPDATE mission_policy SET approved_hash = 'approved' WHERE team_id = ?", [approvedTeam])
    expect(() => importPreparationDocument(approved, approvedTeam, raw, v2)).toThrow(/before mission start/i)
    expect(count(approved, "team_task")).toBe(0)

    const bare = setupDb()
    insertTeam(bare, "bare", "bare", "lead-session")
    expect(() => importPreparationDocument(bare, "bare", raw, v2)).toThrow(/mission draft/i)
    expect(() => importPreparationDocument(bare, "missing", raw, v2)).toThrow(/existing mission team/i)
  })

  test("replays after approval and does not persist an invalid document", () => {
    const db = setupDb()
    const teamId = draft(db)
    const raw = document([task("only")], { parallelGroups: [] })
    const first = importPreparationDocument(db, teamId, raw, policies().v2)
    db.run("UPDATE mission_policy SET approved_hash = 'approved' WHERE team_id = ?", [teamId])
    const replay = importPreparationDocument(db, teamId, raw, policies().v2)
    expect(replay.replayed).toBe(true)
    expect(replay.mapping).toEqual(first.mapping)

    expect(() => importPreparationDocument(db, teamId, { version: 1, context: "x" }, policies().v2)).toThrow(PreparationDocumentError)
    expect(count(db, "team_task")).toBe(1)
  })

  test("replays persisted decisions after approval without rereading the supplied policy", () => {
    const db = setupDb()
    const teamId = draft(db)
    const { v2, v3 } = policies()
    const raw = document()
    const first = importPreparationDocument(db, teamId, raw, v2)
    const audit = db.query("SELECT id, policy_hash FROM preparation_import WHERE team_id = ?").get(teamId) as { id: string; policy_hash: string }
    const tasksBefore = db.query("SELECT id, status, assignee, execution_request, execution_decision FROM team_task ORDER BY id").all()
    expect(audit.policy_hash).not.toBe("")
    db.run("UPDATE mission_policy SET approved_hash = 'approved' WHERE team_id = ?", [teamId])

    const invalid = structuredClone(v2)
    invalid.providers = []
    expect(() => validateExecutionPolicy(invalid)).toThrow(/execution providers/i)

    const broken = importPreparationDocument(db, teamId, raw, invalid)
    const absent = importPreparationDocument(db, teamId, raw)
    const changed = importPreparationDocument(db, teamId, raw, v3)
    for (const replay of [broken, absent, changed]) {
      expect(replay.replayed).toBe(true)
      expect(replay.importId).toBe(first.importId)
      expect(replay.mapping).toEqual(first.mapping)
      expect(replay.documentHash).toBe(first.documentHash)
    }

    const auditAfter = db.query("SELECT id, policy_hash FROM preparation_import WHERE team_id = ?").get(teamId) as { id: string; policy_hash: string }
    expect(auditAfter).toEqual(audit)
    expect(db.query("SELECT id, status, assignee, execution_request, execution_decision FROM team_task ORDER BY id").all()).toEqual(tasksBefore)
    expect(count(db, "preparation_import")).toBe(1)
    expect(count(db, "team_task")).toBe(2)
    expect(count(db, "team_member")).toBe(0)

    const other = document([task("only")], { parallelGroups: [] })
    expect(() => importPreparationDocument(db, teamId, other, invalid)).toThrow(/different preparation document/i)
    expect(count(db, "team_task")).toBe(2)
    expect(db.query("SELECT policy_hash FROM preparation_import WHERE team_id = ?").get(teamId)).toEqual({ policy_hash: audit.policy_hash })
  })

  test("refuses an invalid policy on the first import and writes nothing", () => {
    const db = setupDb()
    const teamId = draft(db)
    const invalid = structuredClone(policies().v2)
    invalid.providers = []
    expect(() => importPreparationDocument(db, teamId, document(), invalid)).toThrow(/execution providers/i)
    expect(count(db, "preparation_import")).toBe(0)
    expect(count(db, "team_task")).toBe(0)
    expect(count(db, "team_member")).toBe(0)
  })

  test("refuses cycles and unknown dependencies before writing", () => {
    const db = setupDb()
    const teamId = draft(db)
    const policy = policies().v2
    const refuse = (value: Record<string, unknown>, issue: RegExp) => {
      try {
        importPreparationDocument(db, teamId, value, policy)
      } catch (error) {
        expect(error).toBeInstanceOf(PreparationDocumentError)
        if (!(error instanceof PreparationDocumentError)) throw error
        expect(error.issues.join("\n")).toMatch(issue)
        return
      }
      throw new Error("expected the preparation document to be refused")
    }

    refuse(document([
      task("a", { dependsOn: ["b"] }),
      task("b", { dependsOn: ["a"] }),
    ], { parallelGroups: [] }), /cycle/)
    refuse(document([
      task("a", { dependsOn: ["missing"] }),
    ], { parallelGroups: [] }), /unknown/)
    expect(count(db, "preparation_import")).toBe(0)
    expect(count(db, "preparation_task")).toBe(0)
    expect(count(db, "team_task")).toBe(0)
    expect(count(db, "team_member")).toBe(0)
  })

  test("retains version 2 direct code without admission or launch", () => {
    const db = setupDb()
    const teamId = draft(db)
    const imported = importPreparationDocument(db, teamId, document([
      task("code", { planning: { required: false, reason: "Version 2 must keep this direct request held." } }),
    ], { parallelGroups: [] }), policies().v2)
    const item = imported.mapping[0]
    if (!item) throw new Error("expected the held task")
    expect(item).toMatchObject({ pmId: "code", disposition: "held", mode: "direct", kind: "code" })
    expect(item.holdReason).toMatch(/version 2/i)
    expect(JSON.stringify(item)).not.toMatch(/cursor\/grok|variant|model/)

    const row = db.query("SELECT status, assignee, model_routing, classification_status, execution_request, execution_decision FROM team_task WHERE id = ?").get(item.taskId) as {
      status: string
      assignee: string | null
      model_routing: string | null
      classification_status: string
      execution_request: string | null
      execution_decision: string | null
    }
    expect(row).toEqual({
      status: "pending",
      assignee: null,
      model_routing: null,
      classification_status: "not_required",
      execution_request: JSON.stringify({ mode: "direct", kind: "code" }),
      execution_decision: null,
    })
    expect(count(db, "team_member")).toBe(0)
    expect(count(db, "classification_helper")).toBe(0)
    expect(count(db, "classification_incident")).toBe(0)

    const source = readFileSync(new URL("../src/preparation-import.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/pumpTeam|assertMissionAdmission|promptAsync|session\.abort|team_spawn|classifyBoardTasks/)
  })

  test("replays when a concurrent insert loses the unique constraint", () => {
    const db = setupDb()
    const teamId = draft(db)
    const raw = document([task("only")], { parallelGroups: [] })
    const policy = policies().v2
    const first = importPreparationDocument(db, teamId, raw, policy)
    // Two head reads miss, so the insert hits the unique constraint and the catch replays.
    let hidden = 2
    const racing: EnsembleDatabase = {
      exec: sql => db.exec(sql),
      close: () => db.close(),
      query: sql => {
        const statement = db.query(sql)
        if (hidden > 0 && sql.includes("FROM preparation_import WHERE team_id")) {
          hidden -= 1
          return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }
        }
        return statement
      },
      run: (sql, ...params) => db.run(sql, ...params),
      transaction: fn => db.transaction(fn),
    }
    const replay = importPreparationDocument(racing, teamId, raw, policy)
    expect(hidden).toBe(0)
    expect(replay.replayed).toBe(true)
    expect(replay.importId).toBe(first.importId)
    expect(replay.mapping).toEqual(first.mapping)
    expect(count(db, "preparation_import")).toBe(1)
    expect(count(db, "team_task")).toBe(1)
  })

  test("reports a corrupt import record instead of returning it", () => {
    const db = setupDb()
    const teamId = draft(db)
    const raw = document([task("only")], { parallelGroups: [] })
    const first = importPreparationDocument(db, teamId, raw, policies().v2)
    const taskId = first.mapping[0]?.taskId
    if (!taskId) throw new Error("expected the imported task")
    db.run("UPDATE preparation_task SET decision_json = ? WHERE task_id = ?", ["not-json", taskId])
    expect(() => importPreparationDocument(db, teamId, raw, policies().v2)).toThrow(/corrupt/i)
    db.run("UPDATE preparation_task SET decision_json = ? WHERE task_id = ?", [JSON.stringify({ mode: "planned", kind: "code" }), taskId])
    db.run("UPDATE preparation_import SET open_questions_json = ? WHERE team_id = ?", ["not-json", teamId])
    expect(() => importPreparationDocument(db, teamId, raw, policies().v2)).toThrow(/corrupt/i)
    expect(count(db, "team_task")).toBe(1)
  })

  test("maps a dependency declared later in the document", () => {
    const db = setupDb()
    const teamId = draft(db)
    const imported = importPreparationDocument(db, teamId, document([
      task("build", { dependsOn: ["plan"], planning: { required: false, reason: "Implement the accepted contract." } }),
      task("plan"),
    ], { parallelGroups: [] }), policies().v2)
    const plan = imported.mapping.find(item => item.pmId === "plan")
    const build = imported.mapping.find(item => item.pmId === "build")
    if (!plan || !build) throw new Error("expected both mapped tasks")
    const row = db.query("SELECT status, depends_on, execution_decision FROM team_task WHERE id = ?").get(build.taskId) as {
      status: string
      depends_on: string | null
      execution_decision: string | null
    }
    expect(imported.mapping.map(item => item.pmId)).toEqual(["build", "plan"])
    expect(plan.disposition).toBe("authorized")
    expect(build).toMatchObject({ disposition: "held", mode: "direct", kind: "code" })
    expect(row.status).toBe("blocked")
    expect(JSON.parse(row.depends_on ?? "[]")).toEqual([plan.taskId])
    expect(row.execution_decision).toBeNull()
  })

  test("rolls back the import when persistence fails midway", () => {
    const db = setupDb()
    const teamId = draft(db)
    db.exec(`
      CREATE TRIGGER preparation_task_fail BEFORE INSERT ON preparation_task
      WHEN NEW.pm_id = 'boom'
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `)
    expect(() => importPreparationDocument(db, teamId, document([task("boom")], { parallelGroups: [] }), policies().v2)).toThrow(/forced rollback/)
    expect(count(db, "preparation_import")).toBe(0)
    expect(count(db, "preparation_task")).toBe(0)
    expect(count(db, "team_task")).toBe(0)
  })

  test("migration 24 adds preparation tables to a version 23 database", () => {
    const db = new Database(":memory:")
    db.exec("PRAGMA foreign_keys = OFF")
    for (let index = 0; index < 23; index++) {
      const statement = MIGRATIONS[index]
      if (!statement) throw new Error(`missing migration ${index + 1}`)
      db.exec(statement)
      db.exec(`PRAGMA user_version = ${index + 1}`)
    }
    applyMigrations(db as EnsembleDatabase)
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length })
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'preparation_import'").get()).toEqual({ name: "preparation_import" })
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'preparation_task'").get()).toEqual({ name: "preparation_task" })
    db.close()
  })
})
