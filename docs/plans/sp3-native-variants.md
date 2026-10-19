# SP-3 — Native variants: identifiers are provider/model-specific

Status: **Proposed — observations independently reviewed; integrated checkout gate passed**.

Mission `team_mvffoozl_001l_8ws0e8`; task `task_mvffskns_001o_yr9d53`.
Worker `sp3-variants` (`dev-reader`, read-only), session
`ses_eab0743faffel2h4p51HNgDCs9`, candidate
`result_mvfgrd0g_0026_6mtmze`.

## 1. Finding and evidence levels

A native variant identifier may look like a display label. Rejecting a string
because it contains spaces, capitals or `Extra High` would reject real Cursor
variants. Validate exact membership for the **provider/model pair** instead.

The worker queried public `opencode.models` at 2026-10-19 16:22:46 UTC:
five authorized providers (`cursor`, `openai`, `opencode`, `opencode-go`,
`zai-coding-plan`) crossed with `grok`, `glm`, `gpt`; 15 searches with
`all: true, limit: 100`. It reported 61 entries, all `active`, with `next: null`
on every response. That count and the full inventory below are worker findings.

The tool exposes model `name` and `variants: string[]`, not separately named
variant `id`/display-name objects. Those strings alone do not independently
establish how the public API represents identifiers.

The lead therefore spot-checked the tool results and then consulted the actual
same-host OpenAPI and `GET /api/model`, using the absolute OpenCode 2.0.32 CLI
and its normal service discovery/authentication, without invoking a model:

- Public OpenAPI exposes `model.list` at `/api/model` and `Model.Variant` with
  an `id` field and settings. The returned variants are objects with keys
  `id` and `settings`; no separate variant display name was observed.
- At 2026-10-19 16:26:16.370 UTC, `/api/model` returned 187 models in the wider
  native view. This total is **not** the worker's filtered 61-entry inventory.
- For `cursor/grok-4.7`, `cursor/grok-4.7-fast`, `cursor/glm-5p3-flash` and
  `cursor/gpt-5.6-sol`, the long tool strings are actual **`variant.id` values**,
  not just inferred from a display label. All four models had `enabled: true`.
- The native ids and enabled state of `openai/gpt-6.1-sol` and
  `opencode-go/gpt-6-luna` were independently confirmed as well.
- `src/mission-native-models.ts:12–17`, `nativeMissionModels`, already projects
  `variant.id` into mission admission candidates. This static code observation
  is distinct from the live catalogue observation.

The worker's full 61-entry inventory was not independently re-enumerated by the
lead. Catalogue presence/enabled/active state is not proof of authentication,
quota, contract access or a successful inference. No inference was requested.

## 2. Current approved mission trio

The approved mission remains revision 1, hash
`4b96ac3e5d41ba852a91c257a106b74ea74fadf7f51e0c97b5dad6cb43628e8c`:

- `opencode-go/gpt-6-luna`: `none` is native.
- `openai/gpt-6.1-sol`: `low` and `xhigh` are native.

Astra in the original SP-3 task wording is historical, not this mission's
current strong group. No policy, provider, model or variant was changed by SP-3.

## 3. Grok inventory

The following concise notation describes exact expansions, not a normalization
rule. Braces enumerate alternatives. A written `\u200b` represents one actual
U+200B code point in the native id, not six literal characters.

- `opencode-go/grok-4.7`: `low`, `medium`, `high`, `xhigh`.
- `cursor/grok-4.7`: `Grok 4.7 {Low|Medium|High|Extra High}`, each with and
  without the suffix ` 500k`.
- `cursor/grok-4.6`: `Grok 4.6 {Low|Medium|High|Extra High}`.
- `cursor/grok-4.5`: `Grok 4.5 {Low|Medium|High}`.
- `cursor/grok-4.7-fast`:
  `Grok 4.7 {Low|Medium|High|Extra High} Fast\u200b\u200b`, each also available
  with the additional suffix ` 500k Fast`.
