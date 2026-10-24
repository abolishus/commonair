<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N3: import from Twitch

**Goal.** A streamer moving from Twitch connects their Twitch account once and brings over
their channel title, category, tags, description, panels, emotes and schedule. Followers cannot
be copied (they are other people's accounts); they come over through W3-portability move links.

## State

- Sign in with Twitch exists (`packages/config/src/env.ts:160-163`,
  `services/api/src/auth/index.ts:74`); `TWITCH_SCOPE_MAP` (`scopes.ts:30`) maps bot scopes;
  Twitch is a simulcast target; the IRC gateway is Twitch-compatible.
- No import code. feature-wins §4.14 (lines 764-777) plans one bundle schema shared with the
  Twitch import.

## Gates

- **Counsel:** the Twitch Developer Agreement and trademark terms (feature-wins §7). Do not
  ship before the answer; the importer must not scrape.
- **W3-portability** fixes the bundle schema. The importer converts Twitch data into that
  bundle and feeds the same import path, so there is one importer and one set of tests.
- AGENTS.md rule 3: Twitch is a proprietary adapter; the instance runs without
  `TWITCH_CLIENT_ID`, and the import page explains that it is unavailable.

## Decisions (ADR 0030, short)

- Scopes requested (read-only: `user:read:email` is not needed; `channel:read:*` for schedule
  and subscriptions count only if shown).
- Emotes: the streamer asserts they own the art; imported emotes go through the same
  moderation and PDQ hashing as uploads (E4c), and are re-hosted, never hotlinked.
- Panels: images re-hosted, links kept, HTML stripped to the panel's markdown subset.
- The Twitch token is used once and discarded (no stored refresh token).

## Units

| Unit       | Owns                                        | Builds                                                                       |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| N3-adapter | `packages/twitch/**` (new)                  | Helix client for the fields above, mapping to the portability bundle         |
| N3-job     | `services/worker/src/jobs/import-twitch.ts` | runs the adapter, re-hosts media through the upload path, feeds the importer |
| N3-web     | `apps/web/src/routes/_studio/import.tsx`    | connect, preview, choose what to import, progress, result                    |
| N3-mock    | `harness/src/mocks/twitch/**`               | a Helix mock serving fixture data (no real Twitch in tests)                  |

## Done means

`twitch-import` scenario against the mock: connect, preview, import, the channel page shows the
title, panels, emotes (hashed and moderated) and schedule; `--no-proprietary` hides the page.
