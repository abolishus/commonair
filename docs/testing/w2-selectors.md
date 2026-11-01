<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2 web ↔ harness contract (feature wins, wave 2)

The W2 units (splits, captions, rollup and analytics, the enforcement report, live DVR, rehearsal
mode, signed attestations, group exclusion appeals and the VOD and clip watch pages) and their
harness scenarios agree on these routes, the W2 player seam and the `data-testid` values
(`.claude/briefs/batch6/README.md`, decisions (a)–(r)). Changing one is a contract change: update
this file, the web app and the scenarios together. `apps/web/tests/selectors.test.ts` checks every
id below: an id is rendered somewhere in web or ui source, or it waits in `PENDING_W2_IDS` until
its unit merges (a pending id that is already rendered fails, so the list only shrinks).

## Rules

- Tests select by `data-testid`, never visible text (it is translated; the `en-XA` scan visits the
  new pages). Option items follow `<field>-<value>`; `<x>` in an id is a template its unit's render
  tests check, and the selectors test checks its literal prefix.
- Numbers on elements are plain integers in `data-*` (cents, seconds, bytes, counts); a suppressed
  figure carries `data-suppressed="true"` and no number.
- Every list item carries its entity id (`data-split-id`, `data-vod-id`, `data-message-id`, …).
- Harness-only hooks (contract step §1.4: run the rollup and the attestation job now, bypass the
  24 h analytics display delay) live behind `INTERNAL_API_SECRET` and `OPS_TEST_HOOKS=true`.

## Routes

| Route                     | What                                                            | Unit                              |
| ------------------------- | --------------------------------------------------------------- | --------------------------------- |
| `/crew`                   | revenue splits with the channel's crew                          | W2-splits                         |
| `/captions`               | live captions settings, track state, the VOD cue editor         | W2-captions                       |
| `/analytics`              | per-broadcast and range analytics, excluded groups, share links | W2-rollup-analytics (+ W2b units) |
| `/rehearse`               | arm a rehearsal, invitees, live checklist and report            | W2-rehearsal                      |
| `/$channel/vods/$vodId`   | public VOD watch page with the chat replay panel                | W2-vod-watch                      |
| `/$channel/clips/$clipId` | public clip watch page with the clip window's chat              | W2-vod-watch                      |
| `/attestations/verify`    | public verifier for signed audience attestations                | W2b-attestations                  |
| `/transparency`           | gains the enforcement report (`EnforcementReport` slot)         | W2-enforcement-report             |
| `/transparency`           | gains the split write-off and suspense lines                    | W2-splits                         |
| `/dashboard`              | gains the DVR settings (`DvrSettings` mount)                    | W2-dvr                            |
| `/$channel` (the player)  | gains the CC toggle and the DVR scrubber and controls (slots)   | W2-captions, W2-dvr               |

The four studio pages are in the studio nav from the contract step on and render the not-found
state until their unit merges. The watch pages' route files are `routes/_app/$channel_.vods.$vodId.tsx`
and `$channel_.clips.$clipId.tsx`: the trailing `_` keeps them out of the channel page's route
(which renders no outlet) while the URLs stay `/$channel/vods/$vodId` and `/$channel/clips/$clipId`.
Typed links: `vodWatchLink(channel, vodId)` and `clipWatchLink(channel, clipId)` in `lib/nav.ts`.
`harness/src/seed/routes.ts` has a `SEED_ROUTES` row for each new route (seed-media publishes
`vodId` and `clipId` in `store.extra`).

## Player seam (W2)

The contract step extends W1's seam (`docs/testing/w1-selectors.md` "Player seam"); units build on
it and never edit `controller.ts` or `player.tsx`.

- `PlayerControllerOptions.onFeatures(features)`, once per session: `{captions: {tracks, state},
  dvr: DvrGrant | null}` from `playback.start` (`captions`, `captionsState`, `dvrWindowSeconds`,
  `dvrPlaylistUrl`); `NO_SESSION_FEATURES` before and after a session.
- `dvrGrant(): {windowSeconds, playlistUrl} | null`, the URL carrying the newest DVR token.
- `enterDvr(playlistUrl): Promise<boolean>`: loads the DVR playlist on the same hls.js instance
  (native HLS: the same element), so the session, its heartbeats and its played seconds carry on;
  true once the playlist's level loaded and the mode is `dvr` (then `seekToWallclock`); false and
  back on live after `DVR_LOAD_TIMEOUT_MS` (10 s); false with nothing changed without a grant, in
  data mode or once stopped. A P2P session stops sharing on entering DVR (origin-only, ADR 0016
  decision 5). A later `enterDvr` or `exitDvr` supersedes a pending one.
