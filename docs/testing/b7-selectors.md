<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 7 web ↔ harness contract (W3, N3, N4)

The batch 7 units (watch rooms, portability, giveaways, the advisory jury, surge raids, fair
predictions, the Twitch import and federation) and their harness scenarios agree on these
routes, the interact web seams and the `data-testid` values
(`.claude/briefs/batch7/README.md`, decisions (a)–(ad)). Changing one is a contract change: update
this file, the web app and the scenarios together. `apps/web/tests/selectors.test.ts` checks every
id below: an id is rendered somewhere in web or ui source, or it waits in `PENDING_B7_IDS` until
its unit merges (a pending id that is already rendered fails, so the list only shrinks).

## Rules

- Tests select by `data-testid`, never visible text (it is translated; the `en-XA` scan visits the
  new pages). Option items follow `<field>-<value>`; `<x>` in an id is a template its unit's render
  tests check, and the selectors test checks its literal prefix.
- Numbers on elements are plain integers in `data-*` (cents, seconds, counts, points); a
  suppressed figure carries `data-suppressed="true"` and no number.
- Every list item carries its entity id (`data-room-id`, `data-link-id`, `data-giveaway-id`,
  `data-case-id`, …). Remote federation handles are text, never links.
- Every surface a flag turns off (`GIVEAWAYS_ENABLED`, `TWITCH_IMPORT_ENABLED` with the Twitch
  credentials, `FEDERATION_ENABLED`; `instance.info().features`) renders its unavailable id or
  nothing, never an error.
- Harness-only hooks (contract step §2: `b7Tick`, `watchRoomAge`, `relayPurgeHold`) live behind
  `INTERNAL_API_SECRET` and `OPS_TEST_HOOKS=true`.

## Routes

| Route                             | What                                                                                  | Unit                         |
| --------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| `/m/$channel/$nonce`              | a move link's landing page: the channel card and a follow button                      | W3-portability               |
| `/move`                           | studio: move links, "moved to", bundle export and import                              | W3-portability               |
| `/import`                         | studio: import from Twitch, the panel paste-in helper                                 | N3-import                    |
| `/$channel/giveaways/$giveawayId` | public verify page: commitment, seed, entries, winners, the draw re-run               | W3-giveaways                 |
| `/coop/jury`                      | jury opt-in, and a seated juror's cases and votes                                     | W3-jury                      |
| `/admin/federation`               | admins: the domain block list and key rotation                                        | N4-web                       |
| `/dashboard`                      | gains the federation section (`FederationSettings` mount)                             | N4-web                       |
| `/settings/privacy`               | gains the portability grants (`PortabilityGrants` mount)                              | W3-portability               |
| `/transparency`                   | gains the jury results (`JuryResults` slot)                                           | W3-jury                      |
| `/admin/moderation`               | a `watch_room` report's detail gains its evidence (`WatchRoomEvidence`)               | W3-watch-rooms               |
| `/$channel`                       | gains the "moved to" notice (`MovedNotice`)                                           | W3-portability               |
| `/$channel` (the chat panel)      | gains the giveaway card (`GiveawayCard`) and the room drawer (`WatchRoomDrawer` slot) | W3-giveaways, W3-watch-rooms |

The studio pages are files `routes/_studio/move.tsx` and `import.tsx`, so their URLs are `/move`
and `/import` (the `_studio` layout adds no segment, as for `/crew`). The verify page's file is
`routes/_app/$channel_.giveaways.$giveawayId.tsx`: the trailing `_` keeps it out of the channel
page's route (which renders no outlet) while the URL stays `/$channel/giveaways/$giveawayId`.
`/admin/federation` is an admin page (`adminPageFor` / `mayOpenAdminPage`: admins only). Every new
route renders the not-found state until its unit merges. `harness/src/seed/routes.ts` has a
`SEED_ROUTES` row for each (the seed publishes a `giveawayId` and a move-link nonce in
`store.extra`). Nav: `/move` and `/import` are in the studio nav, `/coop/jury` in the co-op tabs
(`coopNav()`), `/admin/federation` in the platform tools for admins.

