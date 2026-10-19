<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/db

Drizzle schema, migrations, database protections and test databases for CommonAir. See
[AGENTS.md](../../AGENTS.md) for the rules and [docs/architecture.md](../../docs/architecture.md)
for how the services use it.

## Demo data

Realistic data for clicking around a local or staging instance, and a way to remove all of it
again without touching anything real.

```sh
# Insert demo data (prints the usernames and the shared password once)
DATABASE_URL=postgres://… bun run --filter @commonair/db demo:seed
# Already seeded? Clear and re-seed in one transaction
DATABASE_URL=postgres://… bun run --filter @commonair/db demo:seed -- --reset

# Show what would be deleted (dry run), then delete it
DATABASE_URL=postgres://… bun run --filter @commonair/db demo:clear
DATABASE_URL=postgres://… bun run --filter @commonair/db demo:clear -- --yes
```

`DEMO_SEED_PASSWORD` sets the one password every demo account shares (10 to 256 characters);
without it a strong random password is generated and printed at the end of the seed. Nothing
else is written to disk.

**Database role.** Both commands work as the least-privilege application role (`commonair_app`,
what the services use): they only write tables that role may write, and they never delete
append-only rows. The owner/migration URL works too. Locally that is the `.env` `DATABASE_URL`;
on staging use the api service's `DATABASE_URL`.

### What gets created

All in one transaction, inserted directly with Drizzle (no API calls, no mail):

- 3 streamers (`demo_streamer1`–`3`) and 6 viewers (`demo_viewer1`–`6`) with display names, adult
  birth dates, verified emails and better-auth credential accounts. The password hash matches the
  pinned better-auth exactly (scrypt N=16384, r=16, p=1; `services/api/tests/demo-seed.int.test.ts`
  signs a seeded user in through the real API). Sign in with the **email**
  (`demo_streamer1@demo-seed.invalid`): `demo_` is a reserved username prefix, and better-auth
  applies the username rules to username sign-in as well.
- A channel per streamer with title, description, category, tags and language (en, es, de),
  an active stream key (hashed like `stream.rotateKey`; rotate it in the dashboard to go live) and
  two past broadcasts each, so dashboards and channel pages have history.
- Follows between them (with matching follower counts) and two channel moderators.
- About fifty chat messages spread through each channel's latest broadcast.
- One active one-hour timeout (by a channel moderator) and one permanent ban (by the owner), with
  the `mod_actions` and `audit_log` rows the API writes (ids only).
- A bot account (`demo_bot1`) owned by `demo_streamer1`. It has no token; sign in as the owner and
  mint one (`me.bots.createToken`) to try tmi.js or the SDK.
- Three categories (`just-chatting`, `music`, `software-development`), reused if they exist.
  Categories are shared reference data, so `demo:clear` leaves them in place.

No money, co-op, ledger, governance or relay rows are created, and no `events` outbox rows, so
demo data never reaches webhooks or EventSub subscribers.

If demo users already exist, `demo:seed` says so and changes nothing unless `--reset`.

### Why it cannot touch real data

Every demo account carries two anchors from `@commonair/contracts/fixtures` (`DEMO_FIXTURES`):

1. A username starting with `demo_`. The API reserves that prefix (`services/api/src/auth/identity.ts`),
   so no sign-up and no bot can ever get such a name.
2. An email on `demo-seed.invalid`. `.invalid` is reserved by RFC 6761: no real mailbox exists
   there, so no real account can verify such an address.

`demo:clear` selects only users matching **both** anchors
(`username like 'demo\_%' escape '\'` and `email like '%@demo-seed.invalid'`); a user with one
anchor is never touched. It then deletes, children before parents and in one transaction:
playback sessions, stream hours and integrity flags on demo channels or broadcasts (these
reference channels and broadcasts with RESTRICT), reports, moderation history, chat messages,
bans, follows and channel roles in demo channels or by demo users, clips, VODs, broadcasts,
stream keys, the channels, sessions, credential accounts, tokens and notifications, the bots
demo users own, and finally the users. Follows by demo users on real channels are removed too,
and those channels' follower counts are lowered to match.

`audit_log` rows stay (the table is append-only and references ids only, per ADR 0004). If an
anchored user somehow has money, co-op or relay rows, their RESTRICT foreign keys make the whole
transaction fail and nothing is deleted. The dry run executes the same deletes and rolls them
back, so its counts are exact. Both commands print the target host and database first (never the
credentials).

Valkey holds nothing that needs clearing: chat and rate-limit keys for deleted users expire on
their own.
