<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0019: Clause catalog and statements of reasons

- Status: Proposed (2026-10-27)
- Date: 2026-10-27 (code checked at `9c51c93`)

**Counsel has not reviewed this ADR, the record shape or the notice text.** It ships the
mechanism. The wording that is meant to satisfy DSA Art. 17 lives in an operator-editable draft
document (decision 2), labelled as unreviewed, and reviewing it is on the L1 launch checklist.
This is not legal advice.

## Context

[ADR 0006](0006-automated-moderation.md) makes automated moderation a core function and points
operators at DSA Art. 17 (statements of reasons to the affected user) in
`docs/operators/trust-safety.md:186`. Nothing produces those statements yet. `feature-wins.md`
§4.7 moved them out of the scored "Open Enforcement" feature into the unscored W0-sor compliance
track (`feature-wins.md:442`; it cites "ADR 0010" there, which means this ADR). The W0 unit owns
`packages/moderation/src/reasons.ts`, `services/worker/src/moderation/sor-*`,
`apps/web/src/routes/_app/settings.appeals.tsx` and `packages/email/src/templates/trust.tsx`
(`feature-wins.md:814`). Done means `trust-safety` asserts a statement for every platform
T1/T2/NCII action and none for channel-moderator actions (`W0-prerequisites.md`).

What the code has today:

- **Every action already writes an `audit_log` row in its own transaction.**
  `moderation.t1.restrict` and `moderation.t2.label` (`services/worker/src/moderation/scan.ts:213`,
  `:326`), `moderation.t1.upload_reject` (`services/api/src/moderation/uploads.ts:182`),
  `moderation.case.<decision>` (`services/api/src/routes/moderation.ts:218`), `ncii.decide`
  (`services/api/src/routes/ncii.ts:324`), `ncii.auto_hide`
  (`services/worker/src/moderation/ncii-clock.ts:167`). `audit_log` is append-only by trigger
  (`packages/db/drizzle/0001_protections.sql:105`, `:129`).
- **Platform and channel actions are already separated** by `mod_actions.scope`
  (`packages/contracts/src/enums.ts:163`). Platform: the case decisions
  (`services/api/src/routes/moderation.ts:171-210`). Channel: chat bans and timeouts
  (`services/chat/src/moderation.ts:412-414`, `services/api/src/routes/chat.ts:265`,
  `services/api/src/routes/channels.ts:337`). T1/T2 automatic actions and NCII removals write no
  `mod_actions` row at all.
- **No clause catalog.** The rules a user breaks are the headings of the seeded community
  guidelines (`packages/db/src/legal/guidelines.md:14-77`), a draft "pending lawyer review"
  (`:6`). The guidelines already promise "We tell you what we did and why" (`:69`).
- **Legal documents are versioned rows** (`legal_documents`, unique on kind and version,
  `packages/db/src/schema/safety.ts:200-214`), seeded as drafts (`packages/db/src/legal/index.ts:17`).
  There is no admin route to publish a new version (`services/api/src/routes/legal.ts:38-51` are
  reads and consent), and no trigger stops a row being edited.
- **Notices go in-app only.** `notifyUser` inserts a `notifications` row with ids and enums
  (`services/api/src/moderation/notify.ts:28-31`). The trust email templates are registered
  (`packages/email/src/registry.ts:31-32`) but no service sends them; the worker does send mail
  elsewhere (`services/worker/src/exports/build.ts:188`).
- **Redress has gaps.** Appeals accept `moderation_action`, `content_label` and
  `moderation_case` (`services/api/src/routes/appeals.ts:45-52`). NCII removals have no appeal
  subject, although ADR 0006 Q6 says the uploader can appeal an auto-hide. And a suspended user
  cannot file any appeal: every write is refused while suspended
  (`services/api/src/lib/access.ts:82`), `appeals.create` included.

DSA Art. 17(3) asks each statement for: (a) the restriction, its territorial scope and duration;
(b) the facts and circumstances, including whether it followed a notice (Art. 16) or the
provider's own initiative; (c) the use of automated means in detection and in the decision;
(d) for illegal content, the legal ground; (e) for terms violations, the contractual ground;
(f) redress: internal complaint, out-of-court settlement, courts. That list is the record shape.

