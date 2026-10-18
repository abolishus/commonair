<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/integrity

How CommonAir decides which viewers, follows, raids and relay bytes are real. Viewer counts,
raids, patronage viewer-hours and streaming-hour eligibility use only what this package marks
verified (ADR 0003 §5). This README is the public integrity documentation: every signal, its
weight and every threshold is listed here, and the code is the reference.

Principles:

- **Explainable.** Every decision stores reason codes (`playback_sessions.verdict_reasons`) and an
  `integrity_flags` row per signal with the measured values; every action writes an `audit_log` row.
- **Appealable.** Nothing is deleted. Excluded sessions, follows and receipts are kept with their
  reasons; flags reference the stable id of the excluded thing (session id, relay id, follower id +
  channel id), which is what an appeal names.
- **No single quirk excludes.** Weak signals (a browser extension, a privacy browser, a muted tab)
  are weighted below the exclusion score; exclusion needs strong evidence or several weak signals.
- **No proprietary feeds.** Datacenter detection uses an operator-supplied list.

## Thresholds (`integrity.thresholds`, an ordinary governance setting)

| Key                        | Default | Meaning                                                                   |
| -------------------------- | ------- | ------------------------------------------------------------------------- |
| `sessionExcludeScore`      | 0.7     | A session whose combined score is **above** this is excluded              |
| `maxSessionsPerDevice`     | 3       | Concurrent sessions allowed per device and per account                    |
| `followBurstPerMinute`     | 30      | Follows per minute on one channel above which low-quality follows are cut |
| `relayOverReportTolerance` | 0.1     | Allowed relay over-report: reported / issued − 1                          |

## Session scoring (`scoreSession`)

Each signal returns a strength in [0, 1]. Strengths combine as a noisy-OR,
`score = 1 − Π(1 − sᵢ)`, so independent weak evidence adds up but never exceeds 1.

- `score > sessionExcludeScore` → **excluded** (at any time, even before 3 heartbeats)
- otherwise fewer than **3 heartbeats** → **pending** (reason `insufficient_heartbeats`)
- otherwise, media not confirmed by the delivery accounting → **pending** (reason
  `media_unconfirmed`, see `fetch_pattern`): a session that claims playback it never fetched
  never verifies
- otherwise → **verified** (reasons still list any weak signals that fired)

Exclusions are sticky: rescoring never turns an excluded session back into a verified one; only an
allowance (below) does. A verified session can become excluded, or go back to pending, as evidence
accumulates.

### Appeals and allowed flags stick

An **allowance** is a decision in the viewer's favour, at time T:

- an `integrity_flags` row set to `allowed` (admin "clear flag") on the session or on the account
  (`subject_type = 'user'`): covers that flag's signal (T = `decided_at`);
- an overturned integrity appeal (`appeals.kind = 'integrity'`, `status = 'overturned'`) on the
  session (`subject_type = 'session'`) or one of its flags (`'integrity_flag'`): covers every signal
  flagged on the session at or before T (`resolved_at`);
- the same on the account (`'user'`, or a flag on the account): covers every signal flagged on any of
  the account's sessions at or before T, for all of the account's sessions, later ones included.

**Rule:** covered signals never count again for the covered sessions; the reason
`allowed_on_appeal` is added instead. **New evidence after T still counts:** a signal that had not
fired on the subject before T scores normally (and can exclude), and the heartbeat checks only look
at beats received after T. An excluded session with an allowance is rescored, so an overturn
restores it (audit `integrity.session.restore`) even if the resolver did not reset the verdict.

### `datacenter_ip` — strength 0.6; `privacy_relay` — strength 0.3

The viewer's address is on the operator's network list. The API classifies the address once at
session start with a `NetworkClassifier` (the raw IP is never stored) and records the entry's label
in `playback_sessions.datacenter`; the ASN, when known, is also matched against the list.

- `hosting` entries (servers, cloud compute) fire `datacenter_ip` at 0.6: below the exclusion
  score, because VPN and corporate-proxy users exist. It excludes only with corroboration (e.g.
  `webdriver`: 1 − 0.4 × 0.4 = 0.84).
- `privacy_relay` entries (consumer browser/OS privacy proxies, real people) fire `privacy_relay`
  at 0.3, never fatal alone. Their stored label starts with `privacy_relay:`.

