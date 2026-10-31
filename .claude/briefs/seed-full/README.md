<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Full-coverage seed (plan approved 2026-10-31)

Goal: one command fills a local or staging instance so **every route shows real data for every
role**, at a volume that exercises pagination, search and long chat logs. Today's demo seed
(`packages/db/src/demo/`) fills about 6 of 55 routes, and no seeded account can open `/admin`.

## The core problem: protected tables can't be cleaned up

The schema has about 130 tables, and roughly 45 of them carry triggers: ledger, co-op and
governance, votes, channel points, moderation cases and evidence, enforcement statements, DMCA
items, legal holds, `audit_log`. `demo:clear` works by deleting rows, and it fails on purpose
when a demo user has any money, co-op or points rows. A seed that covers money, co-op and points
can't be removed that way, so this plan has two tiers:

| Tier    | Command                                        | Where                                       | Cleanup                                      |
| ------- | ---------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `basic` | `demo:seed` (exists, unchanged)                | any instance, including production          | `demo:clear` (row-wise, anchored)            |
| `full`  | `bun harness/src/cli.ts seed full --scale <s>` | local and the DigitalOcean staging env only | **database reset**, not row-wise (see guard) |

**Guard for `full`:** it refuses unless `DEMO_SEED_FULL=true` (new env var, default false, in
`packages/config` and `.env.example`), **and** `--confirm <host:port/db>` names the target
database exactly, **and** the database has no users at all. `NODE_ENV` can't be the gate because
staging runs with `NODE_ENV=production`. The point is that it can never run against a real
instance by accident.
Reset: local `bun scripts/infra.ts` recreates the database; staging gets a `selfhost.sh
--reset-staging` step (drop, migrate, base seed), refused on a production env.

## How rows get written

1. **Plain tables: direct inserts** through Drizzle as the app role, the same way the demo seed
   works today (users, channels, follows, chat, notifications, bot config, overlays, OAuth apps,
   reports, and so on).
2. **Protected tables: through the real code paths**, never raw SQL around the triggers.
   - Money: the existing harness money actors against stripe-mock (subscriptions, tips, refunds,
     disputes, payouts, fraud flags) and `@commonair/ledger` postings for costs and treasury.
   - Co-op: the co-op actors (applications, memberships, proposals, votes, elections, council
     responses, a closed patronage period).
   - Channel points: worker accrual under `INTERACT_TEST_HOOKS`.
   - Trust and safety: the API (reports to cases, enforcement statements, appeals, DMCA notice and
     counter-notice, account actions, a legal hold). CSAM/NCII hash paths use the existing
     synthetic fixtures only.
3. **Backdating:** API-created rows get real "now" timestamps. Where history matters (revenue
   charts, patronage periods, transparency quarters, broadcast history), a later pass shifts
   timestamps on plain tables only. Protected tables keep their real times, and the plan records
   any screen that therefore can't show more than "today" history.
4. **Media:** a short ffmpeg run per channel (harness `streamer.ts` test pattern) produces real
   VODs and clips in Garage, so playback, replay and timeline sync work. A separate optional
   `seed live --channels K` keeps K channels streaming with harness chat clients talking, so
   home, Calm Chat, surge guard, data mode, embeds and overlays all have something live.

## Accounts and scale

Fixed named logins (`demo_admin`, `demo_treasurer`, `demo_moderator`, `demo_council1`, three
streamers per role mix, and viewers), all `demo_*@demo-seed.invalid` with one shared password,
plus generated bulk accounts.

| Scale    | Streamers | Viewers | Chat lines | Use                              |
| -------- | --------- | ------- | ---------- | -------------------------------- |
| `small`  | 10        | 50      | 5 k        | local click-through (default)    |
| `medium` | 100       | 2 k     | 200 k      | staging                          |
| `large`  | 1 k       | 20 k    | 2 M        | pagination and query-plan checks |

Content is deterministic per `--seed <n>` (seeded PRNG), so screenshots match between runs. Some
locales vary (`en`, `es`, `en-XA`) so batch 5's switcher has data.

## Coverage guarantee ("literally everything")

- **Table check (unit test):** every `pgTable` in `packages/db/src/schema` is either in the seed's
  coverage map or in an explicit `NOT_SEEDED` list, each entry with a reason. A new table without
  seed data fails CI.
- **Route check (harness scenario `seed-coverage`):** after `seed full --scale small`, sign in as
  each role and visit every route in `routeTree.gen.ts`. It fails on any `<EmptyState>`, an
  error boundary or a 4xx/5xx that isn't on an allowlist. A new route without seed data fails
  the full run.

## Work units (one workflow, under 10 agents)

0. **Contract step (orchestrator):** the `DEMO_SEED_FULL` env var, the `harness/src/seed/`
   skeleton (CLI, guard, PRNG, scale presets, coverage map type), and both checks, starting from
   an empty map so they list every gap.
1. **seed-social:** users and roles, channels, panels, sub tiers, emotes, word filters, follows,
   blocks, bulk chat, notifications and preferences, locales.
2. **seed-interact:** bot configs, commands and timers, polls, predictions, raids, goals, alert
   configs, overlay tokens, song requests, points accrual.
3. **seed-money:** subscriptions, tips, payments and events, refunds, disputes, payout accounts,
   payouts, fraud flags and holds, infra costs, treasury postings.
4. **seed-coop:** memberships and shares, applications, proposals, comments, votes, elections,
   council terms and responses, board seats, a patronage period.
5. **seed-safety:** reports, moderation cases and flags, content labels, appeals, account
   actions, DMCA, incidents, integrity flags, enforcement statements, legal acceptances and
   consents, data exports and deletions.
6. **seed-platform:** OAuth apps, codes, tokens and device codes, EventSub subscriptions,
   webhook deliveries to a local sink, Discord webhooks to a local sink, push subscriptions,
   notifications and preferences.
7. **seed-media:** recorded VODs and clips, broadcast health and egress samples, stream hours,
   simulcast targets, relays, `seed live`.

Units 1–7 each own only their own `harness/src/seed/<domain>.ts` file and its tests. Unit 1 runs
first, because the others need its users and channels; units 2–7 then run in parallel. Each unit
goes implement → independent review → fix, as in batch 4. Briefs: [common.md](common.md) (rules for every unit) and
`seed-<unit>.md` for each unit. Then milestone wiring: the
`seed-coverage` scenario becomes `inFull`, and a docs page (`docs/testing/seeding.md`).

## Decisions (user, 2026-10-31)

- a. Two tiers; `full` is cleaned up by database reset only. No exceptions to the append-only
  triggers (ADR 0004).
- b. Staging is reset and reseeded by hand only, never after every deploy.
- c. `seed live` is in scope for this batch (unit 7).
- d. Runs alongside batch 5 (N2). The contract step was built on branch `seed/contract-step` and
  merged to `main` on 2026-10-31, ahead of batch 5's contract step (user's call). Batch 5 rebases
  onto it; the overlap is `packages/config/src/env.ts`, `.env.example` and the generated config doc.