- `exitDvr()`: back to the live playlist (the newest live token; a `switchTo` that arrived during
  DVR is played then). `setPlaybackMode("live")` while DVR plays is the same; turning data mode on
  leaves DVR.
- Requests under the DVR playlist's directory carry the DVR token, everything else the live one;
  a heartbeat's `dvrToken` replaces the DVR token. In `dvr` mode heartbeats send
  `behindLiveSeconds` (now − `playheadWallclock()`) and `latencySeconds: null`.
- `player.tsx` mounts `CaptionsToggle` (`player/captions-toggle.tsx`, W2-captions) and `DvrControls`
  in the control row and `DvrScrubber` (`player/dvr-controls.tsx`, W2-dvr) in the scrubber slot
  while a session plays, handing them the controller, the features and, for DVR, `dataMode` and the
  playback mode. The `player` element gains `data-dvr-window` (seconds, `0` without DVR) and
  `data-captions` (`off`, `queued` or `active`).

## Test ids

### Navigation (contract step)

| Test id                    | Element and attributes                             |
| -------------------------- | -------------------------------------------------- |
| `studio-rehearse-link`     | Studio nav link to `/rehearse`                     |
| `studio-captions-link`     | Studio nav link to `/captions`                     |
| `studio-analytics-link`    | Studio nav link to `/analytics`                    |
| `studio-crew-link`         | Studio nav link to `/crew`                         |
| `footer-attestations-link` | Footer link to `/attestations/verify` (every page) |

### Crew (W2-splits)

| Test id                       | Element and attributes                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `crew-page`                   | The `/crew` page container (channel owners and crew)                                          |
| `crew-propose-form`           | The propose form (owner only)                                                                 |
| `crew-recipient`              | Recipient username input                                                                      |
| `crew-basis`                  | Basis `Select` trigger; `data-value`                                                          |
| `crew-basis-<basis>`          | One item per `SPLIT_BASES` value (`tips`, `subs`, `all`)                                      |
| `crew-bps`                    | Share input in basis points                                                                   |
| `crew-preview`                | The plain-language preview; `data-example-cents`, `data-recipient-cents` (empty until priced) |
| `crew-propose-submit`         | Submits `money.splits.propose`                                                                |
| `crew-split`                  | A split version row; `data-split-id`, `data-version`, `data-status`, `data-basis`             |
| `crew-share`                  | A recipient's share in a version; `data-user-id`, `data-bps`, `data-accepted`                 |
| `crew-accept`                 | Accept, for a recipient of a `proposed` version                                               |
| `crew-reject`                 | Reject, for a recipient of a `proposed` version                                               |
| `crew-end`                    | End an `accepted` version (owner); opens a `ConfirmDialog`                                    |
| `crew-end-confirm`            | The end `ConfirmDialog`'s content; its confirm button is `confirm-dialog-confirm`             |
| `crew-payout-note`            | The note that crew are paid by the treasurer through the manual adapter                       |
| `transparency-split-writeoff` | `/transparency`: the split-shortfall write-off cost line; `data-cents`                        |
| `transparency-split-suspense` | `/transparency`: the split-suspense line (`TransparencyMonth.splitSuspense`); `data-cents`    |

### Captions (W2-captions)

| Test id                               | Element and attributes                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `captions-page`                       | The `/captions` page container                                                |
| `captions-enabled`                    | Enable switch; `data-state` `on`/`off`, `data-default` (the instance default) |
| `captions-language`                   | Spoken-language `Select` trigger; `data-value`                                |
| `captions-mask-words`                 | Mask list textarea (one pattern per line)                                     |
| `captions-mask-error`                 | Inline error for an invalid pattern; `data-line`                              |
| `captions-save`                       | Saves `channels.updateMediaSettings` (`captions`)                             |
| `captions-track-state`                | Live track state; `data-state` `off`, `queued` or `active`                    |
| `captions-vod-editor`                 | The per-VOD cue editor; `data-vod-id`                                         |
| `captions-cue`                        | One cue; `data-start-ms`, `data-end-ms`                                       |
| `captions-cue-text`                   | A cue's text input                                                            |
| `captions-cue-save`                   | Saves `vods.captions.update`                                                  |
| `captions-privacy-note`               | The draft privacy text on transcripts                                         |
| `player-captions-toggle`              | The player's CC `IconButton`; `data-state` `on`/`off` (only with a track)     |
| `player-captions-queued`              | The player's note that captions wait for capacity (`captionsState` `queued`)  |
| `player-captions-style`               | The captions style menu trigger (beside the CC toggle)                        |
| `player-captions-size-<size>`         | One size item (`small`, `medium`, `large`)                                    |
| `player-captions-contrast-<contrast>` | One contrast item (`standard`, `high`)                                        |

