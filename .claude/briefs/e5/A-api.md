<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E5 unit A, API co-op** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md and `.claude/briefs/e5/_common.md` first (all of
it), then `docs/testing/e5-selectors.md` in full, ADR 0020, ADR 0004, `services/api/README.md`,
`services/api/src/money/README.md`, and the patterns in `services/api/src/money/checkout.ts`,
`money/checkout-treasurer.ts` (confirm), `money/checkout-shared.ts`, `money/reports.ts`
(`transparency`), `src/moderation/hooks.ts` + `src/http.ts` (how the `ncii-tick` test hook enqueues
a job and awaits it with `QueueEvents`), `lib/access.ts`, `lib/errors.ts`, `events/outbox.ts`,
`events/audit.ts`. Do not look outside the repository.

This unit is on the vote, protected-decision, share-refund and patronage-approval paths: it gets
a second, security-focused review.

## You own (write only these)

- `services/api/src/routes/coop.ts` (replace the 501 stubs; keep it a thin map of handlers),
  new `services/api/src/coop/**` (handlers, view builders, error mapping, the test hook),
  `services/api/src/money/checkout-treasurer.ts` (share confirmation only),
  `services/api/src/money/checkout-shared.ts` and `money/checkout.ts` only where buying a share
  needs a shared helper, `services/api/src/money/reports.ts` (`transparency` only),
  `services/api/src/http.ts` (only the `INTERNAL_ROUTES.coopTick` route and the `/healthz`
  test-hook flag), `services/api/README.md` (a "Co-op" section),
  `services/api/tests/coop*.ts`, and existing API tests you must update for these changes.
