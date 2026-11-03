<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Seeding demo data

CommonAir has two demo seeds. The full one fills every table and every web route for every
role, at a volume that exercises pagination, search and long chat logs. It writes rows the
database never lets anyone delete, so the only way to remove it is to reset the database.

| Tier    | Command                                                       | Where                  | Removed by                     |
| ------- | ------------------------------------------------------------- | ---------------------- | ------------------------------ |
| `basic` | `bun run --filter @commonair/db demo:seed`                    | any instance           | `demo:clear` (row by row)      |
| `full`  | `bun harness/src/cli.ts seed full --confirm <db> --scale <s>` | local and staging only | a database reset (see "Reset") |

The plan and its decisions are in `.claude/briefs/seed-full/README.md`. Each unit's brief is next to it.

## The guard

`seed full` refuses unless all three of these hold:

1. **`DEMO_SEED_FULL=true`** in the shell that runs it. The worker needs it too, so that points
   accrue on demo accounts; the seed overlay sets it there.
2. **`--confirm host:port/db`** names the target database exactly, without credentials. For the
   local stack that is `localhost:5432/commonair`.
3. **The database has no users at all**, demo users included.

The seed writes ledger postings, votes, moderation cases, audit rows and other append-only rows
(ADR 0004), so a second run, or a run on top of the `basic` seed, is refused. If a run fails
halfway, reset the database and start again.

## The seed stack

Features that ship off are seeded on (decision e), so the seed needs every harness override plus
its own:

```bash
bun scripts/init-env.ts --merge --seed
bun scripts/fetch-model.ts --model captions
bun scripts/infra.ts stack --harness --multi --captions --w3 --seed
```

- **`init-env --merge --seed`** keeps every existing value and fills an empty
  `STRIPE_WEBHOOK_SECRET`. The harness signs stripe-mock's webhook events with that secret.
  `stack --seed` refuses while it, `INTEGRITY_SIGNING_KEY`, `PORTABILITY_SIGNING_KEY` or the
  VAPID pair is empty. None of them is ever committed.
- **`--seed`** layers `harness/compose.seed.yaml` last and starts stripe-mock (the `stripe`
  profile). The overlay sets:
  - `PAYMENTS_PROVIDER=stripe` against stripe-mock;
  - `DEMO_SEED_FULL=true` on the worker;
  - a non-zero `INFRA_COST_MODEL`. Its rates are far above real ones, so the few MB a seeded
    recording moves still cost whole cents.
- The other overrides it needs:
  - **the harness overrides:** every test hook (`COOP_`, `MODERATION_`, `OPS_` and
    `INTERACT_TEST_HOOKS`), the E5 governance bootstrap, the scripted classifier with the
    synthetic hash lists, EventSub's insecure callbacks, push, and the surge guard;
  - **`--captions`:** the whisper sidecar;
  - **`--w3`:** giveaways, the Twitch import against the harness mock, and federation against the
    in-harness ActivityPub peer.

Everything the stack calls while the seed runs is a local peer or a mock. Rows that point at a peer
(webhook deliveries, federation followers, Discord sinks) stay behind after the seed stops that
peer, and fail later. That is expected.

The harness host needs `ffmpeg` (libx264, aac, RTMP listen), the Go toolchain (seed-media builds
the relay from `relay/`) and the Playwright browsers (`bun run --filter @commonair/harness browsers`).

## Running it

On a freshly reset local database:

```bash
DEMO_SEED_FULL=true DEMO_SEED_PASSWORD='<at least 12 characters>' bun harness/src/cli.ts seed full --confirm localhost:5432/commonair --scale small
```

- **Password:** without `DEMO_SEED_PASSWORD`, the run makes one up and prints it at the end.
- **`--seed <n>`:** picks the content (default 1). The same seed and scale give the same names,
  counts and states; ids and real-time timestamps differ.
- **Output:** each unit prints its row count, its time and its notes. At the end the run writes
  the store (every account, channel and published key) to `harness/reports/seed-store.json`.
  Nothing personal or secret goes into that file.

| Scale    | Streamers | Viewers | Chat lines | History  | Use                              |
| -------- | --------- | ------- | ---------- | -------- | -------------------------------- |
| `small`  | 10        | 50      | 5 k        | 90 days  | local click-through (default)    |
| `medium` | 100       | 2 k     | 200 k      | 365 days | staging                          |
| `large`  | 1 k       | 20 k    | 2 M        | 730 days | pagination and query-plan checks |

At `small` the whole run takes roughly 25–30 minutes. Several units really go live, record, encode
and wait for the worker; the slowest are seed-media at about 10 minutes and seed-coop at about 5.
The run order is: social, then interact, money and media, then safety, then coop, then platform.