### Analytics, group appeals and attestations (W2-rollup-analytics, W2b-group-appeals, W2b-attestations)

| Test id                         | Element and attributes                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `analytics-page`                | The `/analytics` page container                                                                     |
| `analytics-broadcast-select`    | Broadcast picker trigger; `data-value` (broadcast id)                                               |
| `analytics-range`               | Range picker trigger; `data-value`                                                                  |
| `analytics-pending`             | "Shown 24 hours after the broadcast ends" state; `data-available-at`                                |
| `analytics-verified`            | Verified viewer seconds; `data-seconds`                                                             |
| `analytics-unverified`          | Unverified (pending, unjudged) viewer seconds; `data-seconds`                                       |
| `analytics-excluded-group`      | An excluded group row; `data-category`, `data-sessions`, `data-seconds`                             |
| `analytics-small-groups-hidden` | "n small groups hidden"; `data-count`                                                               |
| `analytics-delivery-source`     | A delivery-mix row; `data-source`, `data-bytes`, `data-share-bps`                                   |
| `analytics-cost`                | Marginal cost (owner only); `data-cents`                                                            |
| `analytics-chart-table`         | The table fallback of a chart                                                                       |
| `analytics-share-create`        | Creates an analytics share link                                                                     |
| `analytics-share-link`          | A share link row; `data-link-id`, `data-expires-at`                                                 |
| `analytics-share-revoke`        | Revokes a share link                                                                                |
| `group-appeal-open`             | "Appeal this group" on an excluded group; `data-state` `available`, `appealed` or `limited`         |
| `group-appeal-dialog`           | The appeal `Dialog`                                                                                 |
| `group-appeal-limit`            | Appeals left this week; `data-remaining`                                                            |
| `group-appeal-submit`           | Submits `appeals.create` (`exclusion_group`)                                                        |
| `group-appeal-status`           | The decided appeal's result; `data-status`, `data-category` (on other rows: the broadcast's appeal) |
| `attestations-panel`            | The owner's attestation list (`AttestationsPanel`)                                                  |
| `attestation-entry`             | One entry; `data-seq`, `data-kind`, `data-broadcast-id`, `data-entry-hash`                          |
| `attestation-share-create`      | Creates an attestation share link                                                                   |
| `attestation-share-link`        | A share link row; `data-link-id`, `data-expires-at`                                                 |
| `attestation-share-revoke`      | Revokes a share link                                                                                |
| `attestation-verify-page`       | The `/attestations/verify` page container                                                           |
| `attestation-verify-input`      | The statement or bundle input                                                                       |
| `attestation-verify-submit`     | Runs the verifier                                                                                   |
| `attestation-verify-result`     | The result; `data-valid` `true`/`false`, `data-reason` when false                                   |
| `attestation-verify-origin`     | The instance domain the statement names, shown prominently                                          |

### Enforcement report (W2-enforcement-report)

A hidden (below k = 10) figure's count attribute reads `suppressed` instead of a number.

| Test id                              | Element and attributes                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `enforcement-report`                 | The report section on `/transparency`                                               |
| `enforcement-report-window`          | Window `Select` trigger; `data-value` (`30d` or `YYYY-MM`)                          |
| `enforcement-report-window-<window>` | One item per window (`30d`, then the last 12 months as `YYYY-MM`)                   |
| `enforcement-report-group`           | One area's table; `data-group`                                                      |
| `enforcement-report-row`             | One rule; `data-rule-ref`, `data-count` or `data-suppressed="true"`                 |
| `enforcement-report-automated`       | A row's automated split; `data-fully`, `data-partially`, `data-not` (or suppressed) |
| `enforcement-report-overturn`        | A row's overturn rate; `data-numerator`, `data-denominator` (or suppressed)         |
| `enforcement-report-suppressed`      | The "fewer than 10" marker of a suppressed cell (its `Tooltip` trigger)             |
| `enforcement-report-total`           | The period's total; `data-count` (or `suppressed`)                                  |
| `enforcement-report-ncii`            | NCII 48 h compliance line; `data-on-time`, `data-late`, `data-pending`, `data-due`  |
| `enforcement-report-empty`           | `EmptyState` for a window with no actions                                           |

