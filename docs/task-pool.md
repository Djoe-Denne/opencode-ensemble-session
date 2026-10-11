# Task Pool — Deterministic Pull Scheduling

Deterministic admission control and pull-based task dispatch for teammate
pools. The plugin owns **capacity** (a hard concurrency cap) and **hand-off**
(when a member goes idle, the next eligible board task is pushed to it). The
model keeps **matching** (which task suits which member stays a judgment call,
expressed through the board). Both features are opt-in; defaults preserve the
existing behavior exactly.

## Design Principles

1. **Determinism for arithmetic, judgment for matching.** A cap and a queue
   are arithmetic — the plugin enforces them. Task affinity (which agent type
   should take which task) is judgment — the lead declares it, members can
   still claim freely.
2. **Explicit refusal over silent queueing.** When the cap is reached,
   `team_spawn` fails with a clear error. No hidden spawn queue, no hidden
   state machine: the lead decides whether to shut a member down or raise the
   cap.
3. **The board stays the single coordination primitive.** Dispatch claims a
   task through the same atomic `claimTask` path as `team_claim` and
   `claim_task` — a task can never be double-assigned across paths.
4. **Opt-in.** `autoDispatch: false` and `maxActiveMembers: 0` (unlimited)
   are the defaults. Existing teams behave identically until configured.

## Configuration

`ensemble.json` (global or project), with environment overrides:

| Key | Default | Meaning |
|-----|---------|---------|
| `maxActiveMembers` | `0` | Max members per team in non-terminal status. `0` = unlimited. Env: `OPENCODE_ENSEMBLE_MAX_MEMBERS`. |
| `autoDispatch` | `false` | Push the next eligible task to a member on busy→ready. |

## Concurrency Cap (`maxActiveMembers`)

`team_spawn` counts members whose status is not `shutdown`/`error` (that is,
members that still occupy a slot — including `shutdown_requested`, which
still owns a worktree). At or above the cap, spawn throws:

```
Active member limit reached for team "t": 3/3. Shut down a teammate or raise
maxActiveMembers before spawning.
```

The check runs after the duplicate-name check and before any worktree,
session, or fork resource is created — a refused spawn allocates nothing.

## Task Affinity (`team_task.agent`)

Migration 12 adds a nullable `agent` column to `team_task`:

- `team_tasks_add` accepts an optional `agent` per task (the agent *type*,
  e.g. `"build"`). Empty/whitespace values are stored as NULL.
- `team_tasks_list` renders it as `@agent`.
- Manual `team_claim` is unchanged — any member may claim any pending task.
  Affinity guides dispatch ordering; it never forbids a claim.

## Auto-Dispatch (`autoDispatch`)

On a member's busy→ready transition (both V1 event hook and V2 event
adapter), after the existing idle-without-report nudge:

1. **Guards** — `autoDispatch` on, member row `status = 'ready'`,
   `spawn_pending = 0`, session known to the registry.
2. **Selection** (`pickNextTask`) — tasks with `status = 'pending'` and
   `assignee IS NULL` where `agent IS NULL OR agent = <member agent>`,
   ordered: exact affinity match first, then high > medium > low, then FIFO.
3. **Atomic claim** — `claimTask` (the same invariant as `team_claim`). On a
   lost race the next candidate is tried (bounded at 5).
4. **Delivery** — fire-and-forget `promptAsync` with the member's stored
   model and a mission delta: task ID, content, complete-via
   `team_tasks_complete`, ask-the-lead-if-unclear. On delivery failure the
   claim is released back to `pending` so no task is stranded.

The nudge (report-your-findings) and the dispatch message queue in that
order when both fire; the member reports, then starts the next task. When a
member goes busy again, `reported_to_lead` resets through the existing
mechanism, so completion-loop protection stays intact.

## Auto-Scale (`autoScale`)

`autoDispatch` feeds members that already exist. `autoScale` completes the
pull model: while unassigned work remains on the board and the active-member
count is below `maxActiveMembers`, the plugin **spawns additional workers**
itself — the lead no longer has to size the team by hand.

Triggers (all cheap, guarded, one spawn in flight per team):

- a member goes idle and no task was dispatched to it;
- tasks are added (`team_tasks_add`);
- tasks become unblocked (`team_tasks_complete`).

Worker identity is deterministic: `pool-<N>` (N = highest existing + 1). The
worker's agent type comes from the task's `agent` affinity (default
`"build"`), and the spawn goes through `executeTeamSpawn` — so the
concurrency cap, worktree isolation, permission rules, spawn circuit breaker,
and rollback all apply unchanged.

**Provider spreading.** Capacity is not one number: set `modelPool` to your
providers' models with `modelAssignment: "rotate"` and workers are dealt
round-robin across them (5 providers under a cap of 20 ≈ 4 workers each).
Provider pressure stays absorbed by the existing layers: native retries with
per-member visibility (`retry_*` columns, rate-limit toasts), the token
bucket on team tools, and the spawn circuit breaker.

**Scale-down is left to the lead.** Idle workers persist (their worktrees
hold unmerged branches); size the cap to what you are willing to keep warm,
and use `team_shutdown`/`team_cleanup` to reclaim.

## Non-Goals (v1)

- **Per-agent-type caps** — one global cap; per-slot pools need demand.
- **Queued spawns** — refused, not buffered.
- **Continuity-aware chaining** — dispatch reuses the member's current
  session as-is. Per-task `fork`/`checkpoint`/`handoff` chaining (fresh
  context per unrelated task) is future work; until then, prefer shutting a
  member down between unrelated missions over long unbounded sessions.
- **Auto-shutdown at queue drain** — the lead shuts down; dispatch never
  terminates members.

## Testing

- `test/dispatch.test.ts` — selection order (affinity, priority, FIFO),
  claim/deliver, race fallback, delivery-failure release, guard no-ops.
- `test/pool.test.ts` — worker naming, feed-before-spawn ordering, scale-up
  to the cap, cap refusal, empty-board refusal, affinity-derived agent type.
- `test/tools/team-spawn.test.ts` — cap refusal below/at/above, unlimited
  default, refused spawn allocates no worktree.
- `test/tools/team-tasks.test.ts` — `agent` stored, rendered in list.
- `test/config.test.ts` — parsing + env override.
