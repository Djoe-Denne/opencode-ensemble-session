import { describe, expect, test } from "bun:test"
import { setupDb, insertTeam, insertMember } from "./helpers"
import { observeProviderRetry } from "../src/provider-journal"

const routing = JSON.stringify({
  alternatives: [
    { id: "openai/gpt-6.1-sol", variant: "low" },
    { id: "opencode-go/gpt-6-luna", variant: "none" },
  ],
})

describe("provider journal", () => {
  test("keeps three retries on the admitted model, then pins one other provider", () => {
    const db = setupDb()
    insertTeam(db, "t1", "resilience", "lead")
    insertMember(db, "t1", "alice", "sess-alice", "busy", "running")
    db.run("UPDATE team_member SET model = 'openai/gpt-6.1-sol', model_variant = 'low', model_routing = ? WHERE name = 'alice'", [routing])

    expect(observeProviderRetry(db, { teamId: "t1", memberName: "alice", message: "Rate limit reached", attempt: 1 }).kind).toBe("retry")
    expect(observeProviderRetry(db, { teamId: "t1", memberName: "alice", message: "HTTP 500", attempt: 3 }).kind).toBe("retry")
    expect(observeProviderRetry(db, { teamId: "t1", memberName: "alice", message: "Rate limit reached", attempt: 4 })).toEqual({
      kind: "failover",
      model: { id: "opencode-go/gpt-6-luna", variant: "none" },
    })
    expect(db.query("SELECT model, model_variant FROM team_member WHERE name = 'alice'").get()).toEqual({
      model: "opencode-go/gpt-6-luna",
      model_variant: "none",
    })
    expect(observeProviderRetry(db, { teamId: "t1", memberName: "alice", message: "provider.auth rejected", attempt: 1 }).kind).toBe("stop")
    const rows = db.query("SELECT kind, provider, model FROM member_provider_attempt ORDER BY id").all()
    expect(rows).toEqual([
      { kind: "retry", provider: "openai", model: "openai/gpt-6.1-sol" },
      { kind: "retry", provider: "openai", model: "openai/gpt-6.1-sol" },
      { kind: "failover", provider: "opencode-go", model: "opencode-go/gpt-6-luna" },
      { kind: "stop", provider: "opencode-go", model: "opencode-go/gpt-6-luna" },
    ])
  })

  test("authentication fails over once when another approved provider exists", () => {
    const db = setupDb()
    insertTeam(db, "t1", "auth", "lead")
    insertMember(db, "t1", "alice", "sess-alice", "busy", "running")
    db.run("UPDATE team_member SET model = 'openai/gpt-6.1-sol', model_variant = 'low', model_routing = ? WHERE name = 'alice'", [routing])
    expect(observeProviderRetry(db, { teamId: "t1", memberName: "alice", message: "unauthorized", attempt: 1 })).toEqual({
      kind: "failover",
      model: { id: "opencode-go/gpt-6-luna", variant: "none" },
    })
    expect(observeProviderRetry(db, { teamId: "t1", memberName: "alice", message: "unauthorized", attempt: 2 }).kind).toBe("stop")
  })
})
