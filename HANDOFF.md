<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# HANDOFF — for the next head agent

Written 2026-10-18 at the end of orchestration session two. Read this, then
[AGENTS.md](AGENTS.md), [PLAN.md](PLAN.md) (see "Milestones — end-to-end vertical slices"),
[PROGRESS.md](PROGRESS.md), [docs/architecture.md](docs/architecture.md), ADRs 0001–0004 in
`docs/decisions/`, and [docs/testing/e1-selectors.md](docs/testing/e1-selectors.md). The original
product brief's constraints still apply in full: FOSS-first, Podman, local-first on `main`, DCO
sign-off, the verify gate, subagent pods with disjoint ownership (≤ ~6 at once), and an
independent reviewer **before** every merge.

## Where things stand

**Milestone E1 is reached locally.** With the platform up, `e2e-basic` passes: web sign-up with
ALTCHA and email verification, stream key rotation, ffmpeg RTMP publish, playback in Chromium
(signed in) and WebKit (anonymous, native HLS), chat in both directions, offline detection. First
run: TTFF 1.0 s / 1.8 s, glass-to-glass 2.1 s / 3.9 s (Chromium / WebKit).

```
bun scripts/infra.ts stack                       # build + start everything (+ harness profile), wait healthy
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-basic
VERIFY_INFRA=external bun run verify             # the gate, reusing the running data services
```

`main` (last merge `5400a83`, plus this handoff commit) has every unit from this session merged
after review. The last full gate run on the final merge (API round two) was interrupted by a hung
`podman compose up` (see "Known issues") and handed to the user to re-run; every earlier merge this
session was verified GREEN with the full gate. **Not pushed yet** — push `main` once the gate is
confirmed green.

### Merged this session

| Area                  | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Reviewed           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Infra (2I)            | full compose stack; WAL-G push under `timeout 20` (fixed the DROP DATABASE hang); Garage + garage-init + migrate in `infra.ts test`; new `infra.ts stack`; `init-env --merge`; tracker behind `--profile p2p` (not built); fixed compose subnet `10.89.42.0/24` trusted for `x-forwarded-for` (Quadlet mirrors it)                                                                                                                                                                                                  | session one + here |
| Web (3A-e1)           | `apps/web`: TanStack Start on Bun; server proxies `/api` + `/rpc`; sign-up/in, dashboard, `/$channel` (hls.js or native HLS, heartbeats, bfcache-safe), chat, `/embed/$channel`; security headers, server-side dashboard guard, i18n catalog                                                                                                                                                                                                                                                                        | 2 rounds           |
| Harness               | `e2e-basic` (+ failure screenshots with the key redacted); API-path sign-ups follow web-origin verification links; `verify --full/--scenario` start the platform and install browsers; CI installs browser deps                                                                                                                                                                                                                                                                                                     | 2 rounds           |
| API (2A)              | all HANDOFF HIGH/MED items: linear-time regex subset for word filters (incl. Unicode case folding), birthDate etc. immutable via better-auth hook, category mature gate, instance-only media refs, admin plugin endpoints 404, /64 rate-limit buckets, SSRF-safe relay/simulcast URLs with pinned dialing, per-template per-mailbox mail cap, heartbeat floor + CAS, no verdict promotion once scored, `developer.tokens.list/revoke`, `UserControlMessage` publishing, TOTP tests, `stream_keys.last_used_ip_hash` | 3 passes           |
| Integrity (2H2)       | all HANDOFF items + review: fetch-less bots held/excluded, time-bounded allowances, relay coverage required, distinct-segment counting (HLL), owner-IP exclusion time-aligned, reload supersede, datacenter 0.6 + privacy-relay class, relay reinstatement/unknown issuance                                                                                                                                                                                                                                         | 2 rounds           |
| Media (2E)            | stale VOD reconcile, crash recovery + safe sweeps, disk budget, transcode slots, simulcast SSRF; simulcast key isolation by container PID namespace (a key-swapping proxy was built, reviewed as unsafe, removed)                                                                                                                                                                                                                                                                                                   | 2 rounds           |
| DB / config / storage | migrations 0006 integrity scan indexes, 0007 users identity immutability trigger, 0008 appeals subject index; `MEDIA_WORK_DIR_*`, `TRANSCODE_MAX_LADDERS`, `OUTBOUND_ALLOW_PRIVATE_NETWORKS`; presigned PUT signs content type + length; `SegmentFetch.obj`; ConfirmDialog test ids                                                                                                                                                                                                                                 | orchestrator       |

## In flight: worker integrity wiring (do this first)

