<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D1-seed: avatars, category art, verified viewers and unique proposal titles in the seed

You are implementing unit D1-seed for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md;
- `.claude/briefs/d/README.md` and `D0-contract-step.md`;
- `.claude/briefs/_done-means.md`;
- `docs/testing/seeding.md` (units, scales, resume, what is and is not restored);
- the design review, findings **F10, F12 and F19**, with screenshots 02, 09 and 16.

Do not look outside the repository. This is **wave 1**: work on branch `d/d1-seed`, cut from D0's
sha.

## Why

A seeded stack still looks empty. Every avatar is an initial, every category's `boxArtUrl` is
`null`, live channels read "0" viewers, and the co-op decision list repeats titles ("(2)", "(3)").
The UI work in D1-web and D2 is judged against the seeded stack, so the seed has to carry the
identity a real instance would.

## You own (write only these)

- `harness/src/seed/**`, except the chat client calls in `seed/media/live-io.ts`. You may add the
  viewer driver there, but do not change the chat send path, which is the fix from `8cab19e4`.
- `harness/tests/seed/**`.
- `harness/fixtures/seed/**` (new): generated art only, never fetched.
- `docs/testing/seeding.md`: the sections for what you add.

**Read-only:** `packages/contracts/**`, `services/**`, `apps/web/**` and `harness/src/web/**`.
Uploads go through the public API (`ApiClient`), as the other seed units do.

## Build

1. **Avatars (F10).**
   - Every seeded user with a channel gets an avatar, and about 70% of viewer-only users do.
   - Generate deterministic SVGs from the run's seeded RNG: geometric or gradient compositions,
     never photos or faces. Use the user's id as the RNG salt, so a resume regenerates the same
     art.
   - Rasterize to WebP only if the avatar upload endpoint refuses SVG. Check the endpoint's
     accepted types first, and record the choice in `seeding.md`.
   - Upload through the same endpoint the settings page uses.
   - The art is CC0. State that in `REUSE.toml` if any generated file is committed (prefer
     generating at run time and committing nothing).
2. **Category art (F10).**
   - Every seeded category gets box art, using the same generator in a tall 3:4 format.
   - If no API sets `boxArtUrl`, stop. Write a **contract request** with the exact procedure an
     admin would need, and leave the UI fallback to D1-web.
3. **Banners and panels.**
   - Each of `demo_streamer1`–`3` gets a channel banner and 3–5 panels: title, text body, and an
     optional image and link to `example.org` paths only.
   - Use the channel appearance API.
   - If B8-web has not merged, nothing renders them yet. Seed them anyway.
4. **Verified viewers for live channels (F12).**
   - `seed live` keeps a small, stable set of seeded viewer accounts (3–15 per live channel,
     varied by channel) watching through the real playback and heartbeat path, so
     `<ViewerCount>` shows verified numbers.
   - Reuse the harness viewer machinery the `viewers` scenario uses. Do not write counts into the
     database or Valkey.
   - Respect the integrity rules: the viewers are real sessions with the same pacing a real
     viewer has.
   - If verification needs signals the harness cannot honestly produce, say so in your final
     message rather than gaming it.
5. **Unique proposal titles (F19).** The coop unit's filler proposals get distinct, plausible
   titles from a list, instead of a "(2)" suffix.
6. **Recently live variety.** Make sure at least 6 channels outside the live set have a VOD with a
   thumbnail, so D1-web's thumbnails on recent tiles have data at small scale too.

## Tests you must add

- The generator is deterministic: the same salt gives byte-identical SVG, and different salts
  differ.
- The SVGs are valid and small: under 8 KB each, with no `<script>`, `<foreignObject>` or external
  `href`.
- The plan counts per scale: avatars, banners, panels, art, viewers.
- The viewer driver's lifecycle: it starts, renews and stops cleanly when `seed live` aborts.
  Use fake timers, in the style of `live.test.ts`.
- Proposal titles are unique.
- Extend the resume tests: a resume after social does not re-upload avatars that already exist.

## Done means

- The `_done-means.md` checks pass for `harness`.
- Your final message gives the user's live check:
  - `seed full --scale small` on a fresh stack;
  - then `seed live`;
  - then, on `/`, avatars on cards, and live cards with a verified count above 0 within a few
    minutes;
  - `/api/categories` with `boxArtUrl` set (or the contract request).
