# SP-2 — Checkout / installed bundle parity

Status: **Proposed — evidence recorded, not accepted**.

Mission: `team_mvffoozl_001l_8ws0e8`, task `task_mvffs6tq_001m_wqsjxo`.
Source brief: `.opencode/missions/team_mvf7o9mu_0000_v6ro5m/ordre-de-mission.md`.
Reporter: `sp2-parity` (`qa`), native session `ses_eab1aed89ffem7naLrIunZsmoV`.
Observation window: 2026-10-19 16:01:26–16:07:17 UTC.

This is an observational spike report, not authorization to replace the source,
change the installed plugin, migrate the live database, or commit existing work.
The report is integrated documentation; no application source has been changed
by the lead for this spike. Independent review is recorded in section 8 and the
subsequent checkout gate in section 10. Historical deployment checks are not a
current gate pass, and a checkout gate does not establish live schema parity.

## 1. Provenance and confidence

Repository root (`R`):
`C:/Users/djden/source/repos/opencode-ensemble-session`.

Installed bundle (`I`):
`C:/Users/djden/.config/opencode/local-plugins/ensemble/20261018-mission-mode-09bf12ea5d8a`.

The worker observed:

- Git branch `feature/session-continuity`, HEAD
  `dbffdd8454dd248a2fca95d771c1f0e963471ea0`.
- OpenCode service PID 51636, executable
  `C:/Users/djden/AppData/Roaming/ai.opencode.desktop/cli/2.0.32-x64/opencode-cli.exe`.
  The executable version and `GET /api/info` agreed on `2.0.32`; service port
  was 41037. Location and worker-session API responses identified `R` and `qa`.
- `GET /api/plugin` identified active Ensemble source `I/index.js`, **not R**.
- Installed package version
  `0.19.0-local.20261018.mission-mode.09bf12ea5d8a`; checkout package `0.19.0`.
- `I/index.js`: 1,445,477 bytes, mtime `2026-10-18T16:10:35.191Z`, SHA256
  `09bf12ea5d8ab2bf348900466f8a64dec70066f721bd5a0194d5ec753dc2c705`.
  It matched `deployment.json`. The filename suffix is not an established Git
  commit identity. The source snapshot is retained at `I/source`.

The lead independently rechecked the on-disk bundle hash, installed package
version, migration counts, classifier source hashes and mission-file canonical
hash after receiving the report. The lead has **not** independently re-read
live SQLite or established an in-memory bundle hash. API runtime and live SQL
findings below remain attributed to the worker's observations.

## 2. Configuration is not the same as executed source

The worker inspected `GET /api/config`, the global and project configuration,
and the installed reader's source:

- The global plugin points to `I`. Its skill path points to an older
  `20261016-mission-policy-5504fe8e8df8/skills`; project config adds `./skills`.
  A local skill file is not proof of which copy was selected in a session.
- No `R/.opencode/ensemble.json` was found. The installed reader uses
  `~/.config/opencode/ensemble.json`; observed SHA256
  `12d90d89b15be2514acedd7f311d6cf8c62a2be899561a08dfa8722cb4e73d35`.
  Its `modelRouting.costMode` was `effective`.
- The installed reader accepts `costMode`/`intelligenceRange` whereas the
  checkout reader differs. Presence in JSON does not prove a field was retained.
- Installed `source/src/index.ts:783–786`, `v2-setup.ts:122–128` and
  `db.ts:95–98` establish the default database path as
  `~/.config/opencode/ensemble.db`; API and mission rows corroborated that path.
- Server environment and runtime options not exposed by those observations
  were not verified. No global configuration, plugin reload or service restart
  was performed.

## 3. Schema divergence is a blocking compatibility issue

At 16:03:49 UTC the worker used Python sqlite3 3.45.3 with a read-only URI
(`mode=ro`) and a read transaction. Only consultation SELECT/PRAGMA statements
were reported. WAL/SHM files already existed. No plugin `createDb` or
`applyMigrations` was imported against the live database.

- Live `PRAGMA user_version`: **20**; `journal_mode`: `wal`.
- Migration array counts, parsed without executing the source: Git HEAD **13**,
  dirty checkout **16**, installed source **20**. The lead confirmed the counts.
- The worker's static comparison reports that checkout and installed migrations
  1–14 match, with different SQL at 15. The lead's spot checks established the
  array counts, not that full installed SQL comparison.
- HEAD and checkout differ textually at migration 13 only by one indentation
  space before the last `ALTER TABLE`. All thirteen shared migration strings
  match after line-indentation/trailing-space normalization; the checkout adds
  migrations 14–16. This whitespace difference is **not** evidence of a
  functional schema incompatibility. The reviewer and lead confirmed it.
