import { describe, expect, test } from "bun:test"
import { setupDb, insertTeam, insertMember } from "./helpers"
import { MIGRATIONS, WORKTREE_STATE_BACKFILL_SQL } from "../src/schema"

describe("checkout schema bridge", () => {
  test("registers the no-op bridge and the additive worktree migration", () => {
    expect(MIGRATIONS).toHaveLength(22)
    const db = setupDb()
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 22 })
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'member_provider_attempt'").get()).toEqual({ name: "member_provider_attempt" })
    const columns = db.query("PRAGMA table_info(team_member)").all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(["worktree_state", "checkout_branch", "preserved_branch", "short_path", "toolchain_link"]))
    const resultColumns = db.query("PRAGMA table_info(member_result)").all() as Array<{ name: string }>
    expect(resultColumns.map(column => column.name)).toEqual(expect.arrayContaining(["origin", "superseded"]))
  })

  test("classifies existing rows without replacing a live checkout name", () => {
    const db = setupDb()
    insertTeam(db, "t1", "bridge", "lead")
    insertMember(db, "t1", "writer", "sess-writer")
    insertMember(db, "t1", "reader", "sess-reader")
    insertMember(db, "t1", "kept", "sess-kept")
    insertMember(db, "t1", "partial", "sess-partial")
    db.run("UPDATE team_member SET agent = 'explore' WHERE name = 'reader'")
    db.run("UPDATE team_member SET worktree_branch = 'ensemble/preserved/bridge/writer', worktree_dir = '/tmp/wt' WHERE name = 'writer'")
    db.run("UPDATE team_member SET worktree_branch = 'ensemble-reader', worktree_dir = '/tmp/reader' WHERE name = 'reader'")
    db.run("UPDATE team_member SET worktree_branch = 'ensemble-kept', worktree_dir = '/tmp/kept' WHERE name = 'kept'")
    db.run("UPDATE team_member SET worktree_dir = '/tmp/partial' WHERE name = 'partial'")
    db.exec(WORKTREE_STATE_BACKFILL_SQL)

    expect(db.query("SELECT preserved_branch, checkout_branch, worktree_branch, worktree_state FROM team_member WHERE name = 'writer'").get()).toEqual({
      preserved_branch: "ensemble/preserved/bridge/writer",
      checkout_branch: null,
      worktree_branch: "ensemble/preserved/bridge/writer",
      worktree_state: "preserved",
    })
    expect(db.query("SELECT worktree_state, checkout_branch FROM team_member WHERE name = 'reader'").get()).toEqual({
      worktree_state: "off",
      checkout_branch: "ensemble-reader",
    })
    expect(db.query("SELECT worktree_state FROM team_member WHERE name = 'kept'").get()).toEqual({ worktree_state: "ready" })
    expect(db.query("SELECT worktree_state FROM team_member WHERE name = 'partial'").get()).toEqual({ worktree_state: "failed" })
  })
})
