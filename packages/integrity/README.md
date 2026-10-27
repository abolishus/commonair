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

Whatever the verdict, a session whose fetches the delivery path could not judge (`fetchChecks`
skipped it: `cdn`, or `no_accounting`) carries the reason **`fetch_unjudged`**. It is not a signal:
it adds nothing to the score, no allowance removes it, and it never changes the verdict. See
"Gate eligibility" under `fetch_pattern`.

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
  the account's sessions at or before T.

**Rule:** an allowance applies only to sessions that **started at or before T**. A session started
later is scored normally: no covered signals, no lifted `media_unconfirmed` hold, no lifted
concurrency, so an overturn is never a standing whitelist for an account. For the sessions it
applies to, covered signals never count again and the reason `allowed_on_appeal` is added instead.
**New evidence after T still counts:** a signal that had not fired on the subject before T scores
normally (and can exclude), and the heartbeat checks only look at beats received after T. An
excluded session with an allowance is rescored, so an overturn restores it (audit
`integrity.session.restore`) even if the resolver did not reset the verdict.

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

A **reload** leaves a stale session behind. A session is **quiet** when a newer session of the same
device and channel started at or after its last heartbeat (2 s slack) and its last heartbeat was
visible. Quiet sessions are not counted at once (so the reload is never the duplicate). A quiet
session that stays silent for **90 s** after the newer one started is **superseded**: the scoring
job ends it (`ended_at` = last heartbeat, audit `integrity.session.supersede`, same transaction) and
drops it from the live viewer set. Neither ever fires. A session whose last heartbeat was hidden is
never quiet or superseded (browsers throttle background tabs to one timer run a minute), and two tabs
that both keep heartbeating are genuinely concurrent.

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

Heartbeats are the client's claim; delivery accounting is what the server side saw. Only
server-observed quantities are used: client-reported bytes (HTTP or P2P), `p2pCapable` and the
assigned source never lower what is expected. Only server-side P2P evidence does (see below).

- **origin / p2p**: the origin's per-session counters from `stream:segments` in Valkey
  (`integrity:fetch:<session>`: playlists, segments and LL-HLS parts, counted as **distinct
  objects** when the consumer passes object ids to `recordFetches`), else
  `playback_sessions.segments_fetched` (full segments only);
- **relay**: the per-session entries (`sessionId`, `segments`) of the relay's receipts that were
  **verified against complete issuance** (pending, rejected and issuance-unknown receipts prove
  nothing). A receipt's entries can claim at most `bytes_verified / 1000` objects in total (1 kB is
  the smallest plausible media object); beyond that they are scaled down. Expected media is the
  playback the session claimed inside the window those receipts cover;
- **cdn**: no per-session accounting. **Known limitation:** CDN pulls are tokenless and cached, so
  the origin cannot attribute them to a session; CDN-delivered sessions are never judged on
  fetches (the other signals still apply). Closing this needs CDN log ingestion keyed by playback
  token, or a token-bearing edge. Until then such sessions carry `fetch_unjudged` (below).

#### Gate eligibility: `fetch_unjudged` and `gateEligible`

A session `fetchChecks` skipped (`cdn`; or `no_accounting`: an origin session with no accounting
at all when a caller passes none, or a relay session without verified receipt coverage, which is
also held pending) gets the reason `fetch_unjudged` on every verdict. Public viewer counts, the
dashboard breakdown and the verdict itself ignore it: a CDN viewer still counts as a viewer (the
W1 gate policy belongs to ADR 0015). What it changes is what a verified session **earns**:

- `gateEligible({ verdict, reasons })` (pure, `score.ts`): verified and not `fetch_unjudged`. This
  is the marker W1-watch-gate reads. It takes the verdict and reasons **as stored**.
- `GATE_ELIGIBLE` (`jobs.ts`): the same as SQL on the alias `ps`, plus `ps.scored_at is not null`.
  The API promotes a session to verified on heartbeat before the scorer has run
  (`services/api/src/routes/playback.ts`); such a session has **no reasons yet**, and one that ends
  before the next scoring pass (every 15 s) is never scored, because the scorer takes only live or
  pending sessions. Without `scored_at` a CDN session would count until scored, or forever.
- Stream-hour eligibility and follow prior viewing count only gate-eligible sessions. Patronage and
  governance inputs still count every verified session (a policy question for the co-op).

The reason reaches existing rows the next time the scorer touches them: live sessions are
re-scored every pass, so a CDN session already verified gains it within a pass or two. Ended
verified sessions are never re-scored and keep the reasons they had; no migration rewrites them.
A CDN session that ended before this change and was scored then still counts toward the stream
hours of its last 48 hours (the recompute window) until it ages out.

