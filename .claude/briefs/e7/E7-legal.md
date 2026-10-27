<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E7-legal: required documents only, re-acceptance, consent retention

You are implementing unit E7-legal for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E7-platform-debts.md`,
`.claude/briefs/e7/contract-step.md` (§1.2 `LegalDocument.requiresAcceptance`, §5, §6 "Legal
pending banner", §9 "Shared-file rules"), `docs/testing/e7-selectors.md` ("Legal") and
`docs/testing/e1-selectors.md` (`signup-legal`). Do not look outside the repository. Work in your
own git worktree on a branch named `e7/legal`, created from the E7 contract-step commit the
orchestrator gives you (run `git merge main` first if main moved).

## Why

Clients cannot tell which legal documents need acceptance, so the web sign-up and the harness
send every current document id (`apps/web/src/routes/_app/signup.tsx:54`, `harness/src/users.ts:152`)
and the API silently ignores the ones that do not (`services/api/src/lib/legal.ts:88-103`). A
signed-in user whose required documents changed has `me.pendingLegal` (entities.ts:42) but no way
to accept them in the web. And anonymous cookie-consent rows (`consent_records` with a random
`anonymous_id`) are kept forever, which the privacy policy does not justify.

## You own (write only these)

- `services/api/src/routes/legal.ts`, `services/api/src/lib/legal.ts`
- `services/api/tests/legal.test.ts`, `services/api/tests/legal.int.test.ts`
- `services/worker/src/legal/**` (new), `services/worker/src/jobs/legal-consent-retention.ts`
  (stub from the contract step), `services/worker/tests/legal*.test.ts` (new)
- Web: `apps/web/src/routes/_app/signup.tsx`, `apps/web/src/lib/auth.ts` (only if the sign-up call
  needs it), `apps/web/src/components/legal-pending.tsx` (stub mounted by the contract step),
  `apps/web/src/components/legal-document-link.tsx`, `apps/web/src/i18n/e7-legal.ts` (keys prefixed
  `legal.pending.`), `apps/web/tests/e7-legal*.test.ts(x)` (new)
- Harness: `harness/src/users.ts`, the `acceptedDocumentIds` line (:152) only

Read-only: `packages/**` (contracts, db, the seeded texts in `packages/db/src/legal/*.md`),
`services/api/src/routes/me.ts` (`me.acceptLegal` at :144-149 already records acceptances;
`me.get` builds `pendingLegal` at :63, :78), `services/api/src/auth/**` (sign-up acceptance at
`auth/index.ts:210`, `:285`), `apps/web/src/routes/_app.tsx` (the banner is already mounted), every
other i18n file. Anything else is a **contract request** with the exact diff. A change to a
seeded legal text is a new document version: do not make it; propose wording in your final
message.

## Contracts you must honor (read-only for you)

- `packages/contracts/src/api/entities.ts` `LegalDocument` (:902-…) with `requiresAcceptance`
  (contract step; `routes/legal.ts` `toDto` already returns it after the contract step),
  `SessionUser.pendingLegal` (:42), router `legal.current`/`get`/`consent` (:2453-…),
  `me.acceptLegal` (:128-136, input `documentIds` min 1).
- Tables `legal_documents` (`schema/safety.ts:200-…`, `requires_acceptance` :210),
  `legal_acceptances`, `consent_records` (:230-242: `user_id` or `anonymous_id`, `created_at`,
  index on `anonymous_id`).
- Worker job (contract step): `legal-consent-retention` on `QUEUES.retention`, daily at 03:23 UTC.
- `docs/testing/e7-selectors.md`: `legal-pending`, `legal-pending-accept`; `e1-selectors.md`
  `signup-legal` keeps its meaning (one checkbox for all required documents).

## What is there today (verified at `9c51c93`)

- `routes/legal.ts:24-35` `toDto` (title/body rendered with instance variables, `isDraft`);
  `legal.consent` (:52-69) stores signed-out rows with `anonymousId` and signed-in rows without it.
- `lib/legal.ts:33-39` `latestDocuments`, `:64-67` `currentRequiredDocuments` (filters on
  `requiresAcceptance`), `:69-86` `pendingDocuments`, `:88-103` `recordAcceptances` (ignores ids
  that are not current required documents).
- Web sign-up loads `legal.current()` (signup.tsx:33-38) and, when the box is checked, sends every
  document id (:54). Nothing in `apps/web` reads `pendingLegal`.
- The harness signs up with every current id (`harness/src/users.ts:139-152`).
- No job touches `consent_records`. The cookie policy says signed-out choices are kept with a
  random first-party identifier (`packages/db/src/legal/cookies.md:28-30`); the privacy policy's
  retention list (`privacy.md:53-59`) does not mention consent records.

## Build

1. **`requiresAcceptance` everywhere it matters.** Confirm the DTO carries it (contract step).
   Sign-up: list the required documents next to `signup-legal` (links via
   `legal-document-link.tsx`, which shows draft/version) and send only their ids; optional
   documents (`cookies`, `dmca_policy` when not required) are linked, never "accepted". The harness
   sends only required ids. If no document is required, the checkbox is not shown and no ids are
   sent (check the API accepts that: `auth/index.ts:210`; if it does not, contract request).
2. **Re-acceptance.** `LegalPending` (the stub mounted in the app shell): for a signed-in user with
   non-empty `pendingLegal`, a non-blocking banner (`AlertCallout`) listing the documents by kind
   with links, `data-kinds`, and `legal-pending-accept` that resolves the ids via `legal.current()`
   (match kind and version), calls `me.acceptLegal`, refreshes the session, and hides. Toast on
   failure. It never blocks reading or leaving; it reappears on the next load until accepted.
   It is mounted in the `_app` shell only (public and settings pages), not in `_studio` or
   `_admin`; that is enough, say so in your final message.
3. **Consent retention job.** `services/worker/src/legal/consent-retention.ts`: delete
   `consent_records` rows with `user_id is null` and `created_at < now - ANONYMOUS_CONSENT_RETENTION_DAYS`
   (395 days, about 13 months, the usual consent-cookie lifetime; a named constant with that
   reason, flagged in the final message as a policy choice for the user), in batches of 1 000
   until none are left or a time budget (30 s) is spent; return `{ deleted }`; log counts only.
   Select each batch by id (`delete … where id in (select id … order by created_at limit 1000)`) so
   the partial index `consent_records_anon_created_idx` (contract step §2.1) serves it. No audit
   row: this is scheduled retention, not a moderator or admin action.
   Signed-in rows stay (they go with the account: `on delete cascade`). Wire it into the stub job.
4. **Docs.** Propose (final message only) one line for `privacy.md` "How long we keep it" and one
   for `cookies.md` about the 13 months.

## Tests you must add

- API: `legal.current` and `legal.get` return `requiresAcceptance`; `me.acceptLegal` with only
  required ids clears `pendingLegal`; sign-up with only required ids records them (extend
  `legal.int.test.ts`).
- Worker integration (`createTestDatabase()`): old anonymous rows deleted, recent anonymous rows
  and every signed-in row kept, batching stops at the budget, idempotent.
- Web: sign-up sends only required ids and hides the box when none are required; the pending
  banner shows for pending kinds, accepts, hides; selector ids present.

## Done means

Follow `.claude/briefs/_done-means.md`, except that the orchestrator runs the gate this batch:
run only targeted checks (`bun --bun vp test run` and `test:int` in `services/api` and
`services/worker` (not at the same time), `apps/web` and `harness` tests; `bunx tsc -p` for each;
`vp lint --deny-warnings` and `vp fmt` on your paths; `vp build` in `apps/web` and confirm `git
diff apps/web/src/routeTree.gen.ts` is empty). Never run `bun run verify`, `podman`,
`scripts/infra.ts` or a harness scenario; tell the user which scenario exercises your change
(`e2e-basic` signs up through the web and the harness) and the command. `git status` shows only
your paths. Commit in your worktree (`git commit -s`, Conventional Commits, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test
counts per package, branch and sha, contract requests (exact diffs), proposed legal-text and
README wording, the retention period as a decision for the user, and anything left undone.
