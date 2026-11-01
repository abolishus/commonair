<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N4-delivery: inbox processing, signed deliveries, fan-out, deletes, rotation, the AP test peer

You are implementing unit N4-delivery for CommonAir (repo: /Users/joshe/Repos/bcon). Read these
first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (c), (z), (ad), the path ownership and the shared
  rules are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.6 `FEDERATION_JOBS` and the media-state events
  - §3.1 the federation tables
  - §4.2 `packages/federation`
  - §5.2 the `b7JobsFor` mapping
  - §7 `harness/compose.n4.yaml`
- `.claude/briefs/next/N4-federation.md`.
- `docs/decisions/0030-federation.md`. Decisions 3, 4, 5, 6, 7, 8 and 9 are your spec.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. **Wave 2**: own git worktree, branch `n4/delivery`, cut from
`main` after wave 1 merged. N4-api builds the documents and the inbox front door. N4-web builds the
UI.

## Why

The worker does the work that is risky or slow. That covers:

- fetching a stranger's public key through the SSRF guard;
- verifying draft-cavage signatures;
- applying `Follow`, `Undo` and `Delete`;
- sending signed, retried deliveries when a channel goes live or publishes a VOD or clip;
- deleting objects when media is removed or a channel is suspended.

## You own (write only these)

- `packages/federation/src/{activities,objects}.ts` (fill the stubs), and their tests
- `services/worker/src/federation/**`, `services/worker/src/jobs/federation-*.ts`
- `harness/src/mocks/activitypub/**` (the minimal AP peer), `harness/scenarios/federation.ts` (fill the stub),
  `harness/src/n4/**` except `web.ts`, `harness/compose.n4.yaml`, `harness/tests/n4/**`

**Read-only:**

- `packages/federation/src/{signature,keys,digest,index}.ts`
- `services/worker/src/webhooks/{ssrf,http,backoff}.ts` (`resolveCallback` `:162`, `postPinned`
  `:63`, `DEFAULT_BACKOFF_MS`)
- `services/worker/src/notify/fanout/go-live.ts`
- `services/worker/src/b7/outbox-jobs.ts`
- `services/api/src/federation/**`
- `packages/{contracts,db,config,tokens}/**`

Anything else is a **contract request**.

## Contracts you must honor

- **Jobs:** `FEDERATION_JOBS.{inbox, deliver, fanout, rotate, sweep}`.
- **Events in:**
  - `stream.online`;
  - `media.vod.state` and `media.clip.state`;
  - `channel.suspension`;
  - `moderation.restriction`;
  - `channel.update` (`mature`), read at send time.
- **Tables:**
  - `federation_inbox_items`;
  - `federation_followers`;
  - `federation_actors`;
  - `federation_actor_keys`;
  - `federation_deliveries`;
  - `federation_objects` (stable ids, `deleted_at`);
  - `federation_domain_blocks`.
- **Signing:** draft-cavage `signRequest` / `verifyRequest`, RSA-2048.
- **Rules:** `FEDERATION_RULES.{dateSkewSeconds, dropAfterDays, keyRotateDays}`; the gates
  `FEDERATION_ENABLED` and `federation.enabled`.

## Build

1. **Inbox job.** Load the item and re-check the block list. Fetch the sender's key (the
   `keyId` URL, `application/activity+json`) through `resolveCallback`: https only, pinned public
   address, size cap, timeout.
   - The key is cached for 24 h. On a verification failure, refetch it once.
   - Verify: digest, date skew, and `keyId` ∈ the activity's `actor`.
   - Apply:
     - `Follow` of a federated channel: insert the follower (actor id, inbox, shared inbox from
       the fetched actor), then send `Accept{Follow}` signed by the channel actor.
     - `Undo{Follow}`: delete the follower.
     - `Delete` of an actor: remove that actor everywhere.
     - Anything else: drop it.
   - Mark the item processed with an outcome code. A sweep deletes items older than 7 days.
2. **Objects** (`packages/federation/src/objects.ts`, pure).
   - **Go-live `Note`:** title, category, a link to the channel page, and the current thumbnail
     as an attachment. Mature channels get no thumbnail, `sensitive: true` and an i18n
     `summary`.
   - **`Video`** for a public VOD or clip: title, duration, thumbnail (none if mature), and a
     `url` to the home watch page. No media URL and no clipper name (decision 3).
   - **Activities** (`activities.ts`): `Create`, `Delete` with `Tombstone`, `Accept`, and
     `Update{Service}`. Addressed to Public and the followers collection.
   - Ids are stable, from `federation_objects`.
   - Objects carry no emails, IPs or local viewer ids (decision 9).
