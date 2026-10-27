# Permission failure diagnostics (V2)

Ensemble keeps a local journal of observable tool-permission failures and provides
a **read-only** command to inspect it. No permission is granted, no agent profile
is changed, no MCP is reconfigured, and no failed call is retried by this feature.
It adds no team tool and does not require an additional MCP server.

## Where the journal is saved

With the default database location, incidents are appended to:

```text
~/.config/opencode/diagnostics/permissions/YYYY-MM-DD.jsonl
```

Dates are UTC. The directory/file is created on the first recognized incident,
not for successful calls or pending authorization. It is shared across projects,
with project/session identifiers inside each record. A custom database path puts
the default journal under that database's directory instead. Programmatic V2
`setupEnsemble` callers can supply `permissionLogDir`; `false` disables recording.
In-memory test instances default to disabled unless a journal path is supplied.
This is not a new `opencode.json` permission setting.

The journal is append-only with no automatic deletion or retention purge. New
files/directories request owner-only POSIX modes; existing permissions are not
rewritten, and Windows access follows the user's filesystem ACLs. Treat the logs
as private operational data: project paths and agent identities may themselves
be sensitive. Nothing is uploaded automatically.

## What an incident tells you

- When it happened, the observing plugin directory, native session and parent
  session when known, and the native agent profile when available.
- The owning team/member when a native sub-agent can be linked to an Ensemble
  worker through known session ancestry. Unknown identities remain unknown;
  the parent's profile is not presented as the child's profile.
- The effective tool name, catalogue namespace and configured tool permission
  action when exposed by the public tool catalogue. A namespace is a grouping,
  not proof of a remote MCP server's identity. Missing namespace/action metadata
  remains `null` rather than being guessed.
- Native call/message IDs for correlating the incident with OpenCode's history.
- A symptom category and observation source, plus an error fingerprint. The
  fingerprint supports correlation without storing the raw error text.

Categories distinguish a permission refusal, user rejection, operating-system
file-access refusal, external service authorization failure (401/403), unavailable
tool and Ensemble's explicit descendant-isolation refusal. **An unavailable tool
is not necessarily a permission problem**: visibility, naming or connection can
also be involved. A generic refusal does not identify the precise configured rule.

Arguments, resource values/patterns, tool results, prompts, reasoning, raw error
messages, stack traces and credentials are not persisted. Use the session/call
IDs to inspect the relevant native history and agent policy through authorized
tools when more detail is needed. Do not infer that broader permissions are the
right fix merely because an incident exists.

## Inspect incidents

From this repository:

```sh
bun run diagnose:permissions
bun run diagnose:permissions -- --session ses_example --limit 25
bun run diagnose:permissions -- --project "C:/path/to/project" --json
bun run diagnose:permissions -- --log-dir "C:/path/to/journal" --json
```

The build also emits `dist/permission-diagnostics-cli.js`, runnable with Bun when
that bundle is available. `--help` lists the filters. The default display contains
the latest 50 matching incidents; `--limit` accepts 1–1000. JSON output is restricted
to the documented safe record fields, even if a log was manually extended.

The reader streams dated files, bounds the selected records, groups duplicate
observations of the same incident, and does not create or migrate a database.
Exit code 0 means the read completed, 1 means invalid arguments or a directory
access failure, and 2 means partial results due to malformed lines/unreadable
files. A missing journal is reported as empty, not created. Empty output is not
proof that no unobserved failure occurred.

## Capture and limits

The V2 tool error hook records failed calls, including native sub-agents outside
Ensemble. Native final tool states from `session.message.content.updated` provide
an additional path for configured denies: OpenCode explicitly skips permission
evaluation hooks for configured `deny` rules, so those hooks alone cannot audit
refusals. Ensemble's own descendant-isolation refusals are recorded before the
same original error is rethrown. Pending `ask` decisions are not logged as denies.

Recognized structured errors returned inside an otherwise completed wrapper
(for example Code Mode) are labelled `reported_tool_error`, not independently
confirmed native refusals. Ordinary successful prose containing words such as
"permission denied" is ignored. If the host only exposes the outer wrapper, its
tool name is retained; the inner MCP/tool is not invented or extracted from code
arguments. Opaque output, a custom error with no recognizable denial signal,
an intent that never becomes a tool call, or a host rejection that exposes no
hook/final error state cannot be fully reconstructed by this plugin.

Agent identity is observed from public context/agent events or the matching
member row; ancestry depends on observed session creation events. Native events
are scoped to the observing location or known local ownership to avoid logging
unrelated projects from a shared event stream. The catalogue is sampled at setup;
new or unexposed namespaces can remain unknown until a later reload. This is a
diagnostic aid, not a complete security audit or proof of the rule that matched.

An incident ID groups matching call/category observations. The in-memory replay
cache is bounded and resets on reload; multiple processes/replays may append the
same incident ID, which the reader deduplicates in its selected result window.
Independent attempts with distinct call IDs remain separate. Storage failures
emit one bounded warning per plugin instance and never replace the actual tool
error; no complete journal can be promised if storage is unavailable.

Capture runs while the V2 plugin is loaded. It is not retrospective, does not
operate with OpenCode stopped, and does not claim full V1 host coverage.