- `cursor/grok-4.6-fast`:
  `Grok 4.6 {Low|Medium|High|Extra High} Fast\u200b\u200b`.
- `cursor/grok-4.5-fast`: `Grok 4.5 {Low|Medium|High} Fast\u200b`.

For example, the lead confirmed that the API's id for the extra-high 4.7 Fast
case ends with **two U+200B characters**, not an ordinary printable `Fast`
suffix. Removing those characters changes the native identifier.

## 4. GLM inventory

Cursor uses these long native strings:

- `cursor/glm-5.2`: `GLM 5.2 {High|Max}`.
- `cursor/glm-5p3`: `GLM 5.3 {Low|High|Max}`.
- `cursor/glm-5p3-flash`: `GLM 5.3 Flash {Low|High|Max}`.

The following models expose `low`, `high`, `max`:

- `opencode/glm-5.3-flash-free`, `opencode/glm-5.3-flash`, `opencode/glm-5.3`.
- `opencode-go/glm-5.3-flash`, `opencode-go/glm-5.3`.
- `zai-coding-plan/glm-5.3-flash`, `zai-coding-plan/glm-5.3-highspeed`,
  `zai-coding-plan/glm-5.3`.

`opencode-go/glm-5.2`, `zai-coding-plan/glm-5.2` and
`zai-coding-plan/glm-5.2-highspeed` expose `high`, `max`.

`zai-coding-plan/glm-5-turbo` and `zai-coding-plan/glm-4.7` have empty variant
lists in this view. That does not establish an implicit effort or a variant
named `default`.

## 5. GPT inventory outside Cursor

Each suffix below denotes a separate model, not a variant suffix.

OpenAI `low`, `medium`, `high`, `xhigh`, `max`:

- `openai/gpt-6.1-sol`, `openai/gpt-6.1-sol-fast`,
  `openai/gpt-6.1-sol-ultrafast`.
- `openai/gpt-6-astra`, `openai/gpt-6-astra-fast`,
  `openai/gpt-6-astra-ultrafast`.

OpenAI `none`, `low`, `medium`, `high`, `xhigh`, `max`:

- `openai/gpt-6-luna`, `openai/gpt-6-luna-fast`.
- `openai/gpt-6-sol`, `openai/gpt-6-sol-fast`.
- `openai/gpt-5.6-sol`, `openai/gpt-5.6-sol-fast`.
- `openai/gpt-5.6-terra`, `openai/gpt-5.6-terra-fast`.
- `openai/gpt-5.6-luna`, `openai/gpt-5.6-luna-fast`.

OpenAI `none`, `low`, `medium`, `high`, `xhigh`:

- `openai/gpt-5.5`, `openai/gpt-5.5-fast`, `openai/gpt-5.3-codex-spark`.

`opencode/gpt-6-luna`, `opencode-go/gpt-6-luna` and
`opencode-go/gpt-5.6-luna` expose `none`, `low`, `medium`, `high`, `xhigh`, `max`.

## 6. GPT Cursor inventory

For these models, each id's variants use the exact prefix on its right, followed
by a space and an effort suffix:

- `cursor/gpt-5.6-sol` -> `GPT-5.6 Sol`.
- `cursor/gpt-5.6-sol-1m` -> `GPT-5.6 Sol 1M`.
- `cursor/gpt-5.6-terra` -> `GPT-5.6 Terra`.
- `cursor/gpt-5.6-terra-1m` -> `GPT-5.6 Terra 1M`.
- `cursor/gpt-5.6-luna` -> `GPT-5.6 Luna`.
- `cursor/gpt-5.6-luna-1m` -> `GPT-5.6 Luna 1M`.

For all six, effort suffixes are `None`, `Low`, `Medium`, `High`, `Extra High`,
`Max`, each with and without the additional suffix ` Fast`.

`cursor/gpt-5.5` / `GPT-5.5` and `cursor/gpt-5.4` / `GPT-5.4` use `None`,
`Low`, `Medium`, `High`, `Extra High`, each with and without ` Fast`.

