<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Rules every seed-full unit follows

Read this together with your unit brief, [README.md](README.md) (the approved plan) and
`.claude/briefs/_done-means.md`. The contract step is on `main` (commit `63e92d54`): branch from
`main` in your own worktree, on a branch named `seed/<unit>` (for example `seed/money`).

## The contract (read-only for every unit)

- `harness/src/seed/types.ts`: `SeedUnit`, `SeedContext`, `SeedStore`, `SeedUnitReport`,
  `lookupUser`.
- `harness/src/seed/{accounts,scale,prng,guard,coverage,routes,units}.ts`, and `run.ts` except
  where your brief says otherwise.
- `harness/tests/seed/{prng,guard,coverage}.test.ts`.
- `harness/src/*.ts` outside `seed/`: the existing actors and drivers (`users.ts`, `money-actors.ts`,
  `coop-actors.ts`, `stripe.ts`, `streamer.ts`, `safety-io.ts`, `mailpit.ts`, `api/client.ts`, and so on).
  Import them, never edit them. If you need a change, send a contract request.
- Everything in `packages/**`, `services/**` and `apps/**`.

## You own

- `harness/src/seed/<unit>.ts`, the stub with your `unit` export. You may change its `after`,
  `tables` order, `pending` and `run`. You may not change its name or the set of tables it claims.
  Moving a table to another unit is a contract request.
- `harness/src/seed/<unit>/**` (new), for helpers, plans and writers.
- `harness/tests/seed/<unit>*.test.ts` and `harness/tests/seed/<unit>*.int.test.ts`.

## How to write rows

1. **Separate the plan from the writes.** A pure `plan…(rng, scale, store, now)` returns row
   specs: who, what, when, in which state. A writer turns the specs into inserts or API calls.
   Unit-test the plans exhaustively. Integration-test the direct-insert writers against
   `createTestDatabase()` as `TEST_APP_ROLE`.
2. **Plain tables: direct inserts** through `ctx.db` (Drizzle, app role). Insert in chunks of at
   most 1 000 rows per statement, and check `ctx.signal` between chunks.
3. **Trigger-protected tables only through the real code path:** the API (signed in as the right
   seeded user), the worker, or stripe-mock webhooks. Never use raw SQL around a trigger, even
   where the trigger would allow an insert. The protected tables are:
   - accounts, audit_log, channels, users
   - clips, vods
   - content_labels, account_actions, enforcement_statements, legal_holds, legal_documents, local_hash_list
   - moderation_cases, moderation_flags, evidence_objects, evidence_audit_runs
   - dmca_notices, dmca_notice_items, dmca_counter_notices, ncii_requests, ncmec_reports
   - council_members, council_responses, council_terms
   - governance_applications, governance_settings, governance_settings_history
   - memberships, membership_history, membership_shares
   - proposals, proposal_comments, proposal_electorate, votes, vote_history, tallies
   - patronage_periods, patronage_inputs, patronage_allocations
   - ledger_accounts, ledger_transactions, ledger_entries, payouts, payment_fraud_flags
   - loyalty_balances, loyalty_transactions

   `users`, `accounts`, `channels` and the `audit_log` rows for social moderation are the one
   exception: seed-social inserts them directly, the same way the demo seed does
   (`packages/db/src/demo/seed.ts`), because their triggers only guard later changes.

4. **Signing in:** use `UserFactory.signIn` (`harness/src/users.ts`) with
   `demo_<handle>@demo-seed.invalid` and `ctx.password`, against the API in `ctx.env`. Sign each
   user in once per unit and reuse that session. Bulk accounts can sign in too.
5. **Determinism:** take all randomness from `ctx.rng`, using `rng.fork("<purpose>")` for each
   independent stream, so that adding a stream doesn't reshuffle the others. Never use
   `Math.random`. IDs come from `uuidv7()` and are allowed to differ between runs; content, counts,
   names and states must not. Derive every count from `ctx.scale`: `factor` × a base count chosen so
   that every list view at `small` has enough rows to paginate.
