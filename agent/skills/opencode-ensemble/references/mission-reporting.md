# Supervisor checkpoint and decision reports

Give the user enough context to decide without reconstructing worker transcripts.
The lead owns these reports; workers keep their normal task-result contract.
This is an execution instruction, not a new tool, approval gate or QA pipeline.

## When and where

- Write a concise report between meaningful stages: preparation/configuration,
  implementation or integration milestone, verification, closure. Not after every
  tool call, test or worker message.
- Before **every question** to the user, first present a current decision report:
  clarification, configuration, approval, blocker, cost, scope or risk acceptance.
  Group related questions. A current checkpoint can serve both purposes.
- Default to Markdown. Save under the lead's project at
  `.opencode/missions/<team-id>/reports/NN-<stage-or-decision>.md`, or the mission's
  already agreed reporting directory. Before team creation, use the existing
  mission/project journal location; do not create a team just to obtain a path.
- Link the saved report and include the important context in chat **before** the
  question tool or textual question. Use the user's language. Do not force them
  to open a file to understand the decision.
- Keep earlier decisions traceable; do not overwrite them when inputs change.
  Reference previous reports and valid evidence instead of copying raw logs.

## Minimal Markdown structure

```markdown
# <Mission> — <stage / decision>
Date, mission ID, code/policy revision relevant to this report.

## Goal and current state
Expected result, scope, current milestone and what changed since the last report.

## Results and evidence
Observed results with source/test references; reused evidence and its applicability.
Separate implementation, verification and integration. State checks not executed.

## Limits and next step
Failures, blockers, uncertainty, remaining risks and next autonomous action.

## Decision requested (only when asking)
The exact question, realistic options, tradeoffs (scope, time, cost, risk),
recommended option and why; distinguish estimates from observed facts.
```

Keep it proportional: a small clarification needs a short report, not a dossier.
Do not rerun tests or spawn a reporter to fill these sections. Reporting a stage
does not require asking for a new approval; continue within the agreed mandate.
Report creation is not evidence of acceptance. Redact secrets/private raw data
and do not expose supervisor reports to blind authors or contaminate reviewers.
If writing is unavailable, present the full Markdown inline before the question,
state that it was not persisted, and preserve permissions rather than bypassing them.

## Canvas: running backend required

Choose Canvas only when a visual/interactive view materially helps. Follow the
host's applicable Canvas/preview instructions for the artifact format. An IDE
artifact alone does **not** satisfy the user's running-backend requirement.

1. Create the report artifact within authorized paths, with sanitized embedded
   data. Reuse an authorized preview stack; do not add dependencies or start
   Docker/Kind/project infrastructure just to display a report.
2. Start a dedicated local preview backend, or reuse a verified owned preview
   already serving this report. Bind to loopback only and expose only report
   assets, not the repository, arbitrary filesystem reads or execution APIs.
3. Check the actual HTTP response **and report content**, not just a process
   status or a guessed port. Check browser rendering when a browser is available.
4. Record command, PID/managed handle, URL and served artifact in the mission
   journal. Give the user both the saved artifact link and verified working URL
   before asking the question. Keep it available while they inspect and decide.
5. Stop only the preview process owned by this mission when no longer needed;
   record the stop. Never stop another service, kill by port alone or create a
   public tunnel. Respect project resource/lifecycle policies.

If serving is forbidden, broken or needs unapproved infrastructure, fall back to
Markdown and explain the limitation. Do not turn reporting into a backend repair
campaign, claim a URL is live without checking, or leave an untracked server.
