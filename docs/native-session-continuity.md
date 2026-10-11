# Native session continuity: API and validation

Ensemble can reuse OpenCode V2 session history while keeping its existing teams, task board, messaging, worktrees, and lifecycle. This guide covers the local `feature/session-continuity` implementation.

For adoption in a project, start with the skill's [project integration guide](../skills/opencode-ensemble/references/project-integration.md): discoverable skill, short `AGENTS.md` policy, optional durable agent profiles, and mission-specific prompts. Root `opencode.json` enables that skill in this repository. Team composition is chosen per task; the workflow below is one example, not a plugin requirement.

For interactive onboarding, use [ensemble-project-setup](../skills/ensemble-project-setup/README.md) to analyze existing agents, confirm a minimal proposal, and apply it while preserving project-specific settings. Runtime coordination remains the responsibility of `opencode-ensemble`.

## Architecture and scope

The existing dual-host entry point remains in `src/index.ts`. V1 registers SDK tools through `server()`; V2 uses `Plugin.define`, `v2-setup.ts`, and `v2-tools.ts`. Both call the shared tool implementations. SQLite remains the authority for team membership, tasks, messages, and lifecycle state; the existing registry, event adapter, recovery, dashboard, plan approval, shutdown, and merge paths continue to consume those records.

Continuity is an optional `PluginClient.continuity` capability:

- `src/session-continuity.ts` validates team-scoped sources and reconciles interrupted spawns/handoffs.
- `src/v2-continuity.ts` adapts native `fork`, `switchAgent`, `move`, `compact`, `wait`, and `remove` operations.
- `src/tools/team-spawn.ts` selects fresh or inherited initialization and then uses the existing task claim, prompt delivery, registry, and lifecycle.
- `src/tools/team-handoff.ts` changes the calling session's agent and reconciles the persisted agent/model with native truth.

History is owned by OpenCode. Ensemble stores its provenance, not a second conversation transcript. There is no message-by-message replay, custom summarizer, replacement orchestration framework, or `opencode-sessions` dependency. Shared-service discovery uses the public `@opencode/client/service` API already provided by `@opencode/plugin`; that existing SDK dependency is aligned to 2.0.26 along with its lockfile.

### Public V2 bridge

OpenCode 2.0.25/2.0.26 has a public HTTP `session.fork` operation that is absent from its plugin context. The adapter prefers `ctx.session.fork` when supplied by a host; otherwise it discovers the existing registered shared server using the public `Service.discover()` and `Service.headers()` APIs. Credentials remain in memory and are never written to a project file or logged. Discovery does not start or restart a server. The URL and headers are resolved once per operation, so GET identity verification and POST fork use the same connection.

For a private/non-registered server only, override `v2ApiUrl` in `.opencode/ensemble.json` or the global Ensemble config:

```json
{ "v2ApiUrl": "http://127.0.0.1:4096" }
```

Use the URL of the server hosting this plugin. The example port is illustrative; shared-service users need no such setting. Explicit URLs never receive discovered credentials. Environment variables in that server process take precedence:

- `OPENCODE_ENSEMBLE_V2_API_URL`: the same server's base URL.
- `OPENCODE_ENSEMBLE_V2_AUTHORIZATION`: the complete Authorization header value, when authentication is required. Supply the authentication value for that server, including its scheme; this is not an API-key field in `ensemble.json`.

Before an HTTP fork, the adapter compares the native and HTTP views of the source's ID, project ID, creation timestamp, and directory. Redirects are rejected. It also verifies the returned child ID and native `fork.sessionID` relationship. An unavailable capability, authentication failure, missing session, or mismatched server produces an error; it never silently creates a fresh replacement.

