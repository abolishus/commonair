<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-m admission: refuse a go-live when there is no room, and say so

You are implementing unit S1-m for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md (the design rules for web apply in full), PLAN.md and docs/architecture.md.
- [ADR 0041](../../../docs/decisions/0041-launch-scale.md) decision 6 and "Maintainer's answers":
  launch ramps in waves of 100, 300 and 1,000 concurrent go-lives, and the cap is this unit's.
- `.claude/briefs/s1/launch-contract-step.md`: `LIVE_ADMISSION_MAX_STREAMS`,
  `LIVE_ADMISSION_LADDER_STOP_RATIO` (§2), the `capacity_full` reason and `stream.ingest`'s
  `admission` field (§3.6), the metric and i18n keys (§3.9, §3.10).
- `.claude/briefs/s1/S1-e-placement.md` and its merged code: the node registry, `mediaAuth`'s
  node checks, and the `placement` scenario you extend.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**: work in your own git worktree, on branch
`s1/m-admission`, cut from `main` after wave 1 merged. S1-k runs beside you.

## Why

Capacity is finite: each pool has a ceiling from the budget, the scaler needs minutes to add a
host, and the launch opens in waves. When there is no room, the choice is between refusing the
next stream and degrading every stream already live. ADR 0041 chooses refusal, made visible to
the streamer and to the operators. Live streams are never cut or degraded to make room.

## You own (write only these)

- `services/api/src/media/admission.ts` (new) and the capacity decision inside
  `decidePublish`/`planMediaAuth` (`services/api/src/media/auth.ts:39`) and `mediaAuth`
  (`hooks.ts:116`). S1-e's node checks stay as they are.
- `services/api/src/routes/stream.ts` (`stream.ingest`, `:93-107`) for the `admission` field.
- `services/media/src/transcode/controller.ts` and `hysteresis.ts`, only for the pool-wide
  ladder stop.
- `apps/web/src/components/studio/{stream-setup,control-room,dashboard-top}.tsx`,
  `apps/web/src/components/studio-shell/{live-status.tsx,use-live-status.ts}`, and the message
  catalogs for the new keys.
- `harness/scenarios/admission.ts` (new).
- `docs/operators/admission.md` (new), with the alert rule.

**Read-only:** everything else. `packages/contracts`, `packages/config` and `packages/db` are
the orchestrator's: a missing field is a **contract request**.

## Contracts you must honor

- **A resume is never refused.** A publish inside the reconnect grace for an open broadcast
  (`services/api/src/media/live-grace.ts`) is admitted even when the pool is full.
- The decision is made where publishes are authorized, in the api, before MediaMTX accepts the
  stream. A refused encoder gets MediaMTX's normal auth failure and retries on its own schedule.
- No personal data in metrics or logs: a channel id at most, never a key, an address or a name.
- User-facing strings go through `t("key")`. No hex colors, no native dialogs, the house
  primitives (`<EmptyState>`, `toast.*`, `<IconButton tooltip>`).
- A single-host install with nothing set admits everything, as today.

## Build

1. **The decision** (`admission.ts`, a pure function plus its Valkey reads):
   - refuse when live broadcasts are at `LIVE_ADMISSION_MAX_STREAMS`;
   - refuse when no `active` media node in `KEYS.clusterNodes` has room
     (`liveStreams < maxStreams`);
   - otherwise admit. Rehearsals count as streams: they use the same capacity.
2. **No overshoot under a burst.** A hundred encoders retrying at once must not all pass a
   check-then-insert. Reserve a slot atomically in Valkey at auth (a counter with a short
   reservation TTL), turn it into a held slot at `mediaReady`, and release it at the broadcast's
   end or when the reservation expires unused. Reconcile the counter against `broadcasts where
   ended_at is null` on a timer, so a crashed api cannot leak slots. Postgres is the truth, and
   Valkey is the fast path.
3. **Tell the streamer.**
   - A refusal writes a short-lived per-channel marker in Valkey (channel id, reason, time; TTL
     about 60 s, refreshed by each retry).
   - `stream.ingest` returns `admission: "full"` while the instance or every node is full.
   - The studio's stream setup and live-status bar show "capacity full, retrying": what
     happened, that their encoder will keep trying, and that nothing is wrong with their setup.
     It clears when the stream goes live. Design it to 320 px, in dark and light, with a visible
     focus order, and without colour as the only signal.
4. **Stop new ladders first.** Past `LIVE_ADMISSION_LADDER_STOP_RATIO` of pool capacity, the
   transcode controller starts no new ladder (`controller.ts:81`, the same waiting path as a
   full `SlotLimiter`), and running ladders continue. The stream-health warning says the ladder
   is waiting for capacity.
5. **Count and alert.** `live.admission.refused` by reason, plus a gauge of slots used against
   the cap. `admission.md` gives the alert (any refusal for 2 minutes pages), the dashboard
   query, and the runbook: raise the cap, add hosts, or hold the wave.
6. **Changing the cap.** The launch waves raise `LIVE_ADMISSION_MAX_STREAMS` by hand. Document
   the procedure: set it on every app host and restart api one host at a time, with S1-f's
   drain. If the hosts disagree during the rollout, the lower value wins: make the reservation
   script take the cap as an argument and document that behaviour.
7. **The `admission` scenario**, on S1-e's two-node harness stack with a cap of 2:
   - two streams go live, and the third is refused and its dashboard shows the state;
   - one ends, and the third's retry is admitted;
   - a stream that drops and reconnects inside the grace gets back in although the pool is full;
   - a burst of simultaneous publishes never exceeds the cap;
   - past the ladder ratio no new ladder starts, and a running one continues;
   - the refusal metric counted each refusal.

## Edge cases

- The cap lowered below the current live count: nothing is cut, and new go-lives wait.
- Every node cordoned (a full drain): refused with the same reason.
- The Valkey counter lost in a failover: rebuilt from Postgres before admitting past the cap.
- A reservation whose `mediaReady` never arrives.
- WHIP: the signalling proxy refuses with a status the browser encoder can show.
- A suspended channel, or a revoked key, still gets its own refusal reason, not `capacity_full`.

## Tests you must add

- Exhaustive unit tests of the decision: at, below and above the cap, unset cap, no nodes, all
  cordoned, resume in grace, rehearsal.
- Integration tests with real Valkey and Postgres: the burst (many concurrent auths, never over
  the cap), reservation expiry, reconciliation after a wiped counter, release on end.
- Web component tests for the three states (open, full and retrying, live) in en, es and en-XA.
- The `admission` scenario, and a contract request naming its harness shard.

## Reviewer focus

- A live stream is never cut, and a resume is never refused.
- The cap cannot be overshot by a burst or leaked by a crash.
- The streamer's message is accurate and not alarming, and it passes the design rules.
- Refusals cannot be silent: the metric and the alert exist.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun run test` and `bun run test:int` for `services/api`
and `services/media` (one at a time), `vp build` and tests for `apps/web`, `bunx tsc --noEmit`
for each and for `harness`, lint, format and `reuse lint`. `git status` shows only your paths.
Commit with `git commit -s`.

Your final message lists: what you built, test counts, contract requests, and the commands for
the user to run `admission` and to see the dashboard state at 320 px.