### Generated art

seed-social gives the seeded accounts the visual identity a real instance has (design review F10):

- **Avatars:** every streamer and every fixed login except `newbie` (which keeps the initial, for
  comparison), and about 70% of the bulk viewers. Each one is the channel avatar and the profile
  image, so it shows on cards, the channel page, chat and member lists.
- **Banners and panels:** streamer1, streamer2 and streamer3 each get a 6:1 banner and 3–5 panels
  (a title, a text body, a generated image on some, links to `https://example.org/<slug>/…` only).
  These panels replace the plain ones the base rows give those three channels.
- **Category box art:** not seeded. No procedure sets a category's box art yet, so `boxArtUrl`
  stays `null` and the web shows its fallback tile (a contract request from D1-seed).

The art is abstract: a gradient with a few large circles, rings and polygons, drawn by
`harness/src/seed/art.ts` from the unit's seeded PRNG with the user id as the salt. It is never a
photo, a face, text or a brand, and nothing is fetched. The generator makes an SVG and rasterizes
the same scene to PNG for the upload, because the upload endpoint takes PNG, JPEG, WebP and GIF but
not SVG, and the harness has a PNG encoder but no WebP one (WebP would need a new dependency). The
images are CC0-1.0; none is committed, they are made at run time.

Uploads go through the public API, as the dashboard's appearance card does them: a presigned PUT,
the scanning commit, then `channels.update` with the merged theme (and `/update-user` for the
profile image). Six run at once. The step skips any avatar, banner or panel set that is already
there, so it never uploads twice. A resume (`--from`) never reruns seed-social anyway.

At `medium` this is about 1,500 avatar uploads, each with a sign-in, so seed-social takes several
minutes longer than before; `large` is about ten times that.

### `seed live`

```bash
DEMO_SEED_FULL=true DEMO_SEED_PASSWORD='…' bun harness/src/cli.ts seed live --channels 3 --duration 30m
```

After `seed full`, this keeps K seeded channels streaming a test pattern while harness chat
clients talk. That gives the live surfaces something to show: home, Calm Chat, surge guard, data
mode, embeds and overlays. Stop it with Ctrl-C or SIGTERM, or let `--duration` run out.

The fixed streamers go first (streamer1, streamer2, streamer3, council1, council2), then bulk
streamers. Each channel gets three bulk viewers as chatters, never one that is suspended, being
deleted, banned from a chat or blocked by anyone. Chat reaches a page only over its socket (there
is no history on join), so a page shows lines that arrive while it is open: each chatter says one
every 25–60 s. `seed-coverage` runs it itself with faster chat (below), and staging seed mode runs
it after `seed full` until `seed-mode close`.

**Verified viewers (design review F12).** Each live channel also gets 3–15 seeded bulk viewers
(the busiest channel the most; a channel's chatters first, then other bulk viewers, nobody on two
channels) who watch it through the real playback path. They use the HTTP viewer of the `viewers`
scenario: a signed-in playback session that downloads the live segments a player would and sends
heartbeats with a person's jitter. Nothing writes counts to the database or Valkey, so the cards
show only what the integrity scorer verifies; expect the first verified numbers a minute or two
after the streams start. Viewers arrive over the first minute, watch for 20–50 minutes, leave and
come back after 10–45 s, and a session that stops getting media (a publisher restart) is renewed.
Each keeps one device id and fingerprint for the whole run.

**Recently live.** seed-media records seven bulk streamers at every scale (one of them has its VOD
removed mid-stream), so at least six channels outside `seed live`'s default three have a public
VOD with a thumbnail for the home page's recently-live tiles.

**Co-op proposals.** The filler proposals have distinct titles from a list (an action and an
initiative), so `/coop` never shows "(2)" or "(3)" repeats (design review F19).

## Checking it: `seed-coverage`

The `seed-coverage` scenario signs in as each route's login and visits every route in
`harness/src/seed/routes.ts` (`SEED_ROUTES`). A unit test keeps that list equal to the generated
route tree.

- **Every route fails** on the router's error boundary or any 5xx.
- **A route marked `expectData` also fails** on any `<EmptyState>` or any 4xx, from the document or
  from the API.

It runs in one of three ways:

- **On a database with no users and `DEMO_SEED_FULL=true`:** it runs `seed full --scale small`
  itself, then visits every route. CI does this in its own `seed` shard, on a fresh stack with
  every override. The shard is path-filtered on pushes and runs every night.