Brief: `.claude/briefs/e1/2L-worker-integrity.md`. Branch `worktree-agent-a07b926d662d5d4bd`
(worktree `.claude/worktrees/agent-a07b926d662d5d4bd`). The unit was asked to commit a
`wip(worker): …` checkpoint whose message lists done / passing / failing / left — read it with
`git log -1 worktree-agent-a07b926d662d5d4bd`. It touches `services/worker/**`, origin's
accounting call (sets `SegmentFetch.obj`), `harness/scenarios/viewers.ts` and a new
`harness/scenarios/integrity-basic.ts`. **Without it no integrity job runs in the stack** (the API's
interim heartbeat verification is the only verdict source). Finish it in a fresh unit from that
branch, review, merge, then make `viewers` and `integrity-basic` pass. If the unit rebuilt the
`worker`/`origin` images from its worktree, rebuild them from `main` afterwards
(`podman compose build worker origin && podman compose up -d --no-deps worker origin`).

## Open items (not done)

- **API round 3** (from the final re-review; no HIGH left): (MED) safe-regex cost model treats an
  unbounded repeat as 32 instead of the input length and does not cap total cost across top-level
  alternatives (`.*.{0,20}!|…` ×18 ≈ 40–120 ms per message) — fix the model and/or run chat filters
  in a Worker with a hard timeout; (LOW) heartbeats under the 5 s floor still increment counters
  and record evidence — return early; canonicalize IPs before hashing (`::ffff:` unwrap, IPv6
  compression) in both `media/hooks.ts` and `http.ts`; `pinnedGet` needs a total timeout.
- **Contract requests still open**: move `services/api/src/lib/safe-regex.ts` into a shared package
  and use it in chat's `compileFilters` (re-validate saved patterns on load); export better-auth
  paths + ALTCHA field name from `packages/contracts` (web and harness keep copies); API should
  record P2P-enabled sessions as `assignedSource: "p2p"` (integrity otherwise holds heavy-P2P
  viewers at pending); appeals resolver (still a 501 stub) must set `resolved_at` and use subject
  types `session|user|integrity_flag`; ingest auth should set `stream_keys.last_used_at` per
  broadcast; optional `vods.failed_reason` column; document the `mail` rate-limit bucket;
  `IRC_*` env vars into config; `ORIGIN_ISSUANCE_ENABLED`/`ISSUANCE_KEYS` into config.
- Media: internal RTSP password still in ffmpeg argv (isolation-protected, documented).
- Integrity: CDN-delivered sessions are not fetch-judged (README "known limitations").
- `legal.current` returns nothing locally (no seed docs) — sign-up shows no document links.
- UI web: ALTCHA widget tick colour is not a token; one large chunk warning in `vp build`;
  web strings for new media health codes (`transcode_capacity`, `recording_disk_budget`,
  simulcast `lastError` codes, VOD failure reasons).
- Governance: `subscriptionQualifies` and `closeElection` tests.

## Next slices (PLAN.md "Milestones")

E2 follows + directory/discovery page + a moderation action (ban/timeout) + tmi.js bot via the IRC
gateway; E3 relay joins and serves viewers + viewbot swarm excluded (needs the worker wiring above;
local relays need `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` in `.env`); E4 money (manual adapter, then
Stripe against stripe-mock); E5 co-op; E6 the rest. Each slice: a `docs/testing/<slice>-selectors.md`
contract, briefs in `.claude/briefs/<slice>/`, API + worker + web + harness scenario together.

## Known issues and process lessons (session two)

- **Check exit codes, and gate commits on them**: `cmd; echo EXIT $?; git commit` commits even when
  red (happened once this session; amended before push). Use `rc=$?; [ $rc = 0 ] && git commit …`.
- `podman compose up -d` can hang when another process (e.g. a unit rebuilding images) runs
  compose concurrently. Kill it and use `VERIFY_INFRA=external` when the services are already up;
  avoid parallel compose commands from several agents.
- Changing the compose subnet needs `podman compose --profile harness down` and
  `podman network rm commonair_default` once.
- Worktrees may be created from an older commit than `main`: tell every unit to `git merge main`
  first, and format/SPDX-header briefs before committing them (both bit this session).
- Local machine: an unrelated Vite dev server holds `[::1]:3000`, so the local `.env` here uses
  `WEB_PORT=3100`, `PUBLIC_URL=http://localhost:3100`, `AUTH_TRUSTED_ORIGINS=http://localhost:3100`;
  pass `HARNESS_WEB_URL=http://localhost:3100` to the harness. CI uses the defaults (3000).
- The local `.env` has `NODE_ENV=development`, which overrides the images' `NODE_ENV=production`
  via `env_file`; fine for local runs, not for production.
- Review before merge paid off: every unit's first review found real HIGHs (regex folding,
  botting whitelist, key-substituting proxy). Keep doing focused re-reviews of fix rounds for HIGHs.