6. **Time:** relative to `ctx.now`. Only plain tables may be backdated, spread across
   `scale.historyDays`. Protected rows keep their real times. If a screen can therefore only show
   "today", say so in `notes`.
7. **Anchors and personal data:** every account is `demo_*` / `@demo-seed.invalid`. No real
   names, emails, URLs or IPs. Use `.invalid`/`.test` hosts, or the local sinks your brief names.
   Write no personal data or free text into append-only columns (AGENTS.md).
8. **Outbox:** API paths write their own `events` rows. Direct inserts write none unless your
   brief says otherwise, so demo data never fans out to anything except the local sinks.
9. **No idempotency:** the guard only allows a database with no users, and a failed run means a
   reset. Fail loudly on the first error, and say which user, step and spec failed.
10. **Budget:** at `small` your unit should finish in under 2 minutes (seed-media and seed-coop in
    under 5, because of the real periods and the encodes). At `medium`, under 20. At `large`, do
    your best and log progress every 10 s.
11. **Stack flags:** if your unit needs a stack flag (for example `COOP_TEST_HOOKS`,
    `MODERATION_TEST_HOOKS`, `INTERACT_TEST_HOOKS`, stripe-mock, or `DEMO_SEED_FULL` on the worker),
    check for it at the start of `run`. If it is off, throw at once with the exact flag. List every
    flag in your final message: the orchestrator writes the seed compose overlay at milestone
    wiring.
12. **Store:** read `ctx.store.users`/`channels` (seed-social fills them). Publish only under
    `ctx.store.extra.<your unit>`, and only the keys your brief names plus any your own later steps
    need. Never mutate another unit's entry. If you need a value another unit owns, send a
    cross-unit request in your final message, naming the exact key and its shape.
13. **Dependencies:** you may add units to `after` if a code path really needs their rows. For
    example, if a procedure needs a live channel, add `media`. The `units` test must stay acyclic.
    Say why in a comment.
14. **`pending`:** empty it table by table as you seed them. If a table is still pending at the
    end, keep it in `pending`, explain why in `notes`, and send the exact contract request that
    would unblock it.
15. **Report:** return `rows` per table as you counted them (real inserts and API calls), not
    estimates.

## Tests every unit adds

- `harness/tests/seed/<unit>.test.ts`:
  - The plan is deterministic. The same seed and scale give the same specs. A different seed
    gives different content but the same counts.
  - Counts scale with `factor`.
  - Every fixed login named in your brief gets the rows its `purpose` says.
  - Each state your brief lists appears at least once at `small`.
  - Edge cases: zero bulk accounts, and the largest preset's counts, computed without writing.
- `harness/tests/seed/<unit>.int.test.ts`: the direct-insert writers against `createTestDatabase()`
  as the app role. Seed the users and channels you need with a minimal social fixture, which you
  write in your own test file; don't import seed-social's internals. Check:
  - the rows land and satisfy the constraints;
  - triggers accept them;
  - nothing personal goes into append-only columns.
- API-driven writers can't run without the stack. Cover them with plan tests, and list them in your
  final message as "exercised by `seed full` live".

## Done means

`.claude/briefs/_done-means.md` applies. In addition:

- `bunx tsc -p harness --noEmit` passes.
- `vp lint --deny-warnings harness/src/seed harness/tests/seed` passes.
- `cd harness && bun --bun vp test run tests/seed` passes, and so does your `.int.test.ts`.
- The coverage test still passes, with your `pending` as small as you could make it.
- In your final message, also give:
  - the flags your unit needs;
  - the routes from `routes.ts` you expect to show data, and any you could not fill;
  - your `notes`;
  - cross-unit requests.
- Also give the exact command to try it:
  `DEMO_SEED_FULL=true bun harness/src/cli.ts seed full --confirm <db> --scale small`
  against a freshly reset local database, with the flags your unit needs.