References: [public plugin API](https://opencode.ai/v2/docs/build/plugins), [HTTP API](https://opencode.ai/v2/docs/api), [agent/model semantics](https://opencode.ai/v2/docs/agents). The end-to-end evaluation uses the real server's implementation of these public operations.

## Tool API

### `team_spawn`

All existing arguments remain available. The additional optional field is:

```typescript
context?: {
  mode: "fresh" | "fork" | "checkpoint" | "compact_fork"
  from?: string
  messageID?: string
}
```

- Omitted `context` or `{ mode: "fresh" }` uses the original `session.create` path. `fresh` rejects `from` and `messageID`.
- `fork` uses the source's full **projected native history**, then appends the new teammate identity and task delta.
- `checkpoint` passes `messageID` to native `before`. This is an **exclusive** boundary: that message and everything later are omitted. It is required for checkpoint mode and rejected in other modes.
- `compact_fork` compacts the source using native `compact`, waits for completion, verifies that the admitted compaction record has `status: "completed"`, and only then forks. It rejects the caller's own session and any active source to avoid waiting on itself or interrupting another agent's work.

`from` defaults to `"current"`. It accepts `"lead"`, a member's name, the lead's session ID, or a member's session ID. Explicit IDs must belong to the same team. A shutdown/error member can supply history if its native session still exists. A source whose spawn is still initializing is rejected. Only the lead can call `team_spawn`, including when the source is a member.

Checkpoint example, given native messages A/B/C/D/E:

```javascript
await tools.team_spawn({
  name: "checkpoint-worker",
  agent: "build",
  prompt: "Implement the design established through C.",
  context: { mode: "checkpoint", from: "scout", messageID: "msg_D" },
})
```

Replace `msg_D` with D's real native message ID. Using C's ID would exclude C. A nonexistent boundary fails in the native API.

Compaction is durable and modifies the source's native context. A compacted fork inherits OpenCode's projected summary **and retained recent context**; it is not a summary pasted into a fresh session. `session.wait` alone is insufficient proof of success, so a failed compaction record is rejected. Failed compaction creates no child.

### `team_handoff`

```javascript
await tools.team_handoff({ agent: "plan" })
```

This changes the **calling** team session for subsequent provider turns. It retains the session ID, native history, team identity, task ownership, worktree, branch, and plan-approval state. The caller must be a team member or its lead. A member must be active and fully initialized. Sub-agent isolation still applies. A handoff never promotes a member to lead and does not spawn a replacement or navigate the user's UI.

The target must be a native agent available on that server. Agent lookup rejects unknown names. Native agent selection supplies the next turn's system prompt and agent policy. Ensemble replaces only session permission overrides that it owns; user-supplied session rules are retained. Its team-tool permissions remain available after a switch.

OpenCode stores the selected model separately from the agent. **Handoff preserves the selected model**, even if the new agent has a configured default model. Spawn-level `model` and existing Ensemble model-assignment settings still apply. To change an existing teammate's model explicitly, the lead can use:

```javascript
await tools.team_message({ to: "scout", model: "provider/model" })
```

Use a provider/model installed on your server. Concurrent handoffs of the same session are rejected by an atomic SQLite reservation; an interrupted operation is reconciled against the actual native agent before that reservation is cleared.

## Worktree isolation and ordering

Inherited writers follow this order:

1. Validate the source and optionally compact it.
2. Fork with OpenCode and immediately persist the child's native ID and provenance as pending.
3. Create the teammate's worktree through the existing worktree strategy and persist its directory/branch.
4. Verify source and destination Git state, then move the **child** natively to that directory.
5. Settle native location control with `interrupt({ resume: true })` and `wait`, and verify the real directory binding.
6. Switch the child's native agent and settle its initialization wake.
7. Claim its task, register it, append the new identity/task delta, and admit the prompt through the existing fire-and-forget delivery path.

`switchAgent` can wake a native session. Moving first avoids running the requested writer at the source directory. A V2 context hook blocks provider execution during preparation and requires the child's unique task marker during admission. The native evaluation checks actual model requests, session IDs, directories, and task-delta presence.

Cross-directory moves require **both directories to be Git-clean and at the same HEAD**. Uncommitted changes, untracked files, divergent commits, and unverifiable Git state cause an explicit error. Committed changes on a source-only branch must be integrated into the lead's branch before forking into a new worktree. The public V2 move contract has no `moveChanges` option; Ensemble does not invent one or copy files.

Existing `plan`/`explore` agents remain read-only and skip automatic worktree creation. `worktree: false` explicitly opts out of isolation. If a requested inherited worktree cannot be created or bound, the spawn fails. Fresh spawning retains its previous shared-directory fallback and now includes a visible warning when worktree creation fails.

## Persistence and recovery

SQLite migration 11 adds:

- `team_member.context_mode`, defaulting to `fresh` for existing rows.
- `team_member.source_session_id` and `context_message_id` for native provenance.
- `team_member.spawn_pending`: `1` during preparation, `2` during prompt admission, `0` after admission.
- `team_member.handoff_pending` and `team.handoff_pending` for interrupted agent switches.

Pending members are excluded from ordinary registry rehydration and idle nudges. The V2 setup reconciles pending continuity operations before normal registry rehydration. The task delta carries `[Ensemble task <child-session-id>]`; its native message metadata carries `ensemble.spawn = <team-id>/<member-name>/<child-session-id>`.

On a preparation or admission failure, rollback inspects native messages for that admission marker:

- If OpenCode already admitted the task, adopt the existing child and clear the pending state rather than deleting its work.
- Otherwise release claimed tasks and remove the unadmitted child and its known workspace/worktree resources. The source is never removed or aborted by this rollback.
- If cleanup fails, retain an error row with the known native resource references so recovery can retry.

Recovery performs the same reconciliation after SQLite is reopened. For interrupted handoffs, it reads the actual native agent/model and updates Ensemble's cached state rather than assuming the requested switch succeeded.

Admitted workers continue through existing shutdown, branch preservation, merge, and cleanup. The native evaluation confirms that a forked worker's committed branch is preserved before force shutdown and that `team_merge` integrates its changes. The fresh-spawn rollback also preserves its branch before aborting.

## Explorer → Architect → three workers

This optional recipe demonstrates the primitives together. The plugin does not require these role names, this sequence, or three workers. Projects can use different specialties, single-session handoffs, independent teams, or a single agent as appropriate.

These examples show V2 Code Mode calls. Tools may need discovery through your client's catalog before invocation. All spawn/task-board calls below run in the lead session; the handoff runs inside `scout`.

### 1. Lead creates a read-only scout

```javascript
await tools.team_create({ name: "parser-project" })
await tools.team_spawn({
  name: "scout",
  agent: "explore",
  worktree: false,
  prompt: "Research the parser, renderer, and test contracts. Then call team_handoff with agent plan. On subsequent turns, produce an architecture with independent ownership boundaries for three workers. Send the final architecture and task split to the lead with team_message. Do not modify files.",
})
```

The omitted context deliberately starts fresh. The scout owns the research conversation, tool results, and later architecture conversation.

### 2. Scout becomes the architect in the same session

```javascript
await tools.team_handoff({ agent: "plan" })
```

On subsequent turns, the native `plan` agent works from the same research history. A configured custom architect agent may be used instead. Once its architecture is ready, the scout reports through `team_message` to `lead`. The lead waits for this report rather than polling.

### 3. Lead creates independent tasks and forks directly from scout

```javascript
await tools.team_tasks_add({ tasks: [
  { content: "Implement the parser contract established by scout; own parser files only.", priority: "high" },
  { content: "Implement the renderer against that contract; own renderer files only.", priority: "high" },
  { content: "Implement contract tests; own test files only.", priority: "high" },
] })
```

Use the three returned task IDs as `TASK_PARSER`, `TASK_RENDERER`, and `TASK_TESTS` below. These tasks are independent under the agreed interface. If one truly depends on another, add it with `depends_on` referencing an existing task ID and wait until it becomes claimable; inherited spawn refuses a blocked claim and rolls back its child.

```javascript
await tools.team_spawn({
  name: "parser", agent: "build", claim_task: TASK_PARSER,
  prompt: "Implement the parser task. Use scout's inherited architecture. Coordinate interface questions with renderer and tests.",
  context: { mode: "fork", from: "scout" },
})
await tools.team_spawn({
  name: "renderer", agent: "build", claim_task: TASK_RENDERER,
  prompt: "Implement the renderer task using the inherited contract. Keep ownership to renderer files.",
  context: { mode: "fork", from: "scout" },
})
await tools.team_spawn({
  name: "tests", agent: "build", claim_task: TASK_TESTS,
  prompt: "Implement contract tests from the inherited architecture. Coordinate with parser and renderer through team_message.",
  context: { mode: "fork", from: "scout" },
})
```

The three sessions inherit directly from the scout, each receives its own task delta and Git worktree, and their subsequent histories are independent. The scout's report helps the lead coordinate; it is not a substitute for the native history each worker inherits. Use `plan_approval: true` on any worker that should submit its implementation plan first.

### 4. Complete, integrate, and review independently

Workers commit, complete their tasks, and report with the existing tools. After completion, the lead uses `team_shutdown`, waits for shutdown completion when necessary, and calls `team_merge` for each worker. Merge overlap checks remain in force. Once the changes are integrated, create a fresh reviewer:

```javascript
await tools.team_spawn({
  name: "reviewer", agent: "explore", worktree: false,
  prompt: "Independently review the integrated working-tree changes for correctness and missing tests. Report findings to the lead.",
  context: { mode: "fresh" },
})
```

This reviewer sees the files and its new task, without inheriting the scout's reasoning or the workers' conversation histories. Finish with the normal team lifecycle/cleanup after review.

## Compatibility and related fixes

- **V1:** original fresh-spawn behavior and permissions are retained. Inheritance and handoff return explicit V2-capability errors. No new native operation is emulated.
- **V2:** 15 registered tools; members receive the 6 worker tools, 3 inspection tools, and handoff. Lead-only authorization still gates spawning, shutdown, and merge.
- **Modern V2 permissions:** detect the presence of `permission.rules` before using the older method; current hosts grant member tool access through the public permission hook.
- **V2 worktrees:** pass the current `projectID` on create/remove/list/refresh and retain the branch-to-directory mapping for the existing fresh workspace adapter.
- **Upstream #41 prerequisites:** capability detection for `permission.rules`, explicit fresh worktree fallback warnings, and validation of all `depends_on` IDs before task insertion. Unknown/cross-team dependencies are rejected without partially inserting a batch.
- **Windows:** the V2 setup test closes its owned SQLite connections before deleting its temporary directory, fixing the pre-existing `EBUSY` baseline failure.

## Validation

Run the required repository checks:

```sh
bun run typecheck
bun test
bun run build
```

Run the native evaluation with a V2 executable on PATH:

```sh
bun run eval:continuity
```

For the tested Windows desktop installation:

```powershell
$env:OPENCODE_TEST_BIN = 'C:\Users\djden\AppData\Roaming\ai.opencode.desktop\cli\2.0.25\opencode-cli.exe'
bun run eval:continuity
```

The harness starts a private authenticated OpenCode server with isolated config/data, a temporary Git repository, actual native sessions and Git worktrees, and on-disk SQLite. The only simulated external service is a local deterministic model provider. OpenCode itself validates and persists compaction; the fixture returns the native summary format and records provider requests. Its cleanup removes its own sessions/worktrees and stops its server/provider.

Observed validation on 2026-10-09, Windows, Bun 1.4.2:

- Initial baseline: **849 passed, 1 failed / 850**, with the pre-existing Windows SQLite cleanup failure.
- Final unit/integration suite: **906 passed, 0 failed**, 51 files, 3,318 assertions.
- TypeScript check and production build: **passed**.
- Native OpenCode **2.0.25**: **32 checks passed**. The complete harness was not run against 2.0.26.

Native checks cover A/B/C/D/E history inheritance in three workers; exclusive checkpoints; same-session handoff, target system prompt, and native selected-model behavior; actual directory binding; independent histories; fresh review; durable compaction with recent context; SQLite reopen and admission adoption; finished sources; invalid checkpoints; dirty and divergent Git state; cleanup of known failed forks; shutdown branch preservation; merge; and absence of provider execution before isolation/task admission.

Focused tests additionally exercise unsupported V1 requests, invalid source/options/agent names, failed move/compaction/admission/cleanup, permissions, blocked task claims, recovery retries, concurrent handoff rejection, model rotation, and initialization guards. Native model-provider wiring is validated; this deterministic harness does not measure the quality of an LLM's architecture or implementation.

## Modified files

- Core API/config/storage: `src/types.ts`, `src/config.ts`, `src/schema.ts`.
- Continuity orchestration: `src/session-continuity.ts`, `src/tools/team-handoff.ts`, `src/tools/team-spawn.ts`.
- Host adapters/registration: `src/index.ts`, `src/v2-client.ts`, `src/v2-continuity.ts`, `src/v2-setup.ts`, `src/v2-tools.ts`.
- Lifecycle/task prerequisites: `src/hooks.ts`, `src/recovery.ts`, `src/tools/team-tasks-add.ts`.
- Tests: `test/continuity-prerequisites.test.ts`, `test/session-continuity.test.ts`, `test/v2-continuity.test.ts`, `test/v2-client.test.ts`, `test/v2-setup.test.ts`, `test/v2-tools.test.ts`, `test/helpers.ts`.
- Native evaluation/build config: `eval/native-continuity.ts`, `eval/native-fixture/index.ts`, `package.json`, `tsconfig.json`, `bun.lock`.
- Documentation/integration: `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `opencode.json`, this guide, and the canonical `skills/opencode-ensemble/` skill plus its synchronized `agent/skills/opencode-ensemble/` distribution copy.

## Remaining limits

- The HTTP bridge must be explicitly configured until the plugin host exposes native fork. Same-source verification is a consistency check, not automatic server discovery.
- Native creation and local SQLite persistence are not one transaction. If fork/worktree creation succeeds remotely but its acknowledgement/ID is lost, or the process dies before persisting it, Ensemble cannot guarantee immediate cleanup of that unidentified resource. In particular, a worktree creation completing after the spawn timeout is outside the proven rollback guarantee. Known-resource failure/retry paths are covered; that late-acknowledgement window is not.
- Cross-directory inheritance deliberately requires clean, identical Git HEADs. The checks do not lock Git against concurrent external edits. A same-directory `worktree: false` spawn shares the directory by explicit choice.
- Compaction requires a distinct idle source and mutates that source's native context; it cannot atomically reserve the source against unrelated external clients. Checkpoint boundaries remain native message IDs in projected history, not arbitrary token offsets or inclusive snapshots.
- Handoff changes subsequent turns; it does not rewrite the current tool call or automatically change the model. It preserves the directory, so handing a shared-directory scout to a writer does not create a worktree. Prefer forking workers for parallel implementation.
- Complete end-to-end validation currently targets OpenCode 2.0.25 with a deterministic provider. V1 compatibility is regression-tested through its adapter/tests, not a separately launched V1 server.