## Decisions

### 1. The clause catalog is a typed, versioned module: `packages/moderation/src/reasons.ts`

**Options.**

- **A. A code module** (recommended). Each clause is `{ id, version, ground, guidelinesAnchor,
  legalBasis?, titleKey }`: a stable slug (`mature.unlabelled`, `safety.sexual-explicit`,
  `illegal.ncii`, …), an integer version bumped when its meaning changes, `ground` `terms` or
  `illegal`, the guidelines heading it cites, a legal-basis code for illegal grounds
  (`us.take-it-down`, `eu.member-state-law`), and an i18n key for its plain-language title. Old
  versions stay in the array. The same module maps each source action to its clause (a
  classifier category to `safety.sexual-explicit` or `mature.unlabelled`, NCII to
  `illegal.ncii`).
- **B. A `policy_rules` table** (`feature-wins.md:459`): operators could add clauses at runtime.
  But the action-to-clause mapping lives in code either way, so a clause with no code mapping
  is never cited, and runtime rows need an admin UI, a trigger for immutability and a migration
  per clause.
- **C. Clauses parsed out of the guidelines Markdown.** Rejected: an operator's wording edit
  would silently change ids.

**Why A.** Ids and versions are what code, statements, appeals and the W2 report key on, so
they belong where the compiler and tests can check them. A unit test forbids changing a released
`id@version` (a committed snapshot of id, version, ground and legal basis). The W2 unit's planned
`packages/moderation/src/clauses.ts` (`feature-wins.md:866`) should import this module, not add a
second catalog, and `rule_ref` uses the same `id@version` string.

**Consequences.** Adding a clause is a code change and a release. Operators change the
_wording_ (decision 2), not the set of clauses.

### 2. Wording lives in a versioned, operator-editable legal document, shipped as an unreviewed draft

**Options.**

- **A. A new legal-document kind `enforcement_notice`** (recommended), seeded from
  `packages/db/src/legal/enforcement_notice.md` with the same placeholders and draft banner as the
  guidelines. One section per clause id carries the explanation; fixed sections carry the
  Art. 17 framing and the redress paragraph (internal appeal, the out-of-court body the operator
  names, courts). Short labels (clause titles, restriction names) stay in the i18n catalogs per
  AGENTS.md.
- **B. An env-pointed file** (`ENFORCEMENT_NOTICE_FILE`). Simpler for operators, but unversioned
  in the database, so a statement could not say which text it was sent under.
- **C. i18n only.** Every operator would have to fork the message catalog to change legal text.

**Why A.** Legal documents already have kind-plus-version identity, placeholders rendered from the
instance env, and `isDraft`. A statement pins the `legal_documents` id it was rendered with, so
the operator can later list every statement sent under the unreviewed draft.

**Consequences (contract step).** `LEGAL_DOCUMENT_KINDS` gains `enforcement_notice`
(`packages/contracts/src/enums.ts:166`) with its enum migration; `requiresAcceptance` is false.
Pinning only works if published versions cannot change, so `legal_documents` gets an
update/delete guard trigger (immutable once `publishedAt <= now()`). Operators need a way to
publish their own version; until an admin route exists, the operator guide documents a
`db` CLI command run as the owner.

### 3. Which actions produce a statement: platform T1/T2/NCII, never channel moderation

