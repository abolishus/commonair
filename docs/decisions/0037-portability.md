<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0037: Portability: move links, move notices and the channel bundle

- Status: proposed (maintainer to accept; see [Decisions at acceptance](#decisions-at-acceptance))
- Date: 2026-11-01 (code checked at `3bb7af9b`)
- Gates: W3-portability ([batch 7 contract step](../../.claude/briefs/w3/contract-step.md) §2.3,
  §2.4, §3.1, §4.3, §5.1–§5.3; [brief](../../.claude/briefs/w3/W3-portability.md)), and through its
  importer N3-import ([ADR 0031](0031-twitch-import.md))

**No counsel retained; listed for post-launch review.** The maintainer decided the points below
that would otherwise go to counsel (refunds on a move, the content of the standing statement) with
the conservative default; they are listed under "Post-launch review" in the batch 7 README. This is
not legal advice.

## Context

Feature-wins §4.14 asks for three things: a way for a creator to bring their audience with them
when they move, a way for viewers to hear about a move without the creator holding their
addresses, and a way for a channel to leave an instance with its setup intact, carrying proof that
it is not leaving to escape moderation. Twitch offers none of these: followers cannot be exported
or contacted.

What exists at `3bb7af9b`:

- **Data export (E6).** `me.exports` builds a ZIP with a `manifest.json` (`EXPORT_FORMAT_VERSION` 1,
  `packages/contracts/src/internal.ts`), with cooldown, TTL and an email when it is ready. It is a
  personal-data export, not something another instance can import.
- **Follows** have no source. `channels.follower_count` is updated by the application with `±1`
  (`services/api/src/routes/channels.ts`), and integrity exclusion never decrements it
  (`packages/integrity/src/jobs.ts:788-791`), so it drifts.
- **One upload pipeline**, in the API: `commitUpload` (`services/api/src/moderation/uploads.ts:225`)
  checks magic bytes, PDQ-hashes against the hash lists (the T0 gate), runs the classifier with
  stricter emote and panel thresholds, then copies the image to its public key. The worker never
  calls the API and has no matcher.
- **Signed statements** exist for attestations (ADR 0014): a worker-only Ed25519 key, a `kid`, a
  published key history and an envelope `{ payload, signature }` whose signed bytes are the JSON of
  a Zod-parsed statement.
- No move link, grant, bundle or import code exists.

There are no self-hosters and no public instance, so nothing below needs a migration window.

## Decisions

### 1. One bundle schema for every import (decision (j))

`PortabilityBundle` v1 is defined once, in `packages/contracts/src/portability.ts` (exported as
`@commonair/contracts/portability`). A bundle is a ZIP holding `bundle.json`, the image files under
`files/`, and a manifest listing each file's path, byte size and SHA-256.

`bundle.json` holds `v: 1`, `source` (`commonair` or `twitch`), `exportedAt`, the exporting
`instance` (`domain`, `software`, `version`), the channel fields (title, description, tags,
language, mature, category slug and name), panels (title, body, link, image file or null), emotes
(code, tier, animated, file), the schedule, and an optional standing statement (decision 4).

- **One importer.** W3-portability builds, verifies and applies bundles. N3-import maps Helix data
  into the same schema and calls the same exported `applyBundle`. There is one set of moderation
  gates to keep correct.
- **The schedule is carried, never applied.** CommonAir has no schedule feature (ADR 0031
  decision 7); the field exists so the format does not change when one arrives.
- **Parsing refuses**: an unknown `v`; a file whose size or SHA-256 differs from the manifest; a
  file name that is absolute, contains `..` or leaves `files/`; more emotes than `MAX_EMOTES`, more
  panels than the studio allows, or a file over the per-file byte cap. Limits are the studio's own,
  so a bundle can never hold what a creator could not make by hand.

### 2. Move links (decision (k))

A move link is `/m/<slug>/<nonce>`, pinned by the creator wherever their old audience is.

- **The nonce** is 128 random bits from the CSPRNG, base64url-encoded. The database stores only its
  SHA-256 (`move_links.nonce_hash`); the full link is shown once at creation. `links.resolve` hashes
  the presented nonce and looks it up by `(channel, nonce_hash)`, accepting only a row that is not
  revoked and not expired.
- **Why no signature.** Only the instance that minted a link ever verifies it, so a database lookup
  is all the "signed" in the spec needs. A hash at rest means a database read does not hand out
  working links, and 128 bits cannot be guessed.
- **Limits.** At most `MOVE_LINK_RULES.maxActive` (10) unrevoked links per channel, enforced by a
  trigger (AGENTS.md rule 9), and `MOVE_LINK_RULES.perDay` (20) created per channel per day, a rate
  limit. Links can be revoked and can carry an optional expiry.
- **Attribution.** A follow made through a live link records `follows.source = 'move_link'` and
  `follows.move_link_id` (set null if the link row goes). Only a **new** follow is attributed: an
  existing follower who clicks the link is not counted again, and a revoked or expired link still
  lets the visitor follow but attributes nothing. Other follows are `direct`; `import` is reserved
  for future importers.
- **Conversions** count only non-excluded follows, so integrity exclusion (bot follows) removes a
  link's fake conversions as it removes fake followers.
- **`channels.follower_count`** is maintained by a trigger from this batch on (decision (aa)): the
  count of non-excluded follows, updated on insert, delete and `excluded_at` changes, recounted
  once by the migration. The application no longer writes it.

### 3. "Tell me if they move" grants and the moved notice (decisions (l), (m))

- **Grants.** A viewer opts in per followed channel (`follow_portability_grants`, primary key
  `(user, channel)`, cascading with the user and the channel). The creator never sees the list, the
  count of grant holders, or any address.
- **Moving.** `portability.move.set` takes an https URL (no userinfo, a length cap from the
  contract) and sets `channels.moved_to` and `moved_at`, writing the internal `channel.moved` event
  in the same transaction. The outbox hook (`b7JobsFor`) maps it to `PORTABILITY_JOBS.moved`.
- **One email, then the grants are gone.** The job sends each grant holder **one** `channelMoved`
  email, on the new unsubscribe list `moved`, with the List-Unsubscribe header, and deletes those
  grants. Clearing the move (`move.clear`) sends nothing; setting a new destination later reaches
  only the grants made since.
- **The channel page** shows a "moved to" notice with an external-link note.
- **Subscriptions are untouched (decision (m)).** A move does not end, pause or refund a
  subscription. Prorated refunds need finance rules and live money, so they are deferred to M1; the
  notice and the studio page say that subscriptions continue until the streamer ends them.

### 4. The signed standing statement (decision (n))

A bundle exported from CommonAir carries a statement of the channel's moderation standing, so that
moving is not a way to shed a suspension.

- **Key.** Ed25519, `PORTABILITY_SIGNING_KEY` (`__generate_ed25519__`, written by `init-env`),
  loaded by the **worker only**, as the attestation key is (ADR 0014 decision 1). The worker
  publishes its public key and `kid` (`deriveKid`: the first 16 bytes of SHA-256 of the raw public
  key, base64url) to `portability_signing_keys` at start. The API serves the key history at
  `/.well-known/commonair-portability`: each key's `kid`, public key, creation time and retirement
  time. A retired key keeps verifying statements it signed.
- **Fields** (`packages/tokens/src/standing.ts`, with vectors in `packages/tokens/vectors.json`
  under `standing`): `v` (1), `kid`, `issuer` (the exporting instance's domain), `channelId`,
  `issuedAt`, `expiresAt` (`issuedAt` + 30 days), `activeSuspension` (boolean), `legalHold`
  (boolean), `upheld` (counts of upheld platform actions in the last 12 months, by tier: `t0`,
  `t1`, `t2`) and `dmcaStrikes` (count in the same window). Integers and booleans only, no floats.
- **No personal data.** Ids, counts and booleans; no names, reasons, free text or user ids other
  than the channel id (ADR 0004).
- **Envelope.** `{ payload, signature }`, both base64url, the shape of receipts and attestations.
  The signed bytes are the JSON of the Zod-parsed statement in schema key order. A verifier checks
  the signature over the bytes first and parses after, so no JSON canonicalization is needed. It is
  its own file, not part of the attestation code, and the SDK does not inline it.
- **What it proves, and what it does not.** It proves what the issuing instance said about the
  channel on that instance at `issuedAt`. It does not bind the person importing it, and a hostile
  instance can sign anything about its own channels; a destination that does not trust the issuer
  treats it as unverified. Destination moderation is unchanged either way.

### 5. Import gates (decision (o))

`imports.upload` presigns an upload to `incoming/`; `imports.preview` parses the bundle, checks the
statement and stores a preview (public data only) with per-item choices; `imports.start` queues
`PORTABILITY_JOBS.import`, whose job calls `applyBundle`.

- **Statement check, in the worker.** The issuer's key is fetched from
  `https://<issuer>/.well-known/commonair-portability` through the SSRF guard
  (`resolveCallback`); the API never fetches it.
- **Refused:**
  - a bundle whose statement verifies and says `activeSuspension` or `legalHold`;
  - an import by an account under an active local legal hold;
  - an import into a channel that is suspended here.
- **Imported, marked "standing not verified"**: a bundle whose statement is missing, expired,
  signed by an unknown `kid`, or fails to verify. The mark is on the preview and on
  `portability_imports.standing_verified`. Twitch bundles never carry a statement (ADR 0031
  decision 3).
- **Upheld counts** are shown in the preview but refuse nothing: they are history, not a current
  restriction.
- **Applying.** Channel fields go through the same validation as a studio edit; an import never
  clears an existing `mature` label, and `mature: true` sets it. The category maps by slug, then by
  exact name, else stays unset. Panels go through the `setPanels` rules, emotes through the emote
  create rules (a clashing code is skipped and reported; `MAX_EMOTES` holds). The schedule is
  recorded as "carried, not applied". Each item's result (imported, skipped or rejected, with an
  opaque reason) is stored, then `portability.import.finished` is written. A retried job does not
  insert twice.
- **Every image** goes through the upload pipeline (decision 6): magic bytes, PDQ against the hash
  lists with the T0 path, and the classifier at emote or panel thresholds. A refused image is
  skipped with the same opaque reason a direct upload gets.

### 6. The worker reaches the upload pipeline through the API (decision (p))

The import runs in the worker; the pipeline lives in the API. Rather than move the pipeline (and
its T0 hand-off) into a package, the API exposes one internal route, `INTERNAL_ROUTES.uploadCommit`
(`services/api/src/moderation/internal-commit.ts`), behind the `INTERNAL_SECRET_HEADER` check. The
worker writes the fetched or unpacked image to `incoming/` and posts the channel id, user id,
`incoming/` key and `purpose`; the API runs the existing `commitUpload` with that purpose and
answers `{key, url}` or a refusal code. A T0 match is handled exactly as for a user upload. The worker gains
`API_INTERNAL_URL` and `INTERNAL_API_SECRET`. This settles the question ADR 0031 decision 5 left to
the contract step.

## Consequences

- A creator can count real conversions from a move link and tell opted-in viewers once that they
  have moved, without ever holding a viewer's address.
- A channel can leave with its title, panels, emotes and settings; a suspended channel or one under
  legal hold cannot launder its standing through a CommonAir-signed bundle.
- A statement from an unknown or hostile instance carries no weight, and the preview says so.
- `follower_count` stops drifting, at the cost of a trigger on every follow write.
- Subscribers of a moved channel keep paying until the streamer ends their subscriptions; refunds
  on a move wait for M1.
- The worker now calls the API on one internal route. An API outage fails an import job, which
  retries.

## Alternatives considered

- **Signed move links (HMAC or Ed25519).** Rejected: only this instance verifies them, so a
  hashed random nonce does the same with no key to rotate.
- **Give the creator a follower list or email export.** Rejected: it hands personal data to a
  third party without the viewer's per-channel consent, and makes an instance a list-building tool.
- **Email every follower on a move.** Rejected: a follow is not consent to email.
- **Prorated refunds on a move now.** Deferred (decision (m)): finance rules and live money first.
- **Refuse any bundle without a verified statement.** Rejected: it would block every Twitch import
  and every move from an instance that is down; "not verified" is shown instead.
- **Move `commitUpload` into `packages/moderation`.** Rejected for now: two services would run the
  pipeline and the T0 hand-off, and one could drift.

## Decisions at acceptance

For the maintainer. Each item is the recommended default; accepting this ADR accepts them.

1. **Bundle (j):** one v1 schema in `@commonair/contracts/portability`, shared with the Twitch
   import; the schedule carried, never applied.
2. **Move links (k):** 128-bit nonce stored as SHA-256; 10 active per channel (trigger), 20 per
   day; revocable; only new follows through a live link are attributed; conversions exclude
   excluded follows.
3. **Grants (l):** per channel, invisible to the creator; one `channelMoved` email on the `moved`
   list, then the grants are deleted.
4. **Subscriptions (m):** untouched by a move; refunds deferred to M1. Post-launch review.
5. **Standing statement (n):** Ed25519, worker-only key, 30-day validity, the fields of decision 4
   and no personal data. Post-launch review of its content.
6. **Import gates (o):** refuse a verified `activeSuspension` or `legalHold`, a local legal hold on
   the importer, a suspended channel; import anything else, unverified statements marked as such.
7. **Internal upload route (p):** the worker calls `uploadCommit` on the API.
8. **Follower count (aa):** trigger-maintained.
