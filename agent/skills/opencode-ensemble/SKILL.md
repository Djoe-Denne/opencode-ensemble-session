---
name: opencode-ensemble
description: "Use when coordinating multiple coding agents, delegating independent software work, managing OpenCode Ensemble teams, choosing teammate profiles or models, reusing native session history, handing a session to another agent, or reviewing teammate output. Also use to decide whether a team is worthwhile. Project installation and agent-file adaptation use ensemble-project-setup."
license: MIT
compatibility: "OpenCode with the @hueyexe/opencode-ensemble plugin installed; native session continuity requires the V2-capable fork"
metadata:
  author: hueyexe
  version: "1.3.1"
---

# OpenCode Ensemble

Use Ensemble to coordinate bounded, verifiable missions. The lead chooses the team shape for the actual task and owns integration and verification. A single agent is often enough.

## Choose the Team for the Mission

- Identify independent questions or implementation slices before spawning. Keep tightly coupled changes with one owner or sequence them through task dependencies.
- Choose only the profiles and number of teammates the work needs. Research, implementation, testing, review, documentation, and other domain specialties can be combined freely.
- Treat explorer → architect → implementers, scout/builder/reviewer, and other recipes as optional examples. No role sequence is required.
- Distinguish an agent **profile** (expertise, system prompt, permissions, model preference) from Ensemble **lead/member** identity. A profile named `architect` or `orchestrator` does not grant lead privileges.
- Respect the user's delegation and model constraints. For a small or inseparable task, work directly rather than creating an unnecessary team.

## Command-Prepared Missions (V2)

When the host exposes `/ensemble-mission`, the user can prepare an objective,
discuss providers/models with `config`, and approve the presented policy with
`start`. The persisted policy owns the initial model and allowed reasoning;
workers may adjust reasoning within that envelope, not substitute models through
altered task scores or `team_message` controls. Default V2 tasks plan read-only,
then use `team_handoff({ phase: "implementation", reasoning: "<allowed variant>" })`;
later `team_handoff({ reasoning: "<allowed variant>" })` may raise or lower effort.
Write chat corrections to the mission draft rather than retaining them only in
context. Do not invoke `start` on the user's behalf. Read
[mission policy](references/mission-policy.md) for the approval and revision flow.
Optional PM discovery before `start` uses
`/ensemble-mission prepare [--pm <agent>] [--preplan <file>] [--history none|fork|checkpoint] [--before <messageID>] <mandat>`.
A new session requires the objective; an existing draft always transmits its
stored objective alongside any extra mandate. Preplan/history are explicit and
frozen, not implicit context inheritance. Blocked/incomplete preparation imports
no tasks; use `prepare --resume <clarification>` after resolving blockers.
Only ready v2 results are importable; start still requires user approval. After the
initial candidate and five PM corrections are exhausted, only the lead may run
`/ensemble-mission prepare --accept <json>`. `--pm` and `--accept` are mutually
exclusive. The runtime reuses an existing native PM and injects the discovery
contract without registering an agent or adding permissions. Read
[preparation](references/preparation.md). Direct V2 `team_create`
also freezes this catalogue policy when configured; V1/no-catalogue teams
retain the legacy assignment workflow below.

## Lead Workflow

1. Define each mission's scope, deliverable, ownership boundaries, and verification criteria.
2. Create a team with `team_create` when coordination is justified.
3. Add tasks with `team_tasks_add`. Record the real returned IDs; use `depends_on` only for tasks already in this team. A dependent task must be unblocked before it can be claimed.
   When classification is enabled, wait for notifications only for tasks needing classification. Fully manual scores make a task `not_required` immediately with zero attempts and no classifier notification; observe that board state once instead of waiting for a notification that will never arrive.
4. Choose a profile, context strategy, worktree policy, and model strategy for each mission. Discover available profiles/models rather than assuming example names exist.
5. Spawn teammates one at a time, waiting for each tool result; their work runs asynchronously. Use `claim_task` for a claimable implementation task. Built-in `explore`/`plan` spawns do not auto-claim tasks.
6. Use `plan_approval: true` when a mission or project policy calls for a reviewed implementation plan. Approve/reject through `team_message`.
7. Wait for teammate messages. Use `team_results` for full content when a report is truncated or consequential; use status tools for a specific diagnostic, not a waiting loop.
8. After completion, use `team_shutdown`, then `team_merge` once the teammate is shut down. Inspect the diff and run the project's verification before `team_cleanup` and before claiming success.

## Supervisor Reports

Present a concise report between meaningful stages and **before every question
to the user**, including approvals and blockers. Markdown is the default; save
it in the mission's reports directory, link it and give the decision context in
chat before asking. A report is not a new approval gate or a reason to rerun QA.
For Canvas, start/reuse an owned loopback preview backend and verify the working
URL and report content before presenting it; otherwise fall back to Markdown.
Read [mission reporting](references/mission-reporting.md) for the template,
privacy, permission fallback and preview-server lifecycle.

## Choose Context Deliberately

On V2, choose the smallest appropriate transition:

- **`fresh`** (also the default): start an independent mission. Prefer it for an independent review or an unrelated task.
- **`fork`**: create a new teammate from useful native research/history; give it only its new identity/task delta. Set `context: { mode: "fork", from: "member-name" }` on `team_spawn`.
- **`checkpoint`**: inherit before a native `messageID`, an **exclusive** boundary. For A/B/C/D/E, choose D to keep C and omit D/E.
- **`compact_fork`**: natively compact a distinct idle source, verify completion, then fork its projected summary and retained recent context. This modifies the source's context.
- **`team_handoff({ agent })`**: change the calling session's profile for subsequent turns, keeping its identity/history/tasks/worktree. Use it for a continuation that needs another specialty, rather than an independent worker. It does not transfer leadership or create a worktree.

Only the lead spawns; any active initialized member, including the lead, may hand off itself. A teammate needing follow-up workers reports to the lead. Sources are restricted to the same team: `current` (default), `lead`, a member name, or a team session ID; a finished member is usable while its native session exists.

Read [context continuity](references/context-continuity.md) before using inheritance or handoff: it covers the same-server HTTP bridge, Git restrictions, exclusive boundaries, admission errors, and V1 compatibility. Unsupported inheritance fails explicitly; do not silently substitute fresh context or paste a synthetic conversation history.

## Profiles, Worktrees, and Models

- Built-in `explore` and `plan` are read-only profiles and skip automatic worktree creation. For a custom read-only profile, configure native edit/shell permissions and pass `worktree: false` explicitly. A name such as `reviewer` is not a permission policy.
- Writers use isolated worktrees by default. Inherited cross-directory moves require clean source/destination directories at the same Git HEAD. Integrate divergent commits before creating the inherited worktree; do not transfer files implicitly.
- Handoff preserves the directory. Turning a shared-directory researcher into a writer does not add isolation; fork an isolated worker when that is what the task needs.
- In legacy teams, set `model` when an explicit selection is required by the task, budget, or project. Otherwise use the configured Ensemble/native selection. A fork preserves the source's native model unless an explicit spawn model or Ensemble model-assignment setting overrides it. Command-prepared missions instead enforce their approved grid.
- Native handoff keeps the session's selected model, independently of the target profile's default. In legacy teams the lead can separately use `team_message({ to, model })` to change a teammate's model; governed missions require a policy revision.
- IDs such as `openai/gpt-5-mini` and `anthropic/claude-opus-4-7` are illustrative, not required defaults. Verify available IDs and match capabilities to the mission.

## Project Integration

For interactive installation, analysis of existing agents, or changes to project configuration/instructions, use `ensemble-project-setup`. This operational skill handles team execution after setup.

Keep this skill as the reusable operating guide. In project `AGENTS.md`, add a short rule to load it when teamwork is justified, plus the project's ownership and verification policy. Use optional `.opencode/agents/*.md` files for durable expertise/permissions; put the current task and ownership boundaries in spawn prompts. Do not duplicate the entire tool protocol across every profile.

For setup, copyable `AGENTS.md` guidance, and an optional agent profile, read [project integration](references/project-integration.md). The project chooses its workflows; the plugin supplies generic coordination and continuity operations.

## Load References As Needed

- Installing or integrating into project/agent instructions: [project integration](references/project-integration.md).
- Preparing and configuring a command-governed mission: [mission policy](references/mission-policy.md).
- Writing an optional pre-start discovery document: [preparation](references/preparation.md).
- Reusing native history or changing profiles: [context continuity](references/context-continuity.md).
- Choosing an optional team shape: [coordination patterns](references/coordination-patterns.md).
- Writing a mission prompt: [prompt recipes](references/prompt-recipes.md).
- Checking spawn/merge/verification readiness: [lead checklists](references/lead-checklists.md).
- Diagnosing poor coordination: [anti-patterns](references/anti-patterns.md).
- Evaluating this skill: [eval scenarios](references/eval-scenarios.md).

## Operational Rules

- Do not invent task IDs. Use IDs returned by `team_tasks_add` when setting `depends_on` or `claim_task`.
- Keep teammate prompts short. The plugin already injects team identity, allowed tools, worktree context, and completion/blocker reporting instructions. Add the mission, not another copy of that protocol.
- Use `team_message` for reports; plain text output alone is not delivered to the lead.
- Keep spawning, shutdown, merge, and cleanup with the lead. A handoff does not bypass that authorization.
- Read the full result and inspect the integrated diff before accepting work. Report verification failures accurately.
- On V2, discover the client's Code Mode tool paths before calling them. `team_view` navigates only with `navigate: true` and an explicit user request; archived-team purge uses the existing preview/approval flow.

## Minimal Example

This is one possible bounded mission, not a required team topology. Calls below use illustrative Code Mode paths; use those exposed by your client.

```ts
await tools.team_create({ name: "cache-fix" })
await tools.team_tasks_add({ tasks: [
  { content: "Fix expired cache entries; own cache code and its focused regression tests.", priority: "high" },
] })
```

In the next call, `taskID` is the actual ID returned above:

```ts
await tools.team_spawn({
  name: "cache-worker",
  agent: "build",
  claim_task: taskID,
  prompt: "Fix expiry handling in the cache subsystem. Keep the change scoped, test expired and valid entries, run the project's focused cache checks, and report the result.",
  context: { mode: "fresh" },
})
```

If an existing member already owns relevant research, choose a native fork from that member instead. Add other missions only when they contribute independent, verifiable work.