| Source audit action                                     | Statement                   | Restriction                            |
| ------------------------------------------------------- | --------------------------- | -------------------------------------- |
| `moderation.t1.restrict` (`scan.ts:213`)                | yes                         | visibility: restricted                 |
| `moderation.t1.flag` (`scan.ts:213`, case already open) | no                          | adds a flag only                       |
| `moderation.t2.label` (`scan.ts:326`)                   | yes                         | visibility: age-gated                  |
| `moderation.t1.upload_reject` (`uploads.ts:182`)        | yes                         | visibility: removed                    |
| `moderation.case.warn` (`moderation.ts:218`)            | yes                         | warning (no restriction)               |
| `moderation.case.end_stream`                            | yes                         | visibility: removed                    |
| `moderation.case.suspend` (user, channel or both)       | yes, one per target         | account / service suspension, with end |
| `moderation.case.clear`, `.escalate_legal`              | no                          | a lift, or a hand-off to T0            |
| `ncii.decide` with `removed` (`ncii.ts:324`)            | yes, one per affected owner | visibility: removed                    |
| `ncii.decide` with `rejected`                           | no                          | nothing restricted                     |
| `ncii.auto_hide` (`ncii-clock.ts:167`)                  | yes, one per affected owner | visibility: disabled                   |
| `moderation.t0.match` (`t0.ts:284`)                     | no (open question 1)        | —                                      |
| any `mod_actions` row with `scope = 'channel'`          | never                       | —                                      |

**Options.** A: the brief's set above (recommended). B: every platform `mod_actions` row,
including report resolutions (`services/api/src/routes/safety.ts:346`) and admin suspensions
(`:505`). Art. 17 does cover those, but they carry only free-text reasons today, so they need a
clause picker in the staff UI and a required `clauseId` in two contract inputs. That is the right
next step (open question 3), not a W0 prerequisite.

Warnings are not Art. 17 restrictions; they get a statement anyway so a user's record is
complete and the W2 per-clause statistics count them. Channel-moderator actions enforce the
channel's own rules (`guidelines.md:59-63`) and stay out of statements and platform statistics.
Selection is by audit action name, which the builder's allowlist fixes; `scope = 'channel'`
rows never write a platform audit action, and a unit test asserts the allowlist contains none.

### 4. Record shape: Art. 17(3), structured, ids and enums only

```ts
EnforcementStatement = {
  id: Id;                       // uuidv7
  sourceAuditId: Id;            // the audit_log row that applied the action
  recipientUserId: Id;          // the account notified (case user, or channel owner)
  channelId: Id | null;
  content: { type: "broadcast" | "vod" | "clip" | "upload" | "channel" | "account"; id: Id };
  restriction: {                // 17(3)(a)
    kind: "visibility" | "service" | "account" | "warning";
    detail: "removed" | "disabled" | "restricted" | "age_gated" | "suspended" | "none";
    endsAt: Timestamp | null;   // null = indefinite or not applicable
    territorialScope: "all";    // no geo-scoped actions exist
  };
  facts: Facts;                 // 17(3)(b), discriminated by `code`, see below
  source: "own_initiative" | "notice_art16";
  automatedDetection: boolean;  // 17(3)(c)
  automatedDecision: "fully" | "partially" | "not";
  ground: {                     // 17(3)(d)/(e)
    kind: "terms" | "illegal";
    clauseId: string; clauseVersion: number;
    legalBasis: string | null;  // code from the catalog, illegal ground only
  };
  documents: { guidelinesId: Id; noticeId: Id };   // legal_documents rows rendered against
  appeal: { kind: "moderation"; subjectType: AppealSubject; subjectId: Id } | null; // 17(3)(f)
  createdAt: Timestamp;         // = the audit row's time: when the restriction applied
};

Facts =
  | { code: "classifier"; category: ModerationCategory; tier: "t1" | "t2";
      threshold: number; capturedAt: Timestamp }        // threshold in force, never the score
  | { code: "moderator_review"; caseId: Id; caseOrigin: "classifier" | "human"; decision: string }
  | { code: "ncii_notice"; requestId: Id; receivedAt: Timestamp; deadlineAt: Timestamp };
```

- **No exact scores.** Notices show the governance threshold
  (`packages/moderation/src/thresholds.ts:25`), as `feature-wins.md` §4.7 asks; the appeal view
  keeps the score.
