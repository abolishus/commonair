<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# HANDOFF — for the next head agent

Written 2026-10-18 at the end of orchestration session three. Read this, then
[AGENTS.md](AGENTS.md), [PLAN.md](PLAN.md) ("Milestones — end-to-end vertical slices"),
[PROGRESS.md](PROGRESS.md), [docs/architecture.md](docs/architecture.md), ADRs 0001–0004 in
`docs/decisions/`, [docs/testing/e1-selectors.md](docs/testing/e1-selectors.md),
[docs/testing/e2-selectors.md](docs/testing/e2-selectors.md) and
[docs/deploy/railway.md](docs/deploy/railway.md). The original constraints still apply: FOSS-first,
Podman, local-first on `main`, DCO sign-off, subagent pods with disjoint ownership (≤ ~6 at once),
an independent reviewer **before** every merge and a focused re-review of fix rounds for any HIGH.

## Process rules from the user (session three)

- **The user runs the gate (`bun run verify`), image rebuilds, harness scenarios and all visual
  checks.** Agents and units do not. Run only targeted checks: the touched packages' unit tests and
  `test:int`, `bunx tsc -p <pkg>`, `vp lint`/`vp fmt` on changed files (and `vp build` for web).
- Focus on development; after review, merge and push `main` so the user can test. Ask before
  pushing unless the user has said to push. Gate failures are fixed "in post".
- Briefs must tell units the same (no verify, no dev servers/browsers, no live scenario runs).

## Where things stand

`main` is pushed (last merge `61c6e2f`, plus this handoff commit). Everything below was reviewed
before merge; every HIGH had a fix round and a focused re-review. **Not yet tested live by the
user**: the E2 slice end to end (`e2e-social`), the rebuilt worker/origin integrity wiring, and the
harness against Railway staging.

### Merged this session

| Area                    | What landed                                                                                                                                                                                                                                                                                                                                                           | Review                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Worker integrity (2L)   | four integrity jobs on the `integrity` queue (schedulers + Valkey run locks, lapses logged/counted), consumer fetch evidence with ack isolated from apply, origin `SegmentFetch.obj`, viewer-count republish, scheduled jobs retry with backoff, SIGHUP CIDR reload keeps a good list, `integrity-basic` scenario, worker README                                      | no HIGH; fixes applied      |
| API round 3             | appeals (create/mine/queue/resolve: CAS + audit, no outbox event by decision), heartbeat floor returns before any write, canonical IP hashing (RFC 5952, `::ffff:` unwrap) on both hash paths, `pinnedGet` hard deadline, auth paths from contracts, README rate-limit table. P2P `assignedSource` **reverted** (see open items). `channels.get` → `viewer.following` | 2 HIGH → fixed, re-reviewed |
| Safe-regex + chat (2B)  | `packages/safe-regex` (moved from the API) with a sound cost model (nested alternations in repeated groups refused, sums across alternatives, O(n) unbounded repeats); chat re-validates stored filters on load and runs regex filter sets in a Bun worker pool with a hard timeout, quarantine, capped zombie threads, token-bucket respawns, queue-wait deadline    | 2 HIGH → fixed, re-reviewed |
| E2 web (3A)             | `/` is the directory (spotlight/new/live/following, `StreamCard`, empty/skeleton states), follow button (optimistic, stale-poll safe) + follower count, chat moderation menu (timeout 600 s / ban with `ConfirmDialog`), deleted rows, inline notices, sign-in-again toast                                                                                            | no HIGH; fixes applied      |
| E2 harness (2J)         | `e2e-social` (five steps of `e2-selectors.md`, `--set via=api` backend-only mode), E2 selectors parsed from both docs, tmi.js event recording (CLEARCHAT/timeout/ban/messagedeleted/notices)                                                                                                                                                                          | no HIGH; fixes applied      |
| Head (contracts/config) | `@commonair/contracts/auth` (`AUTH_ROUTES`, `ALTCHA_FIELD`), `E.APPEAL_SUBJECTS`, `ircEnv` + `ORIGIN_ISSUANCE_ENABLED` in config, `Channel.viewer`, harness Mailpit basic auth (`HARNESS_MAILPIT_AUTH`), IRC health port 6681 published in compose                                                                                                                    | orchestrator                |

## For the user to run (agents: don't, unless asked)

