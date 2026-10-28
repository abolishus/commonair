<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 2 wave 3: handoff prompt

Paste everything below the line into a new session.

---

You are the orchestrator for CommonAir batch 2, wave 3 (repo /Users/joshe/Repos/bcon, `main`,
pushed). You are explicitly authorized to use multi-agent Workflows for this wave.

Read first: AGENTS.md, PLAN.md, PROGRESS.md ("In flight", batch 2), `.claude/briefs/batch2/README.md`
(waves, path rules, milestone checks), `.claude/briefs/_done-means.md`, and the two unit briefs:
`.claude/briefs/p1/P1-player.md` and `.claude/briefs/w0/W0-clock.md`. ADRs that bind them:
`docs/decisions/0005-p2p-tracker.md` (amendment 1, accepted) and `docs/decisions/0012-media-clock.md`
(part 1 with decision 3 = A2, the ladder and recorder read SRT; accepted). The W0-clock spike
write-up is `services/media/src/clock/README.md`.

## Where things stand

Waves 1 (six E7 units) and 2 (W0-sor, W0-media-exposure, W0-integrity, P1-tracker, P1-turn) are
merged, their contract requests applied, `bun run verify` green, and `trust-safety` (steps 1–11),
`integrity-basic`, `vod-clips`, `e2e-social`, `e5-coop`, `e7-admin` green against the stack. All
contract steps (E7, W0, P1) are on `main`, as is `MEDIAMTX_SRT_URL` (config, `.env.example`,
compose, the multi-instance override, every Quadlet unit). Nothing of wave 3 has started.

## Wave 3: two units in parallel

| Unit      | Brief                            | Branch      | Notes                                                                                                                                                                     |
| --------- | -------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-player | `.claude/briefs/p1/P1-player.md` | `p1/player` | p2p-media-loader 4.0.0 is already in `apps/web`. P2P is opt-in by default (`P2P_DEFAULT=off`). Per-segment digest validation is in scope (fail closed, refetch over HTTP) |
| W0-clock  | `.claude/briefs/w0/W0-clock.md`  | `w0/clock`  | A2. Step 0 has three gate checks; if Opus does not survive SRT the unit **stops and reports**. Never touches `apps/web/**` or the viewers/p2p harness files               |

Their paths are disjoint (each brief lists them). Pass each its brief verbatim ("read and implement
<path>"), one git worktree each, from the current `main` tip. Per unit: implement → an independent
reviewer (diff vs AGENTS.md and the brief) → the implementer's fix pass. Commits `git commit -s`
with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Then integrate: merge, apply contract requests (expected: `clock-skew` into `FULL_REQUIRED` and a
shard; `P2P_VIEWERS_DEFAULT` to 10 in `harness/src/p2p.ts`; P1 test ids into `TEST_IDS` and
`docs/testing/p1-selectors.md` into `apps/web/tests/selectors.test.ts`; anything else the units
report), reconcile `bun.lock`, targeted tests.

## Verification (you run it; fix what fails)

- `bun run verify` after the merge.
- `bun run verify --scenario clock-skew` (p95 cross-rendition < 100 ms, live-to-VOD < 250 ms).
- `bun harness/src/cli.ts run viewers --set p2p=10` against the stack: `bytesP2p` > 0, origin
  egress drops, counts and verdicts unchanged, digests fetched and none rejected, the default viewer
  never connects to peers.
- `trust-safety`, `integrity-basic` again (W0-clock touches the recorder).
- End of batch: `bun run verify:full` and CI green on `main`. Push `main` after each verified step.

## Environment lessons from waves 1–2 (read before running anything heavy)

- **Quit Podman Desktop before the gate.** Its polling keeps the VM's `podman system service` at
  200–400 % CPU and every time-limited test then fails somewhere different. If it is pegged,
  `podman machine ssh "systemctl --user restart podman.service"`.
- The podman VM's chrony has no time source; check drift with
  `python3 -c 'import time;print(time.time())'; podman machine ssh 'date +%s.%N'` and reset if it
  is more than ~100 ms off.
- A failed integration run orphans its containers (`commonair-it-*`, `commonair-pgh-*`,
  `media-int-*`, `harness-mediamtx-*`, `commonair-caddy-int-*`); remove only those patterns, and
  only ones your run created.
- Run package tests with each package's own script (`bun run test` / `bun run test:int` in its
  directory). `vp test run <dir>` from the root also runs the container-backed `*.int.test.ts`.
- Another session may be committing to this checkout. Commit only your own paths
  (`git commit -- <paths>`), and never revert files you did not change.

## Stop and ask the user on

A design blocker (including W0-clock's step 0 failing), any ADR decision, a contract change not
listed above, or a dependency that fails vet or the cooldown. Never run `tofu apply` or touch a
DigitalOcean account.

## Open items that are not yours to decide

Counsel: the DMCA flow and `DMCA_RULES` numbers, the DSA statement template, an EU lawful basis
before any instance turns `P2P_DEFAULT` on. The user: a US Copyright Office designated agent before
launch; the TURN relay port range on the DigitalOcean firewall (only udp/3478 is open); redress for
a suspended, signed-out user (email only today).

## When done

Update PROGRESS.md (batch 2 section: wave 3 rows, verification, open findings) and
`.claude/briefs/batch2/README.md`, then report per unit (what landed, commits, test counts), open
findings and accepted risks, and what still needs the user or counsel.