- **No free text.** The moderator's note stays in `moderation_cases.resolution_note`
  (`packages/db/src/schema/moderation.ts:63`), a mutable row the API may join and show; it is
  never copied into the statement. NCII facts never name the requester (Art. 17(3)(b) asks for
  the notifier's identity only where strictly necessary, and naming them risks the requester).
- **Automation flags** follow from the source: T1/T2/upload rejections are `true`/`fully`; a
  moderator decision on a classifier case is `true`/`not`; on a human-origin case `false`/`not`;
  an NCII removal `false`/`not`; an NCII auto-hide `false`/`fully` (a deadline, not a model,
  decided).
- **Appeal subject.** T2 label → `content_label`; T1 restriction and case decisions →
  `moderation_case`; NCII → none until a subject exists (open question 4). The statement
  carries what to pass to `appeals.create`, so the client never guesses.
- The enums are modelled on the Commission's DSA Transparency Database fields, so the optional
  adapter (`feature-wins.md` §4.7, off by default) is a mapping. Field names are to be verified
  against that API when the adapter is built.

**Alternative.** Store the rendered text. Rejected: rendered text is per locale, repeats the
document body thousands of times, and adds nothing the pinned document ids and structured facts
do not already reproduce, given decision 2's immutability trigger.

### 5. Built by a worker job from `audit_log`, not inline in each action

**Options.**

- **A. A worker job reads `audit_log`** (recommended). `services/worker/src/moderation/sor-build.ts`
  runs on a BullMQ scheduler every 15 s, selects allowlisted audit rows with no statement, parses
  each row's `details` with a per-action Zod schema, resolves the recipient and the appeal
  subject, and inserts the statements. A unique index on `(source_audit_id, recipient_user_id)`
  makes reruns no-ops. A daily `sor-coverage` sweep counts allowlisted audit rows older than
  5 minutes without a statement and raises an alert and a metric (the `feature-wins.md:903`
  target is 100%).
- **B. Inline in each action's transaction.** Atomic, but it touches six files across api and
  worker that W0-sor does not own, and puts DSA knowledge in every action path.
- **C. A database trigger on `audit_log` insert.** Lowest layer, but the clause mapping and
  recipient resolution would live in PL/pgSQL, duplicated from the TypeScript catalog.

**Why A.** The audit row is already written atomically with every action and cannot be edited,
so it is a reliable source, and no action can be missed silently: the coverage sweep finds it.
Art. 17(2) asks for the statement "at the latest" when the restriction applies; a 15 s lag meets
that in practice. It keeps the unit on its own paths.

**Consequences.** Audit `details` shapes become an internal contract: the builder's per-action
schemas fail loudly (row skipped, alert, metric) on drift, and their unit tests use fixtures
taken from each writer's current shape. `audit_log` has no index on `action`
(`packages/db/src/schema/safety.ts:80-84`); the contract step adds
`audit_log_action_idx (action, created_at)`.

### 6. Storage: `enforcement_statements`, append-only, no personal data

One table with the columns of decision 4 (`facts` as `jsonb` validated by the shared Zod
schema). No foreign keys to `users` or `channels`, like the moderation tables
(`packages/db/src/schema/moderation.ts:6-7`), so account deletion never cascades into the
record. Append-only for every role with the existing `commonair_forbid_mutation()` trigger
(`0001_protections.sql:105` pattern). Delivery state is mutable, so it lives in a separate
`enforcement_statement_deliveries (statement_id, channel, sent_at, attempts, last_error)` table.

Because the row holds only ids, enums, timestamps and catalog codes, ADR 0004 pseudonymization has
nothing to rewrite. Statements are kept as long as `audit_log` rows (open question 6).

**Alternative.** Derive statements on read from `audit_log` with no table. Rejected: the
statement would change whenever the catalog mapping or recipient resolution changed, and Art. 17
is about what the user was told.

### 7. Delivery: email plus the appeals page

- **Email.** A new `enforcementStatement` template in `packages/email/src/templates/trust.tsx`,
  sent by the build job after insert, in the recipient's `users.locale`. It carries every
  Art. 17(3) element on its own (restriction, end, facts, automation, clause title and link,
  redress), because a suspended user may not be able to sign in to read it. Skipped for deleted
  accounts or accounts without an email; the delivery row records why.
- **In-app.** A `notifications` row (`type: "moderation"`, payload
  `{ kind: "enforcement_statement", statementId }`, ids only, as `notify.ts:5-6` requires), and
  the list on `/settings/appeals` above `MyAppeals`
  (`apps/web/src/routes/_app/settings.appeals.tsx:25`), each item with an "Appeal" button
  prefilled from `appeal`.

**Alternative.** In-app only. Rejected: Art. 17(2) ties delivery to known electronic contact
details, and a suspended account is the case that matters most.

### 8. `me.enforcement.list`

```ts
me.enforcement.list: user                     // session or token, user's own data
  .route({ method: "GET", path: "/me/enforcement", summary: "Statements of reasons about you", ...tag("Users") })
  .input(PageInput)                           // packages/contracts/src/api/common.ts:69
  .output(page(D.EnforcementStatement.extend({
    clauseTitle: z.string(),                  // rendered from i18n
    explanation: z.string(),                  // the clause section of the pinned notice document
    noticeIsDraft: z.boolean(),               // the notice text was unreviewed when sent
    moderatorNote: z.string().nullable(),     // joined from moderation_cases, never stored
    appealId: Id.nullable(),                  // an existing appeal against the same subject
    reversedAt: Timestamp.nullable(),         // the case cleared or the appeal overturned it
  })))
```

Newest first, keyset cursor on `(created_at, id)`, same pattern as `me.notifications`
(`packages/contracts/src/api/router.ts:156-172`). A GET, so it stays readable while suspended
(`access.ts:32`). `reversedAt` is computed on read; the statement row itself never changes.
T0 cases never appear, consistent with appeals hiding them (`appeals.ts:124-131`).

## Consequences

- **Contract step (orchestrator):** the `EnforcementStatement` entity and `me.enforcement.list`;
  `enforcement_notice` in `LEGAL_DOCUMENT_KINDS`; migration for `enforcement_statements`,
  `enforcement_statement_deliveries`, their triggers, the `legal_documents` immutability guard and
  `audit_log_action_idx`; `docs/testing/w0-selectors.md` rows for each source action.
- **W0-sor** then owns the catalog, the builder and coverage jobs, the email template, the seeded
  notice draft and the page section, with a builder unit test per row of decision 3 (channel-scope
  exclusion included) and the `trust-safety` assertion.
- **Shipped unreviewed.** The seeded notice is `isDraft: true` with the same banner as the
  guidelines; every statement records which notice version it used. The L1 checklist gains
  "counsel reviews `enforcement_notice` and the clause mapping". Statements sent before that review
  can be listed and, if counsel asks, re-sent under the reviewed text.
- **The redress line is only as good as appeals.** Until a suspended user can appeal and NCII has
  an appeal subject, the statement offers redress the platform does not deliver for those cases
  (open questions 2 and 4).
- W2's `rule_ref` and enforcement report reuse this catalog and table; they add nothing parallel.

## Open questions for the user

1. **T0 CSAM matches**: no statement by default (tipping off a suspect; Art. 17 may not require
   it where a law-enforcement duty applies), and what does the suspended account see? **T0 NCII
   list matches**: send a statement under `illegal.ncii`? Recommended: CSAM no, NCII yes; both
   for counsel.
2. **Appeals while suspended**: exempt `appeals.create` (and nothing else) from the suspended-write
   block at `access.ts:82` in the W0 contract step? Recommended yes. Also unverified: whether the
   auth library's banned-user check (`services/api/src/auth/index.ts:190`) stops a suspended user
   signing in at all, in which case email is the only channel.
3. **Report resolutions and admin suspensions** (`safety.ts:346`, `:505`): add a required
   `clauseId` and statements in E7, or leave them out until W2?
4. **NCII appeals**: add an `ncii_request_item` appeal subject (contract change, wired by
   E7-appeals), or make the statement itself the appeal subject for every action?
5. **Counsel**: the notice wording, the legal-basis codes, which out-of-court body the default
   text names, and whether our instance must submit to the DSA Transparency Database (our reading:
   Art. 17 applies to every hosting service, while the Art. 24(5) submission falls under the
   Art. 19 micro and small enterprise exemption; counsel to confirm).
6. **Retention**: keep statements as long as `audit_log` (indefinitely), or set a period?