The default classifier reads `INTEGRITY_DATACENTER_CIDRS_FILE`: one IPv4/IPv6 CIDR or `AS<number>`
per line, an optional `class=hosting|privacy_relay` token (default `hosting`), an optional label,
`#` comments. Unset means nothing is classified. `data/sample-hosting-cidrs.txt` is a **sample** for
the harness (documentation ranges, a few cloud compute ranges and hosting ASNs), not a feed. It
deliberately omits hyperscaler ASNs that also carry consumer traffic (Amazon AS16509, Google
AS15169, Microsoft AS8075); list their published compute ranges instead.

### `device_concurrency` / `account_concurrency` — strength 0.9

More than `maxSessionsPerDevice` live sessions (heartbeat in the last 2 minutes) on one device hash,
or one signed-in account. Sessions are ranked **newest first**: the newest `maxSessionsPerDevice`
are fine; each older session beyond them fires.

A **reload** leaves a stale session behind. A session is **superseded** when a newer session of the
same device and channel started at or after its last heartbeat (2 s slack) and it has stayed silent
for 30 s since. Superseded sessions neither count nor fire; the scoring job ends them
(`ended_at` = last heartbeat) and drops them from the live viewer set. Two tabs that both keep
heartbeating are genuinely concurrent (a heavily throttled hidden duplicate of the same channel can
be superseded, which is intended).

### `headless` — weighted flags, noisy-OR

| Flag                  | Weight | Fingerprint evidence                                      |
| --------------------- | ------ | --------------------------------------------------------- |
| `webdriver`           | 0.6    | `navigator.webdriver` is true                             |
| `headless_user_agent` | 0.6    | User agent contains HeadlessChrome / PhantomJS / …        |
| `automation_globals`  | 0.5    | Automation globals present (Playwright, Phantom, CDP …)   |
| `zero_window`         | 0.3    | `innerWidth` or `innerHeight` is 0                        |
| `no_webgl`            | 0.25   | No WebGL context                                          |
| `no_plugins_desktop`  | 0.2    | Zero plugins with a desktop user agent (mobile is exempt) |
| `no_audio_context`    | 0.15   | No `AudioContext`                                         |

Fingerprint keys: `webdriver`, `automation`, `plugins`, `webgl`, `innerWidth`, `innerHeight`,
`audio` (booleans/numbers, no persistent identifiers), from the session start and the latest
heartbeat.

### `heartbeat_inconsistent` — sub-checks, noisy-OR

| Check                       | Weight | Fires when                                                        |
| --------------------------- | ------ | ----------------------------------------------------------------- |
| `played_exceeds_wall_clock` | 0.5    | ≥ 3 beats and played seconds > 1.5 × wall-clock time between them |
| `never_visible_and_muted`   | 0.25   | ≥ 3 beats, every one hidden and muted                             |
| `buffer_never_advances`     | 0.4    | ≥ 5 beats, buffer level identical on all of them while playing    |
| `periodic_timing`           | 0.6    | ≥ 10 visible-to-visible intervals with < 2 ms standard deviation  |

A background tab is not a bot: `never_visible_and_muted` is weak corroboration only (with any one
other weak signal it stays at or below 0.7). `periodic_timing` ignores intervals that touch a
hidden beat, because browsers clamp, align and throttle timers in hidden tabs, which makes honest
beats regular.

Heartbeat history lives in Valkey (`integrity:hb:<session>`, last 120 beats, 6 h TTL), written by
the API with `recordHeartbeat`. Without it, sessions are still scored from the database.

### `fetch_pattern` — sub-checks, noisy-OR, and the `media_unconfirmed` hold

Heartbeats are the client's claim; delivery accounting is what the server side saw:

- **origin / p2p**: the origin's per-session request counters from `stream:segments` — Valkey
  (`integrity:fetch:<session>`, playlists, segments and LL-HLS parts, written with
  `recordFetch`/`recordFetches`), else `playback_sessions.segments_fetched` (full segments only);
- **relay**: the per-session entries (`sessionId`, `segments`) of the relay's non-rejected
  receipts, against the playback the session claimed inside the window those receipts cover;
- **cdn**: CDN pulls are tokenless, so there is no per-session accounting: never judged.

Expected segments = claimed watch seconds / segment duration (1 s) × HTTP byte share, judged only
when at least 10 are expected. Self-reported P2P bytes can lower the share to 10 % at most. LL-HLS
parts count as 1/5 segment.

