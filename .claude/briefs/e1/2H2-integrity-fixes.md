You are fixing **open integrity review findings (2H2 integrity half, round two)** for CommonAir
(repo: /Users/joshe/Repos/bcon). Read AGENTS.md, HANDOFF.md ("Open review findings" →
Integrity), PLAN.md, docs/architecture.md and ADR 0003 decisions 5 and 8 first. Do not look
outside the repository.

## You own (write only these)

- `packages/integrity/**`

## Contracts you must honor (read-only for you)

- `packages/db` schema (`playback_sessions`, stream keys, appeals, relays, …), `packages/contracts`,
  `packages/config` (`membership.classes.streamer.minVerifiedViewers` etc.), `services/worker`
  (the jobs that call you — read how). The orchestrator is adding these indexes as a migration in
  parallel; assume they exist:
  `playback_sessions_scoring_idx on playback_sessions (scored_at nulls first) where ended_at is null or verdict = 'pending'`
  `playback_sessions_live_hb_idx on playback_sessions (last_heartbeat_at) where ended_at is null`
  Write your candidate-session queries so they use them (predicates matching the index `where`).

## Fix (each with tests)

1. Fetch-less heartbeat bots get verified: a session whose heartbeats claim playback but whose
   token fetched no (or far too few) media segments from origin/relay must not verify. Use the
   segment-fetch accounting that origin/relay receipts produce (read the schema/worker).
2. Stream-hour eligibility is gameable: exclude viewers sharing the owner's ipHash, including the
   stream key's `last_used_ip_hash`; require `membership.classes.streamer.minVerifiedViewers`
   (= 2) distinct verified viewers for an hour to count.
3. Appeal overturns / `allowed` flags must stick: rescoring must not re-exclude a session or
   account an appeal allowed, unless new evidence arrives after the appeal decision (document the
   rule).
4. Concurrency signal ranks the live reload as the duplicate: when one device has overlapping
   sessions, the newest (the reload) is the real one; the stale one ends, neither is "botted".
5. Datacenter weight 0.8 is fatal alone: lower to 0.6, add a privacy-relay class (lower weight,
   never fatal alone), drop hyperscaler ASNs that serve consumer traffic from the bundled sample
   (ADR 0003 decision 8 — coordinate the data file under `packages/integrity` only).
6. False positives: periodic-timing signal must tolerate browser timer clamping/throttling;
   background-tab (visibility hidden) sessions are not bots; CDN-delivered sessions have no origin
   fetches — use CDN accounting or skip the fetch-less signal when delivery is CDN.
7. Relay suspension on missing issuance and post-reinstatement history: a reinstated relay is not
   re-suspended for receipts from before reinstatement; missing issuance data (origin restart) is
   "unknown", not over-reporting.
8. Follow-burst prior viewing counts verified sessions only.
9. Also: `subscriptionQualifies` unit test; `closeElection` test lives in governance — skip unless
   trivial and inside your paths.

## Tests you must add

- Exhaustive unit tests for every signal change (boundaries, empty sets, clamped timers, reload
  overlap). Integration tests with `createTestDatabase()` for eligibility, appeal stickiness,
  relay reinstatement and the fetch-less rule against real tables.

## Done means

- `bun run verify --quick` passes plus `bun run --filter @commonair/integrity test:int` (infra is
  up; never drop databases you did not create). If the worker's call sites need changing,
  report the exact change as a contract request rather than editing `services/worker`.
- No files outside `packages/integrity/**` changed (`git status`).
- Commit in your worktree (Conventional Commits, `git commit -s`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Final message: each finding → fixed / not fixed (why), test counts, contract requests.
