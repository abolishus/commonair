<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# After rc.1: milestone plans

Everything left once `v0.1.0-rc.1` ships, as milestones in the same shape as E1–E6: a contract
step by the orchestrator, then at most six units in parallel on disjoint paths, each reviewed
before merge, merged only with `bun run verify` green and the milestone's harness scenario passing
against the harness stack. Unit briefs for a milestone go in `.claude/briefs/<id>/` and follow the
AGENTS.md template; the plan file here is what those briefs are cut from.

State checked at `ef9f2b3` (2026-10-23). Line numbers below are from that commit. Updated at
`35ad653` (2026-10-26): rc.1 and rc.2 are released and upgraded on a DigitalOcean droplet, ADR
0025 (proposed) moves hosting to DigitalOcean, the planned ADRs moved up one number, and S1
(scaling) was added. Later that day the user accepted ADR 0025 (Railway retired, staging is
the rc droplet), chose managed Postgres and Valkey at S1 stage 1 with the same external option
for self-hosters, held `v0.1.0` for R0-g (landed the same day, `6a1983f`), and moved P1 into batch 2.

## Milestones

| Id                             | What                                                                                     | Gated on                                                   | Done when                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| [R0](R0-release.md)            | rcs → `v0.1.0`: rc.1/rc.2 done on a droplet; restore, Fedora, the self-hosting leftovers | ADR 0025 decision; the staging droplet                     | restore onto a second droplet timed; `v0.1.0` tagged           |
| [E7](E7-platform-debts.md)     | the 18 small stubs, open contract requests, E4c/E5 follow-ups                            | none                                                       | `trust-safety`, `e2e-social`, `e5-coop` extended and green     |
| [E8](E8-interactivity-bot.md)  | PLAN 3D: polls, predictions, raids, goals, channel points, the built-in channel bot      | ADR 0026                                                   | new `interact` and `channel-bot` scenarios                     |
| [E9](E9-developer-platform.md) | PLAN 3C: OAuth apps, EventSub (webhook + WebSocket), developer console, `@commonair/sdk` | ADR 0027                                                   | new `developer-platform` scenario; `e2e-social` uses the SDK   |
| [W0](W0-prerequisites.md)      | feature-wins Wave 0: media clock, integrity close-out, private VOD prefix, SoR           | ADRs 0012, 0019, 0009 amendment; counsel on DSA statements | `clock-skew`; `trust-safety` and `integrity-basic` extended    |
| [W1](W1-quick-wins.md)         | feature-wins Wave 1: breakdown, Calm Chat, Spine, watch gate, fraud floor, data mode     | W0 (per unit); ADRs 0015, 0018                             | `timeline-sync`, `surge-guard`; `e4b-money` extended           |
| [W2](W2-feature-wave.md)       | feature-wins Wave 2: splits, captions, analytics, enforcement report, DVR, rehearsal     | W1 (per unit); ADRs 0011, 0013, 0014, 0016                 | `captions`, `live-dvr`, `rehearsal`; others extended           |
| [W3](W3-feature-wave.md)       | feature-wins Wave 3: watch rooms, portability, giveaways, jury, surge raids, predictions | W2, E8; ADR 0017                                           | `watch-room`, `portability`                                    |
| [N1](N1-notifications-pwa.md)  | go-live notifications (in-app, email, web push, Discord adapter) and the installable PWA | ADR 0028                                                   | new `notifications` scenario                                   |
| [N2](N2-i18n-weblate.md)       | real i18n (locale negotiation, a second locale, plurals) and Hosted Weblate (libre plan) | ADR 0029                                                   | `i18n` unit gate; `e2e-basic` under a second locale            |
| [N3](N3-twitch-import.md)      | import channel info, panels, emotes and schedule from Twitch                             | counsel on the Twitch Developer Agreement; W3 bundle shape | `twitch-import` scenario against a Twitch mock                 |
| [N4](N4-federation.md)         | ActivityPub: followable channels, go-live posts                                          | N1 (go-live event), ADR 0030                               | `federation` scenario against a second instance                |
| [M1](M1-money-follow-ups.md)   | ADR 0007 follow-ups, Stripe Connect transfers, E5 money follow-ups                       | counsel and a legal entity before any live keys            | `e4b-money` and `e5-coop` extended (stripe-mock)               |
| [P1](P1-p2p-client.md)         | the browser P2P client, so `bytesP2p` stops being 0                                      | ADR 0005 amendment                                         | `viewers` scenario reports real P2P bytes, integrity unchanged |
| [S1](S1-scaling.md)            | scaling and availability on DigitalOcean: capacity numbers, targets, staged topology     | ADR 0032; R0-b for stage 1                                 | new `multi-instance` scenario; `failover` on real droplets     |
| [L1](L1-public-instance.md)    | the first public instance (ADR 0025)                                                     | user decisions, counsel, a tested restore, S1-a            | the launch checklist in the plan, signed off by the user       |

