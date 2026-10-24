<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W0: feature-wins prerequisites

The spec is `docs/product/feature-wins.md` §5 "Wave 0" and the sections it cites. This file
records what changed since that doc (`8e5e14a`) and what done means now. None of the four units
has started.

## Decisions first

- **ADR 0012** media clock and Timeline Spine (feature-wins §7). W0-clock needs its first half
  (alignment method, skew targets); the chat retention and replay half can follow in W1.
- **ADR 0019** clause catalog and statement-of-reasons shape (the doc cites "ADR 0010" for SoR
  in one place; 0010 is production hosting, so read it as 0019).
- **ADR 0009 amendment:** the private in-progress recording prefix; whether `subscribers` and
  `private` VOD objects leave the public `vods/` prefix (recommended: yes, same change).
- **Counsel:** DSA Art. 17 statement content for EU instances. Ship the mechanism without it;
  the operator template carries the text.

## Units

| Unit              | State and corrections                                                                                                                                                                                                                                                                                                                                                                                             | Done when                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| W0-clock          | Not started: no `services/media/src/clock`, no absolute timestamps in `infra/mediamtx/mediamtx.yml`. Owner paths valid.                                                                                                                                                                                                                                                                                           | new `clock-skew` scenario: cross-rendition skew < 100 ms, live-to-VOD < 250 ms                                 |
| W0-integrity      | **Mostly done.** The 2H2 list is `PROGRESS.md:907` (not `:235`); `b30bc78` fixed appeal stickiness, stream-hour eligibility, relay suspension and indexes. Left: CDN sessions are not fetch-judged (`signals/fetch.ts:107`), fetch-unjudged sessions are not marked gate-ineligible, `integrity-basic` lacks the false-positive and CDN-bot cases, and the PROGRESS row was never closed. Size drops from M to S. | `integrity-basic` passes with fetch-less bot, CDN bot and false-positive cases; PROGRESS 2H2 row marked closed |
| W0-media-exposure | Not started: `services/media/src/vod/recorder.ts:23` writes `vods/${vodId}/` as segments close; `services/origin/src/media.ts:17` serves `vods` with no removal check.                                                                                                                                                                                                                                            | in-progress and removed VOD segments 404 via `/media`; `trust-safety` asserts it                               |
| W0-sor            | Not started: no `packages/moderation/src/reasons.ts`, no `me.enforcement` contract. `settings.appeals.tsx` and `packages/email/src/templates/trust.tsx` exist.                                                                                                                                                                                                                                                    | `trust-safety` asserts a statement for every platform T1/T2/NCII action; channel-mod actions get none          |

Paths are disjoint (W0-clock and W0-media-exposure split `services/media` by file, as the doc
says). E7-appeals also touches `services/worker/src/moderation/**`: give W0-sor `sor-*` files
only and sequence E7-appeals' worker change after it, or merge W0-sor first.

## Contract step

`me.enforcement.list`, the SoR shape, the new VOD prefix constant in `packages/contracts`,
`clock-skew` scenario stub, `docs/testing/w0-selectors.md`.
