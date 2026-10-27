<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N3: import from Twitch

**Goal.** A streamer moving from Twitch connects their Twitch account once and brings over
their channel title, category, tags, description, panels, emotes and schedule. Followers cannot
be copied (they are other people's accounts); they come over through W3-portability move links.

## State

- Sign in with Twitch exists (`packages/config/src/env.ts:161-163`,
  `services/api/src/auth/index.ts:74`); `TWITCH_SCOPE_MAP` (`scopes.ts:31`) maps Twitch scope
  names to CommonAir scopes for the IRC gateway; Twitch is a simulcast target; the IRC gateway
  is Twitch-compatible.
- No import code. feature-wins §4.14 (lines 764-777) plans one bundle schema shared with the
  Twitch import.

## Gates

- **Counsel:** the Twitch Developer Agreement and trademark terms (feature-wins §7). Do not
  ship before the answer; the importer must not scrape.
- **W3-portability** fixes the bundle schema. The importer converts Twitch data into that
  bundle and feeds the same import path, so there is one importer and one set of tests.
- AGENTS.md rule 3: Twitch is a proprietary adapter; the instance runs without
  `OAUTH_TWITCH_CLIENT_ID` and `OAUTH_TWITCH_CLIENT_SECRET`, and the import page explains that
  it is unavailable.

## Decisions: [ADR 0031](../../../docs/decisions/0031-twitch-import.md) (proposed; counsel gate)

ADR 0031 departs from this plan in three places, each awaiting the maintainer (open:
maintainer): no scopes instead of `channel:read:*`; panels only if Twitch has a documented API
for them; the schedule carried in the bundle but not applied.

- Scopes: none are requested. The authorization only proves the streamer controls the Twitch
  account; the data is public Helix data. No `user:read:email`, no `channel:read:*` (the
  subscriber count is not imported).
- Emotes: the streamer asserts they own the art; imported emotes go through the same
  moderation and PDQ hashing as uploads (E4c), and are re-hosted, never hotlinked.
- Panels: images re-hosted, links kept, HTML stripped to the panel's markdown subset, only if
  Helix has a documented panels endpoint; otherwise panels drop out of v1 (open: maintainer).
- Schedule: CommonAir has no schedule feature, so imported segments have nowhere to land; the
  bundle carries them and the importer does not apply them (open: maintainer).
- The Twitch token is used once and discarded (no stored refresh token).

## Contract step

N3-job needs a stated route into the upload moderation pipeline in
`services/api/src/moderation/uploads.ts` (the worker job cannot import it): an internal API call
or moving the pipeline into `packages/moderation`. This is a contract request, settled in the N3
contract step.

## Units

| Unit       | Owns                                        | Builds                                                                       |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| N3-adapter | `packages/twitch/**` (new)                  | Helix client for the fields above, mapping to the portability bundle         |
| N3-job     | `services/worker/src/jobs/import-twitch.ts` | runs the adapter, re-hosts media through the upload path, feeds the importer |
| N3-web     | `apps/web/src/routes/_studio/import.tsx`    | connect, preview, choose what to import, progress, result                    |
| N3-mock    | `harness/src/mocks/twitch/**`               | a Helix mock serving fixture data (no real Twitch in tests)                  |

## Done means

`twitch-import` scenario against the mock: connect, preview, import, the channel page shows the
title, panels (if they stay in v1), emotes (hashed and moderated), and the schedule shown as
carried but not applied; `--no-proprietary` hides the page.
