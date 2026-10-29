# Diagnose a denied tool or MCP call

Do not treat every tool failure as a permission problem. A missing tool, a user
rejection, an operating-system file-access refusal, a remote 401/403 and an
Ensemble isolation refusal have different possible causes. Do not respond by
granting broad permissions, changing profiles or restarting MCP servers blindly.

In an approved long-run mission, necessary non-secret local reads and read-only
diagnostics already have mission authorization; do not add a chat approval before
using a normally permitted tool. This does not override native enforcement.
A generic `Permission.DeclinedError` alone does not identify the cause, an explicit
human rejection or a missing mission mandate. Inspect available diagnostic
evidence and report the observed boundary accurately. An actual native denial
still binds even when unexplained: do not retry a confirmed refusal or switch
tools to evade it. Escalate only if the specific action is indispensable and no
compliant authorized alternative remains; keep unaffected work moving. A failed
test or missing acceptance proof similarly blocks the affected acceptance, not
all permitted analysis or research.

Approved V2 long runs reconcile native session access: wildcard access for the
lead (preserving explicit session denies), effective profile/session permissions
for workers with routine asks allowed. Planning/reporting restrictions and native
hard denies remain. Drafts cannot activate grants; approved revocation and cleanup
restore owned overrides. Do not change global permissions as an incident workaround.
Pending requests are not automatically answered or represented as user consent.

On V2, the running plugin appends recognized incidents to
`~/.config/opencode/diagnostics/permissions/YYYY-MM-DD.jsonl` (UTC; adjacent to a
custom database when configured). The journal includes safe native call/session
IDs, agent identity and known ownership, tool/catalogue namespace and symptom.
It excludes arguments, resource values, raw errors, prompts and credentials.

If your existing permissions allow local command execution, use the read-only
CLI from the repository:

```sh
bun run diagnose:permissions -- --session ses_example --limit 25
bun run diagnose:permissions -- --project "C:/path/to/project" --json
```

Do not use it to bypass a read-only profile. A restricted worker reports the
specific blocked action to the lead through its permitted reporting channel.
The lead can inspect the journal and correlate native session/call IDs with
authorized history and the relevant agent/configuration policy. Explain findings
in everyday language, with the actual action and boundary, not a wall of IDs.

`reported_tool_error` means a wrapper reported an error, not that the precise
native permission rule has been established. Missing namespace/identity stays
unknown. A bare tool-unavailable incident can also mean an incorrect tool name,
visibility or connection issue. Configured denies can bypass evaluation hooks;
the logger also observes native final tool errors, but opaque/missing native
events and unrecognizable errors remain limits. Empty logs do not prove absence.
`permission_declined` deliberately does not mean a human veto: the native tag can
also mean service closure. The journal recognizes tagged native errors and the
real Code Mode `execute` envelope (`metadata.error=true` and exact decline text),
not successful prose merely quoting that tag.

Use `team_status` for the last persisted supervisor recovery check and skip reason.
For approved long runs, blocked/attention/critical labels do not suppress an idle
supervisor's diagnostic wake. Native active sessions, unavailable activity and
the persisted ten-minute wake cooldown remain meaningful exclusions.

The CLI changes no rights and retries no actions. Partial logs are reported with
exit code 2; invalid arguments/unreadable directories use 1. Do not replay failed
calls merely to populate a report, upload logs automatically, or delete journal
history without an explicit authorized cleanup request.