`cursor/gpt-5.3-codex` / `Codex 5.3` and `cursor/gpt-5.2` / `GPT-5.2` use
`Low`, `Medium`, `High`, `Extra High`, each with and without ` Fast`.

These four use `None`, `Low`, `Medium`, `High`, `Extra High`, without ` Fast`:

- `cursor/gpt-5.5-1m` / `GPT-5.5 1M`.
- `cursor/gpt-5.4-1m` / `GPT-5.4 1M`.
- `cursor/gpt-5.4-mini` / `GPT-5.4 Mini`.
- `cursor/gpt-5.4-nano` / `GPT-5.4 Nano`.

`cursor/gpt-5.1` / `GPT-5.1` uses `Low`, `Medium`, `High`.
`cursor/gpt-5-mini`, model name `GPT-5 Mini`, exposes the single exact variant
`GPT-5 Mini default`. It must not be replaced by an invented generic `default`.

## 7. Absences and limits

The worker's searches returned no Grok/GLM under OpenAI, no Grok under OpenCode,
and no Grok/GPT under Z.AI Coding Plan. Those are scoped, time-bound catalogue
absences, not universal provider limitations or authentication diagnoses.

No variant display-name field independent from `id` was established. No model
request, classifier call, session-model switch, database access or abort was
performed for this inventory. The worker did not use a shell or edit files.

The inventory is not proof of the worker's own effective reasoning variant;
its configured route and the approved policy are separate facts from a verified
inference's settings.

## 8. Contract inputs for L2 and verification

The later implementation should pin these regression cases before changing
admission or switch behavior:

- Accept long native ids such as `Grok 4.7 Extra High` for the correct model.
- Do not translate them to another provider's `xhigh` identifier.
- Preserve native Unicode exactly. The printable version missing U+200B is not
  interchangeable; use escaped diagnostics so invisible differences are visible.
- Keep native `none`, omitted variant, empty variant list and unknown variant
  distinct. Also distinguish catalogue unavailability from an unknown id.
- Retain canonical effort only as annotation; approved/stored native ids stay
  authoritative and existing policy revisions remain compatible.

No production code or policy changed for SP-3. No tests/build were run by the
inventory worker; the prior main checkpoint gate is not claimed as a new SP-3
gate. The subsequent independent review and integrated gate are recorded in
sections 9–10. G0 remains blocked on the other spikes.

## 9. Independent review

Fresh `code-reviewer` `sp3-review`, session `ses_eab027ca9ffelsMLfeHgspqEDh`,
returned candidate `result_mvfgxu49_002f_bmz0bk` for review task
`task_mvfgwo90_002d_86bahn`: **no confirmed defect**.

It independently checked representative long Cursor identifiers, the exact
U+200B counts for Grok 4.5/4.6/4.7 Fast, the mission trio's catalogue presence,
`GPT-5 Mini default`, an empty GLM variant list, the scoped absence queries and
the static `nativeMissionModels` projection. It found the recommendations and
evidence attribution consistent with the observed catalogue.

The reviewer did not independently recount all 61 worker entries, repeat the
lead's `/api/model` observation or inspect persisted approval/task state. Its
catalogue check establishes presence, not persisted policy approval. It ran no
shell, test or build and invoked no inference, classifier, DB access or abort.
The inventory is receivable as observational evidence, not a global gate pass
or permission to start L2 before G0.

## 10. Integrated checkout verification

After integrating the inventory and independent review on `main`, the lead ran:

`bun run typecheck && bun test && bun run build`

Window: 2026-10-19 16:29:53.200–16:30:17.142 UTC; exit status **0**.
Typecheck passed; **1302 tests passed, 0 failed**, across 73 files. Build bundled
336 modules into `dist/index.js` (1.30 MB).
Log:
`C:/Users/djden/AppData/Local/Temp/opencode/ensemble-sp3-integrated-gate-2026-10-19T16-29-53-200Z.log`.

Only this documentation was updated afterward to record the result; production
code and the approved policy remain unchanged. This passes the checkout gate,
not an inference/authentication test, live-schema migration or G0 acceptance.
