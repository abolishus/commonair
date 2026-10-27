<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0031: Importing a channel from Twitch

- Status: proposed (2026-10-27; drafted with the maintainer's recommended answers; not to be
  accepted until counsel reviews the Twitch Developer Agreement and trademark terms)
- Date: 2026-10-27 (code checked at `ccf9c17`)

**Counsel has not reviewed this ADR.** Whether the Twitch Developer Agreement allows using its API
to move a streamer's own channel data to another service, and how the import page may name
Twitch, are open questions listed in [Open before acceptance](#open-before-acceptance). The
mechanism below is the recommended design; it does not claim to be permitted. Nothing ships
before counsel answers (N3 gate). This is not legal advice.

## Context

Milestone N3 (`.claude/briefs/next/N3-twitch-import.md`, batch 6 with W3 and N4) lets a streamer
moving from Twitch connect their Twitch account once and bring over their channel's title,
category, tags, description, panels, emotes and schedule. Followers cannot be copied: they are
other people's accounts, and they come over through W3-portability move links. feature-wins.md
§4.14 plans one versioned bundle schema shared by portability and this import
(`docs/product/feature-wins.md:775`) and lists the Developer Agreement and trademark review as its
open question (`:795`, `:939`).

What the code has today:

- **Twitch is already an optional adapter.** Sign in with Twitch is on only when
  `OAUTH_TWITCH_CLIENT_ID` and `OAUTH_TWITCH_CLIENT_SECRET` are set
  (`packages/config/src/env.ts:161-163`, `services/api/src/auth/index.ts:74-79`). Twitch is also a
  simulcast target (`packages/contracts/src/enums.ts:47`), and Twitch scope names map to CommonAir
  scopes for the IRC gateway (`packages/contracts/src/scopes.ts:31`).
- **Sign-in keeps Twitch tokens.** The auth library's `accounts` table has `accessToken` and
  `refreshToken` columns (`packages/db/src/schema/auth.ts:82-83`), which the library fills on
  OAuth sign-in; nothing in the auth config (`services/api/src/auth/index.ts`) encrypts them. The
  importer does not use them (decision 4).
- **Where imported data lands.** `channels` has `title`, `description`, `categoryId`, `tags`,
  `language` and `mature` (`packages/db/src/schema/channels.ts:43-51`). Panels are
  `channel_panels` rows whose body is "Markdown, rendered with a strict allowlist" (`:86`); the
  `setPanels` route scrubs text, accepts only http(s) links and only images that are the channel's
  own committed uploads (`services/api/src/routes/channels.ts:117-139`). Emotes are `emotes` rows
  with a code, an image key, a tier from 0 to 3 and an animated flag
  (`packages/db/src/schema/chat.ts:66-84`).
- **Every image goes through one upload pipeline.** `commitUpload` checks magic bytes, PDQ-hashes
  the image against the hash lists, runs the classifier, and only then copies it to its public
  key; emotes and panels are checked more strictly because they show outside the 18+ gate
  (`services/api/src/moderation/uploads.ts:4-17`). It lives in the API service.
- **There is no schedule.** No table or route holds a streaming schedule; "a schedule plus ICS
  feed" is a parked idea (`docs/product/feature-wins.md:1054`).
- **No import code** and no `packages/twitch`.

There are no self-hosters and no public instance, so nothing here has to stay compatible with
earlier data.

## Decisions

### 1. Twitch stays an optional adapter

The import page and procedures exist only when the Twitch OAuth credentials are set; otherwise
the page explains that Twitch import is not available on this instance. The harness
`--no-proprietary` profile hides it (AGENTS.md rule 3). The import uses the same Twitch app as
sign-in, with its own redirect URI.

### 2. Minimal, read-only access

This is the plan's minimal read-only access taken to its floor: the user authorization requests
**no scopes**. It proves that the CommonAir user controls the
Twitch account, and nothing more; `user:read:email` is not requested. The data itself is public
Helix data read with that token or the app token: the user (`GET /users`: description), the
channel (`GET /channels`: title, category, tags, language, content classification labels), the
channel's emotes (`GET /chat/emotes`) and, if it is ever imported, the schedule
(`GET /schedule`). The importer never scrapes pages and never calls undocumented APIs. The
subscriber count is not imported, so `channel:read:subscriptions` is not needed.

Proving control matters: without it, anyone could import someone else's Twitch channel and
present it as theirs.

### 3. The import is previewed and chosen, then converted to the portability bundle

After authorizing, the streamer sees a preview and picks what to import. The adapter
(`packages/twitch/**`, new) maps Helix data into the W3-portability bundle, and the same importer
that reads portability bundles applies it, so there is one import path and one set of tests. A
Twitch-sourced bundle has no signed moderation-standing statement; it is marked as such, and the
destination still runs the T0 hash gate and refuses channels under legal hold
(`docs/product/feature-wins.md:775`).

Mapping:

- Title, description, tags and language go to the `channels` columns, through the same validation
  as a studio edit.
- The category maps by name to a CommonAir category; no match leaves it unset.
- Any Twitch content classification label suggests `mature: true` in the preview. The importer
  never clears an existing mature label.

### 4. The Twitch token is used once and discarded

The authorization callback, in the API, exchanges the code, makes the read calls of decision 2,
stores the preview (public data only), and then revokes the token with Twitch. The token never
reaches the worker, a queue, the database or a log. There is no stored refresh token; importing
again means authorizing again. The tokens kept by Sign in with Twitch are not read.

### 5. Emotes: the streamer asserts ownership; same moderation and hashing as uploads; re-hosted

- Before emotes are imported the streamer confirms, in i18n text, that they own the emote art or
  have the right to use it here. The confirmation is recorded on the import record (user id,
  time, wording version).
- Each emote image is fetched from Twitch's image CDN (allowed hosts only, through the SSRF guard)
  and goes through the same pipeline as a direct upload: magic bytes, PDQ against the hash lists,
  the classifier, with the stricter emote thresholds. A rejected emote is skipped and reported in
  the result, with the same opaque reason an upload gets.
- Accepted images are stored as the channel's own uploads and served from our storage; nothing
  hotlinks Twitch.
- Subscriber tiers 1000/2000/3000 map to tiers 1 to 3; follower emotes map to tier 0; Bits and
  other emote types are skipped. A code that clashes with an existing emote is skipped and
  reported.
- Re-hosted emotes are uploads like any other: reportable, removable, and subject to DMCA notices.

The pipeline lives in the API (`services/api/src/moderation/uploads.ts`) and the import job runs
in the worker, so the job reaches it through one call path rather than a copy (the pipeline
already hands T0 matches to the worker as "the only implementation of the T0 actions",
`services/api/src/moderation/uploads.ts:9-10`). Whether that is an internal API call or moving
the pipeline into `packages/moderation` is settled in the N3 contract step.

### 6. Panels: re-hosted images, links kept, HTML stripped to the panel markdown subset

A panel's image is re-hosted through the same pipeline as emotes; its link is kept if it is
http(s); its text is converted to the panel markdown subset with all HTML removed, then passes
the same `setPanels` checks. This decision stands only if Twitch offers panels through a
documented API: Helix has no panels endpoint that we know of, and the importer must not scrape
(see Open before acceptance, item 6).

### 7. Schedule: carried in the bundle, not applied

CommonAir has no schedule feature. The bundle can carry schedule segments as optional data so the
format does not change later, but the importer does not apply them and the preview says so.

## Consequences

- Moving from Twitch takes minutes instead of retyping a channel, without holding any Twitch
  credential afterwards.
- A streamer can import art they do not own; the assertion, the moderation pipeline and DMCA
  handling are the controls, the same as for direct uploads.
- If Twitch changes Helix fields, the adapter breaks; the Helix mock in the harness pins the shape
  we expect, and a real-API smoke test is a manual pre-release step.
- The importer depends on W3-portability's bundle schema; N3 cannot finish before it.

## Alternatives considered

- **Request broad scopes (`channel:read:*`, `user:read:email`).** Not needed for public data;
  every scope is more to explain and more for counsel to clear.
- **Keep a refresh token for re-sync.** Rejected: a stored credential for another platform is a
  liability, and the import is one-off.
- **Hotlink emotes and panel images.** Rejected: it skips our moderation and hashing, leaks
  viewers' requests to Twitch (rule 4), and breaks when Twitch moves the file.
- **Scrape or use Twitch's undocumented GraphQL for panels.** Rejected by the N3 gate and likely by
  the Developer Agreement.
- **A separate Twitch importer beside the portability importer.** Rejected: two import paths
  means two sets of moderation gates to keep in step.

## Open before acceptance

Counsel questions (the N3 gate; feature-wins.md §7):

1. **Developer Agreement, purpose.** Does the agreement allow an app that uses the Twitch API to
   help a streamer move their own channel data to a service that competes with Twitch?
2. **Developer Agreement, data handling.** Do its caching, retention or deletion rules apply to
   data copied into the streamer's own channel on another service, and what must happen if the
   streamer later revokes the app?
3. **Emote and panel art.** Is the streamer's assertion of ownership enough for us to copy and
   re-host images fetched from Twitch's CDN, or do Twitch's terms on that content (or the art's
   licence) need more?
4. **Trademark.** May the page say "Import from Twitch" and show Twitch's name or logo on the
   connect button, under Twitch's brand guidelines and nominative use? Review `TRADEMARKS.md`
   with this in mind.
5. **App credentials.** May the sign-in app's client id and secret also serve the import, or does
   the agreement expect a separately registered app for a different purpose?

Product question, to settle with the maintainer at acceptance:

6. **Panels.** If counsel and the current Helix reference confirm there is no documented panels
   endpoint, panels drop out of v1 (decision 6 becomes a paste-in helper that converts text the
   streamer copies by hand), and the N3 plan and harness change to match.
