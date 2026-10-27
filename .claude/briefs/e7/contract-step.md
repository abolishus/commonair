<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E7 contract step (orchestrator)

The orchestrator does this on `main` before any E7 unit starts, commits it (`feat(e7): contract
step`), runs `bun run verify`, and gives that sha to the six units as their base. Everything
below was checked against `9c51c93` (2026-10-27); line numbers are from that commit. Plan:
`.claude/briefs/next/E7-platform-debts.md`. Units: `.claude/briefs/e7/E7-*.md`.

## 0. What is already done (do not redo)

Verified in code; HANDOFF.md:443-444 and PROGRESS.md:986-992 are stale on these, fix them when
you update the handoff:

| Plan item                                           | State at `9c51c93`                                                                                                                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CidrClassifier` `size` getter                      | Done: `packages/integrity/src/network.ts:162-164` (`get size()`), used at `services/worker/src/integrity/classifier.ts:33`                                                                                                         |
| `WordFilter` DTO `invalid`/`invalidReason`          | Done: `packages/contracts/src/api/entities.ts:315-320`, filled by `filterDto` in `services/api/src/routes/chat.ts:71-81` (commit `7833a19`)                                                                                        |
| `appeals.create` on the `write` bucket              | Done: `packages/contracts/src/api/router.ts:2258` (`.meta({ access: "user", rateLimit: "write" })`, commit `7833a19`)                                                                                                              |
| `vods.broadcast_id` index                           | Done: `packages/db/src/schema/media.ts:166-167`, migration `packages/db/drizzle/0022_e6_ops.sql:9`. **But** `clips.broadcast_id` has none (`schema/media.ts:192`) and E7-appeals and E7-dmca query clips by broadcast: add it (§2) |
| `ISSUANCE_KEYS` into contracts                      | **Open**: `services/origin/src/production.ts:22-30` (the `CONTRACT-REQUEST` comment). Do it (§1.5)                                                                                                                                 |
| `services/tracker/src/ip.ts` → `@commonair/service` | Not E7: the P1 contract step does it                                                                                                                                                                                               |

## 1. Contracts (`packages/contracts`)

### 1.1 `src/enums.ts` (append after `DMCA_STATUSES`, :164)

```ts
/** Platform decisions about an account that are not channel or platform mod actions (`account_actions`). */
export const ACCOUNT_ACTIONS = ["dmca_strike", "dmca_termination"] as const;
/** Why an account action was reversed. */
export const ACCOUNT_ACTION_REVERSALS = [
  "appeal_overturned",
  "counter_notice_restored",
  "strikes_below_threshold",
] as const;
/** What a DMCA notice URL can resolve to (anything else stays unresolved; staff handle it by hand). */
export const DMCA_ITEM_SUBJECTS = ["vod", "clip", "broadcast"] as const;
/**
 * DMCA policy constants (17 U.S.C. § 512; not reviewed by a lawyer). `restoreWeekdays`: content
 * comes back 12 weekdays after a counter-notice, which is never fewer than 10 nor more than 14
 * business days even with two federal holidays in the window (§ 512(g)(2)(C)). Repeat infringers:
 * `repeatInfringerStrikes` unreversed strikes within `strikeWindowDays` suspend the account
 * (an `account_actions` `dmca_termination`, appealable); 0 turns the automatic suspension off
 * (moderators are notified only).
 */
