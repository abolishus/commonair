<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2-rollup-analytics: the per-broadcast audience rollup and Creator Analytics

You are implementing unit W2-rollup-analytics for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/batch6/README.md`
(decisions (f), (k), (m), (o), (p), path ownership and shared rules are binding),
`.claude/briefs/w2/contract-step.md` (§1.1 `EXCLUSION_CATEGORIES`, §1.3 `analytics.*` and
`IntegritySummary`, §1.4 `analytics.rollup.ready` and the test hooks, §2.1 analytics tables, §3
`constants.ts`, §5 job stubs and `INFRA_COST_MODEL`, §6), `docs/decisions/0014-attestation-key.md`
(decisions 3 and 7), `docs/product/feature-wins.md` §4.9, `docs/testing/w2-selectors.md`
(analytics) and `.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your
own git worktree on branch `w2/rollup`, created from the contract step's sha (run `git merge main`
first if main moved). **Wave 1.** Checked against `8fc2c974`; recheck line numbers against your base.

## Why

Creators whose counts drop get no explanation, and nobody shows what an audience costs to serve.
One rollup, written once per broadcast after verdicts settle, feeds the studio analytics page now
and the signed attestations (W2b) next: both read the same rows, so a sponsor's statement and the
creator's chart can never disagree. Wave 2 builds on your tables, your job and your route file, so
make them re-runnable and boring.

## You own (write only these)

- `services/worker/src/jobs/broadcast-rollup.ts` (stub from the contract step: the job body and its
  pure helpers) and `services/worker/tests/broadcast-rollup*.test.ts`
- `services/api/src/routes/{integrity,analytics}.ts` (`integrity.ts` until wave 2 hands it to
  W2b-attestations), `services/api/src/analytics/**` **except** `appeals.ts` (W2b-group-appeals'),
  and `services/api/tests/analytics*.test.ts`, `services/api/tests/integrity-summary*.test.ts`
- Web: `apps/web/src/routes/_studio/analytics.tsx` (content only), `apps/web/src/components/analytics/**`
  (in wave 1 this includes creating the `group-appeal.tsx` stub below; wave 2 owns `group-appeal*`)
- i18n: `apps/web/src/i18n/locales/{en,es}/w2-analytics.json`, `keys/w2-analytics.gen.ts`
  (prefix `analytics.`; handed to W2b-group-appeals in wave 2)
- Harness: `harness/src/w2/rollup.ts` and `harness/tests/w2/rollup.test.ts`

Read-only, in particular: `packages/integrity/**` (`GATE_ELIGIBLE` at `jobs.ts:47`, `gateEligible`
at `score.ts:97`, `constants.ts`), `packages/contracts/**`, `packages/db/**`,
`services/worker/src/{outbox.ts,jobs/index.ts}`, `services/api/src/admin/integrity.ts`,
`packages/ledger/src/queries.ts`, `harness/scenarios/integrity-basic.ts`, `harness/src/w2/steps.ts`.
Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- Inputs: `playback_sessions` (`packages/db/src/schema/delivery.ts:75-97`: `assignedSource`,
  `startedAt`, `endedAt`, `bytesHttp`/`bytesP2p`, `verdict`, `verdictReasons`, `scoredAt`),
  `egress_samples` (`schema/media.ts:121-135`), `infra_costs` (`schema/money.ts:257-272`),
  `broadcasts.kind` (decision (f)).
- Outputs: `broadcast_audience_minutes` (90-day retention), `broadcast_costs`,
  `analytics_share_links` as the contract step shaped them; event `analytics.rollup.ready`.
- `AUDIENCE_SETTLE_SECONDS = 7200` and `DEFAULT_FINALIZE_SECONDS` from
  `packages/integrity/src/constants.ts`; the delayed enqueue on `stream.offline` is the contract
  step's (`outbox.ts`); you write only the job body.
- `analytics.{broadcast, range, exclusions, pnl}`, `analytics.shareLink.{create, revoke}`,
  `integrity.channelSummary` (`router.ts:2594-2602`, stub at `routes/integrity.ts:13`), the new
  integer `IntegritySummary` with `category` from `EXCLUSION_CATEGORIES` (decision (k)).
- `INFRA_COST_MODEL` (JSON, cents per GB by source, worker and api), parsed by `packages/config`.

## Build

1. **Rollup job.** For one broadcast, in one transaction: skip `kind = 'rehearsal'` outright
   (belt and braces with the 0043 trigger); bucket every session into each minute it overlaps
   (`startedAt` to `endedAt`, open sessions clipped at the broadcast end); per minute write verified
   (`gateEligible`), unverified (pending and `fetch_unjudged`, ADR 0014 decision 7 — never verified,
   never excluded), excluded by category, and verified/raw by delivery source. A session's category is
   the category of its first exclusion reason (reasons are sorted by score, `score.ts:69`); use the
   contract step's signal→category map (contract request if `constants.ts` lacks one). Costs:
   `egress_samples` bytes by source × the cost model, marginal only, in integer cents (round once,
   at the total, half-up, documented). **Re-runnable:** replace the broadcast's rows (delete +
   insert in one transaction), so a re-score can re-run it; emit `analytics.rollup.ready
   {broadcastId}` in the same transaction every run. A broadcast whose per-minute rows passed
   90 days is not re-rolled (attestations are final then).
