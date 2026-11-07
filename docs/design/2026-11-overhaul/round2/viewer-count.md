<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# viewer-count: open decision 2 (F6, CS-5)

## 1. The question

On staging, streamer1's dashboard said **16 verified viewers** live, and analytics for "the same
broadcast" said **peak verified 4** (with 12 sessions excluded). Which number is right, and what
should be the single source of truth?

## 2. What we found

### Short answer: both numbers are right, and they describe different broadcasts

`seed live` restarts a publisher that dies after a 3 s backoff (`harness/src/seed/live.ts:7`,
`:33-34`, `:198-216`). Ingest has **no reconnect grace for live broadcasts**: every restart ends
the broadcast and starts a new one. Only rehearsals have a grace (`services/api/src/media/hooks.ts:18-25`, `:187-206`).
On 6 Nov streamer1 (`demo_streamer1`) has four broadcasts, all with the same title. Read-only
`SELECT` on staging at 23:57 UTC:

| Broadcast | Started (UTC) | Ended    | Running peak (`broadcasts.peak_verified_viewers`) | Rollup peak (`broadcast_audience_totals`) | Rollup sessions |
| --------- | ------------- | -------- | ------------------------------------------------- | ----------------------------------------- | --------------- |
| `…fec`    | 22:31:44      | **live** | 16                                                | none (live)                               | none            |
| `…3a3`    | 22:02:07      | 22:31:40 | 15                                                | none yet (settles 2 h after the end)      | none            |
| `…365`    | 21:51:42      | 21:52:41 | 0                                                 | **4**                                     | 12 (8 excluded) |
| `…aec6`   | 21:49:21      | 21:49:53 | 0                                                 | 0                                         | 0               |

- **16** is the live broadcast `…fec`: verified sessions with a heartbeat in the last 30 s. At
  23:57 the live breakdown was 15 verified (all bulk `demo_v*` viewers, origin, scored, not
  fetch-unjudged) out of 16 open sessions. The running peak column agrees: 16.
- **4** is broadcast `…365`, a **59-second** broadcast at 21:51. It had 12 sessions: 4 verified,
  and 8 excluded as `automation` (`headless` + `fetch_pattern` / `fetch_unjudged`). These were
  headless harness clients that the scorer correctly dropped. Its rollup ran about 2 h after it
  ended (`AUDIENCE_SETTLE_SECONDS = 7200`, `packages/integrity/src/constants.ts:23`).
  `/analytics` shows it because streamer1's display bypass skips the 24 h delay
  (`services/api/src/ops/analytics-hooks.ts:119-125`, renewed by seed mode,
  `docs/testing/seeding.md:388-390`).
- **The live broadcast cannot be in analytics.** `rangeRows` requires `ended_at is not null`
  (`services/api/src/analytics/queries.ts:150`), and `broadcastAnalytics` throws
  `analytics_pending` while live (`:82`). CS-5's "the live broadcast is already listed" was the
  1-minute broadcast with the same title. The picker label is `{title} · {date}`
  (`apps/web/src/i18n/locales/en/w2-analytics.json:7`, `analytics-page.tsx:305-308`). It shows the
  start time but not the duration, and it doesn't say that the live broadcast is missing, so four
  same-titled broadcasts read as one.

So the gap is **mostly seed-made**, with the UI making it confusing. There are still four real
inconsistencies under it, listed next.

### How each surface counts today

