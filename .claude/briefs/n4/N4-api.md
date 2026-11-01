<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N4-api: WebFinger, actors, NodeInfo, outbox collection, inbox cheap checks, studio and admin procedures

You are implementing unit N4-api for CommonAir (repo: /Users/joshe/Repos/bcon). Read these first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (c), (z), (ad), path ownership and the shared rules
  are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.4 `federation.*`
  - §2.6 `federation.inbox.received`, `FEDERATION_JOBS`
  - §3.1 the federation tables
  - §4.2 `packages/federation`
  - §5.3 the raw HTTP mounts and Caddy
- `.claude/briefs/next/N4-federation.md`.
- `docs/decisions/0030-federation.md`. Decisions 1–7, 9 and 10 are your spec.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**: work in your own git worktree on branch
`n4/api`, cut from `main` after wave 1 merged. N4-delivery (the worker) and N4-web (the UI) run
beside you. You build the read side and the inbox's front door. The API makes **no outbound
fetches**: all key fetches, signature verification and deliveries are N4-delivery's.

## Why

A Mastodon user should be able to find `@slug@instance` and follow it. That needs WebFinger, an
actor document with a public key, NodeInfo, and an inbox that accepts fast and leaves the slow,
risky work (fetching a stranger's key, verifying, applying) to the worker, where the SSRF guard
lives.

## You own (write only these)

- `services/api/src/federation/**`: fill `http.ts`, and add `webfinger.ts`, `actor.ts`,
  `nodeinfo.ts`, `collections.ts`, `inbox.ts`, `settings.ts`, `admin.ts`, `keys.ts`.
- `services/api/src/routes/federation.ts`.
- Tests in `services/api/tests/federation*`.

**Read-only:**

- `services/api/src/http.ts` (the raw mounts).
- `packages/federation/**` (signatures and keys; N4-delivery's `activities.ts`/`objects.ts`
  appear after wave 2 merges: build the actor document yourself).
- `packages/tokens/src/secrets.ts` (`encryptSecret`).
- `packages/{contracts,db,config}/**`.

Anything else is a **contract request**.

## Contracts you must honor

- **Flag:** `FEDERATION_ENABLED`. When it is false, every federation route answers 404 and the
  procedures answer `FORBIDDEN` with a clear code. The `instance.info().features.federation`
  flag follows it.
- **Tables:**
  - `federation_actors`: per channel, with the key encrypted under the federation purpose.
  - `federation_actor_keys`: append-only history.
  - `federation_followers`.
  - `federation_domain_blocks`.
  - `federation_inbox_items`.
- **Events:** `federation.inbox.received`, an outbox event written in the same transaction as the
  item.
- **Channel setting:** `federation.enabled`, off per channel until the streamer turns it on.
- **Identity:** the domain comes from `instanceSite()` (AGENTS.md rule 5). Actor ids are
  `https://<domain>/ap/channels/<uuid>`.
- **`FEDERATION_RULES`:** `inboxMaxBytes` and `dateSkewSeconds`.

## Build

1. **WebFinger** (`/.well-known/webfinger?resource=acct:<slug>@<domain>`): returns JRD with a
   `self` link (`application/activity+json`) to the actor id and a profile-page link. The answer
   is 404 for:
   - an unknown or non-federated channel;
   - a suspended channel;
   - another domain.

   Also accepts `resource=<actor id>`. Rate-limited.

2. **Actor** (`GET /ap/channels/<uuid>`, `Accept: application/activity+json` or
   `application/ld+json; profile=…`). The `Service` document carries:
   - `preferredUsername` = slug;
   - name and summary (the streamer's own text, plus the i18n "replies are not read" line);
   - `icon` and `image` (public avatar and banner URLs; **none** for mature channels);
   - `url` to the channel page;
   - `inbox`, `outbox`, `followers`, and `endpoints.sharedInbox` = `/ap/inbox`;
   - `publicKey {id: <actor>#main-key, owner, publicKeyPem}`;
   - the AS2 and security contexts as plain JSON.

   An HTML `Accept` gets a 303 to the channel page. A suspended or non-federated channel gets
   404 (410 once a `Delete` was sent).

3. **Collections.**
   - `outbox`: public `Create` activities from `federation_objects` that are not deleted,
     newest first, paged. Each entry links its stable object id.
   - `followers`: a `totalItems` count and **no items** (decision 9).
4. **NodeInfo:** `/.well-known/nodeinfo` links to `/nodeinfo/2.1`, which gives the software name
   and version, `protocols: ["activitypub"]` and `openRegistrations`. `usage` carries no user
   counts.
5. **Inbox front door** (`POST /ap/channels/<uuid>/inbox` and `/ap/inbox`). Cheap checks only:
   - **Content type:** activity+json or ld+json.
   - **Body:** at most `inboxMaxBytes`, and parses as JSON.
   - **Type:** `type` ∈ `Follow | Undo | Delete`; anything else gets 202 and is dropped
     unstored.
   - **Domain:** the `actor` host and the `Signature` `keyId` host must match each other and not
     be blocked (domain or subdomain, `federation_domain_blocks`).
   - **`Date`:** within the skew.
   - **Rate limit:** per domain (`RATE_LIMITS` pattern).

   Then store `federation_inbox_items` (raw headers and body, `received_at`), write
   `federation.inbox.received`, and answer 202. Never verify here, never fetch. Refusals answer
   4xx and are counted in metrics without PII.

6. **Studio and admin procedures (`routes/federation.ts`).**
   - **`settings.get` / `settings.update` (owner):** turning federation on creates the actor
     row and its RSA-2048 key (`generateActorKey`, private key with `encryptSecret`). Turning
     it off keeps the key but stops delivery. N4-delivery sends `Delete`.
   - **`followers.list` / `followers.remove` (owner):** lists handles and servers; remove
     deletes the row.
   - **`admin.blocks.list` / `add` / `remove`:** `add` drops that domain's followers in the same
     transaction. Each change writes an `audit_log` row (domain, actor id).
   - **`admin.keys.rotate({channel?})`:** stores the new key, appends the old one to
     `federation_actor_keys`, enqueues `FEDERATION_JOBS.rotate` (which sends `Update`), and
     writes an audit row.

   Admin procedures need admin access, and every one is audited.

## Tests you must add

- **Unit:**
  - WebFinger resource parsing: case, `acct:` forms, a foreign domain.
  - Actor document shape against Mastodon-shaped fixtures (`harness/src/mocks/activitypub`
    fixtures if they are on main; otherwise your own under `services/api/tests/fixtures/` with
    `.license` sidecars).
  - Mature: no `icon` or `image`.
  - Block matching: subdomains, and case.
  - Inbox checks: each refusal, plus the 202-and-drop for other types.
- **Integration:**
  - With the flag off, everything is 404 or `FORBIDDEN`.
  - A non-federated channel gets 404; a suspended channel gets 404.
  - Turning a channel on creates its key, and the key at rest is encrypted.
  - An inbox POST stores an item and writes the outbox event in one transaction.
  - A blocked domain is refused, and its followers are dropped.
  - Rotation appends the old key and writes an audit row.
  - The followers collection has no items.
  - NodeInfo has no usage counts.
  - No federation route makes an outbound request: inject a fetch that throws.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `services/api`.
- `bunx tsc -p services/api`.
- `vp lint --deny-warnings` and `vp fmt` on your files.
- `reuse lint`.
- `git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run `bun harness/src/cli.ts run federation` once N4-delivery and N4-web
are merged too.