Expected segments = claimed watch seconds / segment duration (1 s) × the HTTP share, judged only
when at least 10 are expected. The HTTP share is 10 % (`P2P_HTTP_SHARE`) for a **P2P-evidenced**
session and 100 % for every other session. It applies to `no_media_fetched` and
`too_few_segments` (origin counters and relay receipts alike). `too_many_segments` is always judged
against share 1, so an honest lone peer that falls back to HTTP never trips it. LL-HLS parts count
as 1/5 segment. Legacy rows with `assigned_source = 'p2p'` (the API records the HTTP source for new
sessions) are judged like origin sessions, with the reduced share only when evidenced.

#### Server-side P2P evidence (`readP2pEvidence`, `p2pEvidenceFor`; ADR 0005)

The tracker (`services/tracker`) is the only writer of these keys; integrity only reads them:

- `KEYS.p2pPeer(session)` HASH: `swarm`, `net` (HMAC of the announcing /24 or /48, never the
  address), `first`, `last` (epoch ms), `announces`. Expires 600 s after the last announce.
- `KEYS.p2pLinks(session)` ZSET: peer `net` → last completed offer/answer exchange (ms) the tracker
  relayed between this session and a peer on that network.
- `KEYS.p2pChannelNet(channel, net)` ZSET: session → last announce (ms) to any swarm of the
  channel from that network. Leaving a swarm never removes a member.

Evidence is per session, never per swarm. A session is evidenced at window end `t` (now, or when an
ended session ended), with `since = t − 120 s` (`P2P_EVIDENCE.windowMs`), when all hold:

1. its peer hash shows an announce at or after `since`, to a swarm whose id carries the session's
   own channel (`<channelId>:<infoHash>`);
2. its links hold, at or after `since`, at least **1** network other than its own
   (`minLinkedNetworks`); a link to its own network proves nothing;
3. at most **16** sessions on its network announced to the channel at or after `since`
   (`maxSessionsPerNetwork`, `ZCOUNT p2pChannelNet`, itself included). The cap is per channel
   because clients choose info hashes: a farm could otherwise split into private swarms;
4. at least one linked network from (2) is itself within that cap, so two farm networks over the
   cap cannot vouch for each other.

Announcing into a popular, diverse swarm therefore earns nothing on its own. The counts are not
bounded above by an ended session's end: each member's score is its last announce, so excluding
later scores would drop every peer that kept watching and undercount a farm. Per scoring batch
that is three pipelined round trips at most: `HGETALL` of each session's peer hash; each
candidate's `ZRANGEBYSCORE p2pLinks … WITHSCORES` plus the `ZCOUNT` of its own network; the
`ZCOUNT` of linked networks of the candidates still in the running. Each channel/network count is
read once per batch. Valkey errors never fail the run: a failed count is treated as over the cap,
those sessions are judged without the reduced share and the errors are returned
(`ScoreSessionsResult.p2p.errors`) for the worker's metrics.

The explanation (`fetch_pattern` details) carries `p2pEvidenced` (0/1), `linkedNetworks`,
`linkedWithinCap`, `sameNetworkPeers` and, when evidenced, `httpShare`, so streamers and admins can
see which bar a session was judged against.

**Residual risk (ADR 0005):** a viewbot farm with valid playback tokens and live heartbeats can
still earn the reduced share if it answers offers from a second network, or gets honest clients
to answer offers it sends (browsers answer automatically). The cap limits that to 16 sessions per
network and channel; a farm spread across many prefixes is exposed to the hosting-range and
headless signals. Honest viewers behind one large NAT above the cap lose only the P2P discount.

| Check                        | Weight | Fires when                                                       |
| ---------------------------- | ------ | ---------------------------------------------------------------- |
| `no_media_fetched`           | 0.9    | Accounting shows no media at all (counters or receipts known)    |
| `playlists_without_segments` | 0.8    | ≥ 10 playlist requests and no segment or part                    |
| `segments_without_playlists` | 0.6    | ≥ 10 segments and no playlist request                            |
| `too_few_segments`           | 0.6    | < 25 % of the media expected                                     |
| `too_many_segments`          | 0.4    | > 4 × the segments expected (origin with known part counts only) |

Independently of the score, these hold the session at **pending** (`media_unconfirmed`), never
verified:

- `no_media_fetched`, `playlists_without_segments` or `too_few_segments`;
- **database counter only**: fewer full segments than max(1, 10 % of watched seconds / segment
  duration). That counter does not see LL-HLS parts, so the bar is tolerant and a shortfall only
  holds the session (it never scores); one segment followed by hours of heartbeats stays pending;
- **relay session without proven receipt coverage**. Ended sessions that are still pending stay
  scoring candidates for an hour, so receipts that arrive late still verify them.

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
  Prior viewing counts **gate-eligible** sessions only (`GATE_ELIGIBLE`: verified, scored, not
  `fetch_unjudged`), and only watch time **before the follow**
  (min(watch seconds, follow time − session start)). Established viewers following in the same
  minute are kept.
