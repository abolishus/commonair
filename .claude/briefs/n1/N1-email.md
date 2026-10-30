<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N1-email: go-live email digests and one-click unsubscribe

You are implementing unit N1-email for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/N1-notifications-pwa.md`,
`docs/decisions/0028-notifications.md` (decisions 3 and 4), `.claude/briefs/n1/contract-step.md`
(§0 rows on the one-click handler and governance mail, §1.3, §1.5 `notifications.unsubscribe`,
§2.3 `notification_email_queue`, §3, §5.2, §6.1, §7.1, §7.3, §8 step 2, §12),
`packages/email/README.md`, `apps/web/src/i18n/README.md` ("How to add a namespace") and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git worktree
on a branch named `n1/email`, created from `main` after batch-4 wave 1 (the six W1 units) merged; the orchestrator gives you the sha, which contains the W1 and N1 contract steps; run `git merge main` first if main moved. Batch 4, wave 2, beside N1-fanout, N1-push,
N1-inbox, N1-pwa and W1-data-mode.

## Why

Go-live email is opt-in (ADR 0028 decision 4) and goes as a digest so several follows going live
together make one email (decision 3). Every go-live email carries RFC 8058 one-click unsubscribe;
the mailer already turns a template's `unsubscribeUrl` into `List-Unsubscribe` and
`List-Unsubscribe-Post` (`packages/email/src/mailer.ts:84-92`), but no route answers it. The
governance templates link the same kind of URL and nothing answers that either.

## You own (write only these)

- `packages/email/**` (nobody else edits the email package in batch 4): new
  `src/templates/notify.tsx` (`goLiveDigest`), its catalog block in `src/messages/en.ts`, the
  registry entry (`src/registry.ts`), samples (`src/samples.ts`: the go-live sample, and the two
  governance samples' `unsubscribeUrl` moved to `/api/email/unsubscribe?list=governance&token=sample`),
  the link-list extension in `src/template.tsx` / `src/render.tsx` (Build 2), README rows, tests
  and snapshots.
- `services/worker/src/jobs/notify-email-digest.ts` (stub) and `services/worker/src/notify/email/**` (new)
- `services/api/src/routes/notifications/unsubscribe.ts` (stub) and
  `services/api/src/notifications/email-unsubscribe.ts` (stub) plus `services/api/src/notifications/unsubscribe/**` (new, shared logic)
- `apps/web/src/routes/_app/settings.notifications.unsubscribe.tsx` (placeholder) and
  `apps/web/src/components/notifications-unsubscribe/**` (new)
- i18n: `apps/web/src/i18n/locales/en/n1-email.json` (keys `unsubscribe.*`) and `keys/n1-email.gen.ts`
- Tests: `services/worker/tests/notify-email*.test.ts`, `services/api/tests/unsubscribe*.test.ts`,
  `apps/web/tests/unsubscribe*.test.tsx`, `packages/email/tests/**`
- Harness: `harness/src/n1/email.ts` (step 2), `harness/tests/n1/email.test.ts`

Read-only, in particular: `packages/contracts/**` (`UNSUBSCRIBE_LISTS`, `EMAIL_UNSUBSCRIBE_PATH`,
`UNSUBSCRIBE_PAGE_PATH`, `NOTIFICATION_SETTINGS_PATH`, `NOTIFY_RULES.emailDigestSweepMs`,
`EmailDigestJob`, `GoLiveSetting`), `packages/tokens/**` (`signUnsubscribeToken`,
`verifyUnsubscribeToken`), `packages/db/**`, `services/api/src/{http,router}.ts`,
`services/api/src/routes/notifications.ts`, `services/api/src/lib/**`,
`services/worker/src/notify/settings.ts`, `services/worker/src/context.ts`, the route tree,
`harness/src/n1/{run,selectors}.ts`, `harness/src/mailpit.ts`. Anything else is a **contract
request** with the exact diff.

## Contracts you must honor (read-only for you)

- `notification_email_queue (user_id, event_id, channel_id, broadcast_id, queued_at)`, written by
  N1-fanout only for verified, opted-in, non-excluded followers who passed the cooldown.
- `notifications.goLive.emailDigestMinutes` via `goLiveSetting(db, logger)` (0: send at the next
  sweep; the harness stack uses 1).
- `NOTIFY_JOBS.emailDigest` on `QUEUES.email`, every `NOTIFY_RULES.emailDigestSweepMs` (30 s).
- Unsubscribe tokens: `signUnsubscribeToken(AUTH_SECRET, userId, list)` /
  `verifyUnsubscribeToken(AUTH_SECRET, token, list)` (`packages/tokens/src/unsubscribe.ts`; no expiry).
- URL: `${PUBLIC_URL}/api/email/unsubscribe?list=<list>&token=<token>` (`EMAIL_UNSUBSCRIBE_PATH`):
  raw route, mounted in `services/api/src/http.ts` before oRPC; the web confirm page is
  `/settings/notifications/unsubscribe?list=…&token=…` and calls `notifications.unsubscribe`
  (public, `write` bucket) → `{ list }`.
- Preferences: `go_live` → upsert the member's default row `(user, 'go_live', 'email', channel null, enabled false)`
  **and** set `enabled = false` on every `go_live` / `email` channel override the member has
  (otherwise a channel override with email on would keep mailing after a one-click unsubscribe,
  which RFC 8058 forbids); `governance` → the same for types `proposal` and `vote_open`. Idempotent.
- Selectors: `unsubscribe-page` (`data-list`), `unsubscribe-confirm`, `unsubscribe-done`,
  `unsubscribe-invalid` (`docs/testing/n1-selectors.md`).

## What is there today (verified at `a43aa6b`; recheck against your base)

- Templates: `defineTemplate` and `TemplateDefinition` (`packages/email/src/template.tsx:58-84`);
  only top-level string fields listed in `links` may be links (`:55-64`); `normalizeInstanceUrl`
  validates them (`packages/email/src/render.tsx:52-…`). Catalog format: one block per template
  id in `src/messages/en.ts`, `{name}` placeholders, `{instance}` everywhere, **no plurals**;
  `resolveCatalog` falls back per string (`src/messages/index.ts:15-38`). Governance templates
  with `unsubscribeUrl`: `src/templates/governance.tsx`. Snapshot tests: `packages/email/tests/templates.test.ts`.
- Worker mail: `ctx.mailer` and `ctx.site` (`services/worker/src/context.ts:44-47`); the export
  mail is the model of a worker send (`services/worker/src/exports/build.ts`). No recipient
  limiter in the worker (contract step §0); volume is bounded by opt-in, verification, the
  cooldown and the digest window.
- Raw API route pattern with a per-address rate limit: the auth branch in
  `services/api/src/http.ts:263-283` (`rateLimitKey("auth", "ip:" + info.rateLimitHash)`).

## Build

1. **Template `goLiveDigest`** (`src/templates/notify.tsx`), data
   `{ channels: { name: string; title: string; url: string }[]; settingsUrl: string; unsubscribeUrl: string }`
   (1 to 20 channels; with more, the first 20 and a line "More channels you follow are live"
   linking the home page). One template for one or many: subject
   "{channel} is live on {instance}" for one, "Channels you follow are live on {instance}" for
   several (two strings, **no counts**: the email catalog has no plurals until N2-email, which
   will rework these catalogs; keep the existing `{placeholder}` format so N2-email can convert
   them with the rest). Each channel is a linked name (its `url`) with the title as escaped text
   (an empty title, the mature rule, shows nothing). A line explains why ("You turned on go-live
   emails for channels you follow"), a link to `settingsUrl`, and `unsubscribeUrl` (footer and
   header via the layout).
2. **Link lists.** Add `linkLists?: readonly { field: K; key: string }[]` to `TemplateDefinition`:
   array fields whose items' `key` property is a link, validated and normalised by
   `normalizeInstanceUrl` exactly like `links` (same `EmailLinkError`); `render.tsx` applies it
   before rendering. Tests: a foreign-origin item URL throws; a `javascript:` item throws; items
   are normalised.
3. **Digest sweep** (`jobs/notify-email-digest.ts`, `notify/email/digest.ts`): each run, in one
   transaction per member (`for update skip locked` on that member's queue rows): pick members
   whose oldest queued row is at least `emailDigestMinutes` old (limit 200 members per run);
   load their rows joined to channels (`display_name`, `slug`, `mature`) and broadcasts (`title`,
   `mature`; the title is `""` when `broadcasts.mature OR channels.mature` and the member has no
   `mature_confirmed_at`, the one mature rule of contract step §0); re-check `email_verified`
   and the current email preference for each channel (a member may have opted out since: drop
   those rows without mail); send one email to `users.email` in `users.locale`; delete the rows
   sent. Send inside the transaction, delete after a successful send (at-least-once: a commit
   failure after a send can repeat one digest, never lose one). A send that throws leaves the
   rows for the next sweep; rows older than the window plus one hour are dropped with a warning
   (a member whose mail keeps failing must not grow the queue, and a stale go-live is useless). Logs: user id and counts only.
4. **Unsubscribe logic** (`services/api/src/notifications/unsubscribe/apply.ts`): verify the token
   for the list; unknown or forged → `BAD_REQUEST` (oRPC) / 400 (raw); apply the preference rows
   in one transaction (the default rows by `on conflict … do update set enabled = false` on
   `notification_prefs_uq`, then `update … set enabled = false` for that list's email channel
   overrides); write no audit row
   (a member's own preference). `notifications.unsubscribe` (oRPC) and the raw route share it.
5. **Raw route** (`email-unsubscribe.ts`): `GET` → 303 to `UNSUBSCRIBE_PAGE_PATH` with the same
   `list` and `token` (never applies anything: mail scanners prefetch GETs). `POST` (RFC 8058:
   body `List-Unsubscribe=One-Click`, form-encoded or multipart; accept any body, the token
   authorizes) → apply, `200` `text/plain` "ok", `cache-control: no-store`; bad token → 400; per
   address rate limit `write` (`rateLimitKey("write", "ip:" + rateLimitHash)`) → 429 with
   `retry-after`. Other methods → 405. No cookies read, no CORS headers.
6. **Confirm page** (`settings.notifications.unsubscribe.tsx` + `components/notifications-unsubscribe/**`):
   works signed out; shows which list ("go-live emails" / "co-op governance emails") and a
   button `unsubscribe-confirm`; on success `unsubscribe-done` with a link to
   `/settings/notifications` (sign-in required there); a missing or malformed query or a refused
   token shows `unsubscribe-invalid`. Strings in `n1-email.json` (`unsubscribe.*`), logical CSS,
   house primitives (`toast` for errors, no `alert`).
7. **README**: `packages/email/README.md` rows for `goLiveDigest` and the unsubscribe URL format.

## Tests you must add

- `packages/email`: template renders (one channel, several, 20+ cut, empty title, a hostile
  title stays escaped, `List-Unsubscribe` and `-Post` headers present, snapshot), link lists,
  catalog completeness test still green.
- Worker integration: queued rows older than the window → one email to the verified address
  with every channel, rows deleted; younger → nothing yet; window 0 → next sweep; two members →
  two emails; opted out since queuing → no email, rows gone; unverified since → none; send
  failure → rows kept; two concurrent sweeps → one email (`skip locked`); `MemoryMailer`.
- API: the oRPC procedure and the raw route (GET 303 with the same query; POST applies for
  both lists; a channel override with email on is off afterwards; forged token 400; rate limit
  429; idempotent repeat 200).
- Web: the page's three states (render tests with fixtures, as other `apps/web/tests/*.test.tsx`).
- Harness step 2 (`harness/src/n1/email.ts`) per §8 of the contract step, using
  `Mailpit.headers()` for `List-Unsubscribe`.

## Done means

`.claude/briefs/_done-means.md`, plus: `packages/email`, `services/worker`, `services/api` tests
(unit and `test:int`, one package at a time); `apps/web` tests including `i18n.test.ts` and
`logical-css.test.ts`, `bun run i18n:check`, `vp build`; `tsc` for each; lint and format on your
paths. Final message: what you built, test counts, branch and sha, contract requests, and the
live commands (`bun harness/src/cli.ts run notifications --set steps=1,2`; open a received email
in Mailpit and use its unsubscribe link).