### Live DVR (W2-dvr)

| Test id                  | Element and attributes                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `player-dvr-scrubber`    | The scrubber (`role="group"`); its `input[type=range]` thumb is the slider; `data-behind-seconds`, `data-window-seconds` |
| `player-dvr-live`        | "Back to live" button (also `L` and `End`); shown in `dvr` mode                                                          |
| `player-dvr-behind`      | The behind-live readout; `data-seconds`                                                                                  |
| `player-dvr-source-note` | "Source quality only" note while in DVR                                                                                  |
| `dvr-settings`           | The DVR section on `/dashboard`                                                                                          |
| `dvr-enabled`            | DVR switch; `data-state` `on`/`off`                                                                                      |
| `dvr-window`             | Window `Select` trigger; `data-value` (seconds)                                                                          |
| `dvr-window-<seconds>`   | One item per window up to the instance cap (`instance.info` `features.dvrMaxWindowSeconds`)                              |
| `dvr-needs-vods`         | The note that DVR needs VODs (turning VODs on turns DVR on)                                                              |
| `dvr-save`               | Saves `channels.updateMediaSettings` (`dvr`)                                                                             |

### Rehearsal (W2-rehearsal)

| Test id                    | Element and attributes                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `rehearse-page`            | The `/rehearse` page container                                                         |
| `rehearsal-status`         | State; `data-state` `idle`, `armed`, `rehearsing` or `ended`, `data-remaining-seconds` |
| `rehearsal-arm`            | Arm button (`stream.rehearsal.arm`)                                                    |
| `rehearsal-disarm`         | Disarm button; opens a `ConfirmDialog`                                                 |
| `rehearsal-disarm-confirm` | The dialog's confirm button                                                            |
| `rehearsal-key-reminder`   | The stream key reminder (never the full key)                                           |
| `rehearsal-invitee-input`  | Invitee picker (followers only)                                                        |
| `rehearsal-invitee-add`    | Adds the picked follower                                                               |
| `rehearsal-invitee`        | An invitee; `data-username`                                                            |
| `rehearsal-invitee-remove` | Removes an invitee                                                                     |
| `rehearsal-invitee-limit`  | The "at most 5" notice once the list is full                                           |
| `rehearsal-checklist`      | The live checklist (`aria-live="polite"`)                                              |
| `rehearsal-check`          | One check; `data-check`, `data-state` `pending`, `ok` or `warn`                        |
| `rehearsal-player`         | The owner's player                                                                     |
| `rehearsal-report`         | The report; `data-ended-by` (`owner`, `cap`, `publisher`, `safety`)                    |
| `rehearsal-report-chat`    | Chat results; `data-accepted`, `data-held`, `data-rejected`                            |
| `rehearsal-report-ingest`  | Ingest checks; `data-dips`                                                             |
| `rehearsal-report-dip`     | One timed dip; `data-at`, `data-kind`                                                  |
| `rehearsal-watch`          | The invitee watch view (`stream.rehearsal.watch`)                                      |

### VOD and clip watch pages, replay panel (W2-vod-watch)

| Test id               | Element and attributes                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `vod-watch-page`      | The VOD page container; `data-vod-id`, `data-state` `ready`, `not-ready` or `gated`          |
| `clip-watch-page`     | The clip page container; `data-clip-id`, `data-state` as on the VOD page                     |
| `watch-not-found`     | `EmptyState` for anything the caller may not watch (never says why)                          |
| `watch-not-ready`     | "Not ready yet" for `processing` / `recording`                                               |
| `watch-title`         | The title                                                                                    |
| `watch-channel-link`  | The channel link (`ChannelAvatar`)                                                           |
| `vod-player`          | The VOD or clip player; `data-playhead` (wall clock, ISO 8601, empty before the first frame) |
| `vod-captions-toggle` | The CC toggle, only when `Vod.captions` has tracks                                           |
| `replay-panel`        | The replay panel (`role="log"`, no live announcements)                                       |
| `replay-row`          | A shown line; `data-at`, `data-message-id`, `data-catching-up` on a `catchingUp` line        |
| `replay-row-time`     | A line's time button (seeks the player)                                                      |
| `replay-catching-up`  | The "said while catching up" label on a `catchingUp` line                                    |
| `replay-not-retained` | Notice that chat for this video is no longer kept (`retained: false`, no items)              |
| `replay-empty`        | `EmptyState` for a video without chat                                                        |
| `replay-loading`      | The loading row while pages ahead are fetched                                                |

