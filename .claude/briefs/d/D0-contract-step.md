<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D0: contract step for the design batches (orchestrator)

The orchestrator does this alone, on `main`, before any D unit starts. It creates only the
shared scaffolding the units need, so that no two of them edit a shared file. Read
[README.md](README.md) and the user's answers to its decisions (a)–(d) first.

## 1. Message namespaces

Create these namespaces, empty, in `apps/web/src/i18n/locales/{en,es}/`, then run
`bun run i18n:gen` in `apps/web` and commit the generated `keys/*.gen.ts` and `keys/index.gen.ts`:

- `d1-discovery`
- `d2-channel`
- `d2-player`
- `d2-chat`
- `d3-watch`
- `d4-polish`
- `d5-studio`

Key prefixes follow the namespace: `discovery.*`, `channel.*` (D2-channel adds under
`channel.tabs.*`, `channel.offline.*` and `channel.meta.*`, so they do not collide with B8-web's
`b8-channel` keys), `player.*`, `chat.strip.*`, `watch.*`, `polish.*` and `studio.*`.
`d4-polish` also holds `pageTitle.*`. Every later unit adds its route titles in its own
namespace, as `pageTitle.<route>` keys.

## 2. Test ids

Add the D test ids to `harness/src/web/selectors.ts` (`TEST_IDS`). This file is the
orchestrator's; B8-harness owns `flows.ts`, not this file.

- **D1:**
  - `directory-page`, `directory-category-grid`, `category-page`, `category-tab-live`,
    `category-tab-videos`, `category-tab-clips`;
  - `search-page`, `search-results-channels`, `search-results-categories`, `header-search`;
  - `side-rail`, `side-rail-item`;
  - `home-hero`, `home-categories-shelf`, `home-recent-tile`.
- **D2:**
  - `channel-tabs`, `channel-tab-home`, `channel-tab-videos`, `channel-tab-clips`,
    `channel-tab-about`;
  - `channel-offline-hero`, `channel-video-grid`;
  - `channel-meta-category`, `channel-meta-uptime`, `channel-share`;
  - `player-controls`, `player-settings`, `player-fullscreen`, `player-theatre`, `player-pip`,
    `player-shortcuts-dialog`, `player-data-saver-chip`;
  - `chat-pinned-strip`.
- **D3:** `watch-meta`, `watch-channel-card`, `watch-more-grid`, `watch-share`.
- **D4:** `skip-link`, `empty-state-action`, `account-theme-switcher`.

Add a `ROUTES` entry for each new route, in the URL shape the user chose in decision (a).

## 3. The `d-surfaces` scenario skeleton

- Create `harness/scenarios/d-surfaces.ts`. It runs against a seeded stack (it refuses on an
  empty database). It signs in as the seeded viewer and streamer and runs each unit's steps from
  `harness/src/d/<unit>.ts`.
- Each step file exports one function, `(ctx) => Promise<void>`, and starts as a no-op that the
  unit fills in.
- Register the scenario in `harness/src/registry.ts`, and in `shards.ts` under `rest`.
- The units own their own step files.

## 4. What D0 does not do

- No oRPC, Zod or migration changes. The D units are web-only on existing contracts, apart from
  D1-api's server-side count.
- No component work.

Commit as `docs(briefs)`/`chore(web)` commits on `main` with `git commit -s`. Hand each unit
the resulting sha.