2. **Retention.** Per-minute rows older than 90 days are deleted by the job's housekeeping pass;
   per-broadcast totals stay. Legal holds on the channel keep them (follow the `ownerHeld` pattern in
   `services/worker/src/housekeeping.ts`).
3. **API.** `analytics.broadcast/range/exclusions/pnl` (owner-only), share links (create, revoke,
   expiring, token hashed with `sha256Hex`, never logged). Display delay: a broadcast shows 24 h
   after it ends, except through the contract step's internal test bypass. Groups under **5
   sessions** are omitted (and say so: "n small groups hidden"), never thresholds or signal codes.
   `pnl` joins ledger revenue lines read-only and marginal cost; cost is owner-private.
   `integrity.channelSummary` from the rollup, integer seconds, categories.
4. **Web** (`_studio/analytics.tsx`, `components/analytics/**`): per-broadcast and range views,
   verified vs excluded by category, delivery mix ("relays delivered 40%"), marginal cost; charts
   with a table fallback, `<EmptyState>`, `<Skeleton*>`, `<RelativeTime>`, `<MoneyAmount>`,
   320 px, reduced motion, en + es. Each excluded-group row mounts
   `<GroupAppealAction broadcastId category sessions />` from `components/analytics/group-appeal.tsx`,
   which you create as a stub rendering `null` (W2b-group-appeals fills it).

## Tests you must add

- Unit: minute bucketing (session spanning minute edges, zero-length, open at broadcast end),
  category attribution with several reasons, unverified kept apart, cost rounding (zero cost, CDN
  off, missing source in the model), group-size suppression at 4/5/6, the 24 h boundary.
- Worker integration (`createTestDatabase()`): totals equal session verdicts (verified seconds =
  the sum over gate-eligible sessions); a rehearsal broadcast writes nothing; a re-run after changed
  verdicts replaces rows and emits a second event; idempotent rerun with unchanged data.
- API integration: owner-only access, display delay and test bypass, suppression, share link
  expiry/revoke, `channelSummary` integers.
- Harness `harness/src/w2/rollup.ts`: the `integrity-basic` "group" step: after the settle
  override, the swarm appears as one `datacenter` excluded group with the expected session count.

## Done means

Follow `.claude/briefs/_done-means.md`: targeted checks only (`bun --bun vp test run` and
`bun run test:int` in `services/worker` then `services/api`, one at a time; `bunx tsc -p` for each
and `apps/web`; `vp lint --deny-warnings` and `vp fmt` on your paths; `vp build`, `bun run
i18n:check` and `bun --bun vp test run tests/i18n.test.ts` in `apps/web`; `bun --bun vp test run`
in `harness`; `reuse lint`). `git status` shows only your paths. Commit with `git commit -s`. Final
message as `_done-means.md`, plus the live command (`bun harness/src/cli.ts run integrity-basic
--set w2=<the group step name in steps.ts>`).

**Reviewer focus:** figures equal verdicts; no thresholds, signal codes or user ids in any output;
rehearsals never counted; the job is safe to re-run.
