import type { Database } from "./db"
import { generateId } from "./util"

/** Publication and acceptance are independent of dependency/execution status. */
export interface TaskPublication {
  publication?: "published" | "deferred"
  completion_policy?: "assignee" | "lead"
}

/** Supervisor-only, justified changes before a task's first admission. */
export interface TaskControl extends TaskPublication {
  task_id: string
  reason: string
}

/** Validate both native-tool and preparation publication fields. */
export function taskPublication(value: { publication?: unknown; completion_policy?: unknown }): TaskPublication {
  if (value.publication !== undefined && value.publication !== "published" && value.publication !== "deferred") throw new Error("publication must be published or deferred")
  if (value.completion_policy !== undefined && value.completion_policy !== "assignee" && value.completion_policy !== "lead") throw new Error("completion_policy must be assignee or lead")
  return {
    ...(value.publication !== undefined ? { publication: value.publication } : {}),
    ...(value.completion_policy !== undefined ? { completion_policy: value.completion_policy } : {}),
  }
}

/** Validate a complete control batch before any writes or native awaits. */
export function validateTaskControls(controls: readonly TaskControl[]): void {
  if (new Set(controls.map(control => control.task_id)).size !== controls.length) throw new Error("Duplicate task control IDs")
  controls.forEach(control => {
    taskPublication(control)
    if (typeof control.task_id !== "string" || !control.task_id.trim()) throw new Error("Task control requires task_id")
    if (control.publication === undefined && control.completion_policy === undefined) throw new Error("Task control requires a publication or completion policy change")
    if (typeof control.reason !== "string" || !control.reason.trim() || control.reason.length > 2000) throw new Error("Task control requires a reason of 1 to 2000 characters")
  })
}

/** Apply controls inside the caller's transaction; never cancel, resolve or rewrite dependencies. */
export function applyTaskControls(db: Database, teamId: string, actor: string, controls: readonly TaskControl[], now: number): void {
  controls.forEach(control => {
    const before = db.query(`SELECT publication, completion_policy, control_revision, status, assignee, model_routing, admitted_at, classification_status
      FROM team_task WHERE team_id=? AND id=?`).get(teamId, control.task_id) as {
      publication: string; completion_policy: string; control_revision: number; status: string; assignee: string | null
      model_routing: string | null; admitted_at: number | null; classification_status: string
    } | null
    if (!before || !["pending", "blocked"].includes(before.status) || before.assignee || before.model_routing || before.admitted_at !== null) throw new Error("Task controls require an unassigned, never-admitted pending or blocked task")
    if (before.classification_status === "running") throw new Error("Wait for the running classification before changing task publication")
    const candidate = db.query("SELECT 1 FROM member_result, json_each(member_result.task_ids) WHERE team_id=? AND json_each.value=? LIMIT 1").get(teamId, control.task_id)
    if (candidate) throw new Error("Task controls cannot revise an admitted result candidate")
    const publication = control.publication ?? before.publication
    const completion = control.completion_policy ?? before.completion_policy
    const changed = db.run(`UPDATE team_task SET publication=?, completion_policy=?, control_revision=control_revision+1, time_updated=?
      WHERE team_id=? AND id=? AND control_revision=? AND status IN ('pending','blocked') AND assignee IS NULL
        AND model_routing IS NULL AND admitted_at IS NULL AND classification_status != 'running'`,
    [publication, completion, now, teamId, control.task_id, before.control_revision])
    if (!changed.changes) throw new Error("Task was admitted during its publication change")
    db.run(`INSERT INTO task_control_event (id, team_id, task_id, actor, reason, before_json, after_json, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [generateId("control"), teamId, control.task_id, actor, control.reason.trim(),
      JSON.stringify({ publication: before.publication, completion_policy: before.completion_policy, revision: before.control_revision }),
      JSON.stringify({ publication, completion_policy: completion, revision: before.control_revision + 1 }), now])
  })
}
