const COMPLETE_PREPARATION_EXAMPLE = {
  version: 1,
  context: "Shared cache boundary.",
  openQuestions: [{ id: "schema-owner", question: "Which module owns this schema?", audience: "supervisor" }],
  tasks: [
    {
      id: "research", title: "Locate the owner", type: "research", goal: "Name the module that owns the cache boundary.", dependsOn: [],
      planning: { required: true, reason: "The owner is not established yet." },
      acceptanceCriteria: ["The owner module is named."], verification: ["The cited file names the owner."],
      handoff: { document: "The owner is not named yet.", sources: [{ path: "src/research.ts", note: "Research entry." }] },
    },
    {
      id: "implementation", title: "Keep the boundary", type: "implementation", goal: "Record the boundary in the cited file.", dependsOn: [],
      planning: { required: false, reason: "The cited file already contains the change." },
      acceptanceCriteria: ["The boundary stays in the cited file."], verification: ["The focused test covers the boundary."],
      handoff: { document: "The boundary is local.", sources: [{ path: "src/cache.ts", note: "Boundary site." }] },
    },
  ],
  parallelGroups: [{
    taskIds: ["research", "implementation"], reason: "They do not depend on each other.",
    integrationNotes: "Reconcile on the lead branch.", isolation: "separate-worktrees",
  }],
}

/** Ensemble preparation contract injected into the selected native PM session. */
export const PREPARATION_PM_INSTRUCTIONS = [
  "Ensemble preparation contract for the native PM already selected. These instructions add Ensemble specificity to that session. They do not install a native agent, tool, or permission.",
  "Use GrepAI to locate unknown behavior and Serena for a known symbol, definition, or reference. GrepAI does not prove a symbol is absent. Serena does not search by vague behavior.",
  "Return one JSON object with version, context, openQuestions, tasks, and parallelGroups. Do not include a model, variant, or routing reason. planning.required is only a boolean: true means planned execution and false means direct execution.",
  "Task type is one of implementation, architecture, documentation, research, review, or qa. architecture describes contracts and boundaries and does not replace planning.required.",
  "Each task includes id, title, type, goal, dependsOn, planning, acceptanceCriteria, verification, and handoff.",
  "Split a task when its goal mixes unrelated outcomes or when one part depends on another. Do not group a task with its dependency.",
  'Example: {"planning":{"required":false,"reason":"The cited file already contains the change."}}',
  "Counterexample: a planning object that names a model, variant, or provider.",
  "Example: type architecture with planning.required true while the boundary is undecided.",
  "Counterexample: using type architecture so a code change can skip planning.",
  "openQuestions are addressed to the supervisor. Each item has an id, the question, and audience supervisor. Do not guess the answer.",
  'Example: {"id":"schema-owner","question":"Which module owns this schema?","audience":"supervisor"}',
  "Counterexample: an open question addressed to an implementer, or a question resolved in silence.",
  "A read-only native profile stays read-only. Put the documentary handoff in the JSON result: handoff.document plus handoff.sources. Do not write the worktree.",
  'Example: {"document":"The parser already rejects version 0.","sources":[{"path":"src/preparation-document.ts","note":"version check"}]}',
  "Counterexample: editing a source file from this preparation session, or a handoff with no source.",
  "parallelGroups contain only independent tasks. isolation is separate-worktrees. Do not group a task with its dependency.",
  'Example: {"taskIds":["parser","docs"],"reason":"They do not share files.","integrationNotes":"Reconcile on the lead branch.","isolation":"separate-worktrees"}',
  "Counterexample: isolation shared-checkout, or a group that contains a task and a task that depends on it.",
  "Do not spawn workers, claim tasks, or admit implementation. The plugin imports real task ids after this document validates.",
  `Complete example:\n\`\`\`json\n${JSON.stringify(COMPLETE_PREPARATION_EXAMPLE)}\n\`\`\``,
].join("\n")

/** Sentence that tells the PM to return JSON because session.prompt has no structured-output field. */
export const PREPARATION_JSON_FALLBACK = "The public session prompt accepts text, not a structured-output field. Return one JSON object and no surrounding prose."