| Surface                                                                                   | Code path                                                                                                                                                                                                                                               | Counts                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public `<ViewerCount>`: StreamCard, rail, search, category, watch channel card, directory | `viewerCount(s)` → `KEYS.viewerCount` (5–10 s TTL), written by worker `live-counters` (`services/worker/src/counters.ts:60-85`) or the API fallback query (`services/api/src/lib/viewers.ts:18-55`); `lib/dto.ts:134,154`, `routes/directory.ts:79,441` | `verdict='verified'`, **live mode only** (DVR goes to `catchingUpCount`), heartbeat < 30 s, not ended                                                                                                          |
| Dashboard health "Verified viewers"                                                       | `stream.health` → `viewerBreakdown` (`services/api/src/routes/stream.ts:185`, `lib/viewers.ts:78-93`) → `stream-health-card.tsx:52-55`                                                                                                                  | `verdict='verified'`, heartbeat < 30 s, not ended. **No `playback_mode='live'` filter**, so DVR catch-up viewers count here and nowhere else live                                                              |
| Running broadcast peak / viewer-seconds                                                   | worker `live-counters` → `broadcasts.peak_verified_viewers` (`packages/db/src/schema/media.ts:66-68`)                                                                                                                                                   | Same as the public count. **No API or UI reads it** (only the seed writes it, `harness/src/seed/media/write.ts:70`)                                                                                            |
| Analytics peak, viewer-hours, attestations                                                | `broadcast-rollup` (`services/worker/src/jobs/broadcast-rollup.ts:62-69`, `:135-201`) → `broadcast_audience_totals`; `analytics/queries.ts`                                                                                                             | **Gate-eligible** (`verified` + `scored_at` set + not `fetch_unjudged`); peak = most verified sessions open at one instant (sweep, reconnects not double-counted). Settles 2 h after the end, shown after 24 h |
| Points accrual                                                                            | `services/worker/src/interact/points/accrue.ts:101-122`                                                                                                                                                                                                 | `GATE_ELIGIBLE`, **excludes the owner**, bots, deleted and suspended users                                                                                                                                     |
| Stream hours / patronage                                                                  | `packages/integrity/src/jobs.ts:825-851`                                                                                                                                                                                                                | Gate-eligible, **excludes the owner and the owner's devices and addresses**                                                                                                                                    |

### The real inconsistencies

1. **Health ≠ public count.** `viewerBreakdown` lacks the `playback_mode = 'live'` filter that
   `viewerCount` and the worker apply (ADR 0016 decision 6). A streamer with DVR viewers sees a
   higher "verified viewers" number on the dashboard than on their own channel page.
2. **Live counts a looser "verified" than settled.** The live count takes `verdict='verified'`,
   which includes:
   - sessions the API promoted on heartbeat before the scorer ran (`scored_at is null`,
     `services/api/src/routes/playback.ts:470-485`);
   - CDN or relay sessions marked `fetch_unjudged`.

   The rollup and points count both of these as unverified (ADR 0015 decision 2). Today the gap is
   seconds long (promotions get scored within a 15 s pass) or zero (staging has no CDN). With a CDN
   on, though, a big channel's live number would be visibly higher than its settled peak.

3. **The owner's own viewing counts** in the live count and in the rollup, but not in points or
   stream hours. On staging, `demo_streamer1`'s own account has 2 verified sessions on its live
   broadcast (the studio preview or the channel page). So the dashboard can count the streamer as
   one of their own viewers. CS's 16 may have been 15 bulk viewers plus streamer1. I can't prove
   that after the fact, because the count is a 30 s window.
4. **A 4-second encoder drop splits a broadcast.** This is a product bug and not only a seed one:
   a real streamer whose OBS blips gets a new broadcast, a split analytics history and a peak cut
   into pieces. The running peak also missed broadcast `…365` entirely (0 against the rollup's
   4), because a 59-second broadcast ends before the sessions verify inside the 10 s ticks.

There are also seed-only data gaps:

- Of 3,150 ended live broadcasts on staging, 22 have rollup rows. Seeded history
  (`harness/src/seed/media/plan.ts:209`) writes `broadcasts.peak_verified_viewers` (for example 57
  on 5 Nov) but no playback sessions and no `broadcast_audience_totals`.
- So staging `/analytics` shows only the short real `seed live` stubs, which is why it looked
  empty ("flat at 0 for 29 days then a spike", CS findings).