- Installed lineage: 15 capability, 16 provider order, 17 model policy,
  18 task context, 19 lead wake, 20 mission policy/reporting.
- Checkout lineage: 15 mission policy, 16 reporting/member results.
- Sorted `sqlite_master` fingerprint reported by the worker:
  `451acb17baf3fdd28143f5f26ac77bfd90e506c7bc19f9586281550df836e48b`.
  A version number alone does not establish full schema equivalence.

`R/src/schema.ts:277–301` rejects a database newer than its migration array.
Consequently, this checkout would reject version 20 versus 16. This is a
**static conclusion**, not a deliberately attempted live plugin load.

Migration slots **17/18 are not free**. The planned L4/L5 numbering must not be
used as written. Even 21 or later is only a candidate after source/schema
lineage reconciliation; renumbering alone does not repair incompatible history.

## 4. Policies and classification evidence

- The worker found no exact `provider_order` or `model_policy` occurrences in
  `R/src`, while the live columns and installed implementations exist.
- Historical teams had nonzero independent provider/model-policy revisions.
  Current and source-bundle missions each had provider order revision 0 and
  model policy revision 0. These are **not** `mission_policy.revision`.
- Current mission approval is revision 1, hash
  `4b96ac3e5d41ba852a91c257a106b74ea74fadf7f51e0c97b5dad6cb43628e8c`.
  The worker reported file/approved JSON equality; the lead independently
  confirmed the file's canonical hash.
- Current groups are `opencode-go/gpt-6-luna` / `none`,
  `openai/gpt-6.1-sol` / `low`, and `openai/gpt-6.1-sol` / `xhigh`.
  SP-3's original task text mentions Astra; its actual brief must use this
  approved trio. This is a stale task description, not a policy correction.
- The old mission's disk draft differed from its frozen approved JSON. It must
  not be treated as the policy executed historically.
- Installed `provider-policy.ts:38–48` and `model-routing-policy.ts:65–76`
  increment revisions without a no-op comparison; `tools/team-message.ts:34–35`
  gates those controls for governed missions. No control was exercised here.
- Checkout and installed `v2-classification.ts` have identical SHA256
  `2edcf2434d5c334e7fb9adce76f02239048906bbf991aafb3f51eedf14a9c539`.
  The lead independently confirmed both hashes. The dispatcher and discovery
  prompt exist in both copies. This does **not** reproduce or explain the
  historical discovery incident. No classifier was invoked.

## 5. Existing work is not a clean worktree baseline

Worker snapshots at 16:04:56 and 16:06:39 UTC agreed:

- 0 staged paths; 43 modified tracked files; 42 untracked files.
- Status SHA256:
  `678a5d2192b941a018c5a666837c61e2975218f70399303888e1d96ff9fb383b`.
- Tracked/untracked content-manifest SHA256:
  `0daa984cb89051362abbfb00f70aa2d7ca8858c8ba40350814a20853698035d5`.
- Ignored mission evidence: 41 files, 10,837,361 bytes. Reported manifest SHA256:
  `a36d2bf5c12d72fe8dba91b09b5b48504c386bf7b136e2a26573237b7d4609a6`.
  These ignored files are not preserved by a normal tracked diff.
- Checkout/installed `src`: 70/97 files; 30 identical, 40 different, 27
  installed-only. `test`: 76/110; 51 identical, 25 different, 34 installed-only.
  `bun.lock` matched. Eight existing worktrees had different HEADs; none was
  reused, removed or cleaned.

These are observations **before this lead-authored report was added**. Hashes
are identification evidence, not backups. A fresh worktree at current HEAD
does not carry the checkout's dirty or ignored files.

No reset, stash, commit, branch modification, worktree cleanup or source
replacement was performed in SP-2. Establishing a preserved common base needs
an explicit decision. A SQLite backup, if authorized, must be transactionally
consistent with WAL; copying the `.db` file alone is insufficient.

## 6. Commands actually reported and verification limits

The worker used Git with `GIT_OPTIONAL_LOCKS=0`: `rev-parse`,
`branch --show-current`, `status` including all untracked paths,
`diff --cached --name-status`, `show HEAD:src/schema.ts`,
`worktree list --porcelain`, `check-ignore -v` and
`ls-files --others --ignored --exclude-standard .opencode/missions`.

Other observations: filtered PowerShell `Get-CimInstance Win32_Process`;
the absolute OpenCode executable with `--version`, `service status`,
`api --help`; HTTP GET `/api/info`, `/openapi.json`, `/api/location`,
`/api/plugin`, `/api/config` and the worker's own session; read-only SQLite
consultation; file SHA256 and TypeScript AST comparison via Context Mode;
GrepAI/Serena code exploration and V2 documentation consultation.