Ads stay a governance question (ROADMAP.md); no engineering milestone until members vote.

## Order

Batches, each at most six units at a time (AGENTS.md, PLAN.md "Milestones"):

1. **R0** now, with S1's ADR, S1-a (capacity), S1-c (`multi-instance`) and S1-g (IaC): S1 owns
   `harness/scenarios/{load-plan,multi-instance}.ts` and `infra/tofu/**`, R0 neither.
2. **E7 + W0 + P1** together: disjoint paths (E7 is API routes and small web pages; W0 is
   `services/media`, `packages/integrity`, `services/worker/src/moderation`, the VOD prefix; P1
   is `apps/web/src/player/p2p/**` and `services/tracker/**`). P1 moved up because DigitalOcean
   meters egress: until it ships, every viewer without a relay is served from the origin.
3. **E8 + E9**, plus N2's infrastructure unit (it only touches `apps/web/src/i18n/**` and email
   catalogs). E8 owns `services/chat/src/plugins/**` and `routes/{interact,bot}.ts`; E9 owns
   `routes/developer.ts`, the OAuth routes and `packages/sdk`. E9's EventSub WebSocket
   carries E8's events, so E8's contract step lands first.
4. **W1 + N1.** N1's go-live job and W1's watch gate both touch `services/worker/src/jobs/`, on
   different files.
5. **W2.**
6. **W3 + N3 + N4.** W3 portability fixes the bundle shape that N3 imports into and N4
   federates.

The rest of S1 follows its own order (S1-b after R0-b; S1-e only near the stage 3 trigger).
M1 and L1 are not batched: M1 can run on stripe-mock at any time but must not take live keys
before counsel; L1 is the user's. No P2P claim ships before P1.

## Shared decisions the user owns

- ADRs: all written as of 2026-10-27. Accepted: 0011–0019 (feature-wins candidates), 0022,
  0025, 0026 E8, 0027 E9, 0028 N1, 0029 N2, 0030 N4, 0032 S1. Proposed: 0031 N3 (waits for
  counsel), 0033 SeaweedFS (waits for its phase 0 spike).
- Settled 2026-10-26: ADR 0025 accepted; managed Postgres and Valkey for our instance at S1
  stage 1, with `selfhost.sh` support for external managed services for every operator; launch
  target 99.5%, 99.9% from stage 1; `v0.1.0` waits for R0-g (done) but not for E7 (E7 ships in
  `v0.2.0`).
- Production region and droplet size (after S1-a).
- Release cadence after `v0.1.0`: one minor per milestone batch, patch releases for R0-class
  fixes.
- Which counsel questions to fund (DSA statements, Twitch terms, split-recipient status,
  sweepstakes rules, real money movement).

## Corrections to older plans

feature-wins.md was written at `8e5e14a`, before E5, E6 and Phase 5. Its waves still hold; these
facts changed and each wave plan here carries the fix:

- The 2H2 integrity list is `PROGRESS.md:907`, not `:235`, and most of it is done in code
  (`b30bc78`): appeal stickiness (`packages/integrity/src/allowance.ts`), stream-hour
  eligibility (`packages/integrity/src/jobs.ts:756`), relay suspension, indexes (migrations
  0006, 0008). Open: CDN sessions are not fetch-judged (`packages/integrity/src/signals/fetch.ts:107`).
- Coop, VOD and clip stubs are gone (E5, E6). 55 `notImplemented` handlers remain, not 100
  (the grep counts each file's import line too).
- `scripts/fetch-model.ts` exists and fetches the moderation classifier; W2-captions extends it
  rather than creating it.
- Playback-token minting is `services/api/src/routes/playback.ts:78` (`signFor`, `:66-79`), not
  `services/api/src/playback/**`.
- `services/chat/src/persistence.ts` exists; W1-spine edits it rather than creating it.
- `@commonair/i18n` (PLAN.md "Phase two") does not exist; catalogs live in `apps/web/src/i18n/`.
