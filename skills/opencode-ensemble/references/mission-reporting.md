# Supervisor checkpoint and decision reports

Give the user enough context to decide without reconstructing worker transcripts,
reading previous reports, or seeing the agent's private reasoning. Write for the
person making the decision, not for another agent executing a task.
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

## Human-readable decisions, not operator shorthand

- Use the user's language, natural sentences, normal spaces and paragraphs.
  Never glue words together or pack a paragraph with slash-separated codes to
  save tokens. Short is useful only if the meaning remains understandable.
- Start with the mission's purpose, the concrete current problem, its practical
  consequences, why a user decision is necessary, and your recommendation.
  Metadata is not an introduction. State what is known and what is uncertain;
  give a concise evidence-based reason, not private reasoning or a transcript.
- Name the feature or work in ordinary words first. Internal task/acceptance IDs,
  worker names and report numbers are optional references in parentheses, never
  the subject the user must decode. For example, say "the image import check
  (I2)" rather than simply "I2". A severity label alone does not explain impact.
- Avoid jargon when an everyday phrase is sufficient. Explain unavoidable terms
  and acronyms at first use, and add a short glossary only if several necessary
  terms would otherwise obscure the choice. Do not create a vocabulary lesson
  for a question that can be asked simply.
- The chat summary **and the question itself**, including a question-tool
  payload, must be understandable without opening the linked report. Restate
  the concrete situation and exact choice in the question even when the previous
  chat turn summarized it. Use descriptive link text, not just "report 52".
- Option labels describe actual actions in everyday words, not "A/B", task IDs
  or "approve the report". Use option descriptions for the effect, material
  tradeoffs and limits. Explain what changes, what remains unchanged, and the
  consequence of refusing or deferring when relevant. Keep required exact
  security/approval labels intact when a tool explicitly mandates them; explain
  their meaning in the surrounding question instead of changing the protocol.
- Give a recommendation and a brief reason. Preserve material scope, budget,
  safety, permission and evidence limits; simplicity must not erase them. Do not
  invent timings/costs or turn a code-review hypothesis into a tested failure.
- Keep hashes, commits, exact paths, commands, task IDs and detailed evidence in
  a technical appendix or evidence section, unless essential to the choice. A
  report link is supplementary evidence, never required homework before answering.

### Example: same decision, different presentation

**Not sufficient:** "T4 BLOCK C-1 HIGH; approve HTTP SDK for AC7?"

**Understandable:** "Code review found a risk: a web request might keep working
after the service is stopped. Fixing it requires a targeted change to the shared
library that handles web requests, which is outside the approved scope. The
failure has not yet been reproduced in a test. I recommend allowing that change,
with a test that first demonstrates the problem, then checks the fix. Without
it, we cannot claim the shutdown guarantee is complete. May I extend the work to
include this targeted fix?"

Possible option labels: "Allow the targeted fix" / "Defer the fix". Their
descriptions explain the added shared-code work and verification versus leaving
the mission incomplete on that guarantee. If "shared library" is necessary and
unfamiliar, explain it inline as code reused by several parts of the product.
This is a writing example, not a new finding, test result or execution approval.

## Minimal Markdown structure

```markdown
# <Plain-language mission purpose> — <situation / decision>

## In brief
What we are trying to achieve, what happened, the practical impact,
and the recommended next action. This must make sense on its own.

## Small glossary (only if useful)
Necessary unfamiliar terms explained in one short everyday phrase each.

## Decision requested (only for a genuine decision outside the delegated mandate)
Concrete context and exact question, without requiring prior reading.
Realistic actions and their consequences: what changes/stays unchanged,
scope, risk, time/cost if known, and what happens if we defer or refuse.
Recommended action and brief reason; label estimates and uncertainties.

## Verified results, limits and next step
Observed facts versus hypotheses; checks not executed and remaining risks.
If no decision is needed, state the next autonomous step instead of asking for a go.

## Technical details and evidence (as needed)
Date, mission/task IDs, relevant code/policy revisions and proof references.
Separate implementation, verification and integration; explain reused evidence.
```

Adapt headings to the user's language and omit unnecessary sections. Keep it
proportional: a small clarification needs a short report, not a dossier.
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
