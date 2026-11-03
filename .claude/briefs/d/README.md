<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Design batches D1–D5: plan, order and ownership

The D batches carry out the [November 2026 design review](../../../docs/design/2026-11-design-review.md)
(findings F1–F28, batches D1–D5). The review is the evidence. Each brief quotes the finding ids it
closes, and its "Done means" refers back to the screenshots in `docs/design/2026-11-review/`.

Planned at `8b48841e` (2026-11-03). Line numbers in the briefs are from that commit.

## What the batches change, and what they do not

- **Web work on existing contracts.** The API already serves everything these pages need:
  - `directory.home` (with `following` and `followingOffline`), `directory.live`,
    `directory.random`, `directory.ranking`;
  - `categories.list` and `categories.get`;
  - `search`;
  - `Channel.lastLiveAt`, `Channel.panels` and `Channel.bannerUrl`;
  - channel VODs and clips.

  The one server change is D1-api's category count (F20). No migrations and no new oRPC procedures.
  If a unit finds it needs one, that is a **contract request**, not an edit.

- **No new dependencies.** `packages/ui` already has `CategoryTile`/`CategoryGrid`
  (`blocks/media/category-tile.tsx`, unused by the app today), `PlayerChrome`/`PlayerControl`
  (`blocks/media/player-chrome.tsx`), `CommandPalette`, `Sidebar`, `Tabs`, `Popover`,
  `DropdownMenu` and the media cards. Build from those. A missing shadcn component is added with
  the shadcn CLI, and that counts as a dependency change only if it pulls a new npm package (it
  should not on Base UI).
- **The design rules in AGENTS.md are binding:**
  - Base UI shadcn, Rubik, Hugeicons;
  - colors only as tokens, dark mode first with a full light theme;
  - the house primitives table;
  - `t()` for every string;
  - WCAG AA, keyboard paths, visible focus, `prefers-reduced-motion`;
  - 320 px with a 16 px gutter.
- **Honest numbers stay honest.** `<ViewerCount>` shows verified viewers only (F12 changes the
  presentation of a low count, never the count).

## Units

| Unit                        | Findings                                                           | Wave | Gated on                          |
| --------------------------- | ------------------------------------------------------------------ | ---- | --------------------------------- |
| [D0](D0-contract-step.md)   | namespaces, test ids, the `d-surfaces` scenario skeleton           | 0    | none (orchestrator)               |
| [D4](D4-polish.md)          | F13, F14 (no-flash half), F15, F16, F17, F19 (UI half)             | 1    | D0                                |
| [D1-seed](D1-seed.md)       | F10 (seed half), F12 (seed half), F19 (seed half), avatars and art | 1    | D0                                |
| [D1-api](D1-api.md)         | F20                                                                | 1    | D0                                |
| [D5-capture](D5-capture.md) | the signed-in visual pass; evidence for F21–F28                    | 1    | D0; the user signs in (see unit)  |
| [D1-web](D1-web.md)         | F1, F7, F8, F10 (fallback tile), F14 (switcher move), F18          | 2    | D4, D1-api merged                 |
| [D2-channel](D2-channel.md) | F2, F4, F9, F12 (UI half), F13 for the channel page                | 2    | D4 and batch 8's B8-web merged    |
| [D2-player](D2-player.md)   | F3, F5                                                             | 2    | D4 and batch 8's B8-player merged |
| [D2-chat](D2-chat.md)       | F6                                                                 | 2    | D4 and batch 8's B8-web merged    |
| [D3-watch](D3-watch.md)     | F11                                                                | 3    | D2-channel and D2-player merged   |
| [D5-studio](D5-studio.md)   | F21–F28                                                            | 3    | D5-capture's evidence; D4 merged  |

At most six units run at once (AGENTS.md). Wave 1 is four units. It may run beside batch 8's
wave 2 because the paths are disjoint (see the matrix). Wave 2 is four units, wave 3 is two.

## Why this order

- **D4 first.** Its F15 work puts a `head()` in nearly every route file, and its source-policy
  test enforces that. Landing it first means every later unit only adds titles for the routes it
  creates, and nobody else edits a route file just for its title.
- **Batch 8's web units before D2.** B8-web owns `$channel.tsx`, `components/channel/{panels,banner}*`
  and `chat/interact/prediction-card.tsx`; B8-player owns `player/dvr*` and `room-sync*`. D2
  rebuilds exactly those surfaces, so it starts from batch 8's merge, not beside it. D2-channel
  places B8-web's panels and banner in the About tab; it does not rewrite them.
- **D1-api before D1-web.** F20: the directory must not ship counts that read 0 for a live
  category.
- **D3 after D2.** D3's "More from" grid and channel card reuse the VOD and clip grid D2-channel
  builds in `components/channel/`.
- **D5-capture early, D5-studio late.** The capture needs no code and gives D5-studio real
  screenshots instead of code reading. D5-studio needs D4's title work merged first, because it
  edits studio route files.

## Path ownership by wave

A unit writes only its paths. Everything else is read-only for it, and a needed change elsewhere
is a contract request in its final message.

**Wave 1**

