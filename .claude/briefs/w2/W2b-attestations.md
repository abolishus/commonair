<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2b-attestations: signed per-broadcast audience statements, chain and verifier

You are implementing unit W2b-attestations for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/batch6/README.md`
(decisions (k), (l), (m), (o), (p), path ownership and shared rules are binding),
`.claude/briefs/w2/contract-step.md` (§1.1 `ATTESTATION_KINDS`, §1.3 `integrity.attestations.*`,
verifier and well-known routes, §1.4 events and test hooks, §2.1–2.2 attestation tables and
triggers, §3 `attestation.ts` and `constants.ts`, §5), `docs/decisions/0014-attestation-key.md`
(**decisions 1–7 are your spec**), `docs/decisions/0035-sdk-license.md` (the SDK is Apache-2.0),
`docs/product/feature-wins.md` §4.8, the merged `.claude/briefs/w2/W2-rollup-analytics.md` and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git worktree
on branch `w2/attestations`, created from `main` **after wave 1 merged** (rollup included). **Wave 2.** Checked against `8fc2c974`; recheck line numbers against your base.

## Why

Sponsors rely on scrapers that cannot tell bots from people. A statement signed by the instance,
chained per channel and checkable offline lets a creator prove verified viewers without asking
anyone to trust a dashboard. It must never disagree with the creator's analytics, never mutate,
and never be signed by anything but the worker.

## You own (write only these)

- `services/worker/src/jobs/integrity-attestation.ts` (stub) and
  `services/worker/tests/integrity-attestation*.test.ts`
- `services/api/src/routes/integrity.ts` (handed over from rollup: keep `channelSummary`, add
  `attestations.*`), `services/api/src/routes/attestation-verify.ts` (stub), and
  `services/api/tests/attestation*.test.ts`
- `packages/sdk/src/attestation.ts` and `packages/sdk/tests/attestation*.test.ts` (Apache-2.0 headers)
- `docs/governance/integrity-ruleset-changelog.md` (new: entry for the current `RULESET_VERSION`)
- Web: `apps/web/src/components/attestations/**`; i18n `apps/web/src/i18n/locales/{en,es}/w2-attestations.json`,
  `keys/w2-attestations.gen.ts` (prefix `attestations.`)
- Harness: `harness/src/w2/attestations.ts` and `harness/tests/w2/attestations.test.ts`

Read-only: `packages/tokens/**` (`attestation.ts`, `vectors.json`; `index.ts:28-69` sign/verify,
`:121-153` the receipt envelope), `packages/integrity/src/constants.ts`, `packages/contracts/**`,
`packages/db/**`, `services/worker/src/jobs/broadcast-rollup.ts`, `services/api/src/analytics/**`,
`packages/sdk/src/index.ts` and `scripts/build.ts`, `packages/ledger/src/locks.ts:12-14` (the lock
pattern). Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `packages/tokens/src/attestation.ts`: `canonicalize`, `sign`, `verify`, `kid` derivation (first
  16 bytes of SHA-256 over the raw public key, base64url), `entryHash`, `reasonsCommitment`, the
  `{payload, signature}` base64url envelope. **Never re-implement any of it**: build statements only
  through these functions and test against `vectors.json`'s `attestation` section.
- Tables `integrity_signing_keys` and `integrity_attestations` and their 0043 triggers (seq =
  head + 1, `prev_hash` = head's `entry_hash`, no retired or compromised `kid`, one `broadcast`
  entry per broadcast, rehearsals refused).
- `INTEGRITY_SIGNING_KEY` is on the **worker only** (decision (l)): the API never imports it, signs,
  or loads the env schema that holds it.
- `integrity.attestations.{list, get, share, shareLinks.{list, revoke}, bundle}` (`share` returns an
  `AttestationShareLink` with its `id`; `bundle` is the public window proof: entries with
  `breakdown`/`salt` null plus the key history), the public verifier route (exactly one of
  `envelope` or `bundle`), the web stub `components/attestations/verifier.tsx` mounted on
  `/attestations/verify`, the committed breakdown rule in `@commonair/tokens/attestation`
  (`EXCLUSION_CATEGORIES` keys, values above 0 only; `reasonsCommitment` refuses anything else),
  `/.well-known/commonair-attestation`, event `integrity.attestation.appended`, the rollup's
  `analytics.rollup.ready` and its tables.

## Build

1. **Append job** (`integrity-attestation.ts`), run after the broadcast's rollup is ready (it never
   reads sessions directly, only the rollup): in one transaction take
   `pg_advisory_xact_lock(hashtext('integrity:attestation:<channelId>'))`, read the head, build the
   statement (`v`, `kind`, `origin` from `instanceSite()`, `kid`, ids, `seq`, `prevHash`,
   `supersedes`, period, `signedAt`, `rulesetVersion`, `thresholdsHash` over the
   `integrity.thresholds` setting parsed now, integer figures: `peakVerifiedConcurrent`,
   `verifiedViewerSeconds`, `durationSeconds`, `unverifiedViewerSeconds`, `excludedViewerSeconds`,
   delivery bytes by source, `reasonsCommitment` with a fresh random salt), sign, **verify your own
   signature before insert**, insert with salt and breakdown stored beside it, emit
   `integrity.attestation.appended`. First broadcast entry → `broadcast`; an existing one with
   different figures → `supersede` pointing at the latest entry hash; identical figures → nothing.
   Skip rehearsals and broadcasts whose per-minute rollup is gone (final).
2. **Keys.** First use of a key inserts its `integrity_signing_keys` row and retires the previous
   active key in the same transaction. A refused append from a retired key logs and fails the job
   (it retries after restart). Compromise/`reissue` is ADR 0014 decision 1; implement it only if
   the contract step's `ATTESTATION_KINDS` has `reissue` and an admin procedure exists, else report.
3. **Reconciler.** A daily pass (inside the same job file, scheduled by the contract step's stub
   registration or a contract request) re-checks broadcasts whose sessions were re-scored or
   re-rolled after their latest entry.
4. **API** (`routes/integrity.ts`): `list`/`get` (owner sees breakdown + salt; others the public
   statement), `share` (expiring link revealing the breakdown, checked against the commitment);
   publication waits for analytics' 24 h display delay (decision 3) with the test bypass. Window
   proofs are bundles: contiguous entries from the window's first through the head plus the key
   history; the API assembles, never signs (decision 6). `attestation-verify.ts`: the public
   verifier and the well-known key history (kid, algorithm, public key, `first_used_at`,
   `retired_at`, `compromised_at`).
5. **SDK** (`packages/sdk/src/attestation.ts`): re-export the verifier and bundle checks (signatures,
   chain links, latest entry per broadcast, compromised `kid` rejected whatever its date). The SDK
   build inlines it: `bun run build` in `packages/sdk` must pass without
   `--allow-unlicensed-inline` (ADR 0035; see contract requests below if it cannot).
6. **Web** (`components/attestations/**`): owner list with share-link create/copy/revoke, and a
   plain, screen-reader-first verifier view showing the instance domain prominently and the i18n
   string "excluded traffic is not proof of wrongdoing". en + es, 320 px, house primitives.
7. **Changelog**: first entry for the current `RULESET_VERSION` and what it covers.

## Tests you must add

- Unit: statements built from rollup rows (integer-only, field order), `kind` selection
  (broadcast / supersede / nothing), bundle checks (gap in seq, broken `prevHash`, compromised kid,
  superseded entry shown as superseded), all byte-level cases against `vectors.json`.
- Worker integration (`createTestDatabase()`): figures equal session verdicts via the rollup;
  **concurrent** offline append and supersede serialize (two transactions, one chain, no trigger
  error); the triggers refuse wrong `seq`, wrong `prevHash`, retired `kid`, second `broadcast`;
  a rehearsal is never attested; key rotation retires the old row.
- API integration: owner vs public views, share expiry, 24 h delay and bypass, well-known output;
  the API process has no `INTEGRITY_SIGNING_KEY` in its env schema.
- SDK: verifies a bundle produced by the worker test fixture; rejects every tamper vector.
- Harness `harness/src/w2/attestations.ts`: `integrity-basic` **signed** (the statement verifies
  with the SDK verifier and its figures equal the session verdicts) and **tamper** (a modified
  payload, and a modified stored row, both fail verification).

## Done means

Follow `.claude/briefs/_done-means.md`: targeted checks only (`bun --bun vp test run` and
`bun run test:int` in `services/worker` then `services/api`, one at a time; `bun --bun vp test run`
and `bun run build` in `packages/sdk`; `bunx tsc -p` for each and `apps/web`; `vp lint
--deny-warnings` and `vp fmt` on your paths; `vp build`, `bun run i18n:check` in `apps/web`;
`bun --bun vp test run` in `harness`; `reuse lint`). `git status` shows only your paths. Commit with
`git commit -s`. Final message as `_done-means.md`, plus the live command (`bun harness/src/cli.ts
run integrity-basic --set w2=<the signed and tamper step names in steps.ts>`).

**Reviewer focus:** the signature format against `packages/tokens/vectors.json` (exact bytes,
base64url, kid derivation, no float anywhere); the key never reachable from the API; append-only
chain under the advisory lock; no user ids or personal data in any statement (ADR 0004).
