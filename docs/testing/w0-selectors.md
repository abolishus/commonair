<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W0 web ↔ harness contract (VOD exposure, media clock, statements of reasons, integrity)

The W0 units (W0-media-exposure, W0-clock, W0-sor, W0-integrity) and their harness scenarios
agree on these rules, routes and `data-testid` values. Sources:
[ADR 0009 amendment 1](../decisions/0009-public-media-route.md#amendment-1-vod-objects-stay-private-until-published)
(VOD objects stay private until published), [ADR 0012](../decisions/0012-media-clock.md) part 1
(media clock) and [ADR 0019](../decisions/0019-statement-of-reasons.md) (statements of reasons).
This file extends [e1](e1-selectors.md) to [e7](e7-selectors.md), and everything in those still
holds. Changing anything here is a contract change: update this file, the units' code and the
scenarios together. Tests select elements by `data-testid`, never by visible text. Counsel has not
reviewed ADR 0019 or the notice text; nothing here says otherwise.

## Rules (a reviewer marks any breach HIGH)

- **Only public and playable VODs live under `vods/`.** After the `vod-placement` job ran, no
  object of a VOD whose `vodPlacement` (`@commonair/contracts/storage`) is not `public` is under
  `vods/<id>/`: recording, processing, `subscribers`, `private`, removed (any `removed_reason`,
  `dmca` included), T1-restricted broadcast or suspended channel. They live under
  `recordings/<id>/`, which no public route serves. NCII-hidden, DMCA-hidden and deleted VODs are
  left where their own flow put them (`leave`).
- **Both VOD routes check state before storage.** `/media/vods/<id>/…` answers only when the VOD
  is public and playable; `/vod/<id>/…` only when it is not removed, not restricted and the token
  is valid. The check is cached per VOD for at most 5 s per origin instance.
- **A VOD token never authorizes `/hls` or a relay.** Its `PlaybackClaims.path` is
  `vodTokenPath(id)` = `vod/<id>`, which no MediaMTX path equals; `src = "origin"`; lifetime the
  VOD's duration plus one hour, capped at `VOD_TOKEN_MAX_TTL_SECONDS` (12 h), no refresh.
- **No statement for channel moderation.** A `mod_actions` row with `scope = 'channel'` (chat
  bans, timeouts, message deletions) never produces a statement of reasons. Selection is by the
  audit action names in `ENFORCEMENT_SOURCE_ACTIONS` only.
- **Statements carry ids, enums, times and catalog codes only**: no free text (the moderator's
  note is joined on read from `moderation_cases.resolution_note`, never stored), no exact score
  (the governance threshold in force instead), no NCII requester identity, no hash, match
  distance or hash-list provider identifier.
- **The statement table is append-only** for every role (trigger), and the app role holds no
  UPDATE or DELETE on it. Delivery state lives in `enforcement_statement_deliveries`, with an
  error code, never provider text or an address.
- **A published legal document is immutable** (`published_at <= now()`), so a statement's pinned
  `documents.noticeId` and `documents.guidelinesId` always name the text it was sent under.

## Flows

### Statements of reasons (ADR 0019 decision 3)

One row per source audit action. "Automated" is `automatedDetection` / `automatedDecision`. The
appeal subject is what the statement's `appeal` tells the client to pass to `appeals.create`
(kind `moderation`).

| Source audit action                                       | Statement                   | Restriction (`kind` / `detail`)                     | Fact code                            | Source           | Automated       | Appeal subject       |
| --------------------------------------------------------- | --------------------------- | --------------------------------------------------- | ------------------------------------ | ---------------- | --------------- | -------------------- |
| `moderation.t1.restrict`                                  | yes                         | `visibility` / `restricted`                         | `classifier` (`tier` `t1`)           | `own_initiative` | `true`/`fully`  | `moderation_case`    |
| `moderation.t1.flag` (case already open)                  | no                          | (adds a flag only)                                  |                                      |                  |                 |                      |
| `moderation.t2.label`                                     | yes                         | `visibility` / `age_gated`                          | `classifier` (`tier` `t2`)           | `own_initiative` | `true`/`fully`  | `content_label`      |
| `moderation.t1.upload_reject`                             | yes                         | `visibility` / `removed`                            | `classifier` (`tier` `t1`)           | `own_initiative` | `true`/`fully`  | `moderation_case`    |
| `moderation.case.warn`                                    | yes                         | `warning` / `none`                                  | `moderator_review`                   | `own_initiative` | case origin¹    | `moderation_case`    |
| `moderation.case.end_stream`                              | yes                         | `visibility` / `removed`                            | `moderator_review`                   | `own_initiative` | case origin¹    | `moderation_case`    |
| `moderation.case.suspend`                                 | yes, one per target         | `account` or `service` / `suspended`, with `endsAt` | `moderator_review`                   | `own_initiative` | case origin¹    | `moderation_case`    |
| `moderation.case.clear`, `moderation.case.escalate_legal` | no                          | (a lift, or a hand-off to T0)                       |                                      |                  |                 |                      |
| `ncii.decide` with `removed`                              | yes, one per affected owner | `visibility` / `removed`                            | `ncii_notice`                        | `notice_art16`   | `false`/`not`   | `ncii_request_item`  |
| `ncii.decide` with `rejected`                             | no                          | (nothing restricted)                                |                                      |                  |                 |                      |
| `ncii.auto_hide`                                          | yes, one per affected owner | `visibility` / `disabled`                           | `ncii_notice`                        | `notice_art16`   | `false`/`fully` | `ncii_request_item`  |
| `moderation.t0.match`, CSAM list                          | no (counsel to confirm)     |                                                     |                                      |                  |                 |                      |
| `moderation.t0.match`, NCII list (`details.listCategory`) | yes, ground `illegal.ncii`  | `account` / `suspended`, `endsAt` null              | `hash_match` (`listCategory` `ncii`) | `own_initiative` | `true`/`fully`  | none (`appeal` null) |
| any `mod_actions` row with `scope = 'channel'`            | never                       |                                                     |                                      |                  |                 |                      |

¹ A moderator decision on a classifier-origin case is `true`/`not`; on a human-origin case
`false`/`not`. Every statement has `restriction.territorialScope = "all"`. Report resolutions and
admin suspensions get statements in W2, not W0.

### VOD states (ADR 0009 amendment 1 decision 3)

`/media/vods/…` is the public route (`vods/` prefix); `/vod/…` is the token route (`recordings/`
prefix). "404" is the state check refusing before storage is read; a missing or invalid token on
`/vod/…` is refused as on `/hls` (401/403).

| VOD state                                               | `vodPlacement` | Objects under             | `/media/vods/<id>/…` | `/vod/<id>/…` (valid token)                   |
| ------------------------------------------------------- | -------------- | ------------------------- | -------------------- | --------------------------------------------- |
| recording                                               | `private`      | `recordings/<id>/`        | 404                  | no token is minted (no playable URL)          |
| processing                                              | `private`      | `recordings/<id>/`        | 404                  | no token is minted (no playable URL)          |
| ready, `public`                                         | `public`       | `vods/<id>/`              | 200                  | not used (the API returns the `/media` URL)   |
| ready, `subscribers`                                    | `private`      | `recordings/<id>/`        | 404                  | 200 for a subscriber's (or the owner's) token |
| ready, `private`                                        | `private`      | `recordings/<id>/`        | 404                  | 200 for the owner's token                     |
| owner-removed (`removed_reason` set)                    | `private`      | `recordings/<id>/`        | 404                  | 404 (a token minted before removal too)       |
| broadcast T1-restricted                                 | `private`      | `recordings/<id>/`        | 404                  | 404                                           |
| channel suspended                                       | `private`      | `recordings/<id>/`        | 404                  | 404                                           |
| NCII hidden                                             | `leave`        | `moderation/ncii-hidden/` | 404                  | 404                                           |
| DMCA hidden (`removed_reason = 'dmca'`, objects hidden) | `leave`        | `moderation/dmca/`        | 404                  | 404                                           |
| deleted                                                 | `leave`        | (none)                    | 404                  | 404                                           |