| Check                        | Weight | Fires when                                                       |
| ---------------------------- | ------ | ---------------------------------------------------------------- |
| `no_media_fetched`           | 0.9    | Accounting shows no media at all (counters or receipts known)    |
| `playlists_without_segments` | 0.8    | ≥ 10 playlist requests and no segment or part                    |
| `segments_without_playlists` | 0.6    | ≥ 10 segments and no playlist request                            |
| `too_few_segments`           | 0.6    | < 25 % of the HTTP media expected                                |
| `too_many_segments`          | 0.4    | > 4 × the segments expected (origin with known part counts only) |

Independently of the score, `no_media_fetched`, `playlists_without_segments` and `too_few_segments`
hold the session at **pending** (`media_unconfirmed`). With only the database counter, a zero
segment count also holds it (a part-only low-latency player cannot be told apart from a fetch-less
bot by that counter, so it is held rather than scored) and ratio checks are skipped. A relay with
no receipts for the window is not judged.

### Worked examples (default thresholds)

- Hosting address alone: 0.6 → verified, reason `datacenter_ip` shown.
- Hosting address + `webdriver`: 1 − 0.4 × 0.4 = 0.84 → excluded.
- `webdriver` only: 0.6 → verified, reason `headless` shown.
- `webdriver` + background tab (hidden and muted): 1 − 0.4 × 0.75 = 0.7 → verified (not above).
- Heartbeats claiming 60 s, origin counters show no media: 0.9 → excluded.
- Playlist poller with perfectly periodic beats: 1 − 0.2 × 0.4 = 0.92 → excluded.

## Channel signals

- `chat_viewer_anomaly` (`chatToViewerAnomaly`): with ≥ 50 viewers, the chatters/viewers ratio is
  below 20 % of the channel's own baseline **and** below the 5th percentile of live channels (each
  check used when available, at least one required). Strength = 1 − ratio / reference. Flags the
  channel for review; it does not exclude sessions by itself.
- `follow_burst` (`followBurst`, job `excludeFollowBursts`): in any clock minute with more than
  `followBurstPerMinute` follows on a channel, follows from accounts younger than 7 days or that
  never watched the channel before following are excluded (`follows.excluded_at`; rows kept).
  Prior viewing counts **verified** sessions only. Established viewers following in the same
  minute are kept.
- `raid_overstated` (`raidIntegrity`): a raid carries at most the source channel's verified viewers.

## Relay receipts (`checkReceipt`, `relayStanding`, job `verifyReceipts`)

A receipt is compared with `relay_issuance` for the minutes it covers, 2 minutes after its period
ends:

- reported ≤ issued × (1 + tolerance) → **verified** for min(reported, issued) bytes;
- beyond tolerance → **rejected** (`over_report`, ratio stored);
- bytes reported with nothing issued → **rejected** (`no_issuance`);
- **issuance unknown**: some minute of the period had live sessions assigned to the relay but no
  issuance row with bytes (origin restart, lost production record). Beyond tolerance, the receipt
  is **verified for the issued bytes only** (never more), ratio left empty, flag
  `relay_issuance_unknown` (`pending_review`). It never counts as over-reporting.

A relay is **suspended** (status `suspended`, flag `relay_suspended`, audit row) when it
over-reported beyond tolerance in **≥ 2 of its last 5** checked periods, or in any single period by
more than **3 × tolerance** (a `no_issuance` rejection counts as unbounded). Only verified bytes
count toward patronage. Reinstatement is an admin decision (`relays.reinstate`, audit
`relay.reinstate`); it starts a fresh record: only periods that **started at or after** the latest
reinstatement count toward standing.

## Streaming-hour eligibility (job `markEligibleStreamHours`)

An hour of `stream_hours` is eligible when at least `membership.classes.streamer.minVerifiedViewers`
(default 2) distinct viewers (account, or device for anonymous sessions) with a **verified**
session overlapped it, none of them the streamer. The streamer is recognised by user id, by every
device the streamer has watched from while signed in, and by network: the address hashes of the
streamer's own sessions in the window (plus a day) and each stream key's `last_used_ip_hash` (the
ingest address). Recomputed over the last 48 hours, so later exclusions are reflected.

## Jobs

| Function                               | Writes                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `scoreActiveSessions(db, valkey, now)` | session verdict/score/reasons; flags + audit for exclusions and restores; ends superseded sessions |
| `verifyReceipts(db, now)`              | receipt status/bytes verified/ratio; relay suspension + flags                                      |
| `excludeFollowBursts(db, now)`         | `follows.excluded_at`; follow and channel flags; audit                                             |
| `markEligibleStreamHours(db, now)`     | `stream_hours.verified_other_viewers`, `eligible`; audit                                           |

All are idempotent and safe to retry; none deletes rows.