- `raid_overstated` (`raidIntegrity`): a raid carries at most the source channel's verified viewers.

## Relay receipts (`checkReceipt`, `relayStanding`, job `verifyReceipts`)

A receipt is compared with `relay_issuance` for the minutes it covers, 2 minutes after its period
ends:

- reported ≤ issued × (1 + tolerance) → **verified** for min(reported, issued) bytes;
- beyond tolerance → **rejected** (`over_report`, ratio stored);
- bytes reported with nothing issued → **rejected** (`no_issuance`);
- **issuance unknown**: some minute of the period had live sessions assigned to the relay while the
  origin issued **this relay** nothing (no issuance row with bytes for it: origin restart, lost
  production record of the broadcast its sessions watched). The origin computes issuance for every
  relay with live sessions, so this is missing data; another relay's issuance in that minute
  (another broadcast's production) is not coverage. Beyond tolerance, the receipt is **verified
  for the issued bytes only** (never more), ratio left empty, flag `relay_issuance_unknown`
  (`pending_review`). It never counts as over-reporting. A minute without live sessions on the
  relay and without issuance is real: nothing was issued to it.

A relay is **suspended** (status `suspended`, flag `relay_suspended`, audit row) when it
over-reported beyond tolerance in **≥ 2 of its last 5** checked periods, or in any single period by
more than **3 × tolerance** (a `no_issuance` rejection counts as unbounded). With
`opts.valkey`, a suspended relay is removed from `KEYS.relays` (`relays:active`) right after the
suspension commits, so assignment stops at once instead of on its next heartbeat; a failed removal
is counted (`deassignFailed`), not thrown. Only verified bytes
count toward patronage. Reinstatement is an admin decision (`relays.reinstate`, audit
`relay.reinstate`); it starts a fresh record: only periods that **started at or after** the latest
reinstatement count toward standing.

## Streaming-hour eligibility (job `markEligibleStreamHours`)

An hour of `stream_hours` is eligible when at least `membership.classes.streamer.minVerifiedViewers`
(default 2) distinct viewers (account, or device for anonymous sessions) with a **gate-eligible**
session (`GATE_ELIGIBLE`: verified, scored, not `fetch_unjudged`, so CDN viewers do not count)
overlapped it, none of them the streamer. The streamer is recognised by user id, by the
devices the streamer watched from while signed in during the last 30 days, and by network,
time-aligned so a shared address (a campus, a café) only counts against viewers while the streamer
is there:

- the address hash of a session of the streamer that overlapped the judged hour ± 1 hour;
- a stream key's `last_used_ip_hash` (the ingest address) when the key was last used during that
  broadcast (from 10 minutes before its start).

Recomputed over the last 48 hours, so later exclusions are reflected.

## Jobs and worker integration

Stable entry points for `services/worker` (all take an explicit `now`, are idempotent and safe to
retry, and never delete rows):

| Function                                      | Suggested schedule | Writes                                                                                                                 |
| --------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `scoreActiveSessions(db, valkey, now, opts?)` | every 15–30 s      | session verdict/score/reasons/`scored_at`; flags + audit for exclusions and restores; ends superseded sessions (audit) |
| `verifyReceipts(db, now, opts?)`              | every 60 s         | receipt status/bytes verified/ratio; `relay_issuance_unknown` flags; relay suspension + flags + audit                  |
| `excludeFollowBursts(db, now, opts?)`         | every 60 s         | `follows.excluded_at`; follow and channel flags; audit                                                                 |
| `markEligibleStreamHours(db, now, opts?)`     | every 5–10 min     | `stream_hours.verified_other_viewers`, `eligible`; audit                                                               |
| `recordFetches(valkey, fetches)`              | per consumer batch | Valkey fetch counters (see below)                                                                                      |

- `scoreActiveSessions` options: `classifier` (pass `classifierFromEnv().classifier`),
  `segmentDurationSeconds` (1), `partsPerSegment` (5), `limit` (5000), `staleSeconds` (120),
  `finalizeSeconds` (3600), `supersedeGraceSeconds` (90). Returns
  `{ scored, counts, newlyExcluded, restored, superseded, p2p: { evidenced, errors } }`.
- `verifyReceipts` options: `graceSeconds` (120), `limit` (1000), `valkey` (remove suspended relays
  from `KEYS.relays`). Returns `{ verified, rejected, unknown, suspendedRelays, deassignFailed }`.
- `recordFetches(valkey, FetchRecord[])`: call once per `stream:segments` batch with the entries
  whose `src` is `origin` or `p2p`. `FetchRecord = { sid, kind, object? }`; pass `object` (the
  media object's path, e.g. `<rendition>/<file>`) so segments and parts count as distinct objects.
  Keys expire after 6 h.