3. **Fan-out.** The `fanout` job runs on:
   - `stream.online`, which creates a `Note`;
   - a `media.*.state` with `public: true`, which creates a `Video`;
   - a `media.*.state` with `public: false` (and the VOD or clip was federated), which sends
     `Delete`;
   - `moderation.restriction` (restricted), which deletes that broadcast's `Note`;
   - `channel.suspension` (suspended), which sends `Delete` of the actor to every follower inbox,
     then removes the followers. Recorded choice: remote followers are lost for good.
   - turning off `federation.enabled`, which sends `Delete` of the actor.

   It writes `federation_objects`, then one `deliver` job per distinct shared inbox (or inbox).
   It skips everything unless both `FEDERATION_ENABLED` and the channel's `federation.enabled`
   are on.

4. **Deliver job.** Sign with the channel actor's key (decrypted at use, never logged). Send
   through `postPinned` with the webhook backoff (`DEFAULT_BACKOFF_MS`). Record outcomes in
   `federation_deliveries`. An inbox that has failed every attempt for 7 days has its followers
   dropped (the `sweep` job). Delivery is at-least-once, and stable ids let remote servers
   dedupe.
5. **Rotation.**
   - The `rotate` job sends `Update{Service}` with the new key to every follower inbox.
   - A yearly schedule enqueues rotation for keys older than `keyRotateDays`.
   - Each rotation writes an audit row.
6. **AP test peer** (`harness/src/mocks/activitypub/**`). An in-process `Bun.serve`, reachable
   from the containers as in `harness/src/e9/receiver.ts`. It has:
   - a Mastodon-shaped actor (`Person`) with an RSA key;
   - WebFinger;
   - an inbox that verifies draft-cavage with `packages/federation` and records activities.

   It also offers helpers to send a signed `Follow`, `Undo{Follow}`, `Delete`, and a
   bad-signature `Follow`, plus a second peer on a "blocked" host name. `harness/compose.n4.yaml`
   sets `FEDERATION_ENABLED=true` and `OUTBOUND_ALLOW_PRIVATE_NETWORKS`. If https-only blocks
   the peer, file a contract request for an http allowance gated on that flag; never weaken the
   guard by default.

## Tests you must add

- **Unit (`packages/federation`):**
  - object and activity shapes against Mastodon-shaped fixtures;
  - the mature rules;
  - no clipper;
  - no PII fields (a schema test).
- **Worker integration** (real Postgres and Valkey; the in-process peer as the remote):
  - Inbox:
    - verify succeeds;
    - a bad signature is dropped;
    - a skewed date is dropped;
    - a `keyId` and actor mismatch is dropped;
    - after a key change, verification refetches once;
    - `Follow` stores the follower and sends a signed `Accept`;
    - `Undo` removes the follower;
    - an actor `Delete` removes it everywhere;
    - a blocked domain is re-checked.
  - Fan-out:
    - go-live delivers a signed `Create{Note}`;
    - a VOD made public delivers `Video`;
    - removal sends `Delete`/`Tombstone`;
    - a T1 restriction deletes the `Note`;
    - suspension sends an actor `Delete` and drops followers;
    - a mature channel's object has no thumbnail and has `sensitive: true`.
  - Delivery and rotation:
    - backoff;
    - the 7-day drop (with an injected clock);
    - rotation sends `Update`;
    - nothing is sent when either flag is off.
  - The SSRF guard refuses a private key URL without the harness flag.
- **Harness `federation`** (fill the pending steps):
  1. Turn on federation for a channel (through the API, or N4-web's step once merged: see
     `harness/src/n4/web.ts`).
  2. The peer resolves `@slug@domain` through WebFinger and fetches the actor.
  3. The peer sends `Follow`, and receives a signed `Accept`.
  4. Go live. The peer's inbox receives a signed `Create{Note}` that verifies.
  5. Publish a VOD. The peer receives `Create{Video}`.
  6. `Undo{Follow}`, go live again. Nothing is delivered.
  7. A blocked domain's `Follow` is refused at the inbox.
  8. Suspend the channel. The peer receives `Delete` of the actor.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` in `packages/federation`;
- `bun run test` and `test:int` in `services/worker`;
- `bunx tsc -p` each;
- `bun --bun vp test run` in `harness`;
- `vp lint --deny-warnings` and `vp fmt`;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`. Then tell the user to run
`bun harness/src/cli.ts run federation` against `stack --harness`. A manual follow from a real
Mastodon account against a staging instance is the maintainer's, before any public instance turns
federation on.