- **After a separate `seed full`:** it reads `harness/reports/seed-store.json` and signs in with
  `DEMO_SEED_PASSWORD`:
  ```bash
  DEMO_SEED_PASSWORD='…' bun harness/src/cli.ts run seed-coverage
  ```
- **On any other database** (an unsharded `full`, whose other scenarios made users): it skips
  every route and says why.

During the walk, streamer1 and streamer2 are live: the scenario runs `seed live` with a chat line
every 1.5–4 s per chatter, waits until both channels show as live, and stops it in its teardown.
That fills `/`, the channel page and its chat, the embed and the dashboard. If streamer1 is already
live, a separate `seed live` is running (staging's), and the scenario uses it. A route marked
`expectData` gets up to 10 s for an empty state to fill before it is judged.

To run the shard as CI does:

```bash
bun run verify --full --only harness --shard seed
```

## Fixed logins

Every account is `demo_<handle>@demo-seed.invalid` with the shared password. Bulk accounts are
`demo_s<n>` (streamers) and `demo_v<n>` (viewers).

| Login       | Role      | What it shows                                                                                                    |
| ----------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `admin`     | admin     | Every `/admin` queue has items: moderation, appeals, integrity, DMCA, egress, incidents, apps, co-op, federation |
| `treasurer` | treasurer | `/treasury`: payouts, fraud flags, costs, reconciliation, treasury postings                                      |
| `legal`     | legal     | `/admin/legal`: T0 cases and evidence, NCMEC drafts, a legal hold, DMCA                                          |
| `mod`       | moderator | The platform moderation queue and the appeals to decide                                                          |
| `streamer1` | user      | The full studio: every panel, the bot, overlays, relays, revenue, captions, analytics, crew, move                |
| `streamer2` | user      | A mid-size channel: subscriptions and tips, polls, raids received, a live prediction                             |
| `streamer3` | user      | A new channel: first broadcast, few followers, a finished Twitch import on `/import`                             |
| `chanmod`   | user      | Channel moderator and VIP on streamer1, editor on streamer2                                                      |
| `viewer1`   | user      | Follows, subscriptions, tips, points, inbox, push, connected apps, a data export                                 |
| `viewer2`   | user      | A timeout, a report filed, an appeal pending, a copyright notice                                                 |
| `banned`    | user      | Suspended through the API, with an enforcement statement and an appeal                                           |
| `member1`   | user      | Co-op member: votes cast, a drafted proposal, a patronage allocation, opted in to the jury                       |
| `council1`  | user      | Creator council member: council responses, an election candidacy                                                 |
| `council2`  | user      | The second council member, for quorum and tallies                                                                |
| `developer` | user      | OAuth apps, EventSub subscriptions, webhook deliveries, a bot app                                                |
| `newbie`    | user      | A fresh account: every empty state stays visible for comparison                                                  |
| `bot1`      | user      | streamer1's chat bot (a channel moderator through the channel-bot path)                                          |

## Known gaps

**No empty tables.** Every unit's `pending` list is empty. Four tables are reached only through
test hooks, which the seed stack turns on:

- **seed-money: `payouts` and `split_writeoff_proposals`.** The `money-release-holds` ops tick
  takes a test hold period (`OPS_TEST_HOOKS`), so holds release during the seed. Then a payout
  run, and a chargeback on a released split share. The same flag waives the write-off quiet
  window.
- **seed-coop: `membership_shares`.** `buyShare` takes a manual share on the Stripe stack under
  `COOP_TEST_HOOKS`.
- **seed-safety: `evidence_audit_runs`.** The `evidence-audit` ops tick runs the daily audit now.

**Today-only history.** Protected rows keep the real time they were written: the ledger, votes,
moderation, giveaways and predictions. Only plain tables are backdated. So these screens show
today's history only:

- the admin queues and `/transparency`;
- `/settings/appeals`;
- the points history;
- predictions.

Revenue charts, broadcast history, chat and song requests do spread across the history window.

**Other notes the units report:**

- **seed-interact:** points come from real worker accrual over verified `playback_sessions` that
  seed-interact inserts (user agent `CommonAir-demo-seed/1 (seed-interact)`). Its live window
  rotates streamer1's and streamer2's stream keys.
- **seed-money:**
  - every payment settles through signed stripe-mock webhooks;
  - a lapsed subscription's `current_period_start` comes before the row's own `created_at`;
  - on the manual adapter, `past_due` and `expired` land up to 5 minutes after the seed.
- **seed-coop:**
  - `governance_applications` holds applied rows only, because the settings trigger writes it;
  - every qualifying subscriber becomes a member, because membership sync enrols them all.
- **seed-safety:**
  - a fully dismissed T0 case needs a second legal reviewer, and the fixed logins have only one;
  - the restored DMCA notice and the escalated NCII request carry times stamped ahead by the test
    clock;
  - the analytics display bypass lasts 1 hour.
- **seed-platform:** the Twitch import's category is not matched. Webhook, Discord and federation
  rows point at peers that stopped with the run.
- **seed-media:**
  - the mid-stream VOD removal is on a bulk streamer, so streamer1's VOD and clip stay intact;
  - streamer3 has no backdated history.
- **Sign-in rate limit:** the API's auth limit is 10 sign-ins a minute per address. Units that
  sign in many accounts wait it out, so seed-safety and seed-platform take longer than their
  2-minute budget at `small`.

## Reset

- **Local:** stop the stack, delete its volumes and start it again. Migrate runs on the fresh
  volume with the E5 bootstrap.

  ```bash
  bun scripts/infra.ts reset
  ```

  Then start the seed stack again, as in "The seed stack" above.

- **Staging, by hand only (decision b):** `selfhost.sh reset-staging` drops and recreates the
  database, flushes Valkey, migrates, and starts the instance again. It refuses unless both of
  these hold:
  - `commonair.env` has `DEMO_SEED_FULL=true`;
  - `--confirm` equals the instance's `PUBLIC_HOSTNAME` exactly.

  ```bash
  sh ~/commonair/selfhost.sh reset-staging --confirm <PUBLIC_HOSTNAME>
  ```

  It leaves an empty, migrated database, so `seed full --scale medium` can run next.
  - `--base-seed` adds the `basic` seed instead, but `seed full` then refuses that database.
  - Media objects stay in the bucket. They are harmless, and the next seed writes new ones.
  - The steps are in `docs/self-hosting/upgrades.md`, "Resetting a staging instance".

## Seeding staging

Staging (`staging-stream.abolish.us`, the droplet `commonair-rc-test`) is a normal self-host install
from signed releases. It has none of what the seed needs: test hooks, mocks, Mailpit, and peers the
stack calls back. **Seed mode** turns them on for a few hours, runs the seed from a harness
container on the instance's own network, and closes again (ADR 0040). The commands run on the
droplet, as the `commonair` user.

The instance must have `DEMO_SEED_FULL=true` in `~/.config/commonair/commonair.env` and live
captions on (`install --captions`). Every command below that takes `--confirm` refuses, and
changes nothing, unless it equals the instance's `PUBLIC_HOSTNAME` exactly.

In order:

```sh
# 1. The release whose harness image matches the code you want to seed with.
sh ~/commonair/selfhost.sh upgrade --version vX.Y.Z

# 2. Open seed mode (6 hours at most; --hours shortens it).
sh ~/commonair/selfhost.sh seed-mode open --confirm staging-stream.abolish.us

# 3. A fresh database. Its migrations apply seed mode's governance bootstrap.
sh ~/commonair/selfhost.sh reset-staging --confirm staging-stream.abolish.us

# 4. The full seed, in the harness container; then three channels stay live with chat.
DEMO_SEED_PASSWORD='<at least 12 characters>' \
  sh ~/commonair/selfhost.sh seed-mode run --confirm staging-stream.abolish.us --scale medium

# 5. Optional: every route as its role.
DEMO_SEED_PASSWORD='<the same password>' \
  sh ~/commonair/selfhost.sh seed-mode coverage --confirm staging-stream.abolish.us

# 6. Close seed mode. It stops the live streams first; the seeded data stays.
sh ~/commonair/selfhost.sh seed-mode close
```

- **Order:** open comes before the reset, because `GOVERNANCE_BOOTSTRAP_JSON` takes effect only at
  a database's first migration, and seed-coop checks it (`preflightGovernance`).
- **While it is open:**
  - The API and the worker run every test hook, the scripted classifier with the synthetic hash
    lists, and private-network outbound.
  - Payments go to stripe-mock and all email goes to a Mailpit container. No demo address reaches
    the real SMTP relay.
  - Federation and the Twitch import talk only to the harness's own peers.
  - `upgrade` and `install --reinstall` refuse, and say to run `seed-mode close` first.
  - `selfhost.sh status` shows `seed mode: OPEN until <deadline>`, the seed-mode units, and
    whether `seed live` is running.
- **Its deadline:** a timer, `commonair-seed-mode-close.timer`, runs `seed-mode close` at the
  deadline. `open` arms it before it changes anything, and stops, changing nothing, if it cannot.
  It fires at boot if the host was down then. While it (or any close) runs, a second `close`
  changes nothing, and `status` says seed mode is being closed. A run still going at the deadline stops
  with the harness, and needs a reset before the next run.
- **`run`:** runs `bun harness/src/cli.ts seed full` in `commonair-seed-harness`. It writes as the
  app role, against `postgres:5432/commonair`. Its output streams to your terminal.
  - Without `DEMO_SEED_PASSWORD`, the run makes up a password and prints it once, before the seed.
  - The store report is `~/.local/share/commonair/seed-mode/reports/seed-store.json`, next to
    `seed-coverage`'s reports.
  - Once the seed succeeds, it starts `seed live --channels 3` in the same container, detached
    (`podman exec -d`): streamer1, streamer2 and streamer3 publish a test pattern through the
    stack's ingest, with bulk viewers chatting. It keeps running until `close` or the deadline.
    Its pid (the container's) is `/reports/seed-live.pid`, and its log is `seed-live.log` in the
    reports directory.
  - While it runs, it renews streamer1's analytics display bypass every 30 minutes. seed-safety
    turns the bypass on, but it is a Valkey key with a one-hour TTL (and a resume flushes Valkey),
    so without the renewal `/analytics` would wait out the 24 h display delay again.
- **One unit at a time, and resuming:** `run` asks the harness for its units (`seed units`) and
  runs `seed full --to <unit>` for each, with `--from <unit>` from the second on. Between units it
  dumps the database (`pg_dump -Fc`, as the owner, while the stack keeps running) to
  `reports/snapshots/after-<unit>.dump`. After each unit the harness writes
  `reports/seed-checkpoint-<unit>.json`: the store later units read (`store.extra` included), the
  run's `now`, and the database's fingerprint (the count and a hash of every user id). A unit that
  fails stops the run, and the error names the command that resumes it:

  ```sh
  DEMO_SEED_PASSWORD='<the same password>' \
    sh ~/commonair/selfhost.sh seed-mode run --confirm staging-stream.abolish.us --scale medium --from coop
  ```

  - `--from coop` restores the dump taken after `safety` (the unit before): it stops the app units
    (not Postgres, Valkey, Garage or the idle harness), recreates the database from the dump,
    flushes Valkey and starts the stack. Then it runs `coop` and every unit after it.
  - It refuses, changing nothing, without `DEMO_SEED_PASSWORD` (seed-social set every account's
    password), or without both the checkpoint and the dump after the unit before.
  - The harness checks the checkpoint again: the zero-users guard is relaxed only when the
    checkpoint's target, scale, seed and user fingerprint match this database. A real instance's
    database, or one the dump was not restored to, never matches.
  - **Not restored: Valkey and object storage.** Valkey is flushed instead, as a reset does: it
    holds sessions, rate limits, caches and queued jobs, which units recreate (they sign in again)
    or which name rows of the failed attempt. Jobs queued but not yet run when the dump was taken
    are lost; the worker's scheduled jobs come back when it starts. Media objects stay in the bucket.
    The dump's rows still point at the earlier units' objects, and the failed unit's are orphans,
    harmless as after a reset.
  - A fresh `run` (no `--from`) deletes the old dumps, and the harness deletes the old checkpoints.
  - Without selfhost.sh (a local stack), `seed full --from <unit>` works the same once you restore
    the database yourself; the checkpoints are in `harness/reports/`.

- **`live`:** restarts `seed live` (stop, then start), for example after the harness container
  restarted. It needs `DEMO_SEED_PASSWORD`, the password the run used.
- **`close`:**
  - It first stops `seed live` (SIGTERM, then up to 30 s for its encoders), before the harness
    container stops.
  - It removes the block from `commonair.env` and restores exactly the values the block replaced:
    federation, the Twitch import, payments and Stripe, SMTP, the cost model and the bootstrap.
  - It removes stripe-mock, Mailpit, the harness, the drop-ins and the timer, then restarts.
  - Giveaways, the watch gate, the surge guard and push stay on.
  - Running it again does nothing.

What `open` changes, so you can check it by hand:

- **`commonair.env`:** one block between `# >>> staging seed mode` and `# <<< staging seed mode`.
  The values it replaces are saved in `~/.local/state/commonair/seed-mode` (mode 0600).
- **Drop-ins:** `~/.config/containers/systemd/commonair-{api,worker,media,seed-harness}.container.d/50-seed-mode.conf`.
  They carry the synthetic hash lists, and for the API the harness's fixed address `10.89.42.12/32`
  as a trusted proxy, so each simulated client gets its own rate-limit subject.
- **Units:** `commonair-stripe-mock`, `commonair-mailpit` and `commonair-seed-harness`. They
  publish nothing on the host.
- **The timer:** `commonair-seed-mode-close.timer` and its service.