## Scenarios

Steps are pending until the unit that implements them merges (`harness/src/w2/steps.ts`,
`W2_EXTENSIONS` / `PENDING_W2_*`); a pending step runs only when named (`--set steps=`).

- **`e4b-money` (W2-splits):** a 2-way split proposed on `/crew` and accepted by the recipient; a
  tip releases a hold to each recipient; a chargeback follows the policy (own lot first, the owner
  covers the rest, no crew receivable); a won chargeback restores each slice; a fresh recipient's
  first payout is held by `new_payee`; `/transparency` shows `transparency-split-writeoff` and
  `transparency-split-suspense`; the ledger sums to zero.
- **`captions` (W2-captions):** SUBTITLES advertised; WER < 0.40 (ADR 0011 History); every cue available before the
  playhead's PDT reaches it at 8–10 s latency, with a Chromium viewer pressing
  `player-captions-toggle` and reading `video.textTracks`; VOD captions after the end; a second
  stream queued at the cap (`player-captions-queued`, `captions-track-state` `queued`) and started
  when the first ends; a VODs-off channel keeps no transcript; a rehearsal gets no track; a mask
  word masked.
- **`integrity-basic` (W2-rollup-analytics, W2b-attestations, W2b-group-appeals):** after the
  settle override the swarm's excluded groups (`analytics-excluded-group`) match its first-reason
  categories (a session's category is its highest-scoring reason's); the signed statement
  verifies with the SDK and on `/attestations/verify` (`attestation-verify-result`
  `data-valid="true"`), and a tampered payload or stored row fails; a group appeal
  (`group-appeal-open` → `group-appeal-submit`) succeeds, a second on the broadcast is limited; an
  admin overturns it; the re-run rollup counts the sessions verified and the chain gains a
  `supersede` entry (`attestation-entry` `data-kind="supersede"`) that verifies.
- **`trust-safety` (W2-enforcement-report):** read `transparency.enforcement`, run the T2 and T1
  actions, the counts go up and the automated split moves; a channel ban leaves counts unchanged;
  the overturned T2 appeal moves the rate; a below-k cell is suppressed. Web: `/transparency` shows
  `enforcement-report` with an `enforcement-report-suppressed` cell.
- **`live-dvr` (W2-dvr):** DVR heartbeats verify but are not live viewers; a Chromium viewer drags
  `player-dvr-scrubber` back (the `player` element's `data-playback-mode` becomes `dvr`), then
  `player-dvr-live` returns to `live`; an in-progress segment is 404; after removal or T0 `/dvr/` is
  404 within 5 s; a relay request for a DVR path is refused; a `subscribers` VOD's DVR refuses a
  non-subscriber; a `dm` token is refused; VODs off ⇒ `data-dvr-window="0"`.
- **`rehearsal` (W2-rehearsal):** `rehearsal-arm` on `/rehearse`, publish with the normal key
  (`rehearsal-status` `rehearsing`); no directory entry, no `stream.online`, no `stream_hours`,
  ledger or goal progress; direct inserts refused; the simulated chat and spam burst appear in
  `rehearsal-report-chat`; an invitee plays in `rehearsal-watch`, a signed-out viewer, a
  non-invitee and the embed are refused; the VOD expires at 24 h and is not public; audit rows for
  the arm and the invitee.
- **`timeline-sync` replay panel (W2-vod-watch):** after steps 1 and 3 leave a VOD with marker
  messages, a Chromium viewer opens `/$channel/vods/$vodId`, plays and seeks; `replay-row`s appear
  in `data-at` order and only once the playhead passes them; a catching-up line carries
  `replay-catching-up`; a blocked author's line is absent; a stranger gets `watch-not-found` on a
  `subscribers` VOD; an aged-out VOD shows `replay-not-retained`; the clip page shows the clip
  window's chat.