### Trust check for scope-calls (points)

Points use the strictest count in the system: gate-eligible, owner excluded. The 8 headless
sessions excluded on `…365` show the scorer working. Points counting is trustworthy as built, and
nothing here pushes redemption out. I told scope-calls this (and corrected my first note: accrual
already excludes the owner).

## 3. Options

**A. Relabel and disambiguate only.** Size S. Risk: low. Impact: medium.
Every live number says it is live and provisional, the analytics picker shows the time and
duration, and analytics adds a "Live now" row. No counting changes. This fixes F6 as seen, but
leaves inconsistencies 1–3 in place.

**B. One live definition plus A, and a settled tier.** Size M. Risk: low. Impact: high.
There are two named, documented numbers:

- **Live** = `viewerCount`, used by every live surface, including health and the running peak.
- **Settled** = `broadcast_audience_totals`, used for everything after the stream (analytics,
  recap, attestations). Points keep `GATE_ELIGIBLE`.

Health uses the same filter (live mode only). The owner's own sessions are left out of the live
count and the rollup, as stream hours already does. The running peak becomes "Peak so far" on the
dashboard and in analytics' live row.

**C. Make the live count gate-eligible too.** Size M–L. Risk: medium. Impact: medium.
The live number would equal the settled one by construction. The cost:

- the count lags by one scoring pass;
- with a CDN on, signed-out viewers of big channels would drop out of the live count until CDN
  fetch-judging exists (ADR 0015 decision 8, criterion 1, no owner). Live numbers would under-report
  on exactly the channels that matter, and the CDN-burst threshold reads this count
  (`delivery.ts:47-64`).

## 4. Recommendation

**Option B.** The **settled rollup (`broadcast_audience_totals`) is the source of truth** for
anything after the stream: analytics, recap, attestations, sponsors. The **worker's live count
(`KEYS.viewerCount` via `viewerCount()`) is the one live number** that every live surface shows,
health card included. Every live label says "now" or "so far" and links to "How we count". The
settled number is the only one called final. Both already exclude pending and excluded sessions,
so the remaining drift is small and explainable, and the UI says so.

Why not C: it makes the numbers equal by making the live number wrong (low) on CDN channels until
CDN judging ships.

What would change my mind: if the CDN is turned on for a production instance before CDN
fetch-judging, the live-vs-settled gap becomes large. Then either live shows "verified" and
"checking" side by side, or we take C once judging exists.

### Labels per surface (en; voice-copy to polish)

| Surface                                | Label                                                                                                                                                 | Number             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| StreamCard, rail, channel page, search | `<ViewerCount>` "{n} watching"; on the channel page, tooltip and link "Verified viewers · How we count" (D4.7)                                        | live               |
| Dashboard health / StatTile            | **"Watching now"**, hint "Verified viewers right now. Final numbers settle after the stream." Beside it, **"Peak so far"** with the running peak      | live; running peak |
| Post-stream recap (CS P-recap)         | "Peak **so far** {n} · provisional, final in Analytics within a day"                                                                                  | running peak       |
| Analytics, live broadcast              | A row at the top of the picker: **"Live now · started {time}"**, with "Peak so far {n}". Body: "Final figures appear 24 hours after the stream ends." | running peak       |
| Analytics, ended broadcasts            | "Peak verified viewers" (keep). Picker: `{title} · {date time} · {duration}`                                                                          | settled            |
| Analytics, pending (ended < 24 h)      | "Settling: verification finishes 2 hours after the stream; figures show 24 hours after it ends."                                                      | none               |

"Verified" stays in the settled labels. On live surfaces it moves to the hint, because live is
"verified so far".

## 5. If accepted: changes to the plan

Into **D5 (creator studio)**, replacing CS-5's "once the data owner says":

