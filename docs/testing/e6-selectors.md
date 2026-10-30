<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E6 web ↔ harness contract (Phase 4 completion)

Milestone E6 finishes Phase 4 ([PLAN.md](../../PLAN.md)). A streamer simulcasts to a mock RTMP
target and frames arrive. A tip shows up as an alert on the streamer's overlay, which a scoped,
optionally expiring token opens. Owners rename, re-scope and delete VODs and clips. A user
exports their data and gets a signed link by email; the archive holds nothing of anyone else.
A deleted account leaves its ledger, audit and history rows in place with no personal data in
them. A WAL-G backup restores into an empty Postgres with every trigger in place and the ledger
balanced. The load test reaches the PLAN size on demand. `full` runs every Phase 4 scenario, and
its `no-proprietary` run passes with only the stated skips. Policy:
[ADR 0021](../decisions/0021-e6-operations-policies.md). Data model and pseudonymization:
[ADR 0004](../decisions/0004-governance-enforcement.md). Tooling: ADR 0003 (WAL-G, MediaMTX).
This file extends [e1](e1-selectors.md) through [e5](e5-selectors.md), and everything in those
still holds.

Changing anything here is a contract change: update this file, `services/api`,
`services/worker`, `apps/web`, `packages/ui` and the scenarios together. Tests select elements
by `data-testid`, never by visible text. Amounts in `data-*` attributes are integer cents.

## Rules every unit honors (a reviewer marks any breach HIGH)

