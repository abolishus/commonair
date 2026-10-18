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
- otherwise → **verified** (reasons still list any weak signals that fired)

Exclusions are sticky: rescoring never turns an excluded session back into a verified one; only an
appeal does. A verified session can become excluded as evidence accumulates.

### `datacenter_ip` — strength 0.8

The viewer's address belongs to a hosting provider. The API classifies the address once at session
start with a `NetworkClassifier` (the raw IP is never stored) and records the provider label in
`playback_sessions.datacenter`; the ASN, when known, is also matched against the list. VPN users can
be affected, which is why this is 0.8 and not 1; appeals are the remedy.

The default classifier reads `INTEGRITY_DATACENTER_CIDRS_FILE`: one IPv4/IPv6 CIDR or `AS<number>`
per line, optional label, `#` comments. Unset means nothing is classified as hosting.
`data/sample-hosting-cidrs.txt` is a **sample** for the harness (documentation ranges plus a few
well-known cloud ranges and ASNs), not a feed.

### `device_concurrency` / `account_concurrency` — strength 0.9

More than `maxSessionsPerDevice` live sessions (heartbeat in the last 2 minutes) on one device hash,
or one signed-in account. The oldest `maxSessionsPerDevice` sessions are fine; each session beyond
them fires.

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
| `never_visible_and_muted`   | 0.5    | ≥ 3 beats, every one hidden and muted                             |
| `buffer_never_advances`     | 0.4    | ≥ 5 beats, buffer level identical on all of them while playing    |
| `periodic_timing`           | 0.6    | ≥ 10 beats with < 5 ms standard deviation between arrivals        |

Heartbeat history lives in Valkey (`integrity:hb:<session>`, last 120 beats, 6 h TTL), written by
the API with `recordHeartbeat`. Without it, sessions are still scored from the database.

### `fetch_pattern` — sub-checks, noisy-OR

Only for origin/CDN-assigned sessions (relay viewers are covered by receipts). Bytes received
over P2P reduce the HTTP segments expected. LL-HLS parts count as 1/5 segment.

| Check                        | Weight | Fires when                                              |
| ---------------------------- | ------ | ------------------------------------------------------- |
| `playlists_without_segments` | 0.8    | ≥ 10 playlist requests and no segment or part           |
| `segments_without_playlists` | 0.6    | ≥ 10 segments and no playlist request                   |
| `too_few_segments`           | 0.6    | < 25 % of the HTTP segments expected for the watch time |
| `too_many_segments`          | 0.4    | > 4 × the segments expected for the watch time          |

Expected segments = watch seconds / segment duration (1 s) × HTTP byte share, judged only when at
least 10 are expected. Request counts come from Valkey (`integrity:fetch:<session>`, written from
`stream:segments` with `recordFetch`), else from `playback_sessions.segments_fetched`.

### Worked examples (default thresholds)

- Hosting address: 0.8 → excluded.
- `webdriver` only: 0.6 → verified, reason `headless` shown.
- `webdriver` + never visible and muted: 1 − 0.4 × 0.5 = 0.8 → excluded.
- Playlist poller with perfectly periodic beats: 1 − 0.2 × 0.4 = 0.92 → excluded.

## Channel signals

- `chat_viewer_anomaly` (`chatToViewerAnomaly`): with ≥ 50 viewers, the chatters/viewers ratio is
  below 20 % of the channel's own baseline **and** below the 5th percentile of live channels (each
  check used when available, at least one required). Strength = 1 − ratio / reference. Flags the
  channel for review; it does not exclude sessions by itself.
- `follow_burst` (`followBurst`, job `excludeFollowBursts`): in any clock minute with more than
  `followBurstPerMinute` follows on a channel, follows from accounts younger than 7 days or that
  never watched the channel before following are excluded (`follows.excluded_at`; rows kept).
  Established viewers following in the same minute are kept.
- `raid_overstated` (`raidIntegrity`): a raid carries at most the source channel's verified viewers.

## Relay receipts (`checkReceipt`, `relayStanding`, job `verifyReceipts`)

A receipt is compared with `relay_issuance` for the minutes it covers, 2 minutes after its period
ends:

- reported ≤ issued × (1 + tolerance) → **verified** for min(reported, issued) bytes;
- beyond tolerance → **rejected** (`over_report`, ratio stored);
- bytes reported with nothing issued → **rejected** (`no_issuance`).

A relay is **suspended** (status `suspended`, flag `relay_suspended`, audit row) when it
over-reported beyond tolerance in **≥ 2 of its last 5** checked periods, or in any single period by
more than **3 × tolerance** (a `no_issuance` rejection counts as unbounded). Only verified bytes
count toward patronage. Reinstatement is an admin decision (`relays.reinstate`).

## Streaming-hour eligibility (job `markEligibleStreamHours`)

An hour of `stream_hours` is eligible when at least one **verified** session other than the
streamer's own overlapped it. The streamer's sessions are excluded by user id and by every device
the streamer has watched from while signed in. `verified_other_viewers` counts distinct viewers
(account, or device for anonymous sessions). Recomputed over the last 48 hours, so later exclusions
are reflected.

## Jobs

| Function                               | Writes                                                        |
| -------------------------------------- | ------------------------------------------------------------- |
| `scoreActiveSessions(db, valkey, now)` | session verdict/score/reasons; flags + audit for exclusions   |
| `verifyReceipts(db, now)`              | receipt status/bytes verified/ratio; relay suspension + flags |
| `excludeFollowBursts(db, now)`         | `follows.excluded_at`; follow and channel flags; audit        |
| `markEligibleStreamHours(db, now)`     | `stream_hours.verified_other_viewers`, `eligible`; audit      |

All are idempotent and safe to retry; none deletes rows.
