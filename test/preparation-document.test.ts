import { describe, expect, test } from "bun:test"
import { createExecutionPolicy, type ExecutionPolicy } from "../src/execution-policy"
import type { RoutingModel } from "../src/model-router"
import {
  authorizePreparationDecision,
  parsePreparationDocument,
  preparationExecutionDecision,
  PreparationDocumentError,
  type PreparationDocument,
  type PreparationTask,
} from "../src/preparation-document"

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

function task(id: string, overrides: Partial<PreparationTask> = {}): PreparationTask {
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

function document(tasks: PreparationTask[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    context: "Shared context for the initial preparation import.",
    openQuestions: [{ id: "q1", question: "Which boundary owns the schema?", audience: "supervisor" }],
    tasks,
    parallelGroups: [],
    ...overrides,
  }
}

function issuesOf(value: unknown): readonly string[] {
  try {
    parsePreparationDocument(value)
  } catch (error) {
    if (error instanceof PreparationDocumentError) return error.issues
    throw error
  }
  throw new Error("expected a preparation document error")
}

describe("preparation document", () => {
  test("normalizes a versioned document and derives planned or direct without a model", () => {
    const parsed = parsePreparationDocument(document([
      task("plan"),
      task("build", { type: "implementation", planning: { required: false, reason: "The contract is already stable." }, dependsOn: ["plan"] }),
      task("notes", { type: "documentation", planning: { required: false, reason: "Write the discovery down." } }),
      task("design", { type: "architecture", planning: { required: true, reason: "Boundaries come before edits." } }),
      task("look", { type: "research", planning: { required: false, reason: "Collect the cited evidence." } }),
      task("check", { type: "review", planning: { required: true, reason: "Review the diff after it exists." } }),
      task("prove", { type: "qa", planning: { required: false, reason: "Exercise the agreed gate." } }),
    ], {
      context: "  Shared context for the initial preparation import.  ",
      parallelGroups: [{
        taskIds: ["notes", "look"],
        reason: "These tasks do not share files or a worktree.",
        integrationNotes: "Reconcile on the lead branch after each isolated worktree lands.",
        isolation: "separate-worktrees",
      }],
    }))

    expect(parsed.context).toBe("Shared context for the initial preparation import.")
    expect(parsed.openQuestions).toEqual([{ id: "q1", question: "Which boundary owns the schema?", audience: "supervisor" }])
    expect(parsed.parallelGroups[0]?.isolation).toBe("separate-worktrees")
    expect(parsed.tasks.map(item => preparationExecutionDecision(item))).toEqual([
      { mode: "planned", kind: "code" },
      { mode: "direct", kind: "code" },
      { mode: "direct", kind: "documentation" },
      { mode: "planned", kind: "mixed" },
      { mode: "direct", kind: "research" },
      { mode: "planned", kind: "mixed" },
      { mode: "direct", kind: "mixed" },
    ])
    const direct = parsed.tasks[1] ?? task("build")
    expect(JSON.stringify(preparationExecutionDecision(direct))).not.toMatch(/model|variant|reason/)
    expect(direct.handoff.document.length).toBeGreaterThanOrEqual(400)
  })

  test("holds version 2 direct work outside documentation and research", () => {
    const { v2, v3 } = policies()
    const directCode = { mode: "direct" as const, kind: "code" as const }
    const directDocs = { mode: "direct" as const, kind: "documentation" as const }
    const plannedCode = { mode: "planned" as const, kind: "code" as const }
    const held = authorizePreparationDecision(v2, directCode)
    const authorized = authorizePreparationDecision(v2, directDocs)
    const planned = authorizePreparationDecision(v2, plannedCode)
    const v3Direct = authorizePreparationDecision(v3, directCode)
    const conservative = authorizePreparationDecision(undefined, directCode)

    expect(held).toMatchObject({ disposition: "held", decision: directCode })
    expect(held.reason).toMatch(/version 2/i)
    expect(authorized).toEqual({ disposition: "authorized", decision: directDocs })
    expect(planned).toEqual({ disposition: "authorized", decision: plannedCode })
    expect(v3Direct).toEqual({ disposition: "authorized", decision: directCode })
    expect(conservative.disposition).toBe("held")
    expect(conservative.decision).toEqual(directCode)
    expect(v2.version).toBe(2)
    expect(v3.version).toBe(3)
  })

  test("rejects a model, variant, or routing reason on a preparation decision", () => {
    expect(() => authorizePreparationDecision(undefined, { mode: "planned", kind: "code", model: "cursor/grok-4.7", reason: "Assigned by the PM" })).toThrow(/model/i)
  })

  test("reports cycles, unknown dependencies, and unsupported fields", () => {
    const parsedIssues = issuesOf(document([
      task("a", { dependsOn: ["b"] }),
      task("b", { dependsOn: ["a", "missing"] }),
    ]))
    expect(parsedIssues.some(issue => /cycle/.test(issue) && issue.includes("a") && issue.includes("b"))).toBe(true)
    expect(parsedIssues.some(issue => /unknown/.test(issue) && issue.includes("missing"))).toBe(true)

    const shape = issuesOf({ version: 99, context: "  ", extra: true, openQuestions: [], tasks: [], parallelGroups: [] })
    expect(shape.some(issue => /version/.test(issue))).toBe(true)
    expect(shape.some(issue => /context/.test(issue))).toBe(true)
    expect(shape.some(issue => /extra/.test(issue))).toBe(true)
  })

  test("accepts concise handoff text and a concise parallel group", () => {
    const parsed = parsePreparationDocument(document([
      task("a", { handoff: { document: "Boundary noted.", sources: [{ path: "src/a.ts", note: "Owns a." }] } }),
      task("b", { handoff: { document: "Other boundary.", sources: [{ path: "src/b.ts", note: "Owns b." }] } }),
    ], {
      parallelGroups: [{
        taskIds: ["a", "b"],
        reason: "No shared files.",
        integrationNotes: "Reconcile after both land.",
        isolation: "separate-worktrees",
      }],
    }))

    expect(parsed.tasks.map(item => item.handoff)).toEqual([
      { document: "Boundary noted.", sources: [{ path: "src/a.ts", note: "Owns a." }] },
      { document: "Other boundary.", sources: [{ path: "src/b.ts", note: "Owns b." }] },
    ])
    expect(parsed.parallelGroups).toEqual([{
      taskIds: ["a", "b"],
      reason: "No shared files.",
      integrationNotes: "Reconcile after both land.",
      isolation: "separate-worktrees",
    }])
  })

  test("rejects empty handoff, source note, and group text", () => {
    expect(issuesOf(document([task("a", { handoff: { document: "  ", sources: [{ path: "src/a.ts", note: "Owns a." }] } })])).some(issue => /handoff\.document/.test(issue))).toBe(true)
    expect(issuesOf(document([task("a", { handoff: { document: "Boundary noted.", sources: [{ path: "  ", note: "Owns a." }] } })])).some(issue => /sources\[0\]\.path/.test(issue))).toBe(true)
    expect(issuesOf(document([task("a", { handoff: { document: "Boundary noted.", sources: [{ path: "src/a.ts", note: " " }] } })])).some(issue => /sources\[0\]\.note/.test(issue))).toBe(true)
    expect(issuesOf(document([task("a"), task("b")], {
      parallelGroups: [{ taskIds: ["a", "b"], reason: " ", integrationNotes: "Reconcile after both land.", isolation: "separate-worktrees" }],
    })).some(issue => /\.reason/.test(issue))).toBe(true)
    expect(issuesOf(document([task("a"), task("b")], {
      parallelGroups: [{ taskIds: ["a", "b"], reason: "No shared files.", integrationNotes: " ", isolation: "separate-worktrees" }],
    })).some(issue => /integrationNotes/.test(issue))).toBe(true)
  })

  test("rejects a parallel group whose tasks depend on each other", () => {
    const group = {
      taskIds: ["a", "b"],
      reason: "These tasks do not share files or a worktree.",
      integrationNotes: "Reconcile on the lead branch after each isolated worktree lands.",
      isolation: "separate-worktrees",
    }
    const direct = issuesOf(document([
      task("a", { dependsOn: ["b"] }),
      task("b"),
    ], { parallelGroups: [group] }))
    expect(direct.some(issue => /parallelGroups/.test(issue) && /depend/i.test(issue) && issue.includes("a") && issue.includes("b"))).toBe(true)

    const transitive = issuesOf(document([
      task("a", { dependsOn: ["c"] }),
      task("b"),
      task("c", { dependsOn: ["b"] }),
    ], { parallelGroups: [group] }))
    expect(transitive.some(issue => /parallelGroups/.test(issue) && /depend/i.test(issue) && issue.includes("a") && issue.includes("b"))).toBe(true)

    const separated = parsePreparationDocument(document([
      task("a", { dependsOn: ["c"] }),
      task("b"),
      task("c"),
    ], { parallelGroups: [group] }))
    expect(separated.parallelGroups[0]?.taskIds).toEqual(["a", "b"])
  })

  test("rejects a shared worktree and a question aimed elsewhere", () => {
    expect(issuesOf(document([task("a")], {
      parallelGroups: [{ taskIds: ["a"], reason: "These tasks do not share files or a worktree.", integrationNotes: "Reconcile on the lead branch after each isolated worktree lands.", isolation: "shared" }],
    })).some(issue => /isolation/.test(issue))).toBe(true)
    expect(issuesOf(document([], {
      openQuestions: [{ id: "q1", question: "Who implements this?", audience: "worker" }],
    })).some(issue => /supervisor/.test(issue))).toBe(true)
    expect(issuesOf(document([task("a"), task("a")])).some(issue => /duplicate/.test(issue))).toBe(true)
    expect(issuesOf(document([task("a", { dependsOn: ["a"] })])).some(issue => /cycle/.test(issue))).toBe(true)
    expect(issuesOf(document([task("a")], { model: "cursor/grok-4.7" })).some(issue => /model/.test(issue))).toBe(true)
    expect(issuesOf(document([task("a", { type: "code" as PreparationTask["type"] })])).some(issue => /type/.test(issue))).toBe(true)
  })
})

describe("preparation document fixture", () => {
  test("typechecks a normalized document", () => {
    const parsed: PreparationDocument = parsePreparationDocument(document([task("only")]))
    expect(parsed.version).toBe(1)
    expect(parsed.openQuestions[0]?.audience).toBe("supervisor")
  })
})
