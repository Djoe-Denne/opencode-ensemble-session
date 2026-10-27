# Diagnose a denied tool or MCP call

Do not treat every tool failure as a permission problem. A missing tool, a user
rejection, an operating-system file-access refusal, a remote 401/403 and an
Ensemble isolation refusal have different possible causes. Do not respond by
granting broad permissions, changing profiles or restarting MCP servers blindly.

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

The CLI changes no rights and retries no actions. Partial logs are reported with
exit code 2; invalid arguments/unreadable directories use 1. Do not replay failed
calls merely to populate a report, upload logs automatically, or delete journal
history without an explicit authorized cleanup request.