```
bun scripts/infra.ts stack                                   # rebuild + start everything
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-social
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-social --set via=api   # backend only
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-basic
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run viewers
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run integrity-basic
VERIFY_INFRA=external bun run verify
```

Test the web app from `PUBLIC_URL` (3100 here): the API strips cookies from untrusted origins, so a
dev server on another port makes every browser `/rpc` call anonymous (follows "roll back").
Staging: set `HARNESS_*` URLs from `railway domain list` and `HARNESS_MAILPIT_AUTH` from the
`mailpit` service's `MP_UI_AUTH` (docs/deploy/railway.md), then `smoke` and `e2e-basic`.

## Open items (not done)

- **Contract requests (head agent):**
  - integrity: judge P2P only with server-side swarm evidence (tracker announces / swarm size ≥ 2);
    for `p2p` sessions judge "too few" against the reduced share but "too many" against share 1.
    Until then the API records `origin` even for P2P viewers (client `p2pCapable` must not lower
    the fetch bar). Needs `services/tracker`, which is still not built.
  - `CidrClassifier` public `size` getter (worker reads private fields via `Reflect.get`).
  - API surfaces stored word filters the new validator refuses: `WordFilter` DTO
    `invalid: boolean`, `invalidReason: string | null` (chat skips them on load and only counts
    `chat.filter.skipped`; a skipped `block` filter now passes messages — owner is not told).
  - `appeals.create` on the `write` rate-limit bucket; heartbeat response `throttled` hint so
    clients don't commit sub-floor deltas.
  - optional `vods.failed_reason`; `ISSUANCE_KEYS` into contracts once the worker owns issuance.
- Overturning a moderation appeal records the decision only (does not lift the ban); a relay leaving
  moves viewers to `origin` (P2P-ness not stored server-side).
- IP canonicalization changed `ip_hash` for clients Bun reported as `::ffff:a.b.c.d`: owner-IP
  exclusion for broadcasts live across that deploy compares the old `last_used_ip_hash` until the
  streamer re-publishes (services/api README).
- Some regex filters the old API check accepted are now refused (e.g. `(?:https?://)?\S+`,
  `(?:a(?:bc|bd))+`; safe rewrites are suggested in the error text).
- Chat: test for OAuth revocation on an open socket. Media: internal RTSP password in ffmpeg argv.
  Integrity: CDN-delivered sessions not fetch-judged. `legal.current` has no seed docs locally.
  Web: ALTCHA tick colour token, large chunk warning, strings for media health codes; LOW: the
  moderation `IconButton`-inside-`DropdownMenuTrigger` pattern needs a keyboard check in a browser.
  Governance: `subscriptionQualifies` / `closeElection` tests.

## Next slices

E3 relay joins and serves viewers + viewbot swarm excluded (local relays need
`OUTBOUND_ALLOW_PRIVATE_NETWORKS=true`); the P2P tracker + swarm evidence pairs naturally with it
(both are bandwidth levers). E4 money (manual adapter, then Stripe against stripe-mock); E5 co-op;
E6 the rest. Each slice: a `docs/testing/<slice>-selectors.md` contract, briefs in
`.claude/briefs/<slice>/`, API + worker + web + harness scenario together.

## Known issues and process lessons

- A chat integration test ("a timeout issued on A is enforced on B …", 5 s) times out under
  parallel test load; it passes alone. Avoid running several packages' `test:int` concurrently.
- Stale `commonair-it-*` compose stacks from old integration runs may be lying around; remove them
  if they get in the way. `podman compose up` can hang when another process runs compose: kill it
  and use `VERIFY_INFRA=external`.
- Worktrees: tell every unit to `git merge main` first; resume a finished unit with SendMessage for
  its fix round (it keeps context). Old worktrees under `.claude/worktrees/` can be cleaned up.
- Local machine: an unrelated Vite dev server holds `[::1]:3000`; the local `.env` uses
  `WEB_PORT=3100`, `PUBLIC_URL`/`AUTH_TRUSTED_ORIGINS` on 3100. The local `.env` has
  `NODE_ENV=development` (overrides the images' production mode; fine locally).
- Review before merge keeps paying off: this session's reviews caught a client flag that would have
  let viewbots bypass fetch checks, an exponential regex bypass, and unbounded worker respawns.