- **An export holds only the requester's own data.** Every row is selected by the requester's
  id (or their channel's id, for a channel export). Another person never appears by id, email,
  username, display name, message text, IP or payment detail; where the requester acted on a
  public channel (follow, subscription, tip, chat), that channel appears by its public slug. No
  secret goes in: password hashes, 2FA secrets, passkey material, OAuth tokens, stream keys,
  simulcast keys, webhook secrets, bot/overlay/API token values or hashes, evidence or
  moderation frames. A query that could return another user's row is HIGH even if the test data
  hides it.
- **An export link is scoped and expires.** The presigned GET is for that one object key
  (`exportObjectKey(userId, exportId)`) and expires at the export's `expires_at`
  (`EXPORT_TTL_SECONDS` after completion). `me.exports.list` returns only the caller's exports and
  a `downloadUrl` only while `status = ready` and `expires_at` is in the future. After expiry the
  object is deleted and the status is `expired`.
- **An overlay token grants its overlay and nothing else.** It authenticates only
  `interact.overlays.state` and `OVERLAY_EVENTS_PATH`, for its own channel. Any other procedure
  presented with it treats the request as anonymous. Expired or revoked tokens are refused, and
  an open stream closes within 30 s of revocation or expiry. Only the token's SHA-256 is stored;
  the value is returned once. A frame never carries data the overlay does not display (no payer
  id, no email, no anonymous tipper's name).
- **Deletion keeps history and drops identity (ADR 0004).** Ledger, payment, audit, governance
  and `*_history` rows survive and still reference the user by id; none of them, and no `events`
  or `webhook_deliveries` row, holds the user's email, username, display name or free text after
  deletion. Held data (E4c) is never touched.
- **A restore must bring the triggers back.** The drill compares the full trigger set, the
  protection functions and the app role's grants before and after; a restore that loses any of
  them, or a ledger that no longer balances, fails the scenario.
- **Database-first, outbox and audit as before.** VOD/clip removal, export requests and overlay
  token changes write their `audit_log` row (`vod.update`, `vod.remove`, `clip.remove`,
  `export.request`, `overlay.token.create`, `overlay.token.revoke`; details ids/enums only) in the
  same transaction as the change. No secret, token, email or URL with a signature in logs.
- **Simulcast keys never leave the media process in plain text.** Not in API responses, logs,
  events, harness reports or test output.

## Simulcast

Built in E2/E3 (`stream.simulcast.*`, `services/media/src/simulcast.ts`); E6 adds the studio UI
and the scenario.

| Flow   | Who   | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manage | owner | `/dashboard` simulcast section: list targets (name, platform, URL, enabled, live status, last error code), add (name, platform, `rtmp(s)://` URL, key), enable/disable, remove (`<ConfirmDialog>`). The key field is write-only; the list never shows it. Up to 5 targets (`MAX_SIMULCAST_TARGETS`). URL refusals show a reason in `simulcast-error` `data-reason`: `format` / `credentials` (checked in the browser), `url` (the API's generic `BAD_REQUEST`), `simulcast_limit` (`PRECONDITION_FAILED`), else the error code or `network` |
| Push   | media | Unchanged: when the channel goes live, media pushes each enabled target with `-c copy` and reports `KEYS.simulcastStatus`. `stream.simulcast.list` shows `status` `live` within 20 s of going live                                                                                                                                                                                                                                                                                                                                          |

The harness stack's `mock-rtmp` service (`infra/mediamtx/mock-rtmp-target.yml`, profile
`harness`) is the target: `rtmp://mock-rtmp:1936/live` with the run's key, readable by the
harness at `rtmp://localhost:${MOCK_RTMP_PORT:-1936}/live/<key>`. Private addresses are allowed
only by `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` (api and media, `harness/compose.e6.yaml`).

## Overlays and alerts

| Flow           | Who                       | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configure      | owner                     | `interact.alerts.list` returns one `AlertConfig` per `ALERT_TYPES` entry (defaults for unset types: disabled, i18n default message, min 0, 6000 ms, `fade`). `interact.alerts.set` upserts `alert_configs` (unique channel+type), audit `alert.update`. E6 renders text and animation only: a template with `imageKey` or `soundKey` is `BAD_REQUEST` until alert media uploads exist. Raid alerts can be configured but fire only once raids exist (E8, docs/testing/e8-selectors.md)                                                                                                                                                                                                                                                                                                                                      |
| Create token   | owner                     | `interact.overlays.token({ channel, expiresAt? })`. `expiresAt` absent or null: no expiry; else it must be in the future (`BAD_REQUEST`), no upper cap. One transaction: revoke the channel's unrevoked token (if any), insert the new hash (`overlay_tokens_active_uq` guarantees one), audit `overlay.token.create` (details `{ expires: boolean }`). Returns the token once and the URLs: `alertsUrl` = `${PUBLIC_URL}/overlay/alerts?token=…`; `goalsUrl` and `chatUrl` likewise (`/overlay/goals`, `/overlay/chat`; goals and the chat overlay are built in E8, see docs/testing/e8-selectors.md)                                                                                                                                                                                                                      |
| Status, revoke | owner                     | `overlays.status` → `{ active, createdAt, expiresAt }` (active = unrevoked and not expired). `overlays.revoke` sets `revoked_at`, audit `overlay.token.revoke`, and publishes on `BUS.overlay(channelId)` so open streams close at once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| State          | overlay token             | `interact.overlays.state` → `{ channelSlug, alerts, goals, eventsUrl }` (`goals: []` in E6; E8 fills the open goals, see docs/testing/e8-selectors.md); `eventsUrl` = `${API_PUBLIC_URL}${OVERLAY_EVENTS_PATH}?token=…`. 401 for an unknown, revoked or expired token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Alert stream   | overlay token             | `GET OVERLAY_EVENTS_PATH?token=` (SSE). The API subscribes to `BUS.events` (one shared subscriber per process) and `BUS.overlay(channelId)`; for the token's channel it maps `channel.tip` → `tip`, `channel.follow` → `follow`, `channel.subscribe` (not gifts: `is_gift` subscriptions raise no alert) and `channel.subscription.gift` (once per gift) → `subscription` and emits an `alert` frame (`OverlayAlert`) when that type is enabled and the amount (tips) is at least `minAmountCents`. `${user}` is the supporter's display name, or the i18n "Anonymous" when `is_anonymous`; `${amount}` is `formatMoney` in the instance locale. `ping` every 15 s. The token is re-checked at least every 30 s and on every `BUS.overlay` revoke message; when it no longer resolves the server sends `revoked` and closes |
| Test alert     | owner                     | `interact.alerts.test({ type })` publishes an `OverlayAlert` with `test: true` and sample values on `BUS.overlay(channelId)`; rate-limited `write`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Overlay page   | OBS / anyone with the URL | `/overlay/alerts?token=` renders with a transparent background and no app chrome; it loads the state, opens an `EventSource` on `eventsUrl`, queues alerts (one at a time, each for `durationMs`, de-duplicated by id), honors `prefers-reduced-motion` (animation `none`). On `revoked` or a 401 it stops and shows nothing visible (`data-state="refused"`). The token stays out of logs and the `Referer` (`<meta name="referrer" content="no-referrer">`)                                                                                                                                                                                                                                                                                                                                                               |

Polls, predictions, raids and goals stay 501 in E6 (ADR 0021); E8 builds them (docs/testing/e8-selectors.md).

## VODs and clips

| Flow        | Who                                                                                          | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update VOD  | owner                                                                                        | `vods.update({ id, title?, visibility? })`: `NOT_FOUND` for a removed VOD or another owner's (no existence leak); updates the row, audit `vod.update`. `private` VODs are listed and playable only for the owner; `subscribers` only for the owner and active subscribers of the channel                                                                                                                                                                                          |
| Remove VOD  | owner                                                                                        | `vods.remove({ id })`: one transaction sets `removed_reason = 'owner'`, `expires_at = now()` and removes the broadcast's clips the same way (`clips.removed_reason = 'owner'`), audit `vod.remove`. Lists and `get` treat it as gone at once. The worker's `vod-retention` deletes the objects (VOD prefix, thumbnails, clip objects) and sets `status = deleted`, **unless the channel owner has an active legal hold**: then the objects stay and the run counts them as `held` |
| Remove clip | the channel's owner, editors and moderators (`'owner'`), or the clip's creator (`'creator'`) | `clips.remove({ id })`: `removed_reason = 'owner'` (or `'creator'`), audit `clip.remove`; a clip follows its source VOD's visibility and removal; `vod-retention` deletes its objects (same hold rule) and sets `status = deleted`                                                                                                                                                                                                                                                |

Migration `0022_e6_ops.sql` adds `vods_broadcast_idx` (the clip backstop and "remove a VOD's
clips" look VODs up by broadcast).

## Data export

| Flow    | Who    | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request | user   | `me.exports.create({ kind })`. `channel` needs a channel the user owns (`PRECONDITION_FAILED` otherwise). A `queued`, `running` or `ready` export of that kind created less than `EXPORT_COOLDOWN_SECONDS` ago → `RATE_LIMITED` (`retryAfterSeconds`). One transaction: `data_exports` (`queued`), audit `export.request` (details `{ kind }`). After commit: enqueue `EXPORT_JOBS.build` on `QUEUES.exports` with `jobId = exportId`                                                                                                                                                                                                                                                                                                    |
| Build   | worker | `running` → collect the files below in a read-only repeatable-read transaction → zip (fflate) → upload to `S3_BUCKET_EXPORTS` at `exportObjectKey(userId, exportId)` → one transaction: `ready`, `size_bytes`, `completed_at`, `expires_at = completed_at + EXPORT_TTL_SECONDS` → email `dataExportReady` (`@commonair/email`) to the user's current address with a presigned GET (public endpoint, expiry = `expires_at`; the template declares `downloadUrl` in `storageLinks`, so the mailer accepts the configured storage origin for that field only). A row left `running` by a crashed build is reclaimed. A failure sets `failed` with a stable error code (no free text) and emails nothing; BullMQ retries 3 times before that |
| List    | user   | `me.exports.list`: the caller's exports, newest first; `downloadUrl` presigned fresh (same key, expiry = `expires_at`) only while `ready` and unexpired                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Expire  | worker | `EXPORT_JOBS.cleanup` hourly (and via the ops tick): for `ready` exports past `expires_at` delete the object, set `expired`. Account deletion deletes the user's export objects and rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Archive (`formatVersion` `EXPORT_FORMAT_VERSION`), one JSON file per entry, each an array of
objects unless noted. Timestamps ISO 8601 UTC; amounts integer cents with `currency`.

| File                                  | Kind    | Contents (the requester's own rows only)                                                                                                                                                                                              |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json` (object)              | both    | `{ formatVersion, kind, exportId, userId, generatedAt, files: [{ name, rows }] }`; `rows`: an array's elements; an object without arrays is 1; an object with arrays counts their elements, plus 1 if it also holds a non-array value |
| `account.json` (object)               | account | id, username, displayName, email, emailVerified, locale, role, createdAt, 18+ confirmation time, 2FA enabled (boolean), passkey count                                                                                                 |
| `sessions.json`                       | account | own sessions: createdAt, expiresAt, userAgent, ipAddress (their own)                                                                                                                                                                  |
| `connections.json`                    | account | linked sign-in providers: provider id, createdAt (no tokens)                                                                                                                                                                          |
| `follows.json`                        | account | channelSlug, followedAt                                                                                                                                                                                                               |
| `subscriptions.json`                  | account | as subscriber: channelSlug, tier, status, current period, isGift (the gifter is not named)                                                                                                                                            |
| `payments.json`                       | account | payments they made: id, kind, channelSlug, amount, currency, status, createdAt, refunds/chargebacks of those payments                                                                                                                 |
| `tips.json`                           | account | tips they sent: channelSlug, amount, currency, their message, anonymous flag, createdAt                                                                                                                                               |
| `chat.json`                           | account | their own chat messages: channelSlug, body, createdAt, deleted flag                                                                                                                                                                   |
| `coop.json` (object)                  | account | memberships, shares, their votes (with their own choice), proposals and comments they wrote, their patronage statements                                                                                                               |
| `safety.json` (object)                | account | reports they filed (reason, status, createdAt; no target), their appeals, labels and platform actions on them (action, reason code, createdAt; no staff id), channel bans on them (channelSlug, action, createdAt)                    |
| `enforcement_statements.json`         | account | statements of reasons about them (ADR 0019, W0-sor): the stored decision 4 columns (action, content, restriction, facts, ground and clause, automated flags, appeal subject, createdAt); no moderator note, reversal or deliveries    |
| `notifications.json`, `consents.json` | account | their rows                                                                                                                                                                                                                            |
| `developer.json` (object)             | account | their OAuth apps, bot tokens and webhooks: names, scopes, URLs, createdAt (no secrets, token values or hashes)                                                                                                                        |
| `interact.json` (object)              | account | their channel points balances and history, poll votes, prediction bets and song requests (ids, amounts, timestamps)                                                                                                                   |
| `blocks.json`                         | account | users they blocked (W1): the blocked user's username, blockedAt                                                                                                                                                                       |
| `channel.json` (object)               | channel | settings, title, description, category, panels, chat settings, alert configs, simulcast targets (name, platform, URL, no key)                                                                                                         |
| `vods.json`, `clips.json`             | channel | the channel's VODs and clips: id, title, visibility, status, duration, createdAt (clips by others: no creator)                                                                                                                        |
| `revenue.json`                        | channel | per payment to the channel: date, kind, gross/fee/tax/net, currency, status (no payer)                                                                                                                                                |
| `payouts.json`                        | channel | payout batches and lines for the owner                                                                                                                                                                                                |
| `moderation-actions.json`             | channel | actions the channel took: action, createdAt (no target)                                                                                                                                                                               |

Not exported: other people's chat in the channel, follower and subscriber lists, viewer data.

## Account deletion (additions)

E4c built the flow (`services/worker/src/deletion`). E6 adds to the completion transaction:
delete `events` rows whose payload references the user's id (published or not; delivered copies
are the receivers'), delete `webhook_deliveries` rows referencing it, null the user's free text
in retained non-append-only rows (`tips.message`), delete the user's exports (rows and objects,
after commit like media). The objects still to delete are recorded in
`account_deletions.pending_objects` (migration 0023) and retried by every deletion run: export
archives always, media only while the user has no active legal hold (re-checked under
`lockLegalHold`, which placing a hold also takes), so held media is deleted after release. The completion and the scheduled emails (`accountDeletionScheduled`,
`accountDeletionCompleted`) are sent: scheduled on request (API), completed to the address on
file before pseudonymization (worker, sent after commit; the address is read in the transaction
and never stored).

`/settings/privacy` (new) holds the export panel and the deletion panel (request with
`<ConfirmDialog>`, scheduled date, cancel while scheduled).

## Backup and restore drill

Tooling: WAL-G in our Postgres image (ADR 0003): `commonair-backup` (`backup.sh`) and
`commonair-restore` (`restore.sh`). The drill never touches the running stack (ADR 0021):

1. Start `commonair-drill-<runId>` from the stack's Postgres image on the compose network, with
   its own volume and `WALG_S3_PREFIX=s3://${S3_BUCKET_BACKUPS}/drill/<runId>` (same Garage key
   as the stack's backups), archiving on.
2. Migrate it (`@commonair/db` migrate as owner, then the app role) and seed through the app role:
   the demo seed plus 20 balanced ledger transactions posted with `@commonair/ledger` `post`.
3. Fingerprint: every non-internal trigger (`table`, `name`, `enabled`), the protection
   functions (`proname`, md5 of `prosrc`), the app role's table grants, per-table row counts, and
   an ordered md5 of `ledger_entries`.
4. `commonair-backup`; then post one more transaction (the WAL-replay marker) and
   `select pg_switch_wal()`; wait for it to be archived.
5. Stop the container, remove its volume, create an empty one, run `commonair-restore` into it,
   start Postgres and wait until `pg_is_in_recovery()` is false.
6. Check: fingerprint equal to step 3 plus the marker; every ledger transaction sums to 0; as the
   app role an `UPDATE`/`DELETE` on `ledger_entries` and `audit_log`, an unbalanced posting and a
   direct `proposals.status = 'passed'` write are all refused.
7. Clean up: remove the container and volume, delete the `drill/<runId>` prefix.

## Load test

`load-smoke` (2 × 10, in `full`) is unchanged. `load-plan` (not in `full`, ADR 0021) defaults to
`streamers=20 viewersPerStreamer=200 seconds=120 browserViewers=20` (all `--set`-able), and may
spread HTTP viewers over several harness processes. It reports origin egress (bytes/s, total and
per viewer, by source), CPU per container (average and max), p95 glass-to-glass latency, p95
time to first frame, stall ratio and stall count, and errors, as the run report's `load` section.
Hard assertion: every viewer started. Soft checks: stall ratio < 5 %, p95 latency < 15 s, no
errors.

## `full` and the `no-proprietary` profile

`full` = every scenario except `load-plan`, `smoke` first and `e2e-relay` last, on the harness
stack (`bun scripts/infra.ts stack --harness`; its Postgres volume created with the E5 bootstrap).
`e5-coop`, `trust-safety` and `e2e-relay` join it. `--profile no-proprietary` first checks that
the stack runs without Stripe, OAuth providers and a CDN (the API's `/healthz` reports the
booleans `stripe`, `oauth`, `cdn` and `opsTestHooks`; the run fails if any of the first three is
true), then skips only scenarios or steps whose `needs` include
`stripe`, `oauth` or `cdn`, each with its reason in the report. Expected skips: none of the
scenarios; the Stripe variant of `e4b-money` (`--set provider=stripe`) is the only skipped step.

Phase 4 items already covered: tmi.js bot (`e2e-social`), viewbot swarm excluded
(`integrity-basic`, `e2e-relay`), over-reporting relay caught (`e2e-relay`), chargeback clawback
(`e4b-money`). The SDK bot joins `e2e-social` (below).

Selector conventions added by the `packages/ui` blocks: a select's options are
`<field test id>-option-<value>` (`overlay-expiry-option-7d`, `vod-visibility-option-private`, …);
tabs are `content-tab-vods` / `content-tab-clips`; `overlay-url-value` is the URL input inside
`overlay-url`; `alert-duration` is in seconds with `data-ms`; `simulcast-limit` (cap reached) and
`export-empty` (no exports yet). The deletion request dialog asks for the username
(`deletion-confirm-username`), as `me.deletion.request` requires. The web adds load errors with a
retry (`simulcast-load-error`, `alerts-load-error`, `overlay-token-load-error`,
`content-load-error`, `export-load-error`, `deletion-load-error`), navigation links (`account-privacy-link`, `studio-overlays-link`,
`studio-content-link`) and page wrappers (`overlays-page`, `content-page`, `privacy-page`).

## WHIP audio for WebKit

WHIP ingests carry Opus audio, which MediaMTX muxes into HLS as is and WebKit's native HLS
(Safari, iOS) does not decode. While a source's audio is not AAC and its video is H.264 (or
absent), media publishes `sourceAacPath` (`live/<slug>/aac`: video copied, audio re-encoded to
AAC) and sets `KEYS.sourceAac`: `pending` from the moment it decides a copy is needed (and while
ffmpeg restarts), `1` once the copy produces output. The origin serves the copy wherever clients
request the source, under the same URLs; the `aac` directory itself is not addressable. While
`pending`, the source answers a retryable 503 (`retry-after: 1`), so no WebKit player starts on
Opus. After 20 s still pending, media drops the mark and the original is served, so a copy that
cannot start never makes the stream unwatchable.

Glass-to-glass budgets in `ingest-rtmp` / `ingest-whip` (p50 per engine): 15 s, except WHIP into
WebKit, 20 s. The copy's LL-HLS parts vary in length with WebRTC timing (MediaMTX warns for iOS
clients) and WebKit's low-latency mode degrades on that: measured 10.8 to 17.5 s against about
10 s for RTMP into WebKit and 3 to 6 s for WHIP into Chromium (decided 2026-10-22).

## Routes

| Route                             | Change in E6                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/dashboard`                      | Simulcast section                                                                                  |
| `/overlays`                       | New, studio: alert configuration per type, test alert, overlay URL (expiry choice, rotate, revoke) |
| `/content`                        | New, studio: the channel's VODs and clips (rename, visibility, delete)                             |
| `/settings/privacy`               | New, signed in: data export and account deletion                                                   |
| `/overlay/alerts`                 | New, token in the query: the OBS alert overlay (transparent, no chrome)                            |
| `/overlay/goals`, `/overlay/chat` | New placeholders in E6; built in E8 (docs/testing/e8-selectors.md)                                 |

Studio sidebar gains Overlays and Content; account settings gain Privacy.

## Test ids

### `/dashboard` simulcast

| Test id                                                                  | Element                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `simulcast`                                                              | Section wrapper; `simulcast-empty` `<EmptyState>`                               |
| `simulcast-target`                                                       | One row: `data-target-id`, `data-status` (`SIMULCAST_STATUSES`), `data-enabled` |
| `simulcast-name`, `simulcast-platform`, `simulcast-url`, `simulcast-key` | Add form fields (key is a password input)                                       |
| `simulcast-add`                                                          | Submit                                                                          |
| `simulcast-enabled`                                                      | Switch inside a row                                                             |
| `simulcast-remove`                                                       | Remove inside a row (opens `<ConfirmDialog>`: `confirm-dialog-confirm`)         |
| `simulcast-error`                                                        | Inline error with `data-reason`                                                 |

### `/overlays`

| Test id                                                                                   | Element                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `alert-config`                                                                            | One per type: `data-type`, `data-enabled`                    |
| `alert-enabled`, `alert-message`, `alert-min-amount`, `alert-duration`, `alert-animation` | Fields inside `alert-config`                                 |
| `alert-save`, `alert-test`                                                                | Save / fire a test alert, inside `alert-config`              |
| `overlay-token`                                                                           | Token panel: `data-active`, `data-expires-at` (ISO or empty) |
| `overlay-expiry`                                                                          | Select: `none`, `1d`, `7d`, `30d`, `90d`, `6mo`, `date`      |
| `overlay-expiry-date`                                                                     | Date-time input, shown for `date`                            |
| `overlay-token-create`                                                                    | Create / rotate (rotating opens `<ConfirmDialog>`)           |
| `overlay-url`                                                                             | `<CopyField>` with the alerts URL, shown once after creation |
| `overlay-token-revoke`                                                                    | Revoke (opens `<ConfirmDialog>`)                             |

### `/overlay/alerts`

| Test id              | Element                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `overlay-alerts`     | Root: `data-state` `connecting` / `live` / `refused`                                                |
| `overlay-alert`      | The alert on screen: `data-alert-id`, `data-type`, `data-test`, `data-amount-cents` (empty if none) |
| `overlay-alert-text` | The rendered text; `overlay-alert-message` the supporter's message when shown                       |

### `/content`

| Test id                                                 | Element                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `content-vods`, `content-clips`                         | Tab panels; `content-empty` `<EmptyState>`                     |
| `vod-row`                                               | `data-vod-id`, `data-visibility`, `data-status`                |
| `vod-title`, `vod-visibility`, `vod-save`, `vod-delete` | Inside `vod-row` (delete opens `<ConfirmDialog>`)              |
| `clip-row`                                              | `data-clip-id`; `clip-delete` inside (opens `<ConfirmDialog>`) |

### `/settings/privacy`

| Test id            | Element                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `export-request`   | Button per kind: `data-kind` (`channel` only for channel owners); disabled during cooldown |
| `export-row`       | `data-export-id`, `data-kind`, `data-status`; `export-download` link inside while `ready`  |
| `deletion-request` | Opens `<ConfirmDialog>`                                                                    |
| `deletion-status`  | `data-status` (`DELETION_STATUSES`), `data-scheduled-for`; `deletion-cancel` inside        |

## Stack and test hooks

The harness stack layers `harness/compose.trust-safety.yaml`, `harness/compose.e5-coop.yaml`
and `harness/compose.e6.yaml` (`bun scripts/infra.ts stack --harness`). `compose.e6.yaml` sets
`OPS_TEST_HOOKS=true` (api, worker) and `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` (api, media).

`OPS_TEST_HOOKS` (off by default, logged as a warning at every start, reported by `/healthz`;
never on a public instance) enables `POST INTERNAL_ROUTES.opsTick` behind `INTERNAL_API_SECRET`:
body `OpsTickBody` (`{ job: "account-deletion" | "export-cleanup" | "vod-retention" }`). The API
enqueues that job on its queue (`QUEUES.deletions`, `QUEUES.exports`, `QUEUES.retention`), waits
up to 60 s and returns its `OpsJobResult`; a job whose run lock is busy returns `{ skipped: 1 }`
and the harness ticks again. Without the hook the route is 404. Schedules run either way.

## Scenarios

Every scenario creates its accounts fresh. `--set via=api` drives the backend only; the default
also checks the web flows.

### `simulcast`

1. S signs up, adds a target on `/dashboard` (`rtmp://mock-rtmp:1936/live`, key
   `harness-<runId>`); `simulcast-target` appears with `data-enabled="true"`. The API list
   response contains no key field and no key value.
2. S goes live (ffmpeg test pattern). Within 20 s `simulcast-target` `data-status="live"`.
3. ffprobe on `rtmp://localhost:<MOCK_RTMP_PORT>/live/harness-<runId>` counts at least 60 video
   frames within 10 s at the source resolution. **Frames arrived.**
4. S disables the target: within 20 s the mock path has no publisher and the status is `idle`.
   Re-enable: frames again within 45 s (one stalled publish handshake costs the target's 10 s read timeout plus reconnect backoff, and counting frames takes a 10 s window).
5. S goes offline: the `simulcast_sessions` row (DB helper) has `bytes_sent` > 0 and an end time.
   No API response, harness log or service log line of the run contains the key.

### `overlay-alert`

1. S enables the tip alert on `/overlays` (message `${user} tipped ${amount}`, min 200 cents (tips start at 100),
   5000 ms) and creates a token with `7d`: `overlay-url` shows; `overlay-token` `data-active="true"`
   and `data-expires-at` within a minute of now + 7 days.
2. A new browser context (no cookies) opens the alerts URL: `overlay-alerts` `data-state="live"`.
3. `alert-test`: an `overlay-alert` with `data-test="true"` appears.
4. V tips S 250 cents (manual adapter; a treasurer confirms): within 10 s an `overlay-alert`
   with `data-type="tip"`, `data-amount-cents="250"` and V's display name in `overlay-alert-text`.
   A 150-cent tip (below the minimum) shows nothing within 10 s. An anonymous 300-cent tip shows the anonymous label
   and V's name is nowhere in the overlay DOM.
5. Scope: with the token as bearer and as `?token=`, `interact.alerts.list`,
   `stream.simulcast.list` and `me.get` are refused as anonymous; `interact.overlays.state`
   answers only S's channel. A token-holding request cannot name another channel.
6. Rotate (`none`): the open old overlay reaches `data-state="refused"` within 30 s; the old
   token's state call is 401; the new URL works. Revoke: the new overlay is refused within 30 s.
7. Expiry: an `expiresAt` in the past is `BAD_REQUEST`; a token expiring in 5 s (API) answers
   state, then 401 after expiry, and its open stream closes within 30 s.
8. Audit rows `alert.update`, `overlay.token.create` ×3, `overlay.token.revoke` exist.

### `vod-clips`

1. S streams 40 s (VODs on) and stops; the VOD becomes `ready`. V clips 10 s of it.
2. S renames the VOD and sets it `private` on `/content`: V's VOD list no longer has it and V's
   `vods.get` is `NOT_FOUND`; S sees it. V's `vods.update` and `vods.remove` on it: `NOT_FOUND`.
3. S deletes V's clip: gone from lists, `clips.get` `NOT_FOUND`. An ops tick `vod-retention`:
   its object is gone (S3 HEAD 404), status `deleted`.
4. S deletes the VOD: gone at once, and every clip of the broadcast with it. Ops tick: no object
   left under `vods/<id>/`, status `deleted`, `removed_reason = 'owner'`.
5. Held: a `legal` user places a hold on S2 (`admin.legalHold`); S2 streams, deletes the VOD;
   it is hidden, and after the tick its objects still exist (the result counts `held` ≥ 1).

### `data-export`

1. U signs up, follows S, chats in S's channel, tips S (confirmed). V (another user) follows U's
   channel, chats in U's channel and tips U (confirmed). U also owns a channel.
2. U requests `account` and `channel` exports on `/settings/privacy`; a second `account`
   request is refused (`RATE_LIMITED`; the button is disabled). Both `export-row`s reach
   `data-status="ready"`.
3. Mailpit has U's `dataExportReady` email with a link; its `X-Amz-Expires` is ≤ 604800 and the
   `expiresAt` of the row is completion + 7 days. The link downloads a zip.
4. The archive's `manifest.json` lists every file present; `account.json` is U's; U's chat
   message, follow and tip are present. **No file contains** V's id, email, username, display
   name or chat text, any session/token/key value of anyone, or a password hash.
5. V's `me.exports.list` does not show U's exports; the link with one signature byte changed is
   refused; V cannot `GET` U's object key without a signature.
6. Expiry: the DB helper moves U's account export's `expires_at` into the past; an ops tick
   `export-cleanup` sets it `expired`, the object is gone (the old link answers 403/404) and the
   list has no `downloadUrl`.

### `account-deletion`

1. U tips S (confirmed, ledger postings), subscribes (confirmed), chats, follows, and requests
   an export (ready).
2. U requests deletion on `/settings/privacy` (`deletion-status` `scheduled`; Mailpit has the
   scheduled email). An admin expedites it; an ops tick `account-deletion` completes it.
3. Identity gone: U cannot sign in; the users row has a `deleted_…` username and no email;
   sessions, accounts and the export object are gone; S's channel page shows no message of U.
4. History kept: U's payments, the ledger transactions of U's tip and subscription (each sums to
   0), the audit rows naming U as actor or subject, and `*_history` rows still exist and reference
   U's id. S's revenue still includes the tip.
5. No PII: a DB-helper scan of every text and jsonb column of `ledger_*`, `payments`, `tips`,
   `audit_log`, every `*_history` table, `events` and `webhook_deliveries` finds none of U's old
   email, username, display name, chat text or tip message.
6. The completed email reached U's old address.

### `backup-restore`

Runs the drill above (steps 1–7). Needs `podman` and the built Postgres image. Reports the
backup size, restore duration and WAL segments replayed.

### `load-plan`

See "Load test". Not in `full`.

### `e2e-social` (addition)

After the tmi.js `!ping` step: S creates a bot token (`me.bots.createToken`, scopes
`chat:read chat:edit`); the SDK bot (`harness/src/bots/sdk-bot.ts`) connects over the chat
WebSocket and answers `!ping` in the same channel; both bots' replies arrive, the SDK bot's
with the bot badge.

## Deferred (not in E6)

Polls, predictions, raids, goals and the chat overlay (ADR 0021); alert images and sounds
(needs alert media uploads); exporting media files; Stripe shares and the other E5 follow-ups.