- `packages/patronage/**` (if `computePeriod`/`approvePeriod` need changes for the API, e.g.
  running inside a caller's transaction; keep its tests green).
- `packages/payments/**` (a share checkout: `CheckoutRequest.creatorUserId` is required today,
  which does not fit a share; make it nullable for `membership_share` and keep the manual
  instructions working; Stripe stays unsupported for shares).

## Contracts you must honor (read-only for you)

- Every `coop.*` procedure in `router.ts`, its access level (`user`, `admin`, `treasurer`,
  `finance`), its errors (`VOTE_REFUSED`, `SECOND_APPROVER`, `PRECONDITION_FAILED` with
  `requirement`), and the entities named in `_common.md`.
- Events (emit with `emit(tx, …)` in the same transaction): `coop.proposal.update` (public),
  `coop.membership.update`, `coop.share.update`, `coop.proposal.comment`, `coop.vote.cast`,
  `coop.council.response`, `coop.patronage.update`, `coop.election.update`.
- `QUEUES.coop`, `COOP_JOBS`, `CoopTickBody`, `CoopJobResult`, `INTERNAL_ROUTES.coopTick`:
  `POST` behind `INTERNAL_API_SECRET`, **404 unless `COOP_TEST_HOOKS=true`**; enqueue the named
  job on `QUEUES.coop` (the worker's BullMQ prefix, as the moderation hook does), await it with
  `QueueEvents` (30 s), return its result. A warning at every start while the flag is on, and
  `/healthz` reports it.
- `packages/governance` is **read-only** for you (unit B owns it and adds the proposal lifecycle
  the worker runs). Use what exists: `loadSettings`, `classifyChanges`, `rulesFor`, `isProtectedKey`,
  `membershipClassesOf`, `eligibleHoursByUser`, `canVoteInElection`, `canStandInElection`,
  `activeClasses`, `eligibleVoters`, `tallyElection` types. Need something new there → contract
  request (or a local helper in `src/coop/**` if it is API-only).
- The triggers in `0001`, `0002`, `0021`. They refuse: content edits outside draft/discussion,
  status jumps, votes outside the electorate/window, comments from non-members or in the wrong
  status, a second council response or one from outside the current term, share transitions
  without their payment and postings, patronage approval by the person who computed it.

## Build (the spec's flow tables are authoritative)

1. **Membership.** `membership` (memberships, the share with its id, eligibility per class with
   `basis` and `progress` read from the settings and `eligibleHoursByUser` over the streamer
   window), `buyShare` (manual provider only; `PRECONDITION_FAILED manual_shares` with Stripe;
   `CONFLICT` with an open share or an active viewer membership by share; payment + share +
   audit + event in one transaction; reuse the manual reference/expiry logic and its
   provider-ref retry), `exit` (membership `exited`; viewer with a held share and
   `shareRefundableOnExit` → `refund_pending` in the same transaction), `appointWorker` (admin;
   minute reference in audit `reason`), `shares.list` / `shares.refund` (treasurer;
   `shareRefund` posted with settlement `cash`, then `refunded`).
2. **Share confirmation.** `treasurer.confirm` today refuses `membership_share`. Accept it: lock
   the payment (pending only), then in the same transaction: payment `succeeded`, `sharePurchase`
   posted, share `held` with `purchased_at = receivedAt`, a viewer membership with basis `share`
   unless one is active, audits `payment.confirm` + `membership.activate`, events. Do not reuse
   `confirmPaymentTx` for shares (it assumes a channel and posts `paymentSucceeded`).
3. **Proposals.** `list` (public; drafts only to their author; filter by status; cursor paging),
   `get` (drafts → `NOT_FOUND` for anyone but the author), `create` / `update` (active members;
   `classifyChanges` decides the kind, protected ⇒ `affectsCreators` true; problems →
   `BAD_REQUEST`), `submit`, `withdraw` (author only), `comments` (public, paged), `comment`
   (members; status discussion/council_review/voting), `vote` (insert, or update the caller's own
   row; map the trigger's refusals to `VOTE_REFUSED`: not in the electorate → `FORBIDDEN`
   `not_in_electorate`, window closed or not voting → `CONFLICT` `voting_closed`), and
   `councilRespond` (current term member; `CONFLICT` on a second response). Every action: audit
   - event per the spec, in the transaction. The view: `changes` with `from` (current setting
     value) and `protected`; `timeline`; `councilResponse` and `councilResponseMissed`; `tally`
     only from the `tallies` row; `participation` (`voted`, `eligible` counts from the frozen
     electorate) once voting opened; `myVote` (the caller's own only); `canVote`. **No running
     tally.** The API never moves a proposal past `discussion` (the worker does) and never writes
     `tallies` or settings.
4. **Council and elections.** `council` (the current term: latest by `computed_at` whose window
   contains now; its seats and method), `elections.list/create/nominate/vote` (create: admin,
   seats and term from `board.seats`; nominate: a member of the class while nominating; vote: an
   eligible voter of the class while voting, up to `seats` candidates, one ballot), `board`.
   Audit + `coop.election.update` on create.
5. **Patronage.** `run` (treasurer: `closePeriod` for exactly the period in the instance currency
   — overlap → `CONFLICT`; then `computePeriod` with `computedById` = caller and `surplusCents`
   defaulting to all available retained surplus; `SurplusUnavailableError` →
   `PRECONDITION_FAILED surplus`; audit + event), `approve` (`finance`; the caller must differ
   from `computed_by_id` → `SECOND_APPROVER`; `approvePeriod` with its audit and event in **one**
   transaction), `periods` (`finance`), `statements` / `statement` (the caller's own, approved or
   distributed periods only; lines and inputs).
6. **Settings and transparency.** `settings` (every governance setting with `protected` and the
   proposal that last set it). `transparency` keeps a month that has governance outcomes or
   member counts even without ledger postings (today it iterates the ledger months only), and its
   governance rows carry `kind`, `passed`, `reason` (already joined from `tallies`).
7. **Errors and logs.** Map every trigger exception to the contract's codes (never a 500 with SQL
   text). Logs: ids and enums only (never a choice, a comment, a minute reference, an email).

## Tests you must add

- Unit: the access matrix for every `coop.*` procedure (anonymous, user, member, author, council
  member, treasurer, admin), the view builders (no tally while voting, `myVote` only for the
  caller, drafts hidden), eligibility/progress, error mapping from each trigger message.
- Integration (`createTestDatabase()` with `FAST_GOVERNANCE`, as the app role): buy share →
  confirm → held + viewer membership + balanced posting; a second buy refused; exit →
  refund_pending → refund → refunded + balanced posting; appoint worker; create/update/submit/
  withdraw/comment authorization; vote insert + change, refused for non-electorate and after the
  window, never a double vote under concurrency; council response by a seated member only, once;
  a proposal decided by a direct status write passes through the views with the `tallies` row;
  patronage run → approve by the runner refused (API **and** DB) → approve by a second treasurer
  posts a balanced allocation; statement shows lines; transparency shows the governance row and
  the distribution; the test hook is 404 when off and runs a job when on (mock or real worker
  queue — say which). Every action asserts its `audit_log` row and `events` row.

## Done means

See `_common.md` "Done means". Your packages: `services/api`, `packages/patronage`,
`packages/payments` (`bun run test`, `bun run test:int` once at the end, `tsc`), lint/fmt on
changed paths.