Diagnostic errors were corrected: a JavaScript regex syntax error, a SELECT
for a nonexistent column, and the executable missing from the sandbox PATH.
They are not demonstrated product regressions or permission rejections.

The lead's spot checks used Context Mode to read/hash files, parse migration
arrays with the TypeScript AST and run `git show HEAD:src/schema.ts` with
optional locks disabled. No live DB opening or application initialization was
needed for those spot checks.

**Not executed during the observational audit:** `bun run typecheck`, `bun test`,
`bun run build`. The later checkout gate is recorded separately in section 10.
No schema migration or runtime incident was reproduced by loading this checkout
into the installed service.

## 7. Disposition at audit time

- Keep SP-2 open until independent review and the applicable verification gate.
- **NO-GO writers SP-1/SP-4:** first preserve existing work, select a source
  lineage and establish a common base with proven directory/HEAD/location/cwd.
- **SP-3 observation is technically separable**, but remains behind SP-2's
  acceptance dependency. Its brief must name the approved Sol `xhigh` trio.
- **NO-GO Phase 1, migrations or deployment:** reconcile the divergent schema
  and source histories first. Do not overwrite the checkout with the bundle.
- User decision required for preservation and source-lineage reconciliation;
  mission approval does not silently choose a commit of unrelated existing work
  or a replacement of the live plugin/database.
- Any later `session.abort` path still requires branch preservation first;
  `promptAsync` remains fire-and-forget, transport extraction remains `._client`,
  and all other Settled Decisions / mission section 6 invariants remain intact.

The remaining Phase 0 reports, independent reviews and full integrated gate
are still required. This report does not relax the G0 barrier.

## 8. Independent review and clarification

`sp2-review` (`code-reviewer`, fresh context) returned candidate
`result_mvfggj15_001w_wrarnf` for task `task_mvfgcina_001u_o58mtb`.
The review confirmed the checkout/HEAD counts, source rejection guard,
mission-file policy/hash, checkout classifier hash and conservative barriers.
Its P3 finding was the distinction between textual and functional differences
at migration 13; section 3 now makes that distinction explicitly.

The lead independently compared the thirteen shared SQL strings via the
TypeScript AST and `git show HEAD:src/schema.ts`: only migration 13 differed
textually, by one leading space on `ALTER TABLE team_member ADD COLUMN
model_routing TEXT;`; all shared strings matched after line-edge whitespace
normalization. No migration was executed.

The reviewer's access to the installed schema was denied by Context Mode
confinement; it did not attempt a bypass. Installed SQL lineage, live SQLite
and API observations were consequently **not independently reverified by the
reviewer**. This is a coverage limit, not evidence that those reports are false
or that parity has been established. The lead's narrower on-disk checks remain
identified in section 1.

The reviewer recommended observational receivability after this clarification,
not permission to migrate, deploy or replace the base. A restorable backup,
preservation of dirty/untracked/ignored data and affected worktree work,
full DDL comparison and an authorized disposable-copy validation remain needed.
No typecheck/test/build was run by the reviewer; at review return neither SP-2
nor G0 had been accepted.

## 9. Subsequent operator decision

The operator declined the optional archive/database-backup workflow and
explicitly requested committing all committable work, pushing it, and continuing
on the existing primary branch. The primary branch is `main`.

After fetching `origin/main`, the lead verified that its merge commit had the
same tracked tree as the former feature HEAD. Local `main` was fast-forwarded
and checked out; a content manifest confirmed that all dirty and untracked
files remained unchanged. No history was discarded and no force push is used.

The authorized checkpoint establishes the current checkout as the development
base. Ignored mission data is deliberately not force-added and a Git commit is
not presented as a backup of the live SQLite database or ignored/worktree data.
The installed/live schema difference remains a migration-design constraint;
this instruction does not authorize replacing the installed plugin or migrating
the live database. The remaining spikes and G0 acceptance gate are unchanged.

## 10. Checkout checkpoint verification

On `main`, the lead executed the exact project gate:

`bun run typecheck && bun test && bun run build`

Window: 2026-10-19 16:20:21.757–16:20:46.644 UTC; command exit status **0**.
Typecheck passed; tests reported **1302 pass, 0 fail**, across 73 files;
the build bundled 336 modules into `dist/index.js` (1.30 MB).
Full local log:
`C:/Users/djden/AppData/Local/Temp/opencode/ensemble-main-checkpoint-gate-2026-10-19T16-20-21-757Z.log`.

This verifies the current checkout baseline, not the installed bundle or a
live-database migration. No application source was changed after the gate;
only this documentation was updated to record its result. SP-1/SP-3/SP-4 and
G0 remain outstanding.