## Interact web seams (contract step)

Units build on these and never edit `chat/interact/{state,client,use-chat-interact}.ts` or
`chat/chat-panel.tsx`.

- `InteractClient.giveawayCurrent(channel)` (null with no giveaway, and always null while
  `features.giveaways` is false: the browser client reads `instance.info` once and then asks
  nothing) and `giveawayEnter({id})`.
- `routeEventFrame` routes `channel.giveaway.begin` / `channel.giveaway.end` to the giveaway card
  (malformed frames are dropped, never logged). `useChatInteract` returns `giveaway` (loaded on
  join, reloaded on every giveaway frame; an `end` moves it to drawn or cancelled at once) and
  `setGiveaway` (after the viewer's entry). `giveawayVisible`: open and closed, a drawn one for
  `RESULTS_VISIBLE_MS`, never a cancelled one.
- `chat-panel.tsx` mounts `GiveawayCard` (`chat/interact/giveaway-card.tsx`: `channel`,
  `giveaway`, `signedIn`, `client`, `onEntered`) in the pinned area, and `WatchRoomDrawer`
  (`components/watch-room/drawer.tsx`: `channel`, `signedIn`, `selfUsername`) beside the calm
  controls.
- Bets (decision (v)): the panel's client is `withPlayhead(client, channel)`, which stamps every
  `bet` with `mediaTs` (the channel's `playheadWallclock()`, ISO 8601, null before the first
  frame) and `playbackMode` (`live` or `dvr`) from `player/media-clock.ts`; a caller's own values
  win. The prediction card calls `client.bet({id, outcomeId, points})` as before.

## Test ids

### Navigation (contract step)

| Test id                 | Element and attributes                     |
| ----------------------- | ------------------------------------------ |
| `studio-move-link`      | Studio nav link to `/move`                 |
| `studio-import-link`    | Studio nav link to `/import`               |
| `coop-jury-link`        | Co-op tab link to `/coop/jury`             |
| `admin-federation-link` | Platform tools link to `/admin/federation` |

### Watch rooms (W3-watch-rooms)

| Test id                       | Element and attributes                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `watch-room-open`             | The chat panel's room trigger (`IconButton`); `data-state` `none`, `hosting` or `member`      |
| `watch-room-drawer`           | The drawer; `data-room-id`, `data-band` (`ROOM_AGE_BANDS`), `data-sync-target` (ISO or empty) |
| `watch-room-create`           | Creates a room (`watchRooms.create`)                                                          |
| `watch-room-band-notice`      | The age-band notice; `data-band`                                                              |
| `watch-room-mature-notice`    | "Mature content: adults only"                                                                 |
| `watch-room-invite-link`      | The invite URL (shown to the host)                                                            |
| `watch-room-invite-copy`      | Copies the invite (`IconButton`)                                                              |
| `watch-room-join`             | Join, on the invite landing (`?room=` on the channel page)                                    |
| `watch-room-join-refused`     | The refusal message; `data-code` (the `room_*` notice code)                                   |
| `watch-room-member`           | A member (`ChannelAvatar`); `data-user-id`, `data-host` `true`/`false`                        |
| `watch-room-chat`             | The room's side chat log                                                                      |
| `watch-room-input`            | The room chat input                                                                           |
| `watch-room-send`             | Sends a room message                                                                          |
| `watch-room-message`          | A room message; `data-message-id`, `data-user-id`                                             |
| `watch-room-report`           | A room message's report action                                                                |
| `watch-room-leave`            | Leave (a member); opens a `ConfirmDialog`                                                     |
| `watch-room-leave-confirm`    | The dialog's confirm button                                                                   |
| `watch-room-close`            | Close the room (the host); opens a `ConfirmDialog`                                            |
| `watch-room-close-confirm`    | The dialog's confirm button                                                                   |
| `watch-room-evidence`         | Mod queue: a `watch_room` report's evidence; `data-report-id`                                 |
| `watch-room-evidence-message` | One copied message; `data-user-id`, `data-at`                                                 |
| `watch-room-evidence-member`  | One copied member; `data-user-id`, `data-joined-at`, `data-left-at`                           |

### Portability (W3-portability)

| Test id                     | Element and attributes                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `move-page`                 | The `/move` page container                                                                  |
| `move-link-create`          | Creates a move link (`portability.links.create`)                                            |
| `move-link-expiry`          | Optional expiry `Select` trigger; `data-value`                                              |
| `move-link-new`             | The new link, shown once; `data-url`                                                        |
| `move-link-copy`            | Copies the new link (`IconButton`)                                                          |
| `move-link`                 | A link row; `data-link-id`, `data-conversions`, `data-state` `active`, `revoked`, `expired` |
| `move-link-revoke`          | Revokes a link; opens a `ConfirmDialog`                                                     |
| `move-link-revoke-confirm`  | The dialog's confirm button                                                                 |
| `move-to-url`               | The "moved to" https URL input                                                              |
| `move-to-save`              | Sets "moved to"; opens a `ConfirmDialog`                                                    |
| `move-to-confirm`           | The dialog's confirm button (`portability.move.set`)                                        |
| `move-to-current`           | The current "moved to"; `data-url`                                                          |
| `move-to-clear`             | Clears "moved to" (`portability.move.clear`)                                                |
| `move-subscriptions-note`   | The note that subscriptions are untouched                                                   |
| `bundle-export`             | Requests the bundle export (`portability.bundle.create`)                                    |
| `bundle-import-file`        | The bundle file input (`portability.imports.upload`)                                        |
| `bundle-import-preview`     | The preview; `data-import-id`                                                               |
| `bundle-import-standing`    | The standing badge; `data-state` `verified`, `unverified` or `refused`                      |
| `bundle-import-item`        | A previewed item; `data-kind`, `data-ref`                                                   |
| `bundle-import-item-toggle` | An item's include checkbox; `data-state` `on`/`off`                                         |
| `bundle-import-start`       | Starts the import (`portability.imports.start`)                                             |
| `bundle-import-result`      | The result; `data-status`                                                                   |
| `bundle-import-result-item` | A result item; `data-kind`, `data-ref`, `data-outcome`, `data-reason`                       |
| `move-landing`              | The `/m/$channel/$nonce` container; `data-state` `active`, `revoked` or `expired`           |
| `move-landing-follow`       | Follows through the link (`channels.follow` with `moveLink`)                                |
| `move-landing-gone`         | `EmptyState` for a revoked or expired link                                                  |
| `moved-notice`              | The channel page's "moved to" notice; `data-url`                                            |
| `portability-grants`        | The `/settings/privacy` section                                                             |
| `portability-grant`         | A followed channel's grant row; `data-channel`, `data-state` `on`/`off`                     |
| `portability-grant-toggle`  | A row's switch (`portability.grants.set`)                                                   |

### Giveaways (W3-giveaways)

| Test id                      | Element and attributes                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `giveaway-panel`             | The studio panel on `/interact`; absent while giveaways are off                                               |
| `giveaway-form`              | The open form                                                                                                 |
| `giveaway-title`             | Title input                                                                                                   |
| `giveaway-prize`             | Prize input                                                                                                   |
| `giveaway-winner-count`      | Winner count input                                                                                            |
| `giveaway-keyword`           | Chat keyword input (optional)                                                                                 |
| `giveaway-duration`          | Duration in minutes (optional)                                                                                |
| `giveaway-min-account-age`   | Eligibility: account age in days                                                                              |
| `giveaway-min-follow-days`   | Eligibility: days following (empty = following not required)                                                  |
| `giveaway-min-watch`         | Eligibility: verified-watch seconds                                                                           |
| `giveaway-open`              | Opens the giveaway (`interact.giveaways.open`)                                                                |
| `giveaway-live`              | The open giveaway; `data-giveaway-id`, `data-status`, `data-entries`                                          |
| `giveaway-commitment`        | The published seed commitment                                                                                 |
| `giveaway-close`             | Closes entries                                                                                                |
| `giveaway-draw`              | Draws the winners                                                                                             |
| `giveaway-cancel`            | Cancels; opens a `ConfirmDialog`                                                                              |
| `giveaway-cancel-confirm`    | The dialog's confirm button                                                                                   |
| `chat-giveaway`              | The viewer card; `data-giveaway-id`, `data-status`, `data-entries`                                            |
| `chat-giveaway-enter`        | Enter (`interact.giveaways.enter`)                                                                            |
| `chat-giveaway-entered`      | "You're in"                                                                                                   |
| `chat-giveaway-ineligible`   | Why the viewer cannot enter; `data-reason` (`Giveaway.me.reason`)                                             |
| `chat-giveaway-no-purchase`  | The "no purchase necessary" line                                                                              |
| `chat-giveaway-rules-link`   | The official rules (instance legal document)                                                                  |
| `chat-giveaway-verify-link`  | Link to `/$channel/giveaways/$giveawayId`                                                                     |
| `chat-giveaway-won`          | The viewer won                                                                                                |
| `giveaway-verify-page`       | The verify page container; `data-giveaway-id`, `data-status`                                                  |
| `giveaway-verify-commitment` | The commitment                                                                                                |
| `giveaway-verify-seed`       | The revealed seed (empty before the draw)                                                                     |
| `giveaway-verify-entry`      | An entry pseudonym; `data-index`; `data-mine="true"` on the signed-in entrant's own (the salt is never shown) |
| `giveaway-verify-winner`     | A winner; `data-rank`, `data-index`                                                                           |
| `giveaway-verify-result`     | The in-browser re-run; `data-match` `true`/`false`                                                            |

### Advisory jury (W3-jury)

| Test id                   | Element and attributes                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `jury-page`               | The `/coop/jury` page container                                                                                        |
| `jury-disabled`           | `EmptyState` while `jury.enabled` is false                                                                             |
| `jury-optin`              | The opt-in switch; `data-state` `on`/`off`                                                                             |
| `jury-optin-explainer`    | What jurors see, the blur, how to opt out                                                                              |
| `jury-ineligible`         | Why the caller cannot opt in (not an active adult member, staff); `data-reason`                                        |
| `jury-panel`              | The caller's seated panel; `data-panel-id`, `data-closes-at`                                                           |
| `jury-case`               | A case card; `data-case-id`, `data-kind`, `data-tier`, `data-automated` `true`/`false`                                 |
| `jury-case-clause`        | The clause title and version; `data-rule-ref`                                                                          |
| `jury-evidence-text`      | A kept text excerpt                                                                                                    |
| `jury-evidence-media`     | A kept media item, blurred by default; `data-revealed` `true`/`false`                                                  |
| `jury-evidence-reveal`    | Reveals one media item (behind its content warning)                                                                    |
| `jury-vote-<vote>`        | One button per `JURY_VOTES` value (`agree`, `disagree`, `unsure`)                                                      |
| `jury-reason`             | The reason `Select` trigger; `data-value`                                                                              |
| `jury-reason-<code>`      | One item per `JURY_REASON_CODES` value                                                                                 |
| `jury-vote-submit`        | Submits the vote                                                                                                       |
| `jury-voted`              | The submitted vote; `data-vote`, `data-reason`                                                                         |
| `jury-flag`               | Staff: a flagged case; `data-case-id`, with a link to the case                                                         |
| `jury-results`            | The `/transparency` section                                                                                            |
| `jury-results-row`        | One clause and tier; `data-rule-ref`, `data-tier`, `data-agree`, `data-disagree`, `data-unsure` (or `data-suppressed`) |
| `jury-results-suppressed` | The "fewer than 10" marker of a suppressed cell (its `Tooltip` trigger)                                                |
| `jury-results-seed`       | A closed panel's period, panel size and revealed seed; `data-panel-id`                                                 |
| `jury-results-empty`      | `EmptyState` with no closed panel                                                                                      |

### Surge raids (W3-surge-raids)

| Test id                    | Element and attributes                                                              |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `surge-raid`               | The mod banner's raid line; `data-from` (slug), `data-verified-count`, `data-until` |
| `surge-guard-on-raid`      | The studio "Protect raids" switch; `data-state` `on`/`off`                          |
| `surge-guard-on-raid-note` | The note that raiders who watched the source can chat at once                       |
| `raid-protection-note`     | The outgoing raid panel's note that the target may have raid protection on          |

### Fair predictions (W3-fair-predictions)

| Test id                      | Element and attributes                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `chat-prediction-locks-note` | "Locks at what you see" on the viewer card                                            |
| `chat-prediction-refused`    | A refused bet's reason; `data-reason` (`not_live`, `behind`, `team`, `unverified`, …) |
| `chat-prediction-result`     | The result card; `data-pool`, `data-winners`, `data-payout-sum`                       |
| `prediction-resolved-by`     | Studio: who resolved; `data-user-id`                                                  |
| `prediction-team-note`       | Studio: the note that the channel's team cannot bet                                   |

### Twitch import (N3-import)

| Test id                 | Element and attributes                                                         |
| ----------------------- | ------------------------------------------------------------------------------ |
| `import-page`           | The `/import` page container                                                   |
| `import-unavailable`    | The unavailable state (no credentials, or the flag off)                        |
| `import-connect`        | Connect (`twitchImport.connect`)                                               |
| `import-preview`        | The preview; `data-import-id`, `data-expires-at`                               |
| `import-field`          | A channel field and its checkbox; `data-field`, `data-state` `on`/`off`        |
| `import-emote`          | An emote; `data-code`, `data-tier`, `data-skip-reason` (empty when importable) |
| `import-schedule`       | The schedule, "carried, not applied"                                           |
| `import-mature`         | The mature suggestion                                                          |
| `import-assertion`      | The emote-art assertion checkbox; `data-version`                               |
| `import-start`          | Starts the import (`twitchImport.start`)                                       |
| `import-progress`       | Progress while the job runs; `data-status`                                     |
| `import-result-item`    | A result item; `data-kind`, `data-ref`, `data-outcome`, `data-reason`          |
| `import-panels-paste`   | The panel paste-in textarea                                                    |
| `import-panels-preview` | The live preview (`panelPaste`); `data-count`                                  |
| `import-panels-save`    | Saves through `channels.setPanels`                                             |

### Federation (N4-web)

| Test id                      | Element and attributes                                                          |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `federation-settings`        | The `/dashboard` section; absent while `features.federation` is false           |
| `federation-enabled`         | The on/off switch; `data-state` `on`/`off` (off asks through a `ConfirmDialog`) |
| `federation-handle`          | The `@slug@domain` handle, with its copy `IconButton`; `data-handle`            |
| `federation-followers`       | The remote follower list (`EmptyState` with none)                               |
| `federation-follower`        | A follower (handle and server as text); `data-follower-id`                      |
| `federation-follower-remove` | Removes a follower (with confirmation)                                          |
| `federation-admin-page`      | The `/admin/federation` page container                                          |
| `federation-block-domain`    | The domain input                                                                |
| `federation-block-add`       | Adds a domain block                                                             |
| `federation-blocks`          | The domain block list                                                           |
| `federation-block`           | A block; `data-domain`                                                          |
| `federation-block-remove`    | Removes a block (with confirmation)                                             |
| `federation-keys-rotate`     | "Rotate all keys" (with confirmation)                                           |

## Scenarios

Steps are pending until the unit that implements them merges (`harness/src/w3/steps.ts`,
`W3_EXTENSIONS` / `PENDING_W3_*`); a pending step runs only when named (`--set steps=`).

- **`watch-room` (W3-watch-rooms):** four Chromium viewers in a room (`watch-room-create`,
  `watch-room-invite-link`, `watch-room-join`), playhead delta under 500 ms after 30 s; one WebKit
  member under 1 s; a mixed-age join refused by the API (`watch-room-join-refused`) and by a
  direct insert; a minor refused on a mature channel; a channel-banned user and a blocked pair
  refused; a `watch-room-report` captures the transcript in `reports.evidence` with `channel_id`
  null (`watch-room-evidence` in the mod queue); the retention hook ages a room past 30 days and
  it is gone.
- **`portability` (W3-portability):** a `move-link-create` link converts through
  `move-landing-follow` (`source = move_link`, the count rises); a grant
  (`portability-grant-toggle`), then `move-to-confirm`: Mailpit receives exactly one moved notice
  and the channel page shows `moved-notice`; a bundle round-trips into a second channel
  (`bundle-import-start`, `bundle-import-result`); a T0 fixture emote is refused; a suspended
  channel's bundle is refused at import (`bundle-import-standing` `refused`).
- **`twitch-import` (N3-import; needs `oauth`):** `import-connect` through the mock; the preview
  shows the fixture channel; import title, tags, category, description and emotes with
  `import-assertion`; the channel page shows the title; accepted emotes work in chat and the T0
  emote is rejected with the T0 job run; `import-schedule` is carried, not applied; pasted panels
  (`import-panels-save`) show on the channel page; the mock recorded the revocation. The flag-off
  `import-unavailable` page is not a scenario step: the `w3` stack forces the flag on for every
  replica, so the API integration tests and web unit tests cover it.
- **`federation` (N4-api, N4-delivery, N4-web; `via=web` uses `harness/src/n4/web.ts`):**
  `federation-enabled` on; the peer resolves `@slug@domain` (`federation-handle`) and follows,
  receiving a signed `Accept`; going live delivers a signed `Create{Note}`, a VOD a
  `Create{Video}`; `Undo{Follow}` stops delivery; a `federation-block-add` domain's `Follow` is
  refused; a suspension delivers `Delete` of the actor; `federation-follower-remove` removes a
  follower.
- **`interact` extensions:** `giveaway` (W3-giveaways: with `GIVEAWAYS_ENABLED=true`,
  `giveaway-open` with a keyword; verified viewers enter by keyword and by `chat-giveaway-enter`; a
  viewbot is refused; close and draw; the harness re-runs the draw from `verify`, and
  `giveaway-verify-result` is `data-match="true"`; the flag-off refusal is an API integration test,
  not a step, since the `w3` stack turns the flag on for every replica),
  `surge-raid` (W3-surge-raids: the target turns on `surge-guard-on-raid`; a raid with three
  verified viewers and a viewbot swarm opens a `trigger: "raid"` surge shown as `surge-raid`; the
  verified raiders chat, the bots get the surge notice; a moderator override ends it) and
  `fair-prediction` (W3-fair-predictions: a far viewer's bet just after the wall-clock lock but
  before the media-time lock is accepted; the near viewer's later bet and a moderator's bet are
  refused, `chat-prediction-refused`; resolve: `chat-prediction-result` payouts sum to the pool,
  with an audit row).
- **`e5-coop` extension `jury` (W3-jury):** `jury.enabled` on; 12 members opt in (`jury-optin`);
  closed T1/T2 cases and reports plus one T0 and one NCII case; the draw hook seats a panel;
  jurors vote (`jury-vote-<vote>`, `jury-vote-submit`); close; the results are published with
  suppression (`jury-results-suppressed`), a majority-disagree case is flagged, no T0 or NCII case
  was sampled, and the seed matches the commitment (`jury-results-seed`).
- **`e2e-relay` extensions (W3-dvr-relay):** `dvr-relay`, `dvr-purge`, `relay-vtt` (no web ids).
- **B7-followups:** `trust-safety` `sor-resolve`, `integrity-basic` `group-appeal-threshold` and
  `rehearsal` `moderation-samples` (no new web ids).