export const DMCA_RULES = { restoreWeekdays: 12, repeatInfringerStrikes: 3, strikeWindowDays: 365 } as const;
```

### 1.2 `src/api/entities.ts`

- `LegalDocument` (:902-910): add `requiresAcceptance: z.boolean()` after `isDraft`.
- Replace `DmcaNotice` (:877-884) with the staff view, and add the owner view and its parts:

```ts
export const DmcaNoticeItem = z.object({
  id: Id,
  url: z.string(),
  subjectType: z.enum(E.DMCA_ITEM_SUBJECTS).nullable(),
  subjectId: Id.nullable(),
  ownerId: Id.nullable(),
  removedAt: Timestamp.nullable(),
  restoredAt: Timestamp.nullable(),
});
/** Staff view (platform moderators): the claimant's contact details are on it, never in logs or events. */
export const DmcaCounterNotice = z.object({
  id: Id,
  noticeId: Id,
  user: UserPublic.pick({ id: true, username: true }),
  itemIds: z.array(Id),
  fullName: z.string(),
  address: z.string(),
  phone: z.string(),
  statement: z.string(),
  restoreAfter: Timestamp,
  restoredAt: Timestamp.nullable(),
  suitFiledAt: Timestamp.nullable(),
  suitNote: z.string().nullable(),
  createdAt: Timestamp,
});
export const DmcaNotice = z.object({
  id: Id,
  status: z.enum(E.DMCA_STATUSES),
  claimantName: z.string(),
  claimantEmail: z.string(),
  claimantAddress: z.string(),
  claimantPhone: z.string().nullable(),
  copyrightedWork: z.string(),
  infringingUrls: z.array(z.string()),
  signature: z.string(),
  items: z.array(DmcaNoticeItem),
  counters: z.array(DmcaCounterNotice),
  /** Unreversed strikes in the window per item owner id, for the repeat-infringer policy. */
  ownerStrikes: z.record(Id, z.number().int()),
  handledBy: UserPublic.pick({ id: true, username: true }).nullable(),
  decisionNote: z.string().nullable(),
  createdAt: Timestamp,
  actionedAt: Timestamp.nullable(),
});
/** What the owner of removed content sees: the claimant's name only, never their contact details. */
export const DmcaNoticeForOwner = z.object({
  id: Id,
  status: z.enum(E.DMCA_STATUSES),
  claimantName: z.string(),
  copyrightedWork: z.string(),
  items: z.array(DmcaNoticeItem),
  counter: z
    .object({ id: Id, restoreAfter: Timestamp, restoredAt: Timestamp.nullable(), suitFiledAt: Timestamp.nullable() })
    .nullable(),
  createdAt: Timestamp,
  actionedAt: Timestamp.nullable(),
});
export const AccountAction = z.object({
  id: Id,
  action: z.enum(E.ACCOUNT_ACTIONS),
  /** The decision that caused it, e.g. `dmca_notice` + the notice id. */
  sourceType: z.string().nullable(),
  sourceId: Id.nullable(),
  createdAt: Timestamp,
  reversedAt: Timestamp.nullable(),
  reversedReason: z.enum(E.ACCOUNT_ACTION_REVERSALS).nullable(),
});
```

### 1.3 `src/api/router.ts`

- `safety.dmca.submit` (:2374-2394): add `claimantPhone: z.string().min(5).max(40).optional()` to the
  input (§ 512(c)(3)(A)(iv) "such as … telephone number").
- `safety.dmca.counter` (:2395-2412): add `.meta({ access: "user", rateLimit: "write" })`, and to the
  input `phone: z.string().min(5).max(40)` (§ 512(g)(3)(D) requires it), `itemIds: z.array(Id).min(1).max(50)`
  (§ 512(g)(3)(B): which removed material), `goodFaithStatement: z.literal(true)` (§ 512(g)(3)(C),
  under penalty of perjury). Document on `consentToJurisdiction` that it covers both consent to
  jurisdiction and accepting service of process (§ 512(g)(3)(D)). Output stays `{ restoreAfter }`.
- `safety.dmca.queue` / `action` (:2413-2432): unchanged inputs; they now return the new `DmcaNotice`.
- New `safety.dmca.mine`: `user.route({ method: "GET", path: "/dmca/mine", summary: "Copyright notices about your content", ...tag("DMCA") }).output(z.array(D.DmcaNoticeForOwner))`.
- New `safety.dmca.suitFiled`: `platformMod.route({ method: "POST", path: "/admin/dmca/counter-notices/{id}/suit", summary: "Record that the claimant filed suit (blocks the restore)", ...tag("DMCA") }).input(z.object({ id: Id, note: z.string().max(2000) })).output(D.DmcaNotice)`.
- New `appeals.accountActions` (inside `appeals:` at :2256): `user.route({ method: "GET", path: "/appeals/account-actions", summary: "Account actions about you (appealable)", ...tag("Appeals") }).output(z.array(D.AccountAction))`.
- New `coop.join` (after `coop.exit`, :1940-1948): `user.meta({ access: "user", rateLimit: "write" }).route({ method: "POST", path: "/coop/membership/{class}/join", summary: "Rejoin the viewer class (a qualifying subscription, no new share)", ...tag("Co-op") }).input(z.object({ class: z.literal("viewer") })).output(D.MembershipView)`.

### 1.4 `src/events.ts` (internal events; ids, enums, counts and timestamps only)

Add after `ncmec.draft.created` (:622-629), each `version: "1"`, `condition: []`, `scopes: []`,
`internal: true`:

| Type                      | Description                                                           | Payload                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `dmca.notice.received`    | Internal: a DMCA notice arrived                                       | `notice_id: id, items: int, resolved_items: int`                                                                                    |
| `dmca.notice.decided`     | Internal: a DMCA notice was actioned or rejected                      | `notice_id: id, decision: z.enum(["actioned", "rejected"]), removed_items: int`                                                     |
| `dmca.counter.received`   | Internal: a counter-notice arrived (the restore clock started)        | `notice_id: id, counter_notice_id: id, restore_after: ts, items: int`                                                               |
| `dmca.counter.suit_filed` | Internal: the claimant filed suit; the content stays down             | `notice_id: id, counter_notice_id: id`                                                                                              |
| `dmca.content.restored`   | Internal: countered content was restored after the waiting period     | `notice_id: id, counter_notice_id: id, restored_items: int`                                                                         |
| `account.action.recorded` | Internal: an account action (DMCA strike or termination) was recorded | `account_action_id: id, user_id: id, action: z.enum(ACCOUNT_ACTIONS), source_type: z.string().nullable(), source_id: id.nullable()` |
| `account.action.reversed` | Internal: an account action was reversed                              | `account_action_id: id, user_id: id, action: z.enum(ACCOUNT_ACTIONS), reversal: z.enum(ACCOUNT_ACTION_REVERSALS)`                   |

(Key names avoid the patterns `packages/contracts/tests/contract.test.ts:108` refuses: no `url`,
`name`, `email`, `note`, `…reason`, `body`.) Update the sorted list in
`packages/contracts/tests/contract.test.ts:88-105` with the seven types.

### 1.5 `src/internal.ts`

- `INTERNAL_ROUTES` (:66-87): add `/** POST a DmcaTickBody: run the dmca-restore job once as of that time (test hooks only). */ dmcaTick: "/internal/moderation/dmca-tick",`.
- `MODERATION_JOBS` (:278-290): add `dmcaDisable: "dmca-disable"`, `dmcaRestore: "dmca-restore"`.
- Next to `NciiTickBody` (:390-391): `DmcaDisableJob = z.object({ noticeId: z.uuid() })`,
  `DmcaRestoreJob = z.object({ asOf: z.iso.datetime({ offset: true }).optional() })`,
  `DmcaRestoreResult = z.object({ restored: z.number().int(), counters: z.number().int() })`,
  `DmcaTickBody = z.object({ asOf: z.iso.datetime({ offset: true }) })`, with their types.
- `KEYS` (:131-190): add `issuanceProduction: (epochMinute: number) => \`issuance:production:${epochMinute}\``,
  `issuanceSeen: (object: string) => \`issuance:seen:${object}\``, `issuanceLock: "issuance:lock"`, with the
  comments from `services/origin/src/production.ts:24-29`. Then make `ISSUANCE_KEYS`in`production.ts:23-30` `{ production: KEYS.issuanceProduction, seen: KEYS.issuanceSeen, lock: KEYS.issuanceLock }`and drop the`CONTRACT-REQUEST`comment (:22). Optional:`harness/src/multi/monitor.ts:41`
  `ISSUANCE_LOCK_KEY = KEYS.issuanceLock`. Run `services/origin` unit tests.

