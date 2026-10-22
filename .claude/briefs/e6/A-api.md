<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit A: API (overlays and alerts, VOD/clip management, exports, ops hook, healthz)

You are implementing unit A of slice E6 for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md, docs/architecture.md, `.claude/briefs/e6/_common.md` and
`docs/testing/e6-selectors.md` first. Do not look outside the repository.

## You own (write only these)

- `services/api/src/**` except `src/env.ts` lines unrelated to `opsEnv` (you may add `opsEnv` to
  the API env schema there)
- `services/api/tests/**`

## Contracts you must honor (read-only for you)

Everything listed in `_common.md`, especially `interact.*`, `vods.*`, `clips.remove`,
`me.exports.*`, `me.deletion.request`, `INTERNAL_ROUTES.opsTick`, `OVERLAY_EVENTS_PATH`,
`BUS.overlay`, `OverlayAlert`, `OverlayTokenStatus`, `EXPORT_*`, `exportObjectKey`,
migration `0022_e6_ops.sql`.

## Build

1. **Alerts** (`routes/interact.ts`): `alerts.list` (defaults for unset types), `alerts.set`
   (upsert, `BAD_REQUEST` for `imageKey`/`soundKey`, audit `alert.update`), `alerts.test`
   (publish a sample `OverlayAlert` with `test: true` on `BUS.overlay(channelId)`). Polls,
   predictions, raids and goals stay 501.
2. **Overlay tokens**: `overlays.token` (expiry rules, revoke + insert in one transaction, the
   unique index as the race backstop mapped to `CONFLICT`, audit `overlay.token.create`, publish a
   revoke message on `BUS.overlay` for the old token, return the token once and the URLs from
   `PUBLIC_URL`), `overlays.status`, `overlays.revoke` (audit, publish revoke), `overlays.state`
   (`eventsUrl` from `API_PUBLIC_URL`). Update `resolveOverlay` in `lib/orpc.ts` to refuse
   expired tokens. Generate tokens with 32 random bytes (base64url); store only the SHA-256.
   Make sure the overlay credential authenticates **nothing** but `access: "overlay"` procedures
   (verify `lib/access.ts` and `lib/orpc.ts`; add tests proving `me.get`, `interact.alerts.list`
   and `stream.simulcast.list` treat a bearer/`?token=` overlay token as anonymous).
3. **Overlay stream** at `OVERLAY_EVENTS_PATH` (plain route in `http.ts`, `text/event-stream`):
   resolve the token (401 if not), one shared Valkey subscriber per process for `BUS.events`
   fanned out in memory by channel, plus a per-channel subscription to `BUS.overlay`; map events
   to alerts exactly as the spec says (enabled, min amount, anonymous → i18n label, `formatMoney`);
   `ping` every 15 s; re-check the token at least every 30 s and on revoke messages, then send
   `revoked` and close; clean up subscribers on disconnect; cap concurrent streams per channel
   (e.g. 20) and per process. Never log the token. Load alert configs per channel with a short
   cache invalidated by `alerts.set`.
4. **VODs and clips** (`routes/vods.ts`, `routes/clips.ts`): `vods.update`, `vods.remove`
   (also removes the broadcast's clips), `clips.remove` (channel owner or creator), with the
   spec's `NOT_FOUND`-not-`FORBIDDEN` rule, audit rows, and the visibility rules for `private` /
   `subscribers` in `list`/`get` and media URLs. Removed rows are hidden immediately everywhere.
5. **Exports** (`routes/me.ts`): `exports.create` (channel ownership, cooldown → `RATE_LIMITED`
   with `retryAfterSeconds`, a row lock or advisory lock per user+kind so two concurrent requests
   cannot both pass, audit `export.request`, enqueue `EXPORT_JOBS.build` on `QUEUES.exports` with
   `jobId = exportId` after commit), `exports.list` (caller's rows only; `downloadUrl` presigned
   with `presignGet` against the public endpoint, key `exportObjectKey(userId, id)` taken from the
   row's `storage_key` only if it equals that value, expiry = seconds until `expires_at`, only while
   `ready` and unexpired; `filename` `commonair-<kind>-<date>.zip`).
6. **Deletion emails**: `me.deletion.request` sends `accountDeletionScheduled` after commit (the
   mailer already exists in `src/mail.ts`).
7. **Ops hook** (`OPS_TEST_HOOKS`): `POST /internal/ops/tick` exactly like `coop/hooks.ts`
   (404 when off, before the secret check; internal secret; enqueue on the job's queue, wait up
   to 60 s, return `OpsJobResult`; `{ skipped: 1 }` when the job reports a busy lock). Job names
   and queues: `account-deletion` → `QUEUES.deletions`, `export-cleanup` → `QUEUES.exports`
   (`EXPORT_JOBS.cleanup`), `vod-retention` → `QUEUES.retention`. Warn at start while on.
8. **`/healthz`** booleans: `opsTestHooks`, `stripe` (Stripe adapter configured), `oauth` (any
   OAuth provider configured), `cdn` (a CDN/public media origin other than our own configured;
   false when none exists in config).

## Tests you must add

- Unit: alert template rendering (every variable, anonymous, missing message, `showMessage`
  false, amount formatting), event → alert mapping (each type, disabled, below minimum, other
  channel), token expiry validation, export cooldown arithmetic.
- Integration (`*.int.test.ts`, real Postgres/Valkey): overlay token lifecycle (create, rotate
  revokes, revoke, expiry refused, one-active under two concurrent creates), token scope (refused
  as anonymous elsewhere), the SSE stream end to end (tip event on `BUS.events` → `alert` frame;
  other channel's tip → nothing; revoke → `revoked` and close within the re-check interval, using
  a short interval injected for tests), `vods.update/remove` and `clips.remove` (owner, creator,
  stranger `NOT_FOUND`, clips removed with their VOD, visibility in lists), exports (create,
  cooldown, concurrent create, channel kind without a channel, list scoping between two users,
  link only while ready and unexpired, key mismatch refused), ops hook (404 off, 401 without
  secret, enqueues).

## Done means

As in `_common.md`. Run only `services/api` tests you added or touched plus `bunx tsc -p
services/api --noEmit`.
