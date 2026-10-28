<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 2: E7, W0 and P1

Batch 2 of [`.claude/briefs/next/README.md`](../next/README.md): E7 (platform debts), W0
(feature-wins prerequisites) and P1 (the browser P2P client). Ships in `v0.2.0`. Briefs:
[`e7/`](../e7/), [`w0/`](../w0/), [`p1/`](../p1/); each milestone has a `contract-step.md` the
orchestrator lands (one verified commit) before its units start.

## Gates

| Milestone | Gated on                                                                                                   | State (2026-10-28)  |
| --------- | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| E7        | nothing                                                                                                    | merged, verified    |
| W0        | ADR 0012 part 1 (W0-clock), ADR 0019 (W0-sor), ADR 0009 amendment 1 (W0-media-exposure); W0-integrity none | accepted 2026-10-27 |
| P1        | ADR 0005 amendment 1                                                                                       | accepted 2026-10-27 |

All four were accepted on 2026-10-27 with the orchestrator's recommended answers; the
briefs and contract steps match them. Notable answers: P2P ships opt-in (`P2P_DEFAULT=off`,
operator-changeable) until counsel confirms an EU lawful basis; per-segment digests from the
origin are in P1's scope; ICE servers come from a `p2p.iceServers` endpoint and swarm access from
a per-session Valkey grant; VOD placement uses a one-minute sweep plus direct enqueues.

## Waves

At most six units at a time; two agents never write the same file at the same time.

| Wave | Units (parallel)                                                                                            | Starts from                                                      | Why this order                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | E7-chat-http, E7-dmca, E7-admin, E7-appeals, E7-coop, E7-legal                                              | the E7 contract-step commit                                      | ungated; disjoint by the split in `e7/contract-step.md` §9                                                                                                                      |
| 2    | W0-clock, W0-integrity, W0-media-exposure, W0-sor, P1-tracker, P1-turn (each only once its ADR is accepted) | wave 1 merged, then the W0 and P1 contract steps (in that order) | W0's step and W0-sor/W0-media-exposure need E7-appeals and E7-dmca merged (worker `moderation/**`, trust email, trust-safety steps); P1's step edits files W0's step also edits |
| 3    | P1-player, W0-clock (re-briefed for ADR 0012 A2 after its spike)                                            | wave 2 merged, its contract requests and `MEDIAMTX_SRT_URL`      | P1-player needs P1-tracker's grant checks and P1-turn's ICE handler; W0-clock's spike rejected option A, the user chose A2 (SRT) on 2026-10-27                                  |

## Path conflicts and how they are resolved

- **E7-appeals vs W0-sor** (`services/worker/src/moderation/**`): E7-appeals writes it in wave 1;
  W0-sor adds only `sor-*` files and its job file in wave 2 and reads `audit_log` (ADR 0019 D5)
  instead of editing the action writers. W0-media-exposure edits only the VOD-prefix reads there.
- **`services/tracker/src/ip.ts` helpers into `@commonair/service`**: the P1 contract step does it
  (not E7, not P1-tracker).
- **`services/media`**: in wave 2 W0-media-exposure owned `vod/recorder.ts`, `vod/finalize.ts`
  and the prefix code in `clips.ts`, `recovery.ts`, `lifecycle.ts`; the W0 contract step added the
  `ClockAnchor` hook in `recorder.ts`. W0-clock moved to wave 3 and owns the files its re-brief
  lists (args, redact, `clock/**`, the clock lines in context/service, the input lines in
  transcode, recorder, recovery, finalize, `mediamtx.yml`); P1-player owns nothing there.
- **compose / Quadlet / `selfhost.sh`**: P1-turn only in wave 2 (coturn, offered to every
  operator by `selfhost.sh`, per the self-host parity rule). W0-clock's NTP check and anything
  else there arrive as contract requests, applied after P1-turn merges. `infra/mediamtx` is
  W0-clock's; P1's LL-HLS needs are contract requests.
- **i18n, route tree, nav, router, harness scenarios, legal seeds**: per milestone contract step;
  units get their own catalog file and placeholder routes, never edit `en.ts`,
  `routeTree.gen.ts`, `router.ts` or the shared scenario files.

## Shared rules

- Units are told "read and implement `<brief>`", one git worktree each, branch per brief
  (`e7/chat-http`, …), `git commit -s` with the Co-Authored-By trailer.
- Pipeline per unit: implement → independent reviewer (diff vs AGENTS.md and the brief) → the
  implementer's fix pass.
- Units run targeted checks only (`.claude/briefs/_done-means.md`). **This batch the orchestrator
  runs the gate**: `bun run verify` after each wave, the milestone scenarios at each milestone's
  end, `verify:full` and CI at the end of the batch, and pushes `main` after each verified wave.
- Contract requests go to the orchestrator, applied at integration.
- New dependencies (p2p-media-loader 4.0.0, the coturn image) are vetted, added and digest-pinned
  by the orchestrator in the P1 contract step.
- DMCA follows 17 U.S.C. § 512 and the operator template; no lawyer has reviewed it. ADR 0019's
  DSA text lives in the operator template; counsel has not reviewed it.

Wave 3 merged 2026-10-28 (`435a1fb`, `d222ca6`, fixes `7afa11a`, `1d6fd9a`, `ba10a9b`); state,
results and open findings in [PROGRESS.md](../../../PROGRESS.md).

## Milestone checks

- E7: `grep -c '.handler(notImplemented)' services/api/src/routes/*.ts` leaves only interact, bot,
  developer and `integrity.channelSummary`; `trust-safety`, `e2e-social`, `e5-coop`, `e7-admin`.
- W0: `clock-skew`, `integrity-basic`, `trust-safety`.
- P1: `viewers` with ten opted-in Chromium viewers plus one at the default (off): `bytesP2p` > 0,
  origin egress drops, counts and verdicts unchanged, digests fetched and none rejected, the
  default viewer never connects to peers.
- End of batch: `bun run verify:full` and CI green.

## After the batch (not code)

Counsel: DMCA flow and policy numbers, the DSA statement template, EU lawful basis before
any instance turns `P2P_DEFAULT` on. The user: the US Copyright Office designated agent before any public launch,
S1's `udp/3478` firewall rule on real droplets.