## 2. Database (follow `.claude/skills/schema-change/SKILL.md`)

### 2.1 Schema (`packages/db/src/schema/`)

`_shared.ts` (after `dmcaStatus`, :68):

```ts
export const accountAction = pgEnum("account_action", E.ACCOUNT_ACTIONS);
export const accountActionReversal = pgEnum("account_action_reversal", E.ACCOUNT_ACTION_REVERSALS);
export const dmcaItemSubject = pgEnum("dmca_item_subject", E.DMCA_ITEM_SUBJECTS);
```

`safety.ts`:

- `dmcaNotices` (:159-179): add `claimantPhone: text()` and `decisionNote: text()` (the
  moderator's `action` note, mutable row only); **drop** `subjectType` and `subjectId`
  (never written: `submit` has answered 501 since migration 0000; items replace them).
- `dmcaCounterNotices` (:181-197): add `phone: text().notNull()`, `itemIds: uuid().array().notNull()`,
  `goodFaithStatement: boolean().notNull()`, `suitFiledAt: ts()`, `suitRecordedById: uuid()`,
  `suitNote: text()`; table
  options `uniqueIndex("dmca_counter_notices_notice_user_uq").on(t.noticeId, t.userId)` and
  `index("dmca_counter_notices_due_idx").on(t.restoreAfter).where(sql\`${t.restoredAt} is null and ${t.suitFiledAt} is null\`)`.
  (`NOT NULL`without a default is safe: the table is provably empty,`counter` was 501.)
- New `dmcaNoticeItems` (after `dmcaCounterNotices`):

```ts
/** One infringing URL of a notice and what it resolved to; removal and restore are set once each. */
export const dmcaNoticeItems = pgTable(
  "dmca_notice_items",
  {
    id: id(),
    noticeId: uuid()
      .notNull()
      .references(() => dmcaNotices.id, { onDelete: "restrict" }),
    url: text().notNull(),
    subjectType: dmcaItemSubject(),
    subjectId: uuid(),
    /** The channel owner (the uploader for the purposes of § 512(g)). */
    ownerId: uuid().references(() => users.id, { onDelete: "restrict" }),
    channelId: uuid().references(() => channels.id, { onDelete: "restrict" }),
    removedAt: ts(),
    /** Objects moved to the private DMCA prefix (worker `dmca-disable`). */
    objectsHiddenAt: ts(),
    restoredAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index("dmca_notice_items_notice_idx").on(t.noticeId),
    index("dmca_notice_items_owner_idx").on(t.ownerId, t.createdAt),
    index("dmca_notice_items_subject_idx").on(t.subjectType, t.subjectId),
  ],
);
```

- New `accountActions` (after `appeals`, :133-157). No free-text column at all (ADR 0004):

```ts
/** Platform decisions about an account outside `mod_actions` (DMCA strikes, repeat-infringer suspension). */
export const accountActions = pgTable(
  "account_actions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: accountAction().notNull(),
    sourceType: text(),
    sourceId: uuid(),
    actorType: actorType().notNull(),
    actorId: uuid(),
    createdAt: createdAt(),
    reversedAt: ts(),
    reversedById: uuid(),
    reversedReason: accountActionReversal(),
    reversalAppealId: uuid(),
  },
  (t) => [
    index("account_actions_user_idx").on(t.userId, t.createdAt),
    index("account_actions_source_idx").on(t.sourceType, t.sourceId),
    index("account_actions_active_idx")
      .on(t.userId, t.action)
      .where(sql`${t.reversedAt} is null`),
    check("account_actions_reversal_ck", sql`(${t.reversedAt} is null) = (${t.reversedReason} is null)`),
  ],
);
```

`media.ts` `clips` (:171-193): add `index("clips_broadcast_idx").on(t.broadcastId)` (comment: NCII
broadcast hashing and DMCA broadcast items look clips up by broadcast).

`safety.ts` `consentRecords` (:230-242): add
`index("consent_records_anon_created_idx").on(t.createdAt).where(sql\`${t.userId} is null\`)`
(comment: the E7-legal retention job deletes old anonymous rows in batches; without it every run
scans the table). E7-legal cannot add it: it owns no migration.

### 2.2 Migrations

1. `cd packages/db && bunx drizzle-kit generate --name e7_platform_debts` → `0024_e7_platform_debts.sql`.
   Check it: three enums, two tables, the dmca column adds and drops, ten new indexes (three on
   `dmca_notice_items`, three on `account_actions`, two on `dmca_counter_notices`,
   `clips_broadcast_idx`, `consent_records_anon_created_idx`), the check.
2. `bunx drizzle-kit generate --custom --name e7_protections` → `0025_e7_protections.sql`, SPDX
   header, `--> statement-breakpoint` separators:
   - `CREATE TRIGGER account_actions_guard BEFORE UPDATE OR DELETE ON public.account_actions FOR EACH ROW EXECUTE FUNCTION commonair_revocable_row_guard('reversed_at', 'reversed_by_id', 'reversed_reason', 'reversal_appeal_id');`
     (the 0016 function: only these columns change, once, from NULL; DELETE refused).
   - `CREATE TRIGGER dmca_notice_items_guard BEFORE UPDATE OR DELETE ON public.dmca_notice_items FOR EACH ROW EXECUTE FUNCTION commonair_revocable_row_guard('removed_at', 'objects_hidden_at', 'restored_at');`
   - `… _no_truncate BEFORE TRUNCATE … EXECUTE FUNCTION commonair_forbid_mutation()` for
     `account_actions`, `dmca_notice_items`, `dmca_notices`, `dmca_counter_notices`.
   - `CREATE OR REPLACE FUNCTION commonair_configure_app_role(r name)`: the body of
     `0021_coop_protections.sql:389-410` unchanged, plus
     `EXECUTE format('REVOKE DELETE ON public.account_actions, public.dmca_notices, public.dmca_counter_notices, public.dmca_notice_items FROM %I', r);`
     with the comment "E7 (0025): account actions and DMCA records are never deleted by the app".
     Keep `REVOKE EXECUTE … FROM PUBLIC`. (`infra/postgres/app-role.sql:75` re-applies it after
     migrations.) `dmca_notices` and `dmca_counter_notices` stay updatable (status, scrubbing).
3. Tests: new `packages/db/tests/e7.int.test.ts` with `createTestDatabase()` as the app role:
   an `account_actions` row cannot be deleted or have `action`/`user_id` changed, can be reversed
   once (second reversal refused), the reversal check refuses `reversed_at` without a reason;
   `dmca_notice_items` `removed_at` set once, `url` immutable; DELETE on the four tables refused.

## 3. Shared-code moves (no behaviour change; existing tests stay green)

- **`services/api/src/moderation/suspension.ts`** (new): move `setSuspension` from
  `services/api/src/routes/safety.ts:120-170` with its imports; export it; add a final parameter
  `reason: "moderation" | "dmca_repeat_infringer" = "moderation"` written to `users.banReason`
  and `channels.suspendedReason` where today the literal `"moderation"` is (:136, :155).
  `safety.ts` imports it. (E7-dmca and E7-appeals both need it; neither may edit the other's file.)
- **`services/api/src/moderation/chat-bans.ts`** (new): move `isActiveBan` (chat.ts:~125-128) and
  extract from `chat.bans.unban` (chat.ts:398-436) a
  `liftChatBanInTx(tx, { channel: ChannelRow, target: { id, username, name }, actor: { id: string; actorType: "moderator" | "admin" }, now: Date, appealId?: string }): Promise<ChatBanRow | null>`
  that does the `chat_bans` update, the `mod_actions` `unban`/`untimeout` row, the audit row
  (`chat.unban`/`chat.untimeout`, `details: { banId, appealId? }`) and the `channel.unban` outbox
  event, and returns the lifted active ban or `null`. `unban` keeps its `notFound` and the
  `publishControl(… "invalidate", scope "user")` after commit. (E7-appeals lifts bans with it;
  E7-chat-http owns `chat.ts`.)
- **`packages/contracts/src/chat.ts`**: lift the pure parts of `services/chat/src/events.ts:16-70`
  (`MENTION`, `fragmentsOf`, and the payload object of `chatMessageEvent` as
  `chatMessageEventPayload(channel: { ownerId: string; slug: string; displayName: string }, message: ChatMessage): EventPayload<"channel.chat.message">`)
  into contracts; `services/chat/src/events.ts` keeps `chatMessageEvent` (it adds `uuidv7()` and
  the envelope) on top of it. (E7-chat-http publishes an allowed held message's
  `channel.chat.message` from the API and must build the identical payload.) Run the chat tests.

- **`packages/db/src/account-actions.ts`** (new, exported from `packages/db/src/index.ts` like
  `hold-lock.ts`). E7-dmca (API and worker) and E7-appeals (API) all reverse strikes and lift the
  repeat-infringer suspension, in parallel and in two services; the worker cannot import
  `services/api`, so the shared rules live here, small and pure SQL:
  - `lockAccountActions(tx, userId)`: `pg_advisory_xact_lock(hashtextextended('account_actions:' || userId, 0))`.
    Every path that records or reverses an account action for a user takes it first.
  - `activeDmcaStrikes(tx, userId, now): Promise<number>`: unreversed `dmca_strike` rows with
    `created_at > now - DMCA_RULES.strikeWindowDays`.
  - `activeAccountAction(tx, userId, action)`: the unreversed row of that action, or `null`.
  - `reverseAccountActionInTx(tx, { id, now, byId: string | null, reason, appealId? })`: CAS
    `where reversed_at is null`, returns the reversed row or `null` (already reversed). Callers write
    the `account.action.reversed` event and the audit row themselves (their own outbox helper).
  - `liftDmcaSuspensionInTx(tx, userId): Promise<boolean>`: `update users set banned = false,
    ban_reason = null, ban_expires = null where id = $1 and banned and ban_reason = 'dmca_repeat_infringer'`.
    Never touches a moderation or T0 suspension. Callers publish `BUS.userControl` invalidate after
    commit (API: `publishUserControl`; worker: `ctx.valkey.publish(BUS.userControl, …)` as `t0.ts:380`).
  - `reconcileDmcaTerminationInTx(tx, { userId, now, byId })`: if an unreversed `dmca_termination`
    exists and `activeDmcaStrikes < DMCA_RULES.repeatInfringerStrikes` (or the threshold is 0),
    reverse it with `strikes_below_threshold` and `liftDmcaSuspensionInTx`; returns the reversed row
    or `null`.
    Tests for all five in `packages/db/tests/e7.int.test.ts` (window boundary, threshold 0, a
    moderation suspension left alone, double reversal → `null`).

## 4. API stubs (so the router type-checks)

`base.router` (`services/api/src/router.ts:29`) requires every procedure. Add, each
`.handler(notImplemented)`: `safety.dmca.mine` and `safety.dmca.suitFiled` in the `dmca:` block
(`services/api/src/routes/safety.ts:479-484`); `appeals.accountActions` in
`services/api/src/routes/appeals.ts` (after `mine`, :252); `coop.join` in
`services/api/src/coop/membership.ts` (`membershipHandlers`, after `exit`, :314) mapped in
`services/api/src/routes/coop.ts:15`. In `services/api/src/routes/legal.ts:24-35` `toDto` add
`requiresAcceptance: row.requiresAcceptance`. No change to `router.ts` itself (no new namespace).

## 5. Worker job stubs

Register in `services/worker/src/jobs/index.ts` (imports :9-38, `JOBS` :40-71) three new files
the units then own; each `defineJob` with the final queue, name, data schema and schedule, and a
handler returning a zero result:

- `services/worker/src/jobs/dmca-disable.ts`: `QUEUES.moderation`, `MODERATION_JOBS.dmcaDisable`, `DmcaDisableJob`, `attempts: 10`, no schedule → `{ items: 0, objects: 0 }`.
- `services/worker/src/jobs/dmca-restore.ts`: `QUEUES.moderation`, `MODERATION_JOBS.dmcaRestore`, `DmcaRestoreJob`, `schedule: { every: 900_000 }`, `attempts: 3` → `DmcaRestoreResult` zeros.
- `services/worker/src/jobs/legal-consent-retention.ts`: `QUEUES.retention`, name `"legal-consent-retention"`, `z.object({})`, `schedule: { pattern: "23 3 * * *" }` → `{ deleted: 0 }`.

## 6. Web scaffolding (`apps/web`)

- **Routes (placeholders):** create these six files, each `createFileRoute(...)({ component: () => <NotFoundState /> })`
  (`apps/web/src/components/money/not-found.tsx`), with the guards they will keep: `_app/dmca.tsx`
  (`/_app/dmca`, public), `_app/settings.copyright.tsx` (`/_app/settings/copyright`,
  `beforeLoad: () => requireSession(() => getSessionUser())` as `settings.appeals.tsx:13-16`),
  `_admin/admin.dmca.tsx`, `_admin/admin.egress.tsx`, `_admin/admin.incidents.tsx`,
  `_admin/admin.integrity.tsx`. Run `vp build` (or the TanStack generator) once and commit the
  regenerated `apps/web/src/routeTree.gen.ts`. **No unit adds, renames or removes a route file.**
- **Access and nav:** `apps/web/src/components/safety/access.ts`: `AdminPage` gains `"dmca" | "egress" | "incidents" | "integrity"`;
  `adminPageFor` maps `/admin/dmca`, `/admin/egress`, `/admin/incidents`, `/admin/integrity`;
  `mayOpenAdminPage`: `dmca` → `isPlatformModerator`, the other three → admin only.
  `apps/web/src/lib/nav.ts`: `AdminEntry` ids/`to`s and `adminNav` (dmca under `platformModerator`,
  the three under `admin`, in the order moderation, appeals, dmca, legal, coop, integrity, egress,
  incidents); `AccountEntry` gains `{ id: "copyright", to: "/settings/copyright" }` after `appeals`;
  `FooterEntry` gains `{ id: "dmca", to: "/dmca" }` after `takedown`. `apps/web/src/routes/_admin.tsx`
  `adminItem` (:44-88): four cases with Hugeicons (e.g. `Copyright01Icon` or `LegalDocument01Icon`, `ShieldUserIcon`,
  `Chart01Icon`, `Alert02Icon`: check they exist in `@hugeicons/core-free-icons`). `apps/web/src/components/site-chrome.tsx`:
  `footerLink` (:233-245) case `dmca` → `<Link data-testid="footer-dmca-link" to="/dmca" />`; the
  account-menu renderer gets `copyright` with `data-testid="account-copyright-link"`. Update
  `apps/web/tests/nav.test.ts` expectations.
- **i18n:** create five empty unit catalogs, each `export const e7<Unit>Messages = {} as const;` with
  an SPDX header and an owner comment: `apps/web/src/i18n/e7-chat.ts` (`e7ChatMessages`),
  `e7-dmca.ts`, `e7-admin.ts`, `e7-appeals.ts`, `e7-legal.ts`. Spread them in `apps/web/src/i18n/en.ts`
  (:11-16). Inline keys in `en.ts` for the chrome above: `nav.adminDmca`, `nav.adminIntegrity`,
  `nav.adminEgress`, `nav.adminIncidents`, `nav.copyright`, `footer.dmca`. Add a test to
  `apps/web/tests/i18n.test.ts` (after :88-…) "keeps the E7 unit catalogs disjoint from every other
  catalog and the inline keys, and uses all of them", modelled on the E6 test, over the five new
  catalogs plus `coop`, `ops`, `safety`, `money`, `support`. E7-coop keeps using `coop.ts`.
- **Legal pending banner:** create `apps/web/src/components/legal-pending.tsx` exporting
  `LegalPending(): React.JSX.Element | null` that returns `null`, and mount it once in the signed-in
  app shell (`apps/web/src/routes/_app.tsx`, inside the shell above `<Outlet />`). E7-legal fills it.

## 7. Harness scaffolding

- `harness/src/e7/selectors.ts`: `E7_TEST_IDS`, `E7_ROUTES` and `E7_ROUTE_PATTERNS` from §8, in
  the shape of `harness/src/e6/selectors.ts`; `harness/tests/e7/selectors.test.ts` checks them
  against `docs/testing/e7-selectors.md` like `harness/tests/e6/selectors.test.ts`.
- **trust-safety:** move `Run`, `Staff`, `Streamer` (`harness/scenarios/trust-safety.ts:102-131`)
  and the helpers `title`, `newStreamer`, `publisher`, `benign`, `waitLive`, `waitClip`
  (:295-354, :941-951) into new `harness/src/safety-run.ts` (exported; pure move). In
  `harness/src/safety.ts:18-39` add steps `8: "DMCA takedown and counter-notice"`,
  `9: "overturned appeal lifts the ban"`, both without prerequisites, and fix the `(1-7)` range
  message (:60). In the scenario's step switch (:265-291) add `case 8: await stepDmca(run)` and
  `case 9: await stepAppealLiftsBan(run)`, imported from two new stub modules
  `harness/src/e7/dmca.ts` and `harness/src/e7/appeal-ban.ts` whose functions
  `(run: Run) => Promise<void>` throw `new Error("E7-dmca not merged")` / `"E7-appeals not merged"`.
  Update the scenario `description` and `harness/tests/safety.test.ts`. E7-dmca and E7-appeals own
  the two modules; **no unit edits `trust-safety.ts`, `safety.ts` or `safety-run.ts`** (contract
  request instead).
- `harness/src/safety-io.ts` `ModerationHooks` (:58-89): add
  `async dmcaTick(asOf: string): Promise<DmcaRestoreResult>` next to `nciiTick` (same
  `call("POST", INTERNAL_ROUTES.dmcaTick, { asOf }, 45_000)`, parsed with `DmcaRestoreResult`).
  `Run.hooks` is a `ModerationHooks`, so E7-dmca's step 8 calls `run.hooks.dmcaTick(...)`; nobody
  edits `safety-io.ts` this wave.
- `e2e-social` (owned by E7-chat-http), `e5-coop` (E7-coop) and the new `e7-admin` scenario
  (E7-admin, auto-discovered from `harness/scenarios/`) need no scaffolding.

## 8. `docs/testing/e7-selectors.md` (write it; the units build against it)

Header and intro as `docs/testing/e1-selectors.md:1-11` ("E7 web ↔ harness contract (platform
debts)"; changing a test id is a contract change). Sections and tables below; in the document
each `###` heading here is a `##` heading (`## Rules`, `## Routes`, `## Test ids`, `## Scenarios`),
and the bold group labels under Test ids become `###` headings, so
`harness/tests/e7/selectors.test.ts` can find them the way the E6 test does:

### Rules

- Tests select by `data-testid`, never visible text. Option items follow `<field>-<value>`.
- DMCA records (claimant name, email, address, phone, signatures, counter-notice text) live only
  on the mutable `dmca_*` rows: never in logs, audit `details`, events or `account_actions`.
  Audit and events carry ids, enums and counts.
- Test hooks: `POST /internal/moderation/dmca-tick` (`{ asOf }`, behind `INTERNAL_API_SECRET`, only
  while `MODERATION_TEST_HOOKS=true`, otherwise 404): the API enqueues `dmca-restore` with that
  `asOf`, waits (30 s) and returns `DmcaRestoreResult`. Nothing else shortens the waiting period.

### Routes

| Route                 | Purpose                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `/dmca`               | New, public: the DMCA notice form (§ 512(c)(3)(A)); linked from the footer and the DMCA policy         |
| `/settings/copyright` | New, signed in: notices about your content, their items, and the counter-notice form (§ 512(g)(3))     |
| `/admin/dmca`         | New, platform moderators: the DMCA queue, notice detail, action or reject, counter-notices, suit filed |
| `/admin/integrity`    | New, admins: integrity flags with filters, decide (excluded or allowed)                                |
| `/admin/egress`       | New, admins: egress by delivery source and by broadcast for a range                                    |
| `/admin/incidents`    | New, admins: open and update status-page incidents                                                     |
| `/$channel`           | Chat panel: the held-message queue for the broadcaster and channel moderators                          |
| `/settings/appeals`   | Account actions about you (DMCA strikes, termination) with an appeal button                            |
| `/coop/membership`    | Rejoin the viewer class after an exit, when a subscription qualifies                                   |
| `/coop/council`       | Board elections: nominate and vote (was read-only)                                                     |

### Test ids

**DMCA notice (`/dmca`)**

| Test id            | Element / meaning                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dmca-form`        | The form; fields `dmca-name`, `dmca-email`, `dmca-address`, `dmca-phone` (optional), `dmca-work` (the copyrighted work), `dmca-urls` (one URL per line, 1–50), `dmca-good-faith` and `dmca-accuracy` (checkboxes; the second is "under penalty of perjury"), `dmca-signature`, the ALTCHA widget wrapper `dmca-altcha` (`data-state="verified"` once solved), `dmca-submit` |
| `dmca-receipt`     | Replaces the form on success: `data-notice-id`                                                                                                                                                                                                                                                                                                                              |
| `footer-dmca-link` | In the site footer, a link to `/dmca`                                                                                                                                                                                                                                                                                                                                       |

**Your content (`/settings/copyright`)**

| Test id                  | Element / meaning                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account-copyright-link` | In the account menu, a link to `/settings/copyright`                                                                                                                                                                                                               |
| `copyright`              | Page wrapper; `copyright-empty` `<EmptyState>`                                                                                                                                                                                                                     |
| `copyright-notice`       | One notice: `data-notice-id`, `data-status`; contains `copyright-item` rows (`data-item-id`, `data-subject-type`, `data-subject-id`, `data-removed` and `data-restored` as `true`/`false`)                                                                         |
| `counter-open`           | Opens the counter-notice dialog (only while the notice has removed, unrestored items of yours and no counter-notice)                                                                                                                                               |
| `counter-form`           | The dialog: `counter-name`, `counter-address`, `counter-phone`, `counter-item-<itemId>` (checkbox per removed item, all checked by default), `counter-statement`, `counter-good-faith`, `counter-jurisdiction` (checkboxes), `counter-signature`, `counter-submit` |
| `counter-receipt`        | On the notice after filing: `data-counter-id`, `data-restore-after` (ISO), `data-restored` (`true`/`false`), `data-suit-filed` (`true`/`false`)                                                                                                                    |

**DMCA queue (`/admin/dmca`)**

| Test id          | Element / meaning                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dmcaq`          | Page wrapper; status filter `dmcaq-status` with items `dmcaq-status-<status>` (`DMCA_STATUSES`); `dmcaq-empty`                                                                      |
| `dmcaq-item`     | One notice row (opens the detail): `data-notice-id`, `data-status`, `data-items`, `data-resolved-items`                                                                             |
| `dmcaq-detail`   | Detail: `data-notice-id`, `data-status`; `dmcaq-item-row` per item (`data-item-id`, `data-subject-type`, `data-subject-id`, `data-owner-id`, `data-removed-at`, `data-restored-at`) |
| `dmcaq-strikes`  | Per item owner: `data-user-id`, `data-strikes`, `data-repeat-infringer` (`true` at or over `DMCA_RULES.repeatInfringerStrikes`)                                                     |
| `dmcaq-decision` | `<ChoiceToggle>` items `dmcaq-decision-actioned`, `dmcaq-decision-rejected`; `dmcaq-note`; `dmcaq-submit` (a `ConfirmDialog` for `actioned`)                                        |
| `dmcaq-counter`  | One counter-notice: `data-counter-id`, `data-restore-after`, `data-restored-at`, `data-suit-filed-at` (empty when null); `dmcaq-suit-note`, `dmcaq-suit-filed` (`ConfirmDialog`)    |

**Held messages (`/$channel` chat panel; broadcaster and channel moderators only)**

| Test id           | Element / meaning                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `held-queue-open` | Button in the chat header: `data-count` (held messages waiting); absent for everyone else                 |
| `held-queue`      | The panel; `held-queue-empty` `<EmptyState>`                                                              |
| `held-message`    | One held message: `data-id` (the chat message id), `data-username`; contains `held-allow` and `held-deny` |

An allowed message then appears to everyone as `chat-message` with the same `data-id`; a denied one
leaves the queue and is never shown to viewers.

**Account actions (`/settings/appeals`)**

| Test id                      | Element / meaning                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `account-action`             | One action: `data-action-id`, `data-action` (`ACCOUNT_ACTIONS`), `data-reversed` (`true`/`false`) |
| `account-action-appeal-open` | Opens the appeal dialog (unreversed actions without an open appeal)                               |
| `account-appeal-dialog`      | `account-appeal-body` (10–5000), `account-appeal-submit`                                          |

`appeal-row` (e4c) gains `data-kind`.

**Integrity (`/admin/integrity`)**

| Test id             | Element / meaning                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrityq`        | Page wrapper; filters `integrityq-subject` (items `integrityq-subject-<type>`), `integrityq-decision` (items `integrityq-decision-<decision>`), `integrityq-channel` (slug input); `integrityq-empty` |
| `integrityq-item`   | One flag: `data-flag-id`, `data-subject-type`, `data-subject-id`, `data-signal`, `data-score`, `data-decision`                                                                                        |
| `integrityq-decide` | On a flag: items `integrityq-decide-excluded`, `integrityq-decide-allowed`; `integrityq-reason` (required); `integrityq-submit`                                                                       |

**Egress (`/admin/egress`)**

| Test id        | Element / meaning                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `egress`       | Page wrapper; `egress-from`, `egress-to` (`<input type="datetime-local">`, UTC), `egress-load`; `egress-empty`; `egress-error` |
| `egress-total` | One per delivery source: `data-source` (`DELIVERY_SOURCES`), `data-bytes`                                                      |
| `egress-row`   | One broadcast: `data-broadcast-id`, `data-channel`, `data-origin`, `data-relay`, `data-p2p`, `data-cdn` (bytes)                |

**Incidents (`/admin/incidents`)**

| Test id         | Element / meaning                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `incidents`     | Page wrapper (lists the open and recent incidents from `instance.status`); `incidents-empty`; `incident-new` opens `incident-form`               |
| `incident-row`  | `data-incident-id`, `data-status`; `incident-edit` opens `incident-form` filled                                                                  |
| `incident-form` | `incident-title`, `incident-status` (items `incident-status-<status>`), `incident-components` (one per line), `incident-body`, `incident-submit` |

**Co-op (`/coop/membership`, `/coop/council`)**

| Test id                    | Element / meaning                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `membership-rejoin-viewer` | Calls `coop.join({ class: "viewer" })`; shown only when there is no active viewer membership, the last one exited, and a subscription qualifies           |
| `coop-load-error`          | Any co-op page whose load failed (instead of a skeleton forever); contains `coop-retry`                                                                   |
| `election-nominate`        | On an `election-item` in `nominating` for a member of its class: opens `election-nominate-statement` + `election-nominate-submit`                         |
| `election-candidate`       | One candidate: `data-candidate-id`, `data-username`                                                                                                       |
| `election-ballot`          | On a `voting` election for an eligible member: `election-ballot-<candidateId>` checkboxes (≤ seats), `election-ballot-submit`; `election-voted` once cast |

**Legal**

| Test id         | Element / meaning                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `legal-pending` | Banner for a signed-in user with `me.pendingLegal`: `data-kinds` (comma-separated); `legal-pending-accept` |

### Scenarios

- **`trust-safety` step 8 (DMCA).** Streamer G makes a clip. An anonymous claimant files a notice
  for the clip URL on `/dmca` (`--set via=api`: `safety.dmca.submit`) → `dmca-receipt`. A platform
  moderator actions it on `/admin/dmca`. The clip is gone for owner and public, its media URL
  answers 404 once `dmca-disable` ran, G has an unreversed `dmca_strike` (`appeals.accountActions`),
  and G got the `dmcaNoticeReceived` email. G files a counter-notice on `/settings/copyright` →
  `counter-receipt` with `data-restore-after` = 12 weekdays after filing; the claimant got the
  `dmcaCounterNoticeForwarded` email. `dmca-tick` with `asOf` = restore-after − 1 min restores
  nothing; with restore-after + 1 min restores 1. The clip and its media URL are back, the strike
  is reversed (`counter_notice_restored`), G got `contentRestored`. The audit log (`safety.auditLog`
  by `subjectType=dmca_notice`) shows `dmca.notice.submit`, `dmca.notice.action`,
  `dmca.counter.receive`, `dmca.content.restore` in order. API only: a second notice, countered,
  then `suitFiled` → a tick past restore-after restores nothing.
- **`trust-safety` step 9 (appeal lifts the ban).** Streamer H bans viewer V in chat; V appeals the
  `mod_actions` row; a platform moderator who is not H overturns it on `/admin/appeals`; V's ban is
  lifted (V can send again), the audit log has `chat.unban` by that moderator with `details.appealId`.
  API only: an admin suspends user W (`safety.suspend`), W appeals, overturn → W unsuspended.
- **`e2e-social`.** The streamer adds a `hold` word filter; the troll sends a matching message over
  REST `chat.send` → `{ held: true }`; the fan never sees it; the streamer sees it in `held-queue`
  and presses `held-allow`; the fan sees `chat-message` with that `data-id`. REST
  `chat.deleteMessage` and `chat.clear` are exercised in `--set via=api`.
- **`e5-coop`.** A viewer member qualified by subscription only exits, then rejoins with
  `membership-rejoin-viewer`; `membership-row` for `viewer` is `active` with basis `subscription`.
- **`e7-admin`** (new, E7-admin): egress report for the scenario's own broadcast, an incident opened
  and resolved (seen on `instance.status`), a seeded `pending_review` integrity flag decided on
  `/admin/integrity`.

## 9. Shared-file rules for the wave (every brief repeats its part)

| Shared thing                                                           | Resolution                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| i18n catalogs `apps/web/src/i18n/`                                     | One catalog file per unit (§6), created empty here; a unit writes only its own (`e7-<unit>.ts`; E7-coop `coop.ts`; E7-appeals also `safety.ts`). Key prefixes: `held.*`, `dmca.*`/`copyright.*`/`dmcaq.*`, `admin.integrity.*`/`admin.egress.*`/`admin.incidents.*`, `appeals.account.*`, `legal.pending.*`. Nobody edits `en.ts`, `index.ts` or `i18n.test.ts` |
| `apps/web/src/routeTree.gen.ts`                                        | Regenerated once here from the six placeholders. Units fill their placeholder files and never add/rename/remove route files; if `vp build` changes the tree, `git checkout` it and send a contract request                                                                                                                                                      |
| Admin nav, access, footer, account menu                                | Done here (§6). `lib/nav.ts`, `components/safety/access.ts`, `routes/_admin.tsx`, `components/site-chrome.tsx`, `routes/_app.tsx`, `tests/nav.test.ts` are read-only for units                                                                                                                                                                                  |
| `services/api/src/router.ts`                                           | No change (no new namespace). New procedures are stubbed in their owner's route file (§4)                                                                                                                                                                                                                                                                       |
| `services/api/src/routes/safety.ts`                                    | E7-dmca owns only the `dmca:` block and the header comment; `setSuspension` lives in `moderation/suspension.ts` (§3), read-only for both E7-dmca and E7-appeals                                                                                                                                                                                                 |
| `services/api/src/routes/chat.ts`                                      | E7-chat-http. Ban lifting lives in `moderation/chat-bans.ts` (§3), read-only for units                                                                                                                                                                                                                                                                          |
| `services/api/src/moderation/{hooks,queue}.ts`                         | E7-dmca (dmca-tick hook, dmca jobs producer). Every other file in `services/api/src/moderation/` is read-only this wave                                                                                                                                                                                                                                         |
| `services/worker/src/jobs/index.ts`                                    | Done here (§5). Units own their job files                                                                                                                                                                                                                                                                                                                       |
| `services/worker/src/moderation/**`                                    | E7-appeals. E7-dmca imports `moveObject` read-only and keeps its code in `services/worker/src/dmca/**`                                                                                                                                                                                                                                                          |
| Email (`packages/email`)                                               | E7-dmca only (DMCA templates). Others send existing templates and ask for new ones by contract request                                                                                                                                                                                                                                                          |
| Harness scenarios                                                      | `trust-safety.ts`, `safety.ts`, `safety-run.ts`: nobody (steps 8/9 live in `harness/src/e7/dmca.ts` and `appeal-ban.ts`). `e2e-social.ts` + `social.ts`: E7-chat-http. `e5-coop.ts` + `coop*.ts`: E7-coop. `e7-admin.ts`: E7-admin. `harness/src/e7/selectors.ts`: nobody                                                                                       |
| `harness/src/users.ts`                                                 | E7-legal (the `acceptedDocumentIds` line, :152, only)                                                                                                                                                                                                                                                                                                           |
| `harness/src/safety-io.ts`                                             | Nobody (the contract step adds `ModerationHooks.dmcaTick`, §7)                                                                                                                                                                                                                                                                                                  |
| `packages/db/src/account-actions.ts`                                   | Orchestrator (§3). E7-dmca and E7-appeals import it read-only; strike counting, reversal and the repeat-infringer suspension lift go through it, never through `setSuspension(…, false, …)`                                                                                                                                                                     |
| `harness/src/registry.ts` (`FULL_REQUIRED`)                            | Orchestrator, after E7-admin merges: add `e7-admin` so `full` cannot silently drop it                                                                                                                                                                                                                                                                           |
| READMEs, PROGRESS.md, HANDOFF.md, ADRs, `docs/testing/e7-selectors.md` | Orchestrator. Units put proposed text in their final message                                                                                                                                                                                                                                                                                                    |
| `apps/web/tests/selectors.test.ts`                                     | Orchestrator adds the `e7-selectors.md` check after the last E7 web unit merges (it fails until every id exists)                                                                                                                                                                                                                                                |
| Seeded legal texts `packages/db/src/legal/*.md`                        | Nobody (versioned legal text). Proposed wording goes in the final message                                                                                                                                                                                                                                                                                       |

## 10. Done means for the contract step

`bun run verify` green; `bun --bun vp test run` in `packages/contracts`, `packages/db` (with
`test:int`), `services/api`, `services/origin`, `services/worker`, `apps/web`, `harness`;
`grep -c '.handler(notImplemented)' services/api/src/routes/*.ts` now shows chat 5, safety 6,
admin 2, integrity 3, appeals 1 (+ interact 15, bot 14, developer 12; `coop.join` is in
`src/coop/membership.ts`). Then record the units under "In flight" in PROGRESS.md and hand each
unit its brief and the contract-step sha.

## 11. E7 milestone done means

- `grep -c '.handler(notImplemented)' services/api/src/routes/*.ts` is non-zero only for
  `interact.ts`, `bot.ts`, `developer.ts`, and `integrity.ts` (1: `channelSummary`), and
  `grep -rn 'notImplemented' services/api/src/coop` is empty.
- `trust-safety` (steps 1–9), `e2e-social`, `e5-coop` and `e7-admin` pass on the harness stack;
  `bun run verify` green; the e7 selectors check is in `apps/web/tests/selectors.test.ts`.
- `docs/operators/dmca.md` exists and records that no lawyer has reviewed the DMCA flow.
- `e7-admin` is in `FULL_REQUIRED` (`harness/src/registry.ts:33-…`).