`vods.update` (visibility) and `vods.remove` enqueue `vod-placement { vodId }` after commit; every
other state change is picked up by the one-minute `vod-placement` sweep. The ops test hook runs a
sweep on demand (`OPS_TICK_JOBS` `vod-placement`).

## Routes

| Route                                     | Purpose                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET\|HEAD /vod/<vodId>/<file>?t=<token>` | New, origin (Caddy `handle /vod/*`): a non-public VOD's playlist, segments and thumbnail from `recordings/`; the playlist is rewritten so each URI carries the token; `cache-control: private`; no integrity or receipt samples |
| `GET /me/enforcement`                     | New, API (`me.enforcement.list`): the caller's statements of reasons, newest first, keyset cursor on `(created_at, id)`; readable while suspended                                                                               |

## Appeals

- **`ncii_request_item`** (new `APPEAL_SUBJECTS` value, kind `moderation`): an NCII request item
  that was removed or auto-hidden, whose broadcast, VOD, clip or upload is on a channel the
  appellant owns (or a clip they made). Anyone else, and an item that restricted nothing, gets
  NOT_FOUND. Overturning records the decision only (restoring content is a manual staff step);
  the NCII requester is never told who appealed; the request's decider cannot resolve it.
- **`appeals.create` while suspended** stays allowed (`whileSuspended`, E7), so every statement's
  redress line names a route that works.

## Data export

The account export gains `enforcement_statements.json` (W0-sor, `services/worker/src/exports/collectors.ts`):
the requester's own statements, with the decision 4 columns only (no joined moderator note, no
reversal computed on read). It sits next to e6-selectors' "Data export" files.

## Test ids

### Statements of reasons (`/settings/appeals`, above `MyAppeals`)

| Test id                    | Element / meaning                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enforcement-list`         | Wrapper; `enforcement-empty` (`<EmptyState>`) when there are none                                                                                                                                                                                 |
| `enforcement-statement`    | One statement: `data-statement-id`, `data-source-action` (`ENFORCEMENT_SOURCE_ACTIONS`), `data-restriction-kind`, `data-restriction-detail`, `data-clause-id`, `data-clause-version`, `data-automated-decision`, `data-reversed` (`true`/`false`) |
| `enforcement-appeal-open`  | Opens the existing appeal dialog prefilled from `appeal`; absent when `appeal` is null or `appealId` is set                                                                                                                                       |
| `enforcement-draft-notice` | Shown when `noticeIsDraft` (the notice text was an unreviewed draft when the statement was made)                                                                                                                                                  |

## Scenarios

- **`clock-skew`** (new, W0-clock; not in `full` until it merges): cross-rendition skew p95
  < 100 ms and live-to-VOD skew p95 < 250 ms. Metrics `crossRenditionSkewP95Ms`,
  `liveToVodSkewP95Ms`; with `--set assert=false` it records them as data `baseline` and asserts
  nothing.
- **`trust-safety` step 10 (VOD exposure).** `/media/vods/<id>/…` answers 404 for a recording VOD,
  a `subscribers` VOD and a just-removed VOD; `/vod/<id>/…` plays for the subscriber with their
  token and refuses that token after removal (within 5 s); after a `vod-placement` ops tick no
  object of those VODs is under `vods/`. A VOD token is refused on `/hls`. Runs on its own.
- **`trust-safety` step 11 (statements of reasons).** Needs steps 4–7 (`withPrerequisites` adds
  them). Every allowlisted audit action those steps produced (T2 label, T1 restriction, upload
  rejection, NCII removal or auto-hide) has a statement for the affected user, visible on
  `/settings/appeals` (`enforcement-statement` with the matching `data-source-action`) and through
  `me.enforcement.list`; a channel ban or timeout in the run produced none; the statement email
  arrived; an owner-run `UPDATE`/`DELETE` of a statement is refused.
- **`integrity-basic`** (W0-integrity) new cases: a fetch-less bot is excluded; a CDN bot under
  the `cdn` profile is judged (`fetch_unjudged`); the false-positive fixtures stay verified.
