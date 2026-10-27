<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0015: Verified-watch signal for the chat gate and surge guard

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `ccf9c17`)
- Scope: the ADR 0015 candidate in [feature-wins.md §7](../product/feature-wins.md#7-decisions-needed)
  for W1-watch-gate (feature-wins §4.4,
  [W1-quick-wins](../../.claude/briefs/next/W1-quick-wins.md)): the Valkey key and its TTL,
  fetch-unjudged sessions, the per-network cap, oracle hardening, the fallback gate, and the
  criteria for leaving the feature flag. Builds on what W0-integrity merged (`be72278`, the
  `fetch_unjudged` marker in `545c3d1`).

## Context

The gate lets a streamer require "N seconds of verified watching this broadcast" before a
signed-in account may chat. The surge guard turns that on for a while when a channel is botted.
A false positive silences a real person, so the signal must be the integrity pipeline's, not a
new one, and must fail toward letting people talk.

What the code has at `ccf9c17`:

- **Gate eligibility already exists.** W0-integrity added the reason `fetch_unjudged`
  (`packages/integrity/src/types.ts:37`): a session whose fetches the delivery path could not
  judge (`cdn`, `no_accounting`; `packages/integrity/src/signals/fetch.ts:77`, `:107`, `:113`,
  `:128`) carries it on every verdict. `gateEligible({ verdict, reasons })`
  (`packages/integrity/src/score.ts:97`) is "verified and not `fetch_unjudged`", documented as the
  marker W1-watch-gate reads; `GATE_ELIGIBLE` (`packages/integrity/src/jobs.ts:47`) is its SQL
  form plus `scored_at is not null`, because the API promotes sessions on heartbeat before the
  scorer runs (`packages/integrity/README.md:170-177`). Stream hours, follow prior viewing,
  patronage and governance inputs already count only gate-eligible sessions (`README.md:178-180`,
  `61263d6`).
- **CDN sessions are still not fetch-judged.** W0-integrity marked them; it did not judge them.
  CDN pulls are tokenless and cached, and closing that needs CDN log ingestion keyed by token or a
  token-bearing edge (`README.md:157-160`). No milestone plan owns that work today.
- **Scoring cadence.** `score-sessions` runs every 15 s (`services/worker/src/integrity/jobs.ts:42`).
  A session needs at least 3 heartbeats to verify (`README.md:39`).
- **Addresses.** `playback_sessions.ip_hash` is an HMAC of the full address
  (`packages/db/src/schema/delivery.ts:69`, minted at `services/api/src/http.ts:158`). Privacy-relay
  addresses (consumer proxies shared by many unrelated people) are labelled
  `privacy_relay:<label>` in `playback_sessions.datacenter` (`README.md:84-85`). The `household`
  case in `integrity-basic` puts 3 honest viewers behind one address
  (`harness/scenarios/integrity-basic.ts:152`, `:167`).
- **Delivery assignment** is pure: a capacity-weighted draw over the relays and an origin share;
  sessions not drawn to a relay go to the CDN when it is enabled and the channel's verified
  viewers exceed `CDN_BURST_VIEWER_THRESHOLD` (default 5000, `packages/config/src/env.ts:369`),
  else the origin (`services/api/src/playback/delivery.ts:47-64`).
- **Chat gates are pure and ordered.** `checkGates` (`services/chat/src/rules.ts:41-79`) takes a
  `GateInput` (`rules.ts:15`) with a `Standing` (`services/chat/src/types.ts:62-71`). Verified bot
  accounts skip the email check (`rules.ts:55-57`). Rejections carry a `NOTICE_CODES` code
  (`packages/contracts/src/chat.ts:39-69`) and an inline English text. The `joined` frame tells the
  client `me.canChat` (`chat.ts:84`, computed by `canChatHint`, `rules.ts:112`).
- **Settings.** `ChannelChatSettings` (`packages/contracts/src/shapes.ts:33-44`) has no watch gate.
  `KEYS` (`packages/contracts/src/internal.ts:136`) has no verified-watch or surge key. The
  `follow_burst` channel signal exists (`packages/integrity/src/channel.ts:117`). Instance features
  are env flags published through `instance.info` `features`
  (`services/api/src/routes/instance.ts:115-122`).
- **No writer.** `services/worker/src/integrity/` has `classifier.ts`, `fetches.ts`, `jobs.ts`,
  `lock.ts`; the planned stub `verified-watch.ts` was never created, so there is nothing to wire in.

## Decisions

### 1. The signal: `KEYS.verifiedWatch(channelId, userId)`, written by the integrity worker

- **Shape.** STRING `verified-watch:<channelId>:<userId>` holding JSON
  `{ "b": <broadcastId>, "s": <seconds>, "f": 0 | 1 }`: the live broadcast, the user's
  gate-eligible watch seconds on it (after jitter, decision 4), and the fallback marker
  (decision 5). Chat ignores a value whose `b` is not the channel's live broadcast, so a new
  broadcast starts from zero without anyone deleting keys.
- **Source.** Sum of `watch_seconds` over the user's sessions on that broadcast that satisfy
  `GATE_ELIGIBLE`. Signed-in sessions only: anonymous sessions have no `user_id`, and the UI says
  the gate needs a signed-in viewer.
- **Writer.** New `services/worker/src/integrity/verified-watch.ts`, run at the end of each
  `score-sessions` pass, for channels with the gate on or the surge guard enabled only (decision 6
  needs keys to exist before a surge starts). One pipelined `SET … EX` per watching user.
- **TTL: 600 s, refreshed on every write.** It outlasts the 15 s scoring interval by a wide margin,
  so a slow pass, a page reload or a short network drop never flips a chatter between allowed and
  denied. Ten minutes after the viewer stops watching (or the worker stops writing), the key goes.
- **Reader.** `services/chat/src/cache.ts` (W1-watch-gate) reads it with a short in-process cache;
  the contract step adds `verifiedWatch: { broadcastId, seconds, fallback } | null` to `Standing`,
  loaded in `pipeline.ts`. `rules.ts` stays pure.
- **Valkey unavailable:** the gate fails open (the message goes through), with a metric and a
  logged warning, and the mod banner says the check is unavailable. Chat's own bus runs on the
  same Valkey, so an outage long enough to matter already stops chat.

**Why.** The integrity worker already decides what "verified" means and already holds the data; a
second judgement in chat would drift from it. A key per user keeps the chat read to one `GET`.

### 2. Fetch-unjudged sessions count as unverified for gating

`GATE_ELIGIBLE` is the only test: a session carrying `fetch_unjudged` (CDN, or a relay session
without verified receipt coverage) contributes nothing to `s`, whatever its verdict.

To keep that from silencing real viewers, **the API does not assign the CDN to a signed-in viewer
of a channel whose gate is on or whose surge guard is active**: `assignSource` gains an
`avoidCdn` input (the W1 contract step changes `services/api/src/playback/delivery.ts`, pure and
unit-tested), and those sessions go to the origin or a relay, where they are judged. Relay
sessions verify once their first receipt is verified (`RECEIPT_INTERVAL_SECONDS`, 60 s), which
the 60 s minimum already allows for.

**Why.** A CDN session proves nothing per session, so counting it would let a fetch-less bot behind
the CDN unlock chat (debate item 20). Keeping gated signed-in viewers off the CDN costs some origin
egress during a raid on a channel with more than 5000 viewers, only when the operator runs a CDN
at all, and is the difference between "unverified" being true and being an accident of routing.

### 3. Per-address cap

At most `gateUnlocksPerAddress` (default **5**) accounts are unlocked per `ip_hash` per channel per
broadcast. The worker applies it when it writes: on each address it ranks users by the start of
their first gate-eligible session on the broadcast, writes keys for the first five, and writes
none for the rest. Exempt roles (decision 7) neither need a key nor count toward the cap.

- The exact address (`ip_hash`), not a /24 prefix as the P2P tracker groups networks: a prefix
  would lump unrelated mobile users behind carrier NAT pools together.
- 5, not 3: the `integrity-basic` household is 3 people; 5 leaves room for a shared flat or a
  small office.
- Privacy-relay addresses are not capped; they use the fallback instead (decision 5).
- The cap is a field of the `integrity.thresholds` governance setting (an ordinary decision,
  documented in `packages/integrity/README.md`), with the default applied when the stored value
  lacks it, as `DEFAULT_MIN_VERIFIED_VIEWERS` does (`packages/integrity/src/thresholds.ts:40`).

**Why.** Many accounts behind one address each watching in a real browser is the cheapest way to
farm unlocks. Ranking by first session means a farm cannot push out the honest viewers who arrived
first.

### 4. Oracle hardening

- **One denial.** A new `NOTICE_CODES` value, `msg_verified_watch`, is returned for every gate
  denial: not watched long enough, never watched, capped, unjudged, or fallback not met. The text
  is the client's i18n string for that code ("This chat is for viewers who have been watching for
  a little while"), never a reason. The IRC gateway sends the same code as the NOTICE `msg-id`.
- **Jittered unlock.** The worker writes `s = max(0, seconds − j)` with
  `j = HMAC-SHA256(INTERNAL_API_SECRET, "vw-jitter-v1:" + broadcastId + ":" + userId) mod 31`
  seconds. It is fixed per user and broadcast, so it never flaps, and chat stays a plain
  comparison against the threshold.
- **Attempt limit.** Denied sends count against `KEYS.rateLimit("chat-gate", <userId>:<channelId>)`;
  beyond 6 denials a minute the sender gets `msg_ratelimit` until the minute ends. Probing for the
  exact unlock moment costs a minute per six tries.
- **No hint in `joined`.** `canChatHint` ignores the verified-watch gate, so rejoining does not
  reveal it. The gate's existence is public (it is a channel setting), and the chat input shows it.

**Why.** An attacker who can see why they were refused, or exactly when they unlocked, learns how
to tune bots against the signal.

### 5. The fallback gate: account age for privacy-relay viewers

A user whose counted session is on a privacy-relay address gets `f = 1`: the per-address cap is
not applied to them, and chat additionally requires an account at least
`gateFallbackAccountAgeDays` (default **7**, an `integrity.thresholds` field) old. It is on
whenever the gate is on; the streamer does not configure it.

- The fallback never stands in for watching. The user still needs `s` above the threshold from a
  gate-eligible session. It replaces the cap, not the signal.
- A viewer with no session at all (an IRC-only chatter who watches somewhere else, signed out)
  gets no key and cannot chat while the gate is on. The studio setting and the denial text say the
  gate needs viewers to watch signed in.

**Why.** Privacy relays put many unrelated people behind a few shared addresses, so the cap would
silence them for using a privacy tool. Hate-raid accounts are typically created in bulk just
before a raid, which the account age catches.

### 6. Surge guard v1: TTL'd Valkey override, off by default

- **Instance flag.** `CHAT_SURGE_GUARD=off|on` (`packages/config`, default `off`), published as
  `features.surgeGuard`. With it off, the studio hides the setting and the job does nothing. Per
  channel, `surgeGuard.enabled` also defaults to false.
- **Settings.** `ChannelChatSettings.surgeGuard { enabled, triggerUnverifiedRatio (default 0.5),
  cooldownMinutes (default 10) }`.
- **Trigger** (new `services/worker/src/jobs/chat-surge-guard.ts`, every 30 s): in the last
  2 minutes, at least `max(20, 3 ×` the channel's trailing 15-minute rate) new sessions, and among
  those older than 60 s the share that is not gate-eligible is at least `triggerUnverifiedRatio`;
  or a `follow_burst` flag on the channel in the last 2 minutes.
- **Override state.** `KEYS.surgeOverride(channelId)`, STRING JSON
  `{ state: "on" | "suppressed", since, until, by }`, TTL `until − now + 60 s`. While `on`, chat
  applies the gate at `max(minVerifiedWatchSeconds, 60)`. It is not a settings-row write, which
  would create settings history and need API-side publishing.
- **Hysteresis.** A trigger while `on` extends `until`; the job ends the override itself when
  `cooldownMinutes` pass with no trigger. The TTL is the safety net: if the worker dies, chat
  reopens on its own a minute after `until`. The job writes the `end` event on its next run if the
  key expired without it.
- **Who is unaffected:** exempt roles (decision 7), users already unlocked, and users with a
  non-deleted message in the channel sent before the surge began (chat keeps 30 days of it,
  ADR 0012 amendment 1).
- **Mod override.** A moderator ends (or starts) surge mode in one click through a new API
  procedure; ending writes `state: "suppressed"` for the cooldown so the job does not re-trigger at
  once.
- **Records.** Every begin, end and override writes an `audit_log` row and an outbox event
  (`chat.surge.begin`, `chat.surge.end`) in the same transaction (AGENTS.md: integrity actions are
  audited; side effects go through the outbox). The mod view shows a banner explaining why.

**Why.** Debate item 7: off by default, behind an instance flag, with the override as TTL'd Valkey
state, because an automatic lock that misfires silences a whole room.

### 7. The gate itself

- `ChannelChatSettings.minVerifiedWatchSeconds`: 0 (off) or 60 to 3600. Below 60 cannot work:
  verification takes about 3 heartbeats.
- `ChannelChatSettings.verifiedWatchExemptSubscribers`, default true.
- Always exempt: broadcaster, moderators, VIPs, verified bot accounts (vouched for by their owner,
  as for the email check).
- Order in `checkGates`: after the account-age and followers-only checks, before subscribers-only.
- The instance flag `CHAT_WATCH_GATE=off|on` (default `off` until GA, decision 8), published as
  `features.watchGate`, hides the channel setting while off.

### 8. Leaving the feature flag (GA)

The gate's instance flag defaults to `on` only when **all** of these hold:

1. W0-integrity's CDN fetch-judging is merged.
2. `surge-guard` and `integrity-basic` pass.
3. The gate has run on staging for two weeks.
4. Fewer than 1% of real (harness) viewers are wrongly marked unverified.

**Measuring 4.** Over the two weeks, `surge-guard` and `integrity-basic` run against staging on a
schedule. Every honest harness viewer (browser viewers, the household, the hidden tab, the
throttled data-mode viewer, the audio-only screen-reader viewer) that watched past the threshold
plus 30 s of jitter plus one scoring pass is a trial; a trial fails if that viewer's send is
refused with `msg_verified_watch`. The bar is under 1% of at least 300 trials, so a single failure
in a small sample neither passes nor fails it.

**Criterion 1 is not met at `ccf9c17`, and nothing schedules it.** W0-integrity merged the
`fetch_unjudged` marker, not CDN fetch-judging (Context). Decision 2 makes the gate correct
without it, but the criterion as accepted stays until the maintainer assigns CDN judging (the
natural home is S1 stage 4, where the CDN adapter lives) or restates the criterion.

The surge guard's instance flag stays `off` by default after GA. Whether onboarding recommends it
is revisited once staging has false-positive data (feature-wins §4.4 open question).

**Why.** A false positive silences a real person, so the bar is measured, not assumed.

## Consequences

- **W1 contract step (orchestrator):** `KEYS.verifiedWatch` and `KEYS.surgeOverride`;
  `Standing.verifiedWatch` and the `pipeline.ts` load; `ChannelChatSettings` fields
  (`minVerifiedWatchSeconds`, `verifiedWatchExemptSubscribers`, `surgeGuard`); `msg_verified_watch`
  in `NOTICE_CODES`; `gateUnlocksPerAddress` and `gateFallbackAccountAgeDays` in the integrity
  thresholds shape and seed; `assignSource`'s `avoidCdn`; the `CHAT_WATCH_GATE` and
  `CHAT_SURGE_GUARD` settings in `packages/config` and `.env.example`; the surge override
  procedure; `chat.surge.*` events; `chat-surge-guard` in `jobs/{index,names}.ts`.
- **W1-watch-gate** owns `rules.ts`, `cache.ts`, `verified-watch.ts` (and the one call to it from
  `services/worker/src/integrity/jobs.ts`, now that W0-integrity has merged), `chat-surge-guard.ts`,
  the studio settings component and the mod banner.
- **Tests.** Unit: the gate order and exemptions, jitter determinism, the cap's ranking, the
  fallback, surge hysteresis. Integration against real Valkey and Postgres: the cached read, TTL
  expiry, a `fetch_unjudged` session writing nothing, the cap at 5. Harness `surge-guard`, reusing
  the `integrity-basic` bots: bots that try to chat are refused; a CDN-assigned bot is refused; six
  accounts behind one address leave one refused; real viewers chat after 60 s; an audio-only
  screen-reader viewer verifies and chats; a scripted surge trips the guard and it reverts.
- **Residual risk.** Residential proxies with real browsers raise the attacker's cost but are not
  stopped (feature-wins §4.4). The gate is one layer among several.
- **Egress.** Gated channels above the CDN threshold serve signed-in viewers from the origin or
  relays.

## Alternatives considered

- **Count CDN sessions as verified** (the verdict without the marker). Lets a fetch-less bot unlock
  chat through the CDN. Rejected (debate item 20).
- **A HASH per channel** instead of a key per user. One key to expire, but a viewer who leaves
  would stay in it until the whole hash expires or a writer removes the field, which brings back the
  clean-up a per-key TTL gives for free. Rejected.
- **Compute the gate in chat from Postgres.** A query per message on the hottest path. Rejected.
- **Cap by /24 prefix.** Matches the tracker's grouping, but carrier NAT puts unrelated mobile
  users in one prefix. Rejected for the exact address.
- **Account age as the fallback for everyone.** Turns the gate into "watched or old account", which
  bought aged accounts pass. Rejected; the fallback only replaces the cap for privacy relays.
- **Surge override as a settings-row write.** Audited and visible, but creates settings history
  and needs API publishing to reach chat. Rejected (debate item 7).
- **Fail closed when Valkey is down.** Safer against a raid in an outage, but silences everyone at
  the same time. Rejected.

## Decisions at acceptance (2026-10-27)

The maintainer accepted the recommended answers.

1. **GA criteria.** The gate leaves its feature flag only when W0-integrity's CDN fetch-judging is
   merged, `surge-guard` and `integrity-basic` pass, it has run on staging for two weeks, and
   fewer than 1% of real (harness) viewers are wrongly marked unverified. Why: a false positive
   silences a real person, so the bar is measured, not assumed. Decision 8 records how criterion 4
   is measured, and that criterion 1 has no owner yet.
2. **Surge guard.** Stays off by default behind an instance flag, with the override held as TTL'd
   Valkey state (debate log item 7).
3. **Technical items** (key and TTL, fetch-unjudged = unverified, the per-address cap, oracle
   hardening, the fallback) as recommended in decisions 1 to 5, built on the `gateEligible` and
   `GATE_ELIGIBLE` markers W0-integrity merged.
