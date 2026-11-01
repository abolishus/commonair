<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Rules every seed-full unit follows

Read this together with your unit brief, [README.md](README.md) (the approved plan) and
`.claude/briefs/_done-means.md`. The contract step is on `main` (commit `63e92d54`, brought up to
date with batches 5–7 at `fc1fc4ff`): branch from current `main` in your own worktree, on a
branch named `seed/<unit>` (for example `seed/money`).

The briefs were last checked against `main` at `fc1fc4ff` (batch 7 wave 2). If `main` has moved,
run `git log fc1fc4ff..main -- packages/db/src/schema harness/src/seed` first: a table or route
added since then is yours if it is in your stub, even if your brief doesn't name it.

## The contract (read-only for every unit)

- `harness/src/seed/types.ts`: `SeedUnit`, `SeedContext`, `SeedStore`, `SeedUnitReport`,
  `lookupUser`.
- `harness/src/seed/{accounts,scale,prng,guard,coverage,routes,units}.ts`, and `run.ts` except
  where your brief says otherwise.
- `harness/tests/seed/{prng,guard,coverage}.test.ts`.
- `harness/src/*.ts` outside `seed/`: the existing actors and drivers (`users.ts`, `money-actors.ts`,
  `coop-actors.ts`, `stripe.ts`, `streamer.ts`, `safety-io.ts`, `mailpit.ts`, `api/client.ts`, and so on),
  plus the newer feature drivers: `harness/src/w2/**`, `w3/**`, `n2/**`, `n3/**`, `n4/**` and
  `mocks/**`. Import them, never edit them. If you need a change, send a contract request.
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
3. **Protected tables only through the real code path:** the API (signed in as the right seeded
   user), the worker (directly, or through a test hook), or stripe-mock webhooks. Never use raw
   SQL around their triggers, even where a trigger would allow an insert. As of `fc1fc4ff` they
   are:
   - clips, vods, relay_purges
   - content_labels, account_actions, enforcement_statements, legal_holds, local_hash_list
   - moderation_cases, moderation_flags, evidence_objects, evidence_audit_runs
   - dmca_notices, dmca_notice_items, dmca_counter_notices, ncii_requests, ncmec_reports
   - integrity_signing_keys, integrity_attestations
   - council_members, council_responses, council_terms
   - governance_applications, governance_settings_history
   - memberships, membership_history, membership_shares
   - proposals, proposal_comments, proposal_electorate, votes, vote_history, tallies
   - patronage_periods, patronage_inputs, patronage_allocations
   - jury_panels, jury_seats, jury_cases, jury_votes
   - ledger_accounts, ledger_transactions, ledger_entries, payouts, payment_fraud_flags
   - revenue_splits, revenue_split_shares, revenue_split_acceptances, revenue_split_postings,
     split_writeoff_proposals
   - loyalty_balances, loyalty_transactions, prediction_bets
   - giveaways, giveaway_entries, giveaway_winners
   - broadcast_audience_minutes, broadcast_audience_totals, broadcast_costs, rehearsal_invitees
   - watch_rooms, watch_room_members, move_links
   - federation_actor_keys, portability_signing_keys

   A table missing from this list that has a trigger in `packages/db/drizzle/*.sql` is protected
   too, unless it is one of the consistency-only tables below. Read its trigger before you write
   to it.

   **Direct inserts are allowed on tables whose triggers only keep rows consistent.** The rows
   must satisfy the trigger; never disable it or work around it.
   - `users`, `accounts`, `channels`: seed-social inserts them as the demo seed does
     (`packages/db/src/demo/seed.ts`). Their triggers only guard later changes.
   - `audit_log`: only the rows that go with seed-social's own direct moderation rows.
   - `follows`: a trigger keeps `channels.follower_count`, so never set the count yourself. Another
     trigger checks `move_link_id` against the channel, so a follow through a move link goes
     through the API.
   - `broadcasts`: `kind` is frozen after insert. `stream_hours`: rehearsal broadcasts are
     refused.
   - `governance_settings` and `legal_documents` are filled at migration time. Read them; never
     insert into them.

   **The harness scenarios aren't a model for this.** Several of them (`w2/splits.ts`, `w3/jury.ts`,
   `w3/watch-rooms/db.ts`, `w2/rehearsal/db.ts`) write fixtures through the owner connection
   (`DATABASE_URL` as owner, Bun.SQL). The seed never does: `ctx.db` is the app role, and nothing
   else is allowed. Where a scenario fakes elapsed time that way (a split hold that has passed,
   closed cases for the jury), the seed either gets there through the product in real time, or
   records the gap in `notes`.

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
10. **Budget:** at `small` your unit should finish in under 2 minutes (seed-coop in under 5 and
    seed-media in under 8, because of the real periods and the encodes). At `medium`, under 20. At `large`, do
    your best and log progress every 10 s.
11. **Stack flags:** if your unit needs a stack flag, check for it at the start of `run`. If it is
    off, throw at once with the exact flag. List every flag in your final message: the
    orchestrator writes the seed compose overlay (`harness/compose.seed.yaml`) at milestone
    wiring. The flags the units need:
    - test hooks: `COOP_TEST_HOOKS`, `MODERATION_TEST_HOOKS`, `INTERACT_TEST_HOOKS`, and
      `OPS_TEST_HOOKS` (the analytics tick and display bypass, and the batch 7 `b7Tick` jobs such
      as the jury draw and close);
    - stripe-mock;
    - `DEMO_SEED_FULL` on the worker;
    - features that ship off: `GIVEAWAYS_ENABLED`, `FEDERATION_ENABLED`, and
      `TWITCH_IMPORT_ENABLED`, with `OAUTH_TWITCH_*` pointed at the Twitch mock;
    - live captions: the whisper sidecar (profile `captions`), `WHISPER_URL` and
      `CAPTIONS_MAX_STREAMS`;
    - a non-zero `INFRA_COST_MODEL`, and the signing keys `INTEGRITY_SIGNING_KEY` and
      `PORTABILITY_SIGNING_KEY`.

    The seed overlay turns all of these on (decision e in README.md), so every feature has data.
    11a. **Local peers only:** anything the stack calls out to while a unit runs is a harness peer bound
    to this machine and reached through `HARNESS_WEBHOOK_HOST`, never a real service:
    - the e9 webhook receiver;
    - the ActivityPub test peer (`harness/src/mocks/activitypub/`);
    - the Twitch mock (`harness/src/mocks/twitch/`);
    - the RTMP and Discord sinks.

    Start each peer in `run` and stop it before returning. Rows that point at a peer stay behind
    and fail later, and that is expected. Say so in `notes`.

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
