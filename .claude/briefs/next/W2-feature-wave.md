<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2: feature-wins wave 2

The spec is `docs/product/feature-wins.md` §5 "Wave 2" and §4.5, 4.7–4.10, 4.11, 4.12. Nothing
has started. Decisions first: **ADR 0011** (captions models, whisper.cpp and weights licenses),
**0013** (ledger splits), **0014** (attestation key), **0016** (DVR); counsel on payee and
contractor status for split recipients before W2-splits ships.

Corrections since `8e5e14a`:

| Unit                  | Correction                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W2-captions           | `scripts/fetch-model.ts` exists and fetches the moderation classifier (`packages/moderation/src/model.ts`): extend it with a second model entry, do not replace it. `routes/playback.ts:182` hardcodes `captions: []`. The "worker cap becomes a governance setting after E5" can be a governance setting now. `packages/chat-filter` extraction is still to do (contract step). |
| W2-rollup-analytics   | Owns `integrity.channelSummary` (the one integrity stub E7 leaves).                                                                                                                                                                                                                                                                                                              |
| W2-enforcement-report | The page is `apps/web/src/routes/_app/transparency.tsx`; the existing component is `components/money/transparency.tsx`. "Shared with E5" is no longer a constraint.                                                                                                                                                                                                              |
| W2-dvr                | Needs W0-media-exposure merged. No route seam in `services/origin/src/handler.ts` yet (contract step).                                                                                                                                                                                                                                                                           |
| W2-rehearsal          | `services/api/src/stream/` holds only `ingest.ts`; `rehearsal.ts` is new. Its alert checks need E8 (goals, raids) for the full flow; ship without them if E8 has not merged.                                                                                                                                                                                                     |
| W2b-*                 | Gates cite `PROGRESS.md:235`; read `:907`. Appeal stickiness is met.                                                                                                                                                                                                                                                                                                             |

## Done when

`captions` (WER, cue timing, VOD), `live-dvr` and `rehearsal` scenarios pass; `e4b-money`
per-recipient release, clawback and won-chargeback steps pass; `integrity-basic` group,
signed-attestation and tamper steps pass; `trust-safety` report assertions pass.
