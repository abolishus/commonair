<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W0-sor: statements of reasons for platform enforcement

You are implementing unit W0-sor for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W0-prerequisites.md`,
`docs/product/feature-wins.md` §4.7 "Open Enforcement" (the scope split) and §5 "Wave 0",
`.claude/briefs/w0/contract-step.md`, [ADR 0019](../../../docs/decisions/0019-statement-of-reasons.md),
[ADR 0006](../../../docs/decisions/0006-automated-moderation.md) and
[ADR 0004](../../../docs/decisions/0004-governance-enforcement.md) (no personal data in
append-only rows). Do not look outside the repository. Work in your own git worktree on a branch
named `w0/sor`, starting from the W0 contract-step commit (which already contains E7-appeals and
E7-dmca).

Matches ADR 0019 as accepted on 2026-10-27 (its "Decisions at acceptance" section): a typed
clause catalog in
`packages/moderation/src/reasons.ts`, wording in an operator-editable `enforcement_notice` legal
document shipped as an unreviewed draft, a statement for every platform T1/T2/NCII action and
never for channel-moderator actions, built by a worker job from `audit_log`, stored append-only,
delivered by email and on `/settings/appeals`, read through `me.enforcement.list`, and included in
the user's data export. Counsel has not reviewed any of it and you must not present it as
reviewed. Settled at acceptance: T0 CSAM-list matches produce no statement and T0 NCII-list
matches produce one under `illegal.ncii` (both for counsel to confirm); a suspended user can file
an appeal (contract step); NCII removals are appealed as `ncii_request_item` (contract step);
report resolutions and admin suspensions wait for W2; statements are kept as long as `audit_log`.

## Why

DSA Art. 17 asks every hosting service to tell the affected user what was restricted, why, on
what ground, whether automation was involved, and how to seek redress. ADR 0006 points operators
at it (`docs/operators/trust-safety.md:186`) and nothing produces statements today. Done when
`trust-safety` asserts a statement for every platform T1/T2/NCII action in the run and none for a
channel-moderator action (feature-wins §6 target: 100% coverage, measured by joining `audit_log`).

## You own (write only these)

- `packages/moderation/src/reasons.ts` (new), its export line in `packages/moderation/src/index.ts`,
  `packages/moderation/tests/reasons*.test.ts` and its committed snapshot
- `services/worker/src/moderation/sor-*.ts` (new: builder, per-action schemas, coverage, delivery),
  `services/worker/src/jobs/moderation-sor.ts` (stub from the contract step), the SoR metrics you
  add to `services/worker/src/moderation/metrics.ts`, new `services/worker/tests/moderation-sor*.ts`
- `services/api/src/routes/me-enforcement.ts` (stub from the contract step), new
  `services/api/tests/me-enforcement*.ts`
- `packages/email/src/templates/trust.tsx` (a new `enforcementStatement` template; leave the DMCA and
  appeal templates as E7 left them) and that template's entries in `packages/email/src/registry.ts`,
  `messages/en.ts`, `samples.ts`; tests under `packages/email/tests`
- `packages/db/src/legal/enforcement_notice.md` (the contract step seeds a skeleton; you write the text)
- `apps/web/src/routes/_app/settings.appeals.tsx`, new `apps/web/src/components/safety/enforcement*.tsx`,
  `apps/web/src/components/safety/appeals.tsx` only to reuse its appeal dialog with a prefilled
  subject, the `safety.enforcement.*` keys in `apps/web/src/i18n/safety.ts`, web tests for them
- `docs/operators/trust-safety.md`: the "European Union (Digital Services Act)" section (:182-193)
  and a new short subsection on publishing your own `enforcement_notice` version
- `services/worker/src/exports/collectors.ts`: one new `enforcement_statements` section only (E7-dmca
  edits this file in wave 1; it has merged before you start), and its cases in
  `services/worker/tests/export-collectors.test.ts` and `exports.int.test.ts`
- `harness/src/safety-sor.ts` (stub from the contract step), new `harness/tests/safety-sor*.test.ts`

Not yours: the action writers (`services/worker/src/moderation/{scan,ncii-clock,ncii-hash,t0}.ts`,
`services/api/src/moderation/uploads.ts`, `services/api/src/routes/{moderation,ncii,appeals}.ts`):
the builder reads their `audit_log` rows, so you never edit them. Also not yours: the VOD-prefix
lines W0-media-exposure edits in `moderation/{objects,t0-media,ncii-clock,ncii-hash}.ts`,
`harness/scenarios/trust-safety.ts`, `harness/src/safety.ts`, `packages/contracts/**`,
`packages/db/**` except the one `.md` (and not `packages/db/src/legal/index.ts`: the notice's seed
version is the orchestrator's, contract step B.6), `services/api/src/routes/me.ts` (the contract
step wired your file), `services/api/src/lib/access.ts`, `harness/src/safety-run.ts`,
`apps/web/src/i18n/en.ts` and `index.ts`, the notifications UI, `services/api/src/auth/**`. Need a
change outside your paths?
Do not make it: put the exact change in your final message as a contract request.

## Contracts you must honor (read-only for you)

- `EnforcementStatement` and `EnforcementFacts` (`packages/contracts/src/api/entities.ts`), the
  `ENFORCEMENT_*` enums and `ENFORCEMENT_SOURCE_ACTIONS` (`packages/contracts/src/enums.ts`),
  `me.enforcement.list` (`packages/contracts/src/api/router.ts`, inside `me`), all from the contract
  step and exactly ADR 0019 decisions 4 and 8.
- Tables `enforcement_statements` (append-only for every role by trigger; unique
  `(source_audit_id, recipient_user_id)`) and `enforcement_statement_deliveries`
  (`packages/db/src/schema/safety.ts`), `audit_log_action_idx`, the `legal_documents` immutability
  guard, `enforcement_notice` in `LEGAL_DOCUMENT_KINDS` (contract step).
- `MODERATION_JOBS.sorBuild` / `sorCoverage` (`packages/contracts/src/internal.ts`), registered
  through your stub in `services/worker/src/jobs/index.ts`.
- `docs/testing/w0-selectors.md`: the source-action table and the `enforcement-*` test ids.
- Appeals: `KIND_SUBJECTS` (`services/api/src/routes/appeals.ts:46-51` at `9c51c93`; E7 wires
  `dmca_notice` and `account_action`, and the W0 contract step adds `ncii_request_item` under
  `moderation`). The statement's `appeal` names a subject `appeals.create` accepts, or is null.
  `appeals.create` carries `whileSuspended: true` (contract step), so a suspended user can file it.
- Rows hold ids, enums, timestamps and catalog codes only: no free text, no exact classifier score,
  no NCII requester identity, no email (ADR 0004; AGENTS.md "Code style"). Logs carry statement and
  audit ids, never addresses.

## What is there today (verified at `9c51c93`; recheck against the contract-step commit)

- Source audit rows, each written in its action's transaction: `moderation.t1.restrict` / `.t1.flag`
  (`services/worker/src/moderation/scan.ts:213`), `moderation.t2.label` (`scan.ts:326`, also a
  `notifications` row :318-324), `moderation.t1.upload_reject` (`services/api/src/moderation/uploads.ts:182`),
  `moderation.case.<decision>` (`services/api/src/routes/moderation.ts:215-232`, with platform
  `mod_actions` rows for suspend/warn/end_stream :160-206 and `notifyUser` :212-213),
  `ncii.decide` (`services/api/src/routes/ncii.ts:321-333`; one request can cover items on several
  channels, :280-300), `ncii.auto_hide` (`services/worker/src/moderation/ncii-clock.ts:164-180`),
  `moderation.t0.match` (`services/worker/src/moderation/t0.ts:281-284`). The worker's `audit`
  returns the row id (`services/worker/src/moderation/records.ts:31`); the API's returns void
  (`services/api/src/events/audit.ts:41`), which does not matter to a builder that reads the table.
- Channel moderation never writes these actions: chat bans and timeouts are `mod_actions` with
  `scope = 'channel'` (`packages/contracts/src/enums.ts:163`; `services/chat/src/moderation.ts`,
  `services/api/src/routes/chat.ts`, `services/api/src/routes/channels.ts`).
- No clause catalog; the rules are the headings of the seeded draft guidelines
  (`packages/db/src/legal/guidelines.md`). Thresholds per tier: `packages/moderation/src/thresholds.ts`.
- `/settings/appeals` renders `MyAppeals` under a page header
  (`apps/web/src/routes/_app/settings.appeals.tsx:22-27`); its test ids are in
  `docs/testing/e4c-selectors.md:107-125`.
- Trust email templates exist (`packages/email/src/templates/trust.tsx`), registered at
  `packages/email/src/registry.ts:11`, :30-32; nothing in services sends them. The worker sends mail
  with `ctx.mailer.send(template, data, address)` in the user's `locale`
  (`services/worker/src/exports/build.ts:183-188`).
- Moderation jobs are scheduled with a Valkey run lock (`services/worker/src/jobs/moderation-schedules.ts`
  `scheduled(...)`, :22-50); copy that pattern.
- A suspended user can read but not write (`services/api/src/lib/access.ts:82`), except
  `appeals.create`, which the contract step exempts (`ProcedureMeta.whileSuspended`). The auth
  library's admin plugin keeps its banned-user sign-in check (`services/api/src/auth/index.ts:186-190`);
  whether that refuses a suspended user's sign-in is unverified (Build 9).
- T0 matches write `moderation.t0.match` (`t0.ts:281-302`) with `details.listCategory`
  (`csam` or `ncii`), `userId`, `subjectType`, `subjectId`, and suspend the account indefinitely
  (`suspendForT0`, `t0.ts:96`).
- The user data export (`services/worker/src/exports/collectors.ts`) lists each section's columns
  explicitly and filters by the requester's id; copy that pattern.

## Build

1. **Clause catalog** (`reasons.ts`, ADR decision 1): `Clause = { id, version, ground: "terms" |
   "illegal", guidelinesAnchor, legalBasis?: string, titleKey }`, the initial clauses (at least
   `mature.unlabelled`, `safety.sexual-explicit`, `safety.graphic-violence`, `safety.weapons`,
   `safety.self-harm`, `illegal.ncii`, and whatever a moderator case decision on a human-origin case
   cites; map every `MODERATION_CATEGORIES` value), old versions kept, and the pure mappings from a
   source action plus its facts to `{ clauseId, clauseVersion }`. A snapshot test forbids changing a
   released `id@version` (id, version, ground, legal basis). W2's `clauses.ts` will import this
   module; keep it free of database and I/O.
2. **Builder job** (`sor-build.ts`, every 15 s under a run lock, ADR decision 5): select allowlisted
   (`ENFORCEMENT_SOURCE_ACTIONS`) audit rows with no statement for their recipients, oldest first, in
   batches, using `audit_log_action_idx`. Parse each row's `details` with a per-action Zod schema
   (`sor-schemas.ts`, fixtures copied from each writer's current shape). Resolve: recipient (case
   user, or channel owner; NCII: one statement per affected owner, never the requester), content,
   restriction (decision 3 table: `t1.flag`, `case.clear`, `case.escalate_legal`, `ncii.decide`
   rejected → no statement), facts (decision 4: the threshold in force, never the score;
   `moderator_review` cites the case and decision, never the note; `ncii_notice` cites request id and
   times only), `source` (`notice_art16` for NCII and report-origin cases, else `own_initiative`),
   automation flags (decision 4 list), ground from the catalog, the current published
   `guidelines` and `enforcement_notice` document ids, and the appeal subject (T2 → `content_label`,
   T1 and case decisions → `moderation_case`, `ncii.decide` removed and `ncii.auto_hide` →
   `ncii_request_item` with the affected item's id).
   Insert with `on conflict do nothing`; `createdAt` = the audit row's time. A statement records an
   action already audited, so the builder writes no new `audit_log` row and no `events` row (it has
   no consumer outside this job); say so in a comment. A row whose details do
   not parse is skipped, counted (`sor_build_failures_total{action}`) and logged by audit id. T0
   (ADR 0019 answer 1): a `moderation.t0.match` with `listCategory = 'csam'` never produces a
   statement (and is not counted as missing); one with `listCategory = 'ncii'` produces one for
   `details.userId`: content `details.subjectType`/`subjectId`, restriction `account`/`suspended`
   with `endsAt` null, facts `{ code: "hash_match", listCategory: "ncii", capturedAt }` (never the
   distance, provider identifiers or hash), source `own_initiative`, automation `true`/`fully`,
   ground `illegal.ncii`, `appeal` null (the T0 case is hidden from appeals).
3. **Delivery** (`sor-deliver.ts`, run after insert in the same job): an in-app `notifications` row
   (`type: "moderation"`, payload `{ kind: "enforcement_statement", statementId }`, ids only as
   `services/api/src/moderation/notify.ts:5-6` requires) and the
   `enforcementStatement` email to the recipient's address in `users.locale`, recording each channel
   in `enforcement_statement_deliveries` (sent, attempts, an error code; skipped with a code for a
   deleted account or no email). Retries are bounded and never resend a sent channel. The email
   carries every Art. 17(3) element on its own (restriction, end, facts, automation, clause title and
   explanation, redress: internal appeal, the out-of-court body the notice names, courts) because a
   suspended user may not be able to sign in, and says when the notice text is an unreviewed draft.
4. **Coverage sweep** (`sor-coverage.ts`, daily): count allowlisted audit rows older than 5 minutes
   with no statement for an expected recipient (excluding CSAM-list T0 rows and the decision 3
   "no" rows, by the same predicate the builder uses); export a gauge and log ids at error level when
   non-zero. This is the 100% metric.
5. **`me.enforcement.list`** (`me-enforcement.ts`): the caller's statements, newest first, keyset
   cursor on `(created_at, id)` like `me.notifications`; `clauseTitle` from the catalog's title key,
   `explanation` from the clause's section of the pinned `enforcement_notice` row, `noticeIsDraft`
   from that row, `moderatorNote` joined from `moderation_cases.resolution_note` on read (never
   stored), `appealId` of an existing appeal on the same subject, `reversedAt` when the case was
   cleared or the appeal overturned. T0 NCII-list statements appear, but never join the T0 case
   (no `moderatorNote`, no `reversedAt` from it); CSAM-list matches have no statement. Readable
   while suspended.
6. **Notice draft** (`enforcement_notice.md`): the Art. 17 framing, one section per clause id, the
   redress paragraph, the same placeholders and "draft pending lawyer review" banner as
   `guidelines.md`. Plain language, no claims of legal sufficiency.
7. **Strings.** Clause titles and restriction labels exist once per catalog the readers use: put the
   English text where the API, the worker's email and the web can all reach it without a new package
   dependency (the email catalog `packages/email/src/messages/en.ts` is a candidate the API and
   worker already depend on; the web may render `clauseTitle` from the API). Say what you chose and
   why. Web UI strings go through `t("safety.enforcement.…")`.
8. **Web** (`/settings/appeals`): an "Enforcement" list above `MyAppeals` with the
   `enforcement-*` test ids from the selectors doc; each statement shows the restriction, end, clause
   title and explanation, automation, the moderator note when present, a draft notice, and an
   "Appeal" control that opens the existing appeal dialog prefilled from `appeal` (hidden when
   `appeal` is null or `appealId` is set). House primitives: `<EmptyState>`, `<Skeleton*>`,
   `<RelativeTime>`, `<IconButton tooltip>`; keyboard and screen-reader friendly; 320 px.
9. **Operator docs and the sign-in check**: replace the Art. 17 bullet
   (`docs/operators/trust-safety.md:186-187`) with what the platform now sends, what the operator
   must review (the notice text, the clause mapping, the out-of-court body; counsel has not
   reviewed the defaults), that statements are kept as long as the audit log, and that the DSA
   Transparency Database adapter does not exist (off by default, not built). Add the subsection on
   publishing an operator's own `enforcement_notice` version: there is no admin route yet and no
   `db` CLI for it, so document one command run as the database **owner** role (on the self-host
   bundle, `psql` inside the Postgres container with the owner credentials) that inserts a new
   `legal_documents` row (`kind = 'enforcement_notice'`, a new `version`, the body, `is_draft`,
   `published_at`), and say that published rows cannot be edited (the immutability guard). Prove the
   exact documented SQL in an integration test (`services/worker/tests/moderation-sor*.int.test.ts`:
   run it as the owner, then the next statement the builder writes pins the new id). If a script turns out to be
   necessary, it lives in `packages/db` and is a contract request. Then check whether the auth
   library's banned-user check (`services/api/src/auth/index.ts:186-190`) refuses sign-in for a
   suspended user (an int test signing in as a `banned` user), and record the result in the same
   operator section (if sign-in is refused, email is the user's only channel) and in your final
   message.
10. **Harness** (`harness/src/safety-sor.ts`, `runStatementsStep(run: Run)` with `Run` from
    `harness/src/safety-run.ts`, wired by the contract step as step 11 with prerequisites 4-7: T2
    label, T1 restriction, upload rejection, NCII): for every `ENFORCEMENT_SOURCE_ACTIONS` audit row the run produced
    (scope it to the run's users and channels), assert a statement exists for each expected
    recipient within 60 s, its restriction, clause and appeal subject match the selectors table, and
    `me.enforcement.list` returns it to the recipient and not to another user; perform a
    channel-moderator ban and timeout and assert no statement; check the web list via
    `data-statement-id` when `via=web`.

11. **Data export**: add an `enforcement_statements` section to the user export
    (`services/worker/src/exports/collectors.ts`), the requester's own statements by
    `recipient_user_id`, the decision 4 columns named explicitly (no joined moderator note, no
    delivery rows), oldest first. Update the section list in `docs/testing/w0-selectors.md` only
    if the contract step left it out (then it is a contract request).

## Tests you must add

- `packages/moderation`: catalog snapshot and immutability; every category maps to a clause; mapping
  per source action; no channel-scope action in the allowlist.
- `services/worker` (unit): one builder test per row of ADR 0019 decision 3 (statement or none,
  restriction, facts, automation flags, appeal subject), including a T0 CSAM-list match (no
  statement, not counted missing) and a T0 NCII-list match (statement, `hash_match`, null appeal),
  using fixtures of each writer's current `details`; a channel ban and a timeout produce no
  statement; parse failure is skipped and counted; NCII fan-out per owner with no requester data
  and the `ncii_request_item` appeal subject; the export section's columns and requester filter
  (`export-collectors.test.ts`).
- `services/worker` (int, `createTestDatabase()`): build idempotence (rerun inserts nothing), the
  append-only trigger refuses an update, delivery rows and retry bounds, coverage counts a missing
  statement, the email goes to Mailpit with no PII in logs.
- `services/api` (int): `me.enforcement.list` paging, ownership (another user's statements never
  returned), suspended caller can read (with a session created before the suspension) and can
  file an appeal from a statement's `appeal`, whether a suspended user can sign in at all (Build
  9), `reversedAt` after an overturned appeal, a T0 NCII statement listed without its case.
- `services/worker` (int) also: the documented owner-role publish command (Build 9).
- `packages/email`: the template renders every Art. 17(3) element and the draft notice.
- `apps/web`: the list, empty state, appeal prefill, draft banner (component tests).
- Harness pure helpers in `harness/tests/safety-sor*.test.ts`.

## Done means

Follow `.claude/briefs/_done-means.md`, with this batch's rule: the orchestrator runs the gate; you
run targeted checks only and never run the gate, `podman`, `scripts/infra.ts` or harness scenarios.
Run `bun run test` and `bun run test:int` (one package at a time) in `packages/moderation`,
`packages/email`, `services/worker`, `services/api`; `bun run test` and `vp build` in `apps/web`;
`bunx tsc -p <pkg> --noEmit` for each and for `harness`; `vp lint --deny-warnings` and `vp fmt` on
your paths. Commit in your worktree (`git commit -s`, Conventional Commits, message ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
Final message: what you built, test counts per package, branch and sha, contract requests (any
`details` field a writer must add for the builder, any appeal subject), the string-catalog choice,
the sign-in finding, anything left (report resolutions and admin suspensions are W2, not yours),
and the live
commands: `bun harness/src/cli.ts run trust-safety --set steps=11` (the "statements of reasons" step; its
prerequisites 4-7 run with it; check the number in `harness/src/safety.ts` after the contract step) and a manual
check of `/settings/appeals` as the T2-labelled streamer.

## Contract step as landed

- Your base is main after the W0 contract step merge (`648d04e`, "merge: W0 contract step"), which contains all of E7. Recheck line numbers against it.
- The migrations taken are `0028_enforcement_statements` and `0029_w0_protections`.
- The next free migration number is 0030.
- `0029_snapshot` is a copy of 0028.
- The entity and table carry an extra `sourceAction` / `source_action` field.
- The table columns are flat:
  - `content_type`, `content_id`
  - `restriction_kind`, `restriction_detail`, `restriction_ends_at`, `territorial_scope`
  - `ground_kind`, `clause_id`, `clause_version`, `legal_basis`
  - `guidelines_document_id`, `notice_document_id`
  - `appeal_subject_type`, `appeal_subject_id`
  - `created_at`, with no default
- Deliveries have `last_error_code` and `attempts`, plus a partial index of unsent deliveries.
- Statement CHECKs:
  - territorial scope is `'all'`;
  - `clause_version >= 1`;
  - `legal_basis` only for illegal grounds;
  - appeal subject type and id are both set or both null;
  - `facts` has a `code`.
- Statements are append-only and cannot be truncated (enforced in 0029).
- The facts schema is narrower than the ADR: `moderator_review.decision` is `z.enum(MODERATION_REVIEW_DECISIONS)` and `classifier.threshold` is bounded 0..1.
- The seed version is `ENFORCEMENT_NOTICE_SEED_VERSION` in `packages/db/src/legal/index.ts:24`. The orchestrator bumps it at merge if the skeleton reached a persistent database.
- `seed.int` exempts the skeleton notice from the 300-word minimum. Remove that exemption when the real text lands.
- `enforcement_notice` now appears among the optional documents on signup and in the legal-pending list.
- Appeals:
  - `KIND_SUBJECTS` is at `appeals.ts:89` and the `ncii_request_item` case at :227.
  - The request's decider cannot resolve the appeal (:702).
  - `whileSuspended` is on `appeals.create` at `router.ts:2300`.
  - The web maps `ncii_request_item` to the generic "other subject" label.
- The stubs are `services/api/src/routes/me-enforcement.ts`, `services/worker/src/jobs/moderation-sor.ts` (`sorJobs`, both returning `{ notBuilt: 1 }`) and `harness/src/safety-sor.ts`.
- Step 11 is pending. Remove it from `PENDING_SAFETY_STEPS` through a contract request.
- The export collectors (E7-dmca) have merged, so that file is free to edit.