| Unit       | Owns                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D4         | `head()` in every `apps/web/src/routes/**` file **except** the batch 8 files below; `routes/__root.tsx`; `routes/_app/signin.tsx`, `routes/_app/signup.tsx`; `components/password-fields.tsx`, `components/altcha-field.tsx`; `components/coop/overview.tsx`; `packages/ui/src/layouts/app-shell.tsx`; the `d4-polish` namespace; `apps/web/tests/d4-*` and the `head` check added to `tests/source-policy.test.ts` |
| D1-seed    | `harness/src/seed/**` (not `seed/media/live-io.ts`'s chat client), `harness/tests/seed/**`, `harness/fixtures/seed/**` (new, generated art)                                                                                                                                                                                                                                                                         |
| D1-api     | `services/api/src/routes/directory.ts` (the category count only) and its tests                                                                                                                                                                                                                                                                                                                                      |
| D5-capture | `docs/design/2026-11-review/signed-in/**` (new) and an addendum section in `docs/design/2026-11-design-review.md`                                                                                                                                                                                                                                                                                                   |

D4 leaves these route files to their batch 8 owners and then to D2: `routes/_app/$channel.tsx`,
`routes/_admin/admin.moderation.tsx`, and every file under the B8-web and B8-server
ownership lists. D4's policy test lists them as `PENDING_HEAD` with a comment naming the unit
that removes each one. The list must be empty when wave 3 merges.

**Wave 2**

| Unit       | Owns                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1-web     | `routes/_app/index.tsx`; `routes/_app/directory.*` and `routes/_app/search.tsx` (new); `components/directory.tsx`; `components/discovery/**` (new); `lib/directory-sections.ts`; `components/site-chrome.tsx`; `lib/nav.ts` (the public and account menus only, not the studio list); `packages/ui/src/layouts/app-shell.tsx`; `packages/ui/src/blocks/media/category-tile.tsx`; the `d1-discovery` namespace |
| D2-channel | `routes/_app/$channel.tsx`; `components/channel/**` (B8-web's panels and banner included); `packages/ui/src/blocks/media/channel-header.tsx` and its stories; the `d2-channel` namespace (plus B8-web's `b8-channel`)                                                                                                                                                                                         |
| D2-player  | `apps/web/src/player/**` except `player/p2p/**`; `packages/ui/src/blocks/media/player-chrome.tsx` and its stories; `components/vod-watch/vod-player.tsx`; the `d2-player` namespace (plus `w1-data-mode`)                                                                                                                                                                                                     |
| D2-chat    | `apps/web/src/chat/**`; the `d2-chat` namespace                                                                                                                                                                                                                                                                                                                                                               |

**Wave 3**

| Unit      | Owns                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D3-watch  | `routes/_app/$channel_.vods.$vodId.tsx`, `routes/_app/$channel_.clips.$clipId.tsx`, `components/vod-watch/**` except `vod-player.tsx`, `components/watch/**` (new), the `d3-watch` namespace                                                                                                                                                                                                              |
| D5-studio | `routes/_studio/**`, `routes/_admin.tsx`, `routes/_admin/**` (not moderation), `routes/_app/settings.*`, `components/{analytics,money,relays.tsx,stream-health-card.tsx,mod,attestations,coop/council.tsx,coop/proposal.tsx}`, `components/settings/**` (new), `lib/nav.ts` (the studio and admin lists only), `packages/ui/src/blocks/studio/**`, `packages/ui/src/charts/**`, the `d5-studio` namespace |

`lib/nav.ts` is split by section. D1-web and D5-studio are in different waves, so they never
hold it at the same time.

## Shared rules for every D unit

- Read AGENTS.md, PLAN.md, `docs/architecture.md`, the design review, this README, D0's contract
  step, and `.claude/briefs/_done-means.md`. "Done means" there is binding. You run targeted
  checks only, and the user does every browser and visual check.
- Work in your own worktree on branch `d/<unit>` (for example `d/d1-web`), cut from the sha the
  orchestrator gives you.
- **Seeded data is the test bed.** The user checks your work against a seeded stack (`seed full`
  at small or medium). Every "Done means" item names the seeded account or channel that shows
  it, for example `demo_streamer1` (live, Art) or `newbie` (empty everywhere).
- **Storybook for every new or changed `packages/ui` block.** Cover:
  - dark and light;
  - 320 px and 1440 px;
  - the empty, loading and long-text cases.
- **Tests.** Write component tests for the new UI under `apps/web/tests/d<n>-*.test.tsx`, and pure
  logic tests (sorting, dedupe, formatting) exhaustively. Each unit adds its steps to
  `harness/src/d/<unit>.ts` for the `d-surfaces` scenario that D0 creates, using the test ids D0
  registered.
- **Accessibility is part of done.** Check:
  - every new control has a keyboard path and a visible focus ring;
  - icon-only controls use `<IconButton tooltip>`;
  - landmarks and headings are in order;
  - `aria-live` is used only where something really announces;
  - motion is off under `prefers-reduced-motion`.
- **No fake richness.** Never invent numbers, thumbnails or activity in the UI to make a page look
  fuller. Fuller pages come from the seed (D1-seed) and from surfacing data the API already
  returns.

## Decisions (answered by the user, 2026-11-03)

- **(a) URL shape: `/directory`, `/directory/$category` and `/search?q=`**, as on Twitch and in the
  E4a boards. The nav label stays "Browse".
- **(b) Theatre mode keeps chat docked on the right**, as on Twitch. Theatre mode also gets a
  chat-collapse button for a full-width player (D2-player owns the button; D2-channel lays out
  both states).
- **(c) The signed-in pass: the user signs in, the unit captures.** For each seeded role, the user
  signs in in the built-in browser pane, and D5-capture takes the screenshots. The unit never
  sees, types or stores the password.
- **(d) Generated art: CC0 SVGs made in the harness** from a seeded RNG, uploaded through the
  normal media API. Abstract only (gradients and geometric shapes). Never faces, and nothing that
  could pass for a real person or brand. No fetched images.
