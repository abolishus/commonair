<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1: feature-wins quick wins

The spec is `docs/product/feature-wins.md` §5 "Wave 1" (contract step contents and the unit
table) plus §4.1–4.6 and §4.11 for each feature. Nothing has started. Corrections since
`8e5e14a`:

| Unit           | Correction                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contract step  | `services/api/src/metrics.ts` still does not exist; `holdDays` still lives in `services/worker/src/money/{holds,config}.ts`. "Patronage runs are stubs" and "EventSub delivery is a stub" are stale (E5 `services/api/src/coop/patronage.ts`; worker webhooks). |
| W1-breakdown   | `packages/ledger/src/rules.ts` line references still hold. The breakdown can show the patronage estimate now that E5 exists (debate item 8 parked it "until E5").                                                                                               |
| W1-calm-chat   | No change. `message_set` report subject is still to add.                                                                                                                                                                                                        |
| W1-spine       | `services/chat/src/persistence.ts` exists: edit, do not create. The reason to avoid `routes/vods.ts`/`clips.ts` ("E6 owns") is gone; chat replay may attach to VOD routes directly.                                                                             |
| W1-watch-gate  | GA gate was "after 2H2": now "after W0-integrity's CDN fetch-judging". **ADR 0015** first.                                                                                                                                                                      |
| W1-fraud-floor | No change: `packages/integrity/src/payments/**` is new.                                                                                                                                                                                                         |
| W1b-data-mode  | Token minting is `services/api/src/routes/playback.ts:77` (`signPlaybackToken`), not `services/api/src/playback/**`. **ADR 0018** (claim in TS, Go and vectors) first.                                                                                          |

## Overlaps with other milestones

- E8 owns `services/chat/src/plugins/**`; W1-watch-gate owns `services/chat/src/{rules,cache}.ts`;
  W1-spine owns `clamp.ts`/`persistence.ts`. Keep them file-disjoint.
- N1 adds `services/worker/src/jobs/notify-go-live.ts`; W1-watch-gate adds `chat-surge-guard.ts`.
  Both edit `jobs/index.ts` and `jobs/names.ts`: those go in the contract step.

## Done when

`timeline-sync` and `surge-guard` scenarios exist and pass; `e4b-money` breakdown,
reconciliation and fraud-hold steps pass; `e2e-social` flood step passes; the throttled-viewer
step stays verified. All in `full`.
