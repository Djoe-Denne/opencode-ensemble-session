# Profile lint

```bash
bun scripts/lint-agent-profiles.ts <agents-dir>
```

Stdout is a JSON report. Exit code 1 means at least one `error`. Warnings and info do not fail the command. Built-in `build`, `plan` and `explore` without a file are `builtin-unverified` info.

| Id | Severity | Meaning |
|---|---|---|
| `missing-ensemble-tools` | warning | Collaborator profile does not allow `execute` or a member tool. Absent when the body has `ensemble-report: final_response`. |
| `relative-glob` | error for `edit`, warning for `read` | Allow resource is not `*`, absolute, `~`, a drive, or `*`-anchored. |
| `allow-shadowed-by-deny` | warning | An allow is followed by `deny` of the same action on `*`. |
| `coded-model` | warning | Frontmatter `model:` is present. Mission policy routes teammates. |
| `model-order-conflict` | warning | The first `provider/model` in the body differs from `model:` after stripping `#variant`. |
| `execute-body-conflict` | warning | `execute` is allowed and the body forbids Code Mode or `execute`. "Ni shell" alone is not a conflict. |
| `listing-gap` | warning | `read` allow on a directory glob without a `glob` allow. |
| `restrictive-profile` | info | Final-response marker. Ensemble tools are not required. |
| `env-case-duplication` | info | `.env` denies differ only by case. Not a CI gate. |
| `unparseable` | error | Frontmatter has no closing fence. |
| `builtin-unverified` | info | Built-in agent has no project file. |

Show the report and propose a permission diff as its own approved change. Do not apply it without that approval.
