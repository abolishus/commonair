<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2-enforcement-report: `rule_ref` on platform actions and the live enforcement report

You are implementing unit W2-enforcement-report for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/batch6/README.md`
(decisions (d) and (p), path ownership, shared rules: binding), `.claude/briefs/w2/contract-step.md`
(§1.3 `transparency.enforcement`, §2.1–2.2 `rule_ref`, §5 web slot, §6–7),
`docs/product/feature-wins.md` §4.7, `docs/decisions/0019-statement-of-reasons.md` (decisions 1, 3,
4, 6 and "Decisions at acceptance"), `docs/testing/w2-selectors.md` (enforcement report ids) and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Own git worktree, branch
`w2/enforcement`, from the contract step's sha (`git merge main` first if main moved). Wave 1,
beside five other units; you share no file. Checked at `8fc2c974`; recheck line numbers.

## Why

Twitch notices name a category but not whether a model or a human decided, and its transparency
report is semiannual and aggregate. Every platform T1/T2/NCII action already produces a statement
of reasons citing a clause `id@version` (ADR 0019). This unit stamps that citation on the action
rows themselves (`rule_ref`) and publishes a live per-rule report on `/transparency`: counts,
automated versus human, overturn rate and NCII 48-hour compliance, with small cells suppressed.

## You own (write only these)

- `packages/moderation/src/clauses.ts` (+ new `packages/moderation/tests/clauses.test.ts`)
- `services/api/src/transparency/**` (stub `enforcement.ts` from the contract step),
  `services/api/src/routes/transparency.ts`, new `services/api/tests/transparency*.test.ts`
- `apps/web/src/components/transparency/**` (the `EnforcementReport` slot the contract step mounts
  on `routes/_app/transparency.tsx`; the page and `components/money/transparency.tsx` are not
  yours), new `apps/web/tests/enforcement-report*.test.tsx`
- `apps/web/src/i18n/locales/{en,es}/w2-enforcement.json` (prefix `enforcement.`)
- `harness/src/w2/enforcement.ts`, new `harness/tests/w2/enforcement.test.ts`
- **Only the lines that set `rule_ref`** in the writers below. The README table names
  `routes/{moderation,appeals}.ts` and `worker/src/moderation/records.ts`, but `records.ts` writes
  no case, appeal or `mod_actions` row; the real writers are this list (the orchestrator amends the
  README table before launch; if it has not, send the lines outside it as contract requests):

| Writer (at `8fc2c974`)                              | Row                               | `rule_ref`                                                       |
| --------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `services/worker/src/moderation/scan.ts:166`        | T1 case (classifier)              | `CATEGORY_CLAUSES[category]`                                     |
| `services/worker/src/moderation/scan.ts:279`        | T2 case                           | `T2_CLAUSE_ID`                                                   |
| `services/worker/src/moderation/t0.ts:177`          | T0 case                           | NCII list → `NCII_CLAUSE_ID`; CSAM list → **null** (ADR 0019 1)  |
| `services/api/src/moderation/uploads.ts:150`        | upload-reject case                | `CATEGORY_CLAUSES[category]`                                     |
| `services/api/src/routes/safety.ts:233`             | report → T1 case (human)          | `REPORT_REASON_CLAUSES[reason]`                                  |
| `services/api/src/routes/safety.ts:393`             | report resolution `mod_actions`   | platform scope: report reason's clause; `ban_from_channel`: null |
| `services/api/src/routes/safety.ts:561`             | admin suspension `mod_actions`    | null (no clause input; see contract requests)                    |
| `services/api/src/routes/moderation.ts:138`         | case decision (`review`)          | keep the case's; set from `clauseFor` if null                    |
| `services/api/src/routes/moderation.ts:174,192,207` | decision `mod_actions` (platform) | `clauseFor({action: "moderation.case.<decision>", …})`           |
| `services/api/src/routes/appeals.ts:605`            | appeal insert                     | the appealed subject's statement or case `rule_ref`, else null   |
| `services/api/src/routes/appeals.ts:463`            | unsuspend on overturn             | null (a lift, not an enforcement)                                |

Channel-scope writers (`services/chat/src/moderation.ts:412`, `routes/chat.ts:242,332`,
`chat/held.ts:129`, `channels/roles.ts:51`, `moderation/chat-bans.ts:47`) are never touched: the
CHECK `rule_ref is null or scope = 'platform'` refuses them anyway. Grep again at your base for any
writer added since.

## Contracts you must honor (read-only for you)

- `CLAUSES`, `clauseRef`, `currentClause`, `findClause`, `clauseFor`, the `*_CLAUSE(S)` maps
  (`packages/moderation/src/reasons.ts:45-160`). `clauses.ts` **re-exports** them and adds the
  report grouping; it never declares a clause (ADR 0019 decision 1 rejects a second catalog).
- `rule_ref text` on `moderation_cases`, `appeals`, `mod_actions` with the format CHECK and the
  platform-only CHECK (contract step `0043_w2_protections.sql`).
- `enforcement_statements` (`packages/db/src/schema/safety.ts:110-170`: `clause_id`,
  `clause_version`, `source`, `automated_detection`, `automated_decision`, `appeal_subject_*`);
  `appeals` (`status` `overturned`); `ncii_requests` (`deadline_at`, `decided_at`,
  `auto_hidden_at`; never read its personal columns).
- `transparency.enforcement` (input `{window: "30d" | month}`, output shape from the contract
  step), public, no caller needed. Test ids in `docs/testing/w2-selectors.md`.
- Clause titles: the existing `enforcementStatement.clause.*` keys in
  `packages/email/src/messages/locales/{en,es}/trust.json`, read through `clauseTitle`
  (`services/api/src/routes/me-enforcement.ts:34`); per `apps/web/src/i18n/README.md` the web gets
  clause titles from the API, never from its own catalog.

## Build

1. **`clauses.ts`.** `REPORT_GROUPS` (clause id → area: `safety`, `decency`, `honesty`,
   `creative`, `mature`, `illegal`, `general`, derived from the id prefix; a test fails if a clause
   has no group); `ruleRefFor(input: ClauseInput): string` (`clauseRef(clauseFor(input))`);
   `parseRuleRef` (refuses anything the DB CHECK would refuse).
2. **`rule_ref` writes**, one line each, per the table. No behaviour change otherwise.
3. **`transparency/enforcement.ts`** (pure aggregation plus queries):
   - Window: `30d` = rolling `[now − 30 d, now)`; a month = `[first day 00:00 UTC, next month)`,
     refusing future months and months before the first statement (empty, not an error).
   - Unit of count: one statement row (`enforcement_statements` by `created_at`), grouped by
     `clause_id@clause_version` and tier (from `source_action`), plus platform `mod_actions` with
     `report_id is not null and rule_ref is not null` (report resolutions have no statement yet).
     Case-decision `mod_actions` (`subject_type = 'moderation_case'`) are already counted through
     their statement: never twice. Channel scope never appears.
   - Automated split: `automated_decision` `fully` / `partially` / `not`, and `automated_detection`.
   - Overturn rate per rule: statements whose `(appeal_subject_type, appeal_subject_id)` has an
     appeal resolved `overturned` ÷ statements in the cell; also appealed count. Integer
     numerator and denominator on the wire, the ratio computed by the client.
   - NCII 48 h: requests whose `deadline_at` falls in the window; compliant when
     `least(decided_at, auto_hidden_at) <= deadline_at`; past deadline and undecided = late.
   - **k = 10**: any count (or a ratio's denominator) below 10 is returned as suppressed, never as
     a number; a total is suppressed if subtracting the visible cells would reveal a suppressed
     one (complementary suppression). Zero is not suppressed.
   - One indexed query per figure; add no index (contract request if `EXPLAIN` shows a seq scan).
4. **`routes/transparency.ts`**: the handler, the window validation, a short cache (60 s in
   Valkey or in-process; no new `KEYS` entry), clause titles in the request locale (en fallback).
5. **Web `enforcement-report.tsx`**: window picker (30 days, the last 12 months), a table per
   group (rule title, `id@version`, count, automated/human, overturn rate) that becomes a stacked
   list at 320 px, `—` with a "fewer than 10" `Tooltip` for suppressed cells, `EmptyState`,
   `Skeleton*` while loading, `FormError` on failure; NCII compliance as one line. No hex, no
   charts library. Every string in `w2-enforcement` en **and** es (decision (p)).

## Tests you must add

- Unit: `clauses.ts` (every clause grouped, `ruleRefFor` per `ClauseInput` arm, `parseRuleRef`
  edge cases); aggregation (k boundary 9/10, zero, complementary suppression, overturn
  denominator suppressed, month boundaries at 00:00 UTC, December → January, empty window).
- Integration (`createTestDatabase()`): each `rule_ref` writer sets the expected value; a channel
  ban leaves every count unchanged; an overturned appeal moves the rate; NCII on time / late /
  pending; a CSAM T0 case never appears; `transparency.enforcement` callable signed out.
- Web: the component in dark and light at 320 px, suppressed cell, empty and error states.
- Harness `harness/src/w2/enforcement.ts`, called from `trust-safety` through the contract step's
  `W2_EXTENSIONS` (after steps 4–5, `stepT2Label` / `stepT1Restrict` at
  `harness/scenarios/trust-safety.ts:636-800`): read the report, run the T2 and T1 actions, assert
  the counts go up and the automated split moves; a channel `mod_actions` ban leaves counts
  unchanged; the overturned T2 appeal moves the rate; a below-k cell is suppressed. Counts are
  instance-wide and a fresh stack starts below k: top a run-unique clause cell up to k − 1 with
  rows written through `DATABASE_URL` (the `harness/src/safety-db.ts` pattern), then let the real
  action cross k. Web step: `/transparency` shows the report and a suppressed cell.

## Done means

Follow `.claude/briefs/_done-means.md`. Targeted checks only: `bun --bun vp test run` in
`packages/moderation`, `apps/web`, `harness`; `bun run test` and `bun run test:int` in
`services/api` then `services/worker` (one at a time); `bunx tsc -p` for each; `vp lint
--deny-warnings` and `vp fmt` on your paths; `vp build` and `bun run i18n:check && bun --bun vp
test run tests/i18n.test.ts` in `apps/web`; `reuse lint`. Never `bun run verify`, a harness
scenario, `podman compose` or `scripts/infra.ts`. `git status` shows only your paths. Commit with
`git commit -s`. Final message per `_done-means.md`, including contract requests (exact diffs),
and the live commands for the user: `bun harness/src/cli.ts run trust-safety --set
w2=enforcement`, then `/transparency` at 320 px under `en`, `es` and `en-XA`, dark and light.

Known contract requests to send if still open at your base: ADR 0019 acceptance answer 3 puts a
required `clauseId` in the report-resolution and admin-suspension staff inputs in W2 (`safety.resolve`
and `safety.suspend` inputs); without it `safety.ts:561` stays null.
