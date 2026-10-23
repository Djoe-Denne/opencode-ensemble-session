import type { Database } from "./db"

/**
 * Classify rows that already exist when migration 21 runs.
 * Safe to re-run: it only copies branch names and sets worktree_state.
 */
export const WORKTREE_STATE_BACKFILL_SQL = `
UPDATE team_member SET preserved_branch = worktree_branch WHERE worktree_branch LIKE 'ensemble/preserved/%';
UPDATE team_member SET checkout_branch = worktree_branch WHERE worktree_branch IS NOT NULL AND worktree_branch NOT LIKE 'ensemble/preserved/%';
UPDATE team_member SET worktree_state = CASE
  WHEN agent IN ('plan', 'explore') THEN 'off'
  WHEN preserved_branch IS NOT NULL THEN 'preserved'
  WHEN worktree_dir IS NOT NULL AND checkout_branch IS NOT NULL THEN 'ready'
  WHEN worktree_dir IS NULL AND checkout_branch IS NULL AND preserved_branch IS NULL THEN 'off'
  ELSE 'failed'
END;`

/** Migration SQL statements, applied in order. Version = index + 1. */
export const MIGRATIONS: string[] = [
  // Migration 1: Initial schema — 4 tables
  `
  CREATE TABLE IF NOT EXISTS team (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    lead_session_id TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    delegate        INTEGER NOT NULL DEFAULT 0,
    time_created    INTEGER NOT NULL,
    time_updated    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS team_lead_idx ON team(lead_session_id);
  CREATE INDEX IF NOT EXISTS team_status_idx ON team(status);

  CREATE TABLE IF NOT EXISTS team_member (
    team_id          TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    agent            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'ready'
                       CHECK(status IN ('ready', 'busy', 'shutdown_requested', 'shutdown', 'error')),
    execution_status TEXT NOT NULL DEFAULT 'idle'
                       CHECK(execution_status IN ('idle', 'starting', 'running',
                         'cancel_requested', 'cancelling', 'cancelled',
                         'completing', 'completed', 'failed', 'timed_out')),
    model            TEXT,
    prompt           TEXT,
    time_created     INTEGER NOT NULL,
    time_updated     INTEGER NOT NULL,
    PRIMARY KEY (team_id, name)
  );
  CREATE INDEX IF NOT EXISTS team_member_session_idx ON team_member(session_id);
  CREATE INDEX IF NOT EXISTS team_member_status_idx ON team_member(team_id, status);

  CREATE TABLE IF NOT EXISTS team_task (
    id            TEXT PRIMARY KEY,
    team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    content       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'blocked')),
    priority      TEXT NOT NULL DEFAULT 'medium'
                    CHECK(priority IN ('high', 'medium', 'low')),
    assignee      TEXT,
    depends_on    TEXT,
    time_created  INTEGER NOT NULL,
    time_updated  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS team_task_team_idx ON team_task(team_id);
  CREATE INDEX IF NOT EXISTS team_task_assignee_idx ON team_task(assignee);
  CREATE INDEX IF NOT EXISTS team_task_status_idx ON team_task(team_id, status);

  CREATE TABLE IF NOT EXISTS team_message (
    id            TEXT PRIMARY KEY,
    team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    from_name     TEXT NOT NULL,
    to_name       TEXT,
    content       TEXT NOT NULL,
    delivered     INTEGER NOT NULL DEFAULT 0,
    time_created  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS team_message_team_idx ON team_message(team_id);
  CREATE INDEX IF NOT EXISTS team_message_to_idx ON team_message(to_name);
  CREATE INDEX IF NOT EXISTS team_message_undelivered_idx ON team_message(team_id, delivered)
    WHERE delivered = 0;
  `,
  // Migration 2: Add read column to team_message for team_results tracking
  `ALTER TABLE team_message ADD COLUMN read INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS team_message_unread_idx ON team_message(team_id, read) WHERE read = 0;`,
  // Migration 3: Add worktree columns to team_member for git worktree isolation
  `ALTER TABLE team_member ADD COLUMN worktree_dir TEXT;
   ALTER TABLE team_member ADD COLUMN worktree_branch TEXT;`,
  // Migration 4: Add plan_approval column to team_member for plan-before-build workflow
  `ALTER TABLE team_member ADD COLUMN plan_approval TEXT NOT NULL DEFAULT 'none'
     CHECK(plan_approval IN ('none', 'pending', 'approved', 'rejected'));`,
  // Migration 5: Track lead's agent mode so message delivery preserves it
  `ALTER TABLE team ADD COLUMN lead_agent TEXT;`,
  // Migration 6: Track workspace ID for worktree-session binding
  `ALTER TABLE team_member ADD COLUMN workspace_id TEXT;`,
  // Migration 7: Track whether teammate has reported to lead (completion loop prevention, issue #3)
  `ALTER TABLE team_member ADD COLUMN reported_to_lead INTEGER NOT NULL DEFAULT 0;`,
  // Migration 8: Add project as the dashboard grouping level. For this initial
  // project-first step, project_id is the team lead's working directory.
  `PRAGMA foreign_keys=OFF;
   ALTER TABLE team RENAME TO team_old_m8;
   CREATE TABLE IF NOT EXISTS project (
     id              TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     path            TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
     time_created    INTEGER NOT NULL,
     time_updated    INTEGER NOT NULL
   );
   INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated)
     VALUES ('default', 'Default Project', '', 'active', strftime('%s','now') * 1000, strftime('%s','now') * 1000);
   CREATE TABLE team (
     id              TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     project_id      TEXT NOT NULL DEFAULT 'default' REFERENCES project(id) ON DELETE CASCADE,
     lead_session_id TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
     delegate        INTEGER NOT NULL DEFAULT 0,
     time_created    INTEGER NOT NULL,
     time_updated    INTEGER NOT NULL,
     lead_agent      TEXT
   );
   INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
     SELECT id, name, 'default', lead_session_id, status, delegate, time_created, time_updated, lead_agent FROM team_old_m8;
   DROP TABLE team_old_m8;

   ALTER TABLE team_member RENAME TO team_member_old_m8;
   CREATE TABLE team_member (
     team_id          TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     name             TEXT NOT NULL,
     session_id       TEXT NOT NULL,
     agent            TEXT NOT NULL,
     status           TEXT NOT NULL DEFAULT 'ready'
                        CHECK(status IN ('ready', 'busy', 'shutdown_requested', 'shutdown', 'error')),
     execution_status TEXT NOT NULL DEFAULT 'idle'
                        CHECK(execution_status IN ('idle', 'starting', 'running',
                          'cancel_requested', 'cancelling', 'cancelled',
                          'completing', 'completed', 'failed', 'timed_out')),
     model            TEXT,
     prompt           TEXT,
     time_created     INTEGER NOT NULL,
     time_updated     INTEGER NOT NULL,
     worktree_dir     TEXT,
     worktree_branch  TEXT,
     plan_approval    TEXT NOT NULL DEFAULT 'none'
                        CHECK(plan_approval IN ('none', 'pending', 'approved', 'rejected')),
     workspace_id     TEXT,
     reported_to_lead INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (team_id, name)
   );
   INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead)
     SELECT team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead FROM team_member_old_m8;
   DROP TABLE team_member_old_m8;

   ALTER TABLE team_task RENAME TO team_task_old_m8;
   CREATE TABLE team_task (
     id            TEXT PRIMARY KEY,
     team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     content       TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'blocked')),
     priority      TEXT NOT NULL DEFAULT 'medium'
                     CHECK(priority IN ('high', 'medium', 'low')),
     assignee      TEXT,
     depends_on    TEXT,
     time_created  INTEGER NOT NULL,
     time_updated  INTEGER NOT NULL
   );
   INSERT INTO team_task (id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated)
     SELECT id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated FROM team_task_old_m8;
   DROP TABLE team_task_old_m8;

   ALTER TABLE team_message RENAME TO team_message_old_m8;
   CREATE TABLE team_message (
     id            TEXT PRIMARY KEY,
     team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     from_name     TEXT NOT NULL,
     to_name       TEXT,
     content       TEXT NOT NULL,
     delivered     INTEGER NOT NULL DEFAULT 0,
     time_created  INTEGER NOT NULL,
     read          INTEGER NOT NULL DEFAULT 0
   );
   INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created, read)
     SELECT id, team_id, from_name, to_name, content, delivered, time_created, read FROM team_message_old_m8;
   DROP TABLE team_message_old_m8;

   CREATE INDEX IF NOT EXISTS team_lead_idx ON team(lead_session_id);
   CREATE INDEX IF NOT EXISTS team_status_idx ON team(status);
   CREATE INDEX IF NOT EXISTS team_project_idx ON team(project_id, status);
   CREATE UNIQUE INDEX IF NOT EXISTS team_active_project_name_idx ON team(project_id, name) WHERE status = 'active';
   CREATE INDEX IF NOT EXISTS team_member_session_idx ON team_member(session_id);
   CREATE INDEX IF NOT EXISTS team_member_status_idx ON team_member(team_id, status);
   CREATE INDEX IF NOT EXISTS team_task_team_idx ON team_task(team_id);
   CREATE INDEX IF NOT EXISTS team_task_assignee_idx ON team_task(assignee);
   CREATE INDEX IF NOT EXISTS team_task_status_idx ON team_task(team_id, status);
   CREATE INDEX IF NOT EXISTS team_message_team_idx ON team_message(team_id);
   CREATE INDEX IF NOT EXISTS team_message_to_idx ON team_message(to_name);
   CREATE INDEX IF NOT EXISTS team_message_undelivered_idx ON team_message(team_id, delivered) WHERE delivered = 0;
   CREATE INDEX IF NOT EXISTS team_message_unread_idx ON team_message(team_id, read) WHERE read = 0;
   PRAGMA foreign_keys=ON;`,
  // Migration 9: Add last_nudged_at to team_member — additive-only display-staleness
  // signal for the watchdog's soft stall-nudge path. Deliberately NOT a new status
  // enum value (see checkStalled() in watchdog.ts for the rationale): a 6th CHECK
  // constraint literal would require a table-rebuild migration and touch every
  // consumer that switches on the 5 known status strings. This column is additive —
  // existing consumers that don't know about it simply don't render it.
  `ALTER TABLE team_member ADD COLUMN last_nudged_at INTEGER;`,
  // Migration 10: Add retry_* columns to team_member — additive-only provider-retry
  // display signal (see hooks.ts's "retry" branch). Same non-negotiable as Migration
  // 9: no 6th status/execution_status literal, no table rebuild. retry_until is a
  // TTL, not a stored enum — "currently retrying" is derived at read time
  // (retry_until > Date.now()), so there is no explicit clear-write anywhere in this
  // fix; it simply becomes stale and gets superseded by real activity or by time
  // elapsing.
  `ALTER TABLE team_member ADD COLUMN retry_until INTEGER;
   ALTER TABLE team_member ADD COLUMN retry_attempt INTEGER;
   ALTER TABLE team_member ADD COLUMN retry_provider TEXT;
    ALTER TABLE team_member ADD COLUMN retry_message TEXT;`,
  // Migration 11: native history stays in OpenCode; only provenance and admission intent live here.
  `ALTER TABLE team_member ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'fresh';
   ALTER TABLE team_member ADD COLUMN source_session_id TEXT;
   ALTER TABLE team_member ADD COLUMN context_message_id TEXT;
   ALTER TABLE team_member ADD COLUMN spawn_pending INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE team_member ADD COLUMN handoff_pending TEXT;
   ALTER TABLE team ADD COLUMN handoff_pending TEXT;`,
  // Migration 12: task affinity for the pull-based pool (docs/task-pool.md).
  // Nullable agent *type* — NULL means "any member may be auto-dispatched".
  // Guides dispatch ordering only; manual team_claim stays unrestricted.
  `ALTER TABLE team_task ADD COLUMN agent TEXT;`,
  // Migration 13: routing inputs and native variant/provenance. No review policy.
  `ALTER TABLE team_task ADD COLUMN complexity INTEGER CHECK(complexity IS NULL OR (typeof(complexity) = 'integer' AND complexity BETWEEN 0 AND 100));
   ALTER TABLE team_task ADD COLUMN risk INTEGER CHECK(risk IS NULL OR (typeof(risk) = 'integer' AND risk BETWEEN 0 AND 100));
   ALTER TABLE team_member ADD COLUMN model_variant TEXT;
    ALTER TABLE team_member ADD COLUMN model_routing TEXT;`,
  // Migration 14: mission snapshot and independent task-classification admission.
  `ALTER TABLE team ADD COLUMN classification_policy TEXT;
   ALTER TABLE team ADD COLUMN mission_mode TEXT NOT NULL DEFAULT 'supervised' CHECK(mission_mode IN ('supervised', 'long_run'));
   ALTER TABLE team ADD COLUMN mission_state TEXT NOT NULL DEFAULT 'running' CHECK(mission_state IN ('running', 'attention', 'critical'));
   ALTER TABLE team ADD COLUMN classification_runtime TEXT;
   ALTER TABLE team_task ADD COLUMN task_type TEXT;
   ALTER TABLE team_task ADD COLUMN classification_input TEXT;
   ALTER TABLE team_task ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'not_required' CHECK(classification_status IN ('not_required', 'pending', 'running', 'completed', 'blocked'));
   ALTER TABLE team_task ADD COLUMN classification_result TEXT;
   ALTER TABLE team_task ADD COLUMN classification_error TEXT;
   ALTER TABLE team_task ADD COLUMN classification_token TEXT;
   ALTER TABLE team_task ADD COLUMN classification_until INTEGER;
   ALTER TABLE team_task ADD COLUMN classification_attempts INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE classification_incident (
     id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     task_id TEXT, kind TEXT NOT NULL, method TEXT NOT NULL, detail TEXT NOT NULL, time_created INTEGER NOT NULL
   );
   CREATE INDEX classification_incident_team ON classification_incident(team_id, time_created);
   CREATE TABLE classification_helper (
     session_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     task_id TEXT NOT NULL, lease_until INTEGER NOT NULL
   );
    CREATE INDEX task_classification_queue ON team_task(team_id, classification_status);`,
  // Migration 15: opt-in mission policy, explicit approval and task-level routing history.
  `CREATE TABLE mission_policy (
      team_id TEXT PRIMARY KEY REFERENCES team(id) ON DELETE CASCADE,
      objective TEXT NOT NULL, policy_path TEXT NOT NULL,
      presented_hash TEXT, approved_hash TEXT, approved_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0, time_updated INTEGER NOT NULL
    );
    CREATE TABLE mission_policy_revision (
      team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, policy_hash TEXT NOT NULL, policy_json TEXT NOT NULL,
      time_created INTEGER NOT NULL, PRIMARY KEY(team_id, revision)
    );
     ALTER TABLE team_task ADD COLUMN model_routing TEXT;`,
  // Migration 16: capability-compatible reporting and durable native result candidates.
  `ALTER TABLE team_member ADD COLUMN report_mode TEXT NOT NULL DEFAULT 'team_message' CHECK(report_mode IN ('team_message', 'final_response'));
   ALTER TABLE team_member ADD COLUMN report_started_at INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE team_member ADD COLUMN report_generation INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE team_member ADD COLUMN report_message_cursor INTEGER NOT NULL DEFAULT 0;
   UPDATE team_member SET report_started_at = time_created;
   CREATE TABLE member_result (
     id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     member_name TEXT NOT NULL, session_id TEXT NOT NULL, native_message_id TEXT NOT NULL,
     task_ids TEXT NOT NULL, content TEXT NOT NULL, report_generation INTEGER NOT NULL, time_created INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0,
     UNIQUE(session_id, native_message_id)
   );`,
  // Migrations 17–20: intentional no-ops. The installed plugin already consumed
  // user_version 15–20 with a different history. A checkout database at 16 must
  // advance through these slots; a database already at 20 runs only migration 21.
  // Do not copy the installed SQL into these slots, and do not apply migration 21
  // to the live ~/.config/opencode/ensemble.db from this session.
  `SELECT 1;`,
  `SELECT 1;`,
  `SELECT 1;`,
  `SELECT 1;`,
  // Migration 21: additive worktree state and provider-attempt journal.
  `ALTER TABLE team_member ADD COLUMN worktree_state TEXT NOT NULL DEFAULT 'failed' CHECK(worktree_state IN ('off', 'failed', 'ready', 'preserved', 'released'));
   ALTER TABLE team_member ADD COLUMN checkout_branch TEXT;
   ALTER TABLE team_member ADD COLUMN preserved_branch TEXT;
   ALTER TABLE team_member ADD COLUMN short_path TEXT;
   ALTER TABLE team_member ADD COLUMN toolchain_link TEXT;
   ${WORKTREE_STATE_BACKFILL_SQL}
   CREATE TABLE member_provider_attempt (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     team_id TEXT NOT NULL,
     member_name TEXT NOT NULL,
     task_id TEXT,
     kind TEXT NOT NULL CHECK(kind IN ('retry', 'failover', 'stop')),
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     variant TEXT,
     detail TEXT NOT NULL,
     time_created INTEGER NOT NULL
   );
   ALTER TABLE member_result ADD COLUMN origin TEXT;
    ALTER TABLE member_result ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;`,
  // Migration 22: proposals and supervisor decisions are separate from admitted assignments.
  `ALTER TABLE team_task ADD COLUMN execution_request TEXT;
   ALTER TABLE team_task ADD COLUMN execution_decision TEXT;`,
  // Migration 23: a cleanup retry must not squash-merge the same changes again.
  `ALTER TABLE team_member ADD COLUMN merge_applied INTEGER NOT NULL DEFAULT 0 CHECK(merge_applied IN (0, 1));`,
  // Migration 24: one initial preparation import per mission, kept apart from admission.
  `CREATE TABLE preparation_import (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL UNIQUE REFERENCES team(id) ON DELETE CASCADE,
      document_hash TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      document_json TEXT NOT NULL,
      context TEXT NOT NULL,
      open_questions_json TEXT NOT NULL,
      parallel_groups_json TEXT NOT NULL,
      time_created INTEGER NOT NULL
    );
    CREATE TABLE preparation_task (
      import_id TEXT NOT NULL REFERENCES preparation_import(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      pm_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      goal TEXT NOT NULL,
      planning_required INTEGER NOT NULL CHECK(planning_required IN (0, 1)),
      planning_reason TEXT NOT NULL,
      acceptance_json TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      handoff_json TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK(disposition IN ('authorized', 'held')),
      decision_json TEXT NOT NULL,
      hold_reason TEXT,
      PRIMARY KEY (import_id, pm_id),
      UNIQUE (team_id, pm_id)
    );`,
  // Migration 25: one bounded preparation session per mission, before admission.
  `CREATE TABLE preparation_run (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL UNIQUE REFERENCES team(id) ON DELETE CASCADE,
      session_id TEXT,
      agent TEXT NOT NULL,
      model_id TEXT NOT NULL,
      variant TEXT,
      mandate TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'exhausted', 'imported', 'cancelled')),
      attempts INTEGER NOT NULL,
      supervisor_used INTEGER NOT NULL DEFAULT 0 CHECK(supervisor_used IN (0, 1)),
      candidate_json TEXT,
      errors_json TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );`,
]

/**
 * Apply pending migrations to the database.
 * Uses PRAGMA user_version to track which migrations have been applied.
 */
export function applyMigrations(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number }

  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this plugin supports (${MIGRATIONS.length}). Upgrade opencode-ensemble before continuing.`)
  }

  for (let i = current; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i]
    const { foreign_keys: foreignKeys } = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }

    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("BEGIN IMMEDIATE")
    try {
      if (migration) db.exec(migration)
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    } finally {
      db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`)
    }
  }
}
