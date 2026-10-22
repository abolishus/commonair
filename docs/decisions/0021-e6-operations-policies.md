<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0021: Operating policies for E6 (exports, overlays, restore drills, load size)

- Status: accepted (2026-10-22; the questions below were answered by the maintainer)
- Date: 2026-10-22

## Context

Slice E6 finishes Phase 4 of [PLAN.md](../../PLAN.md): simulcast to a mock target, overlay
alerts, VOD and clip management, data export, account deletion, backup and restore, the load
test and the `no-proprietary` run of `full`
([docs/testing/e6-selectors.md](../testing/e6-selectors.md)). The tables and contract shapes
mostly exist since Phase 1. What was open were policies the schema does not answer: what a data
export contains and how long it lives, how long an overlay URL stays valid, how the restore drill
avoids destroying a developer's stack, how big the load test in `full` is, and which scenarios
`full` covers. Backup tooling itself was decided in ADR 0003 (WAL-G in our Postgres image).

## Decisions

1. **Data export: JSON only, a 7-day link, one per kind per 24 hours.** An export is a zip of
   JSON files (format in the spec) holding the requesting user's own rows. Other people appear
   only as the public slug of a channel the user acted on (follows, subscriptions, tips they
   paid); never another person's id, email, display name, message text, IP or payment details
   (a report the user filed lists its reason, not its target). No secrets go in (stream keys, simulcast keys, webhook
   secrets, token hashes, password hashes). Media files are not copied: a channel export lists
   its VODs and clips with their ids. The archive object and its signed link expire 7 days after
   the export completes (604,800 s, also the SigV4 presign maximum); the worker deletes the object
   and marks the export `expired`. A user may request one export per kind per 24 hours
   (`RATE_LIMITED` with `retryAfterSeconds`). The link is sent by email and is also listed by
   `me.exports.list` while it is valid.
2. **Overlay tokens: optional expiry, one active token per channel.** The streamer chooses no
   expiry (the default, because an OBS browser source breaks silently on expiry), a quick pick
   (1 day, 7 days, 30 days, 90 days, 6 months) or any exact future date; there is no upper cap.
   Creating a token revokes the channel's previous one in the same transaction; the streamer can
   also revoke it without a replacement. A database index allows one unrevoked token per channel.
   The token grants exactly two reads for its one channel: the overlay bootstrap state
   (`interact.overlays.state`) and the overlay alert stream. It grants nothing else, and an
   expired or revoked token is refused at once, including on an open stream (re-checked at least
   every 30 s).
3. **The restore drill uses a throwaway Postgres.** The `backup-restore` scenario starts its own
   Postgres container from our image with its own volume and its own WAL-G prefix in the backups
   bucket, migrates and seeds it, backs it up, wipes it, restores it and checks it. The
   developer's running stack is never stopped or wiped.
4. **`full` keeps the load test small.** `load-smoke` (2 streamers × 10 viewers) stays in `full`.
   The PLAN target (20 streamers × 200 viewers) is the separate `load-plan` scenario, parameterized
   and outside `full`, run by hand on a machine that can sustain it.
5. **`full` covers every Phase 4 scenario on one harness stack.** `e5-coop`, `trust-safety` and
   `e2e-relay` (about 15 minutes) join `full`. The harness stack is `compose.yaml` with every
   harness override layered (`bun scripts/infra.ts stack --harness`) on a Postgres volume created
   with the E5 bootstrap (ADR 0020).
6. **Polls, predictions, raids and goals stay 501 in E6.** Only alerts (tip, follow, subscription;
   raid alerts wait for raids) and the overlay are built.

## Consequences

- An export can never be used to read another user's data, and a leaked link stops working
  after 7 days at most; a user who needs a fresh copy waits 24 hours.
- A leaked overlay URL exposes only alerts the streamer already shows on stream; rotating it is
  one click.
- The restore drill proves WAL-G backup, restore and WAL replay with the triggers and role grants
  intact, without risk to local data. Production restores follow the operator guide (Phase 5).
- `full` gets longer (about 25–30 minutes); the 20 × 200 load run is a manual step until CI
  hardware exists (Phase 5).