1. **Health uses the public filter.** Size S.
   - In `services/api/src/lib/viewers.ts`, `viewerBreakdown` adds
     `eq(playbackSessions.playbackMode, "live")` and returns `catchingUp`. The neatest way is to
     share one `where` builder with `viewerCounts`.
   - Unit and integration test: a DVR session counts in `catchingUp`, not in `verified`.
2. **The owner is excluded live and settled.** Size S–M.
   - Add `user_id is distinct from channels.owner_id` to:
     - `viewerCounts` and `viewerBreakdown`;
     - worker `counters.ts:69`;
     - `broadcast-rollup.ts` (its session select).
   - Device and address matching, as stream hours does, is optional and can follow later.
   - The rollup change alters attested figures. There are no production users (memory: no existing
     deployments), so this needs no migration window. Record it in an ADR 0014 amendment.
   - Tests: an owner session counts nowhere, live or settled.
3. **Expose the running peak.** Size S.
   - Contract (orchestrator): `stream.health` gains `peakSoFar: number` (from
     `broadcasts.peak_verified_viewers`) and `catchingUp`.
   - Contract (orchestrator): `analytics.range` gains `live: { broadcastId, title, startedAt, peakSoFar } | null`.
4. **Analytics picker and live row.** Size S.
   - `analytics-page.tsx`: the picker shows the duration; a "Live now" row; pending copy with
     "2 h settle / 24 h display".
   - New i18n keys in `w2-analytics.json` and `d5-studio.json` (en and es).
5. **Health and StatTile labels.** Size S.
   - `stream-health-card.tsx` and the D5 StatTile row: "Watching now" + "Peak so far", with the
     hint and a "How we count" link (shared with D4.7).

New, owner TBD (ingest / media unit), sized M:

6. **A reconnect grace for live broadcasts.** A publish on the same key within N seconds
   (suggest 30–60 s, like `REHEARSAL_RULES.sessionGraceSeconds`) of `not-ready` resumes the same
   broadcast instead of ending it. This means no new broadcast row, no second go-live
   notification, and one analytics entry.
   - In `services/api/src/media/hooks.ts`, the `stream.offline` emit is delayed by the grace
     (outbox or a TTL key).
   - Harness: a publisher restart within the grace keeps the `broadcastId`.
   - This removes the root cause of F6 on staging and the same bug for real streamers.

Seed (harness), sized S–M:

7. **Seeded history gets rollup rows.** `harness/src/seed/media/write.ts` writes
   `broadcast_audience_totals` (and minute rows for the last few broadcasts), consistent with
   `peak_verified_viewers`. The other way is to insert synthetic `playback_sessions` and let the
   rollup run. Either way, staging `/analytics` gets 30 days of data and stops showing only stubs.
   This needs a check that the 0043 analytics triggers allow seed inserts (schema owner).

Total: items 1–5 are **S–M** (one D5 slice, plus one contract step); item 6 is **M**; item 7 is
**S–M**.

## 6. References

All references are internal: no outside research was needed for this question.

- ADR 0015 (verified-watch signal; `GATE_ELIGIBLE`, fetch-unjudged = unverified, CDN judging
  unowned): `docs/decisions/0015-verified-watch-signal.md`.
- ADR 0016 decision 6 (DVR viewers are "catching up", not live), cited in `lib/viewers.ts:38` and
  `counters.ts:9-12`.
- ADR 0014 decisions 1, 3, 7 (rollup and attestations read the same rows), cited in
  `broadcast-rollup.ts:5-15` and `analytics/queries.ts:4-10`.
- ADR 0040 / `docs/testing/seeding.md:146-171`, `:380-390` (`seed live`, bulk verified viewers,
  display bypass).
- Staging data: read-only `SELECT`s on `broadcasts`, `broadcast_audience_totals` and
  `playback_sessions` (6 Nov 2026, 23:56–23:58 UTC), run through `psql` with
  `default_transaction_read_only=on`. No browser session was used. The API figures follow from the
  same rows the procedures read.
