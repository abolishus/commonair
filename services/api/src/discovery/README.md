<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Fair discovery

The directory is ranked by a published formula whose parameters are the governance setting
`discovery.ranking` (changed only through an ordinary proposal). `GET /api/directory/ranking`
returns the live configuration, a version string and the explanation below. Every stream card
carries a `reason` (`popular`, `spotlight`, `new`, `following`, `random`, `category`, `search`)
so viewers can see why they are shown a stream.

Implementation: [`ranking.ts`](ranking.ts) (pure, unit-tested). Inputs count **verified viewers
only** (sessions with a heartbeat in the last 30 s and verdict `verified`) and **non-excluded
follows only**, so viewbots and follow bursts cannot buy placement.

## Blended score (`live`, sort `recommended`)

```
score = w.viewers          × V
      + w.freshness        × F
      + w.followMomentum   × M
      + w.smallChannelBoost× S

V = log(1 + verified viewers) / log(1 + max verified viewers among live channels)
F = 1 / (1 + hours since the broadcast started)
M = log(1 + follows in the last 24 h) / log(1 + max follows in 24 h among live channels)
S = 1                                            if viewers ≤ spotlightMaxViewers
    (spotlightMaxViewers + 1) / (viewers + 1)    otherwise
```

Log scaling keeps the biggest channel from flattening everyone else; `S` keeps small channels
competitive with the defaults (`viewers 0.4, freshness 0.2, followMomentum 0.2, smallChannelBoost 0.2`).
Ties are broken by a stable hash of the channel id.

## Spotlight

`spotlightSlots` slots for live channels with at most `spotlightMaxViewers` verified viewers.
Candidates are ordered by a stable hash of their id; rotation window
`w = floor(now / spotlightRotationMinutes)` shows candidates `[w·k, w·k + k)` (mod the candidate
count, `k` = number of slots). Consecutive windows therefore never show the same channel when
there are at least `2k` candidates, and repeat as few as possible otherwise. The selection is
deterministic: every API replica shows the same spotlight in the same window.

## Other sections

- **New and live**: live channels created within `newChannelMaxAgeDays`, newest first.
- **Following** (signed in): live channels you follow, by the blended score.
- **Random** (`/directory/random`): uniform over live channels matching the filters.
- **Search**: Postgres full-text search on channel name, title and description (the
  `channels_search_idx` expression), live streams' titles and tags (live channels first, viewer
  accounts with no followers and no stream last), plus category names. Videos and clips match on
  their title (substring, or every word in any order: [`search-media.ts`](search-media.ts)):
  public, ready videos newest first; ready clips, no more visible than their source, most viewed
  first. Anyone who has not confirmed 18+ gets no mature-labelled video or clip at all.
- **Categories**: `liveChannels`, `viewerCount` (the sum of verified viewers) and `tags` (the ten
  most used, ties by name: [`tags.ts`](tags.ts)) all count the same streams, the ones the default
  `directory.live?category=<slug>` lists: by the live broadcast's category, never restricted, and
  mature-exclusive. `videoCount` counts what the default `vods.listByCategory` lists: public,
  ready videos recorded in the category, mature-exclusive, in one grouped query.
- **Recently live / following offline**: each card's `latestVod` is the channel's newest ready,
  public VOD; a mature one's thumbnail goes only to confirmed adults.

Mature streams are excluded everywhere unless the request sets `includeMature` **and** the caller
is a signed-in adult who confirmed 18+. Suspended channels never appear.
