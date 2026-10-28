<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# PROGRESS

Updated by the orchestrator after every integration step. Phases and units: [PLAN.md](PLAN.md).

## Done and verified

- Phase 0: name (ADR 0001), license policy + verified licenses (ADR 0002), architecture (ADR 0003),
  toolchain, REUSE, config module, stray-domain and license checks, `verify` script, project docs,
  AGENTS.md + skills, CI workflow.
- Phase 1: contracts (enums, shapes, scopes, events, chat protocol, tokens, full oRPC router,
  OpenAPI generation), Drizzle schema (all domains) + `0000_initial` + `0001_protections`
  (append-only ledger/audit, double-entry balance, governance protections re-tallying votes),
  tokens package with RFC 8032-anchored vectors, data services in `compose.yaml`.
- Two security reviews of the database protections; every proven bypass fixed with a regression
  test (`0002_protections_hardening.sql`, ADR 0004). Tests run as a least-privilege role.
- Secret scanning and push protection enabled on the GitHub repository.

## In flight

Batch 2 (E7 + W0 + P1; waves and shared rules: `.claude/briefs/batch2/README.md`), started
2026-10-27. ADRs 0005 amendment 1 (P1), 0012 part 1 (W0-clock), 0019 (W0-sor) and 0009
amendment 1 (W0-media-exposure) are accepted.

**ADRs for every later milestone (2026-10-27):** the maintainer accepted the recommended answers.
Accepted: 0011 captions, 0012 amendment 1 (Timeline Spine, chat retention and replay), 0013
splits, 0014 attestation key, 0015 verified-watch signal, 0016 DVR, 0017 watch rooms, 0018 data
mode, 0022 supply chain, 0026 interactivity, 0027 OAuth and EventSub, 0028 notifications, 0029
i18n (Hosted Weblate, Spanish first), 0030 federation, 0032 scaling (NYC3; tracker on an app
droplet). Proposed: 0031 Twitch import (waits for counsel), 0033 SeaweedFS (answers recorded;
waits for the phase 0 spike; replaces Garage outright, no migration tool). The milestone plans and
feature-wins.md are corrected to match. Open for the maintainer: the SDK's license; owners for CDN
fetch-judging (0015 GA) and for user blocks (0012 amd 1, 0017); budgets under ~86 MB/h (0018);
0031's three departures from the N3 plan; 0030's 7-day inbox drop and follower loss on suspension.
Legal seed follow-ups for E8/N2: a no-cash-value clause in `terms.md`, the locale cookie in
`cookies.md`.
**Batch 2 state (2026-10-28): waves 1–3 merged and pushed; CI green on main `0201068` (every job, all four harness shards). Batch done; open findings below.**

| Unit              | Wave | Commits (branch)                   | State                                                                                     |
| ----------------- | ---- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| E7-chat-http      | 1    | `e7/chat-http` → `8298c5c`         | merged; `e2e-social` green                                                                |
| E7-dmca           | 1    | `e7/dmca` → `9e307e3`              | merged; trust-safety step 8 green. **No lawyer reviewed** the § 512 flow or `DMCA_RULES`  |
| E7-admin          | 1    | `e7/admin` → `66629bd`             | merged; new `e7-admin` scenario green (in `FULL_REQUIRED`)                                |
| E7-appeals        | 1    | `e7/appeals` → `224661e`           | merged; trust-safety step 9 green                                                         |
| E7-coop           | 1    | `e7/coop` → `1309ea5`              | merged; `e5-coop` green                                                                   |
| E7-legal          | 1    | `e7/legal` → `779462a`             | merged                                                                                    |
| W0-sor            | 2    | `w0/sor` → `a4a6a29`               | merged; trust-safety step 11. DSA text in the operator template, **counsel not reviewed** |
| W0-media-exposure | 2    | `w0/media-exposure` → `e4ba1a5`    | merged; `vod-clips` green, trust-safety step 10                                           |
| W0-integrity      | 2    | `w0/integrity` → `103e82b`         | merged; `integrity-basic` green. Closes the 2H2 integrity row                             |
| P1-tracker        | 2    | `p1/tracker` → `d069fde`           | merged (grant-derived info hashes, origin `/p2p-digest/`)                                 |
| P1-turn           | 2    | `p1/turn` → `60a3118`              | merged (coturn, STUN only by default; `--turn-relay`); not run on a real host             |
| W0-clock          | 3    | `w0/clock` → `435a1fb`, `e5d5d3d`  | merged (A2 over SRT, step 0 passed); `clock-skew` 12/12 (p95 cross-rendition 14 / 1 ms)   |
| P1-player         | 3    | `p1/player` → `d222ca6`, `ba10a9b` | merged; `viewers --set p2p=10` 15/15, 37 % of opted-in bytes from peers, +4 s latency     |

Contract steps: E7 `3bacecb`+`66e95da`, W0 `600d263`, P1 `d8c4fe0`+`0a5d750`. Contract requests:
E7 wave `0f975b7`, wave 2 `ccf9c17`, `MEDIAMTX_SRT_URL` `a10eeee`. E7's `notImplemented` grep
leaves only interact, bot, developer and `integrity.channelSummary`.

**Decisions taken this batch (user, 2026-10-27):** the four ADRs above with the recommended
answers (P2P opt-in by default, `P2P_DEFAULT=off`, until counsel confirms an EU lawful basis;
per-segment digests in P1); ADR 0012 decision 3 = A2; patronage and governance count only
gate-eligible viewer sessions (`61263d6`). happy-dom 21.0.4 (`22934c4`) dropped its audit exception.

**Verification:** `bun run verify` green on `d520788` (after a dated exception for deepmerge
GHSA-gcqx-w48m-w2h4, published 2026-10-27 with no fix). Against the stack on `5404bbf`:
`trust-safety` 1–11 144/144, `integrity-basic` 15/15, `vod-clips` 29/29; after E7, `e2e-social`,
`e5-coop`, `e7-admin` green. Harness fixes found by the runs: step 8 audit log as admin, e5-coop
tiers, e7-admin flag id, step 11's `Date` parameter, `Mailpit.get` reading `Date` (the message
endpoint has no `Created`), step 11 checking a suspended recipient by email. Not run yet: the self-host e2e
with coturn, `tofu` locally (CI runs it with `REQUIRE_TOFU=1`). Wave 3 handoff:
`.claude/briefs/batch2/HANDOFF-wave3.md`.

**Wave 3 (2026-10-27/28).** Units: W0-clock `a73c83c`, `da8a9d2` (merge `435a1fb`); P1-player
`f5a5498`, `eb297f4` (merge `d222ca6`). Contract requests `48bfb8b`: `clock-skew` in
`FULL_REQUIRED` with its own CI shard (`clock`), `P2P_VIEWERS_DEFAULT` 10, `P1_TEST_IDS` in
`TEST_IDS`, `instance.p2pDefault` in the bootstrap, `MEDIA_INTERNAL_PASSWORD` may not contain `:`
(SRT streamid). Fixes found by the runs: WHIP W0 settle guard `7afa11a` (MediaMTX's LL-HLS PDT for
WebRTC sources starts up to 1.5 s off and slews ~5 % for ~25 s; W0 is taken once two segments
agree), harness web-viewer session id and the `bytes_p_2p` column `1d6fd9a`, P2P sharing
`ba10a9b` (p2p-media-loader-hlsjs 4.0.0 looks streams up by the reloaded playlist URL, which
carries LL-HLS delivery directives, so no segment ever reached the core; P2P now starts after the
first acknowledged heartbeat, so the tracker's `not_watching` never trips the error streak; each
session draws its target 4–8 s behind the edge).

Verified: `bun run verify` green on `ba10a9b`; `clock-skew` PASS 12/12 (live-to-VOD p95 3 / 1 ms,
WHIP max 244 ms); `viewers --set p2p=10` and plain `viewers` PASS 15/15 (bytesP2p 73 MB, opted-in
HTTP 242 KB/s, digests served, none rejected, default viewers no grant or peer); `trust-safety`
144/144; `integrity-basic` 15/15 (one 6/7 flake, green rerun).

**After wave 3: CI is the gate (user, 2026-10-28).** No local `bun run verify`/`verify:full`: push
`main`, watch CI fail-fast, fix what it reports. The local runs had failed on local bottlenecks (a
CPU-hog repro left running, the Mac clock 2 s behind NTP after it, orphaned containers).
Fixes since `ba10a9b`, all CI-proven:

| Problem                                           | Root cause                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WHIP Chromium TTFF 23.6 s (budget 15 s)           | the AAC copy waited ~30 s for W0 (ffmpeg `-re` catching up at 1.05×); MediaMTX dropped every new publish's first ~5 s (gortsplib drops ffmpeg's first sender report, sent before the SSRC is known); hls.js's 1-2-4-8 s backoff | real-time harness streamer `a917c21`; 1 s manifest retry (web `a917c21`, harness page `5de0b28`); loopback sender-report relay for rendition publishes `acb57a8`; probe one segment `34e1967`. Now 10.4–10.6 s Chromium, 11–11.8 s WebKit |
| WHIP VOD stuck in `processing`                    | a 0.2 s chunk tail gave ffmpeg's fps filter no frame                                                                                                                                                                            | `c7b8270`                                                                                                                                                                                                                                 |
| clock int tests red on CI                         | Linux EPIPE piping a segment to a one-frame ffmpeg; the `geq` strip source too slow for a loaded runner; a recorder test that passed vacuously                                                                                  | `d642bb5` (strip ~14× cheaper), `ff00d0a`, `fb9ec58`                                                                                                                                                                                      |
| `clock-skew` never green on CI; sign-up emails    | aardvark-dns stops answering ~40 s while the app containers join the network; Better Auth's one-shot mail hit it                                                                                                                | `0ab22f9`: `infra.ts stack` waits for in-network DNS, migrate retries, auth mail retries pre-delivery failures                                                                                                                            |
| `viewers` 20/21; `integrity-basic` hidden-tab dip | `too_many_segments` counted a player's start-up burst against honest headless Chromium; harness HTTP viewers sent some beats >30 s late on purpose                                                                              | `0201068`: a constant 40 s start-up allowance (long sessions still judged by the ratio), steady harness beats, exclusion reasons logged by session id                                                                                     |
| relay billing and drivers heartbeat tests         | both read a count before the code recorded it                                                                                                                                                                                   | `3ddc559`                                                                                                                                                                                                                                 |

Verified: CI on `0201068` all green (integration, relay, harness relay/long/clock/rest, self-host
e2e ×3, release dry run). Locally `clock-skew` 12/12 (WHIP max skew 1 ms), `ingest-whip` 3/3.

**Open findings (batch 2):**

- In flight: `account-deletion` sometimes cannot open a chat websocket ~20 s after the stack is up
  (3 CI runs; green on `0201068`); suspected chat's Postgres connection broken by the DNS outage and
  an unbounded profile read before the upgrade (branch `fix/ci-chat-open`).
- Seen once: `drivers.int.test.ts` WebKit first frame > 45 s (8.6 MB fetched, no errors), CI run
  40765376044.
- CI's Podman 4.9.3 may return nothing for `{{.Label "com.docker.compose.service"}}`, so
  `infra.ts` preflight / crash-loop / diagnose may be no-ops there (inferred, untested).
- The `viewers` egress baseline is the low-latency sessions' ~1.7 MB/s, so "origin egress drops"
  passes too easily; digest assertions skip silently without `HARNESS_PROMETHEUS_URL`.
- P2P: +4 s latency (4–8 s behind the edge), 37 % of opted-in bytes from peers, first ~10 s HTTP
  only; measured on localhost only. ADR 0005 amendment 1 needs this trade-off text; audio swarm ids
  use the playlist directory, not `audio` (decision 5 wording, user to decide). Report
  p2p-media-loader-hlsjs 4.0.0's `updatePlaylist` (breaks on LL-HLS URLs) upstream.
- The sender-report relay works around gortsplib v5.6.7 dropping a report that arrives before the
  SSRC's first packet; report upstream (a pinned int test notices when MediaMTX fixes it). The self-
  host Quadlet units do not have compose's migrate retry.
- A WHIP publisher that runs off real time still moves PDT; a stall > 5 s re-anchors the source path
  while rungs and the VOD keep their W0 (reported, not handled). A ladder start drops up to 2 s.
- `infra.ts stack` does not restart MediaMTX on a config-only change.
- The web image's missing-stylesheet fix is on `claude/elastic-bartik-7d287f` (`b83e86e`), not
  merged (user to decide).

**Gate stability (fix next):** timing tests fail under load (several given longer timeouts this
batch); Podman Desktop's polling pegs the VM's API service (keep it closed during the gate); a
failed integration run orphans its containers (`commonair-it-*`, `commonair-pgh-*`,
`media-int-*`, `harness-mediamtx-*`), and the stale sweep only removes old ones.

**Open for the user or counsel:** DMCA flow and policy numbers (3 strikes in 365 days, restore
after 12 weekdays, claimant name shown, counter-notice data kept, 395-day consent retention), a US
Copyright Office designated agent before launch; the DSA statement template; EU lawful basis for
default-on P2P; a suspended, signed-out user can only appeal by email (better-auth refuses a
banned sign-in); the TURN relay range on the DigitalOcean firewall (only udp/3478 is open).

Environment note: the podman VM's chrony has no time source; its clock drifted ~150 ms behind
the host and failed the governance tests' 100 ms margin. Reset with
`podman machine ssh 'sudo date -u -s @<host epoch>'`.

### Batch 1 (R0 + S1)

Batch 1 (waves and shared rules: `.claude/briefs/r0/README.md`): **all nine units merged and
verified** (2026-10-27; see "Wave 3 and verification" below). ADR 0032 (scaling and availability)
is **proposed**, awaiting the user.

| Unit          | Wave | Brief                                | Owns (summary)                                                                                                      | State                        |
| ------------- | ---- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| R0-a irc-fds  | 1    | `.claude/briefs/r0/R0-a-irc-fds.md`  | `services/irc/**`, `infra/systemd/commonair-irc.socket`, `commonair-irc.container`, `network.test.ts`, `e2e-irc.ts` | merged `c22eb96`             |
| R0-b s3-ext   | 1    | `.claude/briefs/r0/R0-b-s3-ext.md`   | `selfhost.sh` (not backup), `unit-env.ts`, S3 lines of the units, `infra/garage/**`, Caddy S3 route, `e2e-s3.ts`    | merged `c3b48b4`             |
| S1-a capacity | 1    | `.claude/briefs/s1/S1-a-capacity.md` | `harness/src/load*`, `metrics.ts` (additive), `load-{plan,sweep}.ts`, `docs/operators/capacity.md`, `scripts/load`  | merged `5cc5da8`             |
| S1-c replicas | 1    | `.claude/briefs/s1/S1-c-replicas.md` | `harness/scenarios/multi-instance.ts`, `harness/compose.multi-instance.yaml`, `harness/src/multi/**`                | merged `eb13e10`             |
| S1-g IaC      | 1    | `.claude/briefs/s1/S1-g-iac.md`      | `infra/tofu/**`, the IaC section of `docs/deploy/digitalocean.md`                                                   | merged `1b43869`; tofu unrun |
| R0-c backups  | 2    | `.claude/briefs/r0/R0-c-backups.md`  | `selfhost.sh` backup, `docs/self-hosting/backups.md`, `e2e-backup.ts`                                               | brief ready                  |
| R0-d units    | 2    | `.claude/briefs/r0/R0-d-units.md`    | unit dependency lines, `infra/postgres/health.sh`, `quadlet.test.ts`                                                | brief ready                  |
| R0-e tests    | 2    | `.claude/briefs/r0/R0-e-tests.md`    | `scripts/selfhost/e2e.ts`, `stack.int.test.ts`, `quadlet-order.test.ts`                                             | brief ready                  |
| R0-f docs     | 3    | `.claude/briefs/r0/R0-f-docs.md`     | `docs/self-hosting/**` (not R0-b's and R0-c's pages)                                                                | brief ready                  |

### Wave 1 (2026-10-26): merged on main, gate pending the user

Each unit ran in its own worktree, got an independent review, then a fix pass. All five merged
locally; targeted tests only (the user runs the gate).

| Unit | Commits (branch)                       | What landed                                                                                                                                                                                                                                                                                                                                                                                    | Targeted tests                                                                  |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| R0-a | `3c550de`, `f29edd8` (`r0/a-irc-fds`)  | IRC on systemd sockets (`commonair-irc.socket` 6667 `irc`, `commonair-ircs.socket` 6697 `ircs`; two units because `FileDescriptorName=` names every fd of a unit). Bun listens on inherited fds (proved first). `LISTEN_PID=1` accepted when ppid is catatonit. Log line shows `fdNames`. `e2e-irc.ts` probe (50 held from 127.0.0.2, one more refused, other sources admitted, TLS verified). | irc 270 unit, 21 int; infra 581                                                 |
| R0-b | `a86086e`, `c1017c8` (`r0/b-s3-ext`)   | `selfhost.sh --s3-*`: external S3 store or Garage (default). `garage-init` → `storage-init` (creates or checks buckets/keys). Caddy S3 route as snippets per `S3_MODE`; CSP `connect-src` takes `S3_CONNECT_SRC`. Mode switch and endpoint/bucket repoint refused; storage validated before host prep as root. `docs/self-hosting/object-storage.md`. `e2e-s3.ts`.                             | selfhost-s3 53                                                                  |
| S1-a | `01ff7ec`, `8526667` (`s1/a-capacity`) | Remote capacity tooling: SSH host sampling (/proc, podman stats), generator shards over SSH, `load-sweep` scenario (step up until a limit breaks; heartbeat errors make a step inconclusive; streams axis at 1080p/6000k), `docs/operators/capacity.md` runbook (Bun from the digest-pinned image).                                                                                            | harness load-* 117                                                              |
| S1-c | `78c86a7`, `85b5229` (`s1/c-replicas`) | `multi-instance` scenario + `harness/compose.multi-instance.yaml` (`multi` profile: api-2, chat-2, worker-2, origin-2): nine ADR 0032 replica claims, two kills/restores, claim time budget.                                                                                                                                                                                                   | harness multi-* 123                                                             |
| S1-g | `d6d69dc`, `504c597` (`s1/g-iac`)      | `infra/tofu/` DigitalOcean stages 0–2 (OpenTofu 1.13.1, provider 2.106.0), mocked-provider tests, encrypted state, firewall, backups, monitoring droplet, README with gaps.                                                                                                                                                                                                                    | **tofu fmt/validate/test never ran** (agents may not run the downloaded binary) |

Integration commits: `a1e08cf` (playback rate-limit bucket, below), `fdcb287` (R0-a/R0-b
contract requests), the S1 contract-request commit after the S1 merges.

**Contract requests applied:**

- R0-a: IRC drops out of compose.test `PUBLIC_PORTS`; the install's `enable --now` lists both IRC
  sockets; selfhost.sh socket comment; `irc-socket.test.ts` expects `fdNames`.
- R0-b: the IRC unit's `storage-init` dependency and S3 lines removed; caddy/compose/quadlet/
  selfhost-unit-env tests for the rename and the snippets; CSP `connect-src 'self'
  {$S3_CONNECT_SRC:}` and `S3_CONNECT_SRC` in Caddy's keys; config reference regenerated.
- S1-a request 2 (user approved): `playback` rate-limit bucket (3000/min per address) for
  `playback.start/heartbeat/end` instead of `default` (120/min, about 20 viewers per address).
  Contracts `ProcedureMeta.rateLimit` gains `playback`. Test in `platform.int.test.ts`.
- S1-c: `multi-instance` in `FULL_REQUIRED`; `scripts/infra.ts stack --harness --multi`; the
  gate's stack step now starts the replicas (`verify.ts`).
- S1-g: `REUSE.toml` annotation for `.terraform.lock.hcl`, `check-licenses.ts` OpenTofu
  provider check (`infra/tofu/provider-licenses.json`), `scripts/release/tools.ts` OpenTofu
  1.13.1, `tofu-licenses.test.ts`.

**Held:** S1-g's `verify.ts` tofu step and CI change, until the user has run
`REQUIRE_TOFU=1 bash infra/tofu/check.sh` (h1: lock hashes were computed by hand). S1-a request 1
(move `HARNESS_LOAD_*` from `harness/src/load/env.ts` into `harness/src/env.ts`) and request 3
(an `inconclusive` scenario status) deferred: the code works without them; capacity.md tells
readers to read `data.verdict.outcome`.

**Open findings (accepted, not fixed):**

- R0-a: no `IRC_LISTEN=systemd` opt-in (would need a config env var); a pid mismatch falls back
  to binding inside the container. The e2e plain/TLS checks are the guard. Whether Podman passes
  `LISTEN_FDNAMES` and how catatonit sets `LISTEN_PID` is unverified until the e2e runs.
- S1-g: backups versioning does not stop a stolen readwrite key (documented as accepted risk with
  options); Spaces lifecycle rule with only abort-multipart unconfirmed; staging has no uptime
  monitoring until production's monitoring droplet exists; region/size slugs need `doctl`.
- S1-c: not run live; S1-a: droplet sweep not run.

### Wave 2 (2026-10-26): merged on main, gate pending the user

Base `265f4c7` (wave 1, pushed). Implement, independent review, fix pass in the same worktree.

| Unit | Commits (branch)                      | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Targeted tests                          |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| R0-c | `e526c88`, `219a062` (`r0/c-backups`) | `selfhost.sh backup [--database] [--objects] [--restore-objects] [--bwlimit] [--max-delete] [--allow-empty-source]`: rclone (host package) syncs media and evidence offsite (`BACKUP_OBJECTS_REMOTE_*`), restore copies back without deleting. Guards: an emptied source is refused, `--max-delete` (default 1000), a lock, an unfinished-restore marker. Garage read-only backup key created by the script. `commonair-object-backup.{service,timer}` daily 04:00 UTC, enabled by the first successful run. `status` shows the last object backup. backups.md rewritten. `e2e-backup.ts`. | selfhost-backup 68, e2e-backup 12       |
| R0-d | `dbdcb3a`, `318ec6b` (`r0/d-units`)   | Observability no longer holds back the apps (`Wants=` + `After=` on start, not health). Drop-in directories (incl. symlinked) survive install/upgrade; dangling drop-in symlinks removed. `commonair-pg-health` state in `/run`, SIGKILL after a grace when SIGQUIT/SIGTERM does not stop a stuck postmaster.                                                                                                                                                                                                                                                                              | infra 254 unit; pg-health int SIGKILL 2 |
| R0-e | `06417e8`, `6c88fd1` (`r0/e-tests`)   | e2e: `--storage garage\|external`, `--keep`, a Zot pull-through mirror locally (`--no-mirror`), R0-a's IRC and R0-b's S3 checks wired, ExecStopPost= order check; CI third job (Debian, external store). `quadlet-order.test.ts`, `selfhost-e2e-variants.test.ts`, migrate timing in `stack.int.test.ts`.                                                                                                                                                                                                                                                                                  | 85                                      |

**Contract requests applied (integration commit after the merges):** R0-c's object-backup timer
in compose.test's timer list; `rclone` in root_prepare's apt and dnf installs (and the install
test); R0-e's `cgroup-reset.sh` header (it is the _first_ ExecStopPost=, Quadlet's `podman rm`
follows); the unused `--distro`/`--keep` flag allowlist entries dropped; R0-c's checks wired into
the e2e's backup step (setup, check, teardown, never `externalStoreSetup` again) and the variants
test updated to match. Targeted: infra unit 659, scripts unit 778, tsc clean.

**Not applied:** R0-d's optional compose.yaml change (dev stack depends_on the collector
`service_started` instead of `service_healthy`), to keep the dev gate unchanged; worth doing later.

**Open findings (accepted):** R0-d: a collector container that cannot start at all can still hold
back the apps through After= with RestartMode=direct; drop the apps' After= on the collector if
the droplet shows it matters. R0-e: the migrate test limits (150 s/160 s) come from one 76 s run;
time it during the gate. R0-c: object backups do not encrypt (rclone crypt is the manual path);
the e2e checks only full-bucket emptying, not partial thinning (provider versioning covers that).

### Wave 3 and verification (2026-10-27)

R0-f (`8c1ad98`, `5678fee`, merged `dc211b9`): the self-hosting guide brought in line with R0-a..e
(reading path, fork upgrades, drop-ins, crash loop, IRC addresses, external S3, object backups,
troubleshooting). Its follow-ups outside `docs/self-hosting/` landed in `1775d0b` and `7ff4188`
(infra/README, releasing, the DigitalOcean guide, ADR 0032 notes from S1-c, architecture).

The orchestrator ran every check itself at the user's request. What failed, and the fix:

| Check                                  | Failure                                                                                                                  | Fix                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `infra/tofu/check.sh` (first run ever) | mocked droplet ids and reserved IPs had the wrong types; tests used `nyc1`, which has no Spaces                          | `28a7736`; lock files regenerated by `tofu providers lock` (3 platforms); the held `tofu` verify step and CI install applied |
| `bun run verify`                       | 5 s timeouts in shell-driven selfhost and drop-in tests under load                                                       | `610b134`, test timeouts                                                                                                     |
| self-host e2e (debian)                 | R0-a's IRC probe used `localhost/commonair/irc:latest`, absent on an installed host                                      | `116f431`: probe in the running gateway's image                                                                              |
| self-host e2e (external)               | the outer Podman's `host.containers.internal` in the host's /etc/hosts reached the instance's containers                 | `116f431`: dropped before the store starts                                                                                   |
| `verify:full` e2e-basic                | the dashboard's avatar upload (web-gaps branch) is a cross-origin PUT under compose; Garage had no CORS rule             | `3c4869e`: `garage-init` sets one from `GARAGE_CORS_ORIGINS` (compose only; production is same-origin via Caddy)             |
| `verify:full` multi-instance           | issuance computed twice per minute; chat served stale slow mode in an empty room; viewer-count and kill checks mis-timed | `87479c8` (origin keeps the lock), `10b5404` (chat evicts a room's caches on release; scenario timing per ADR 0032)          |
| `verify:full` integration              | a worker test sampled a running job; teardowns leaked containers and starved the Podman VM                               | `e1901c0`, `56ba674`                                                                                                         |
| CI `verify (unit)`                     | the scenario registry's first load took > 5 s                                                                            | `9a72f3e`                                                                                                                    |

Results: `bun run verify` green (with tofu); self-host e2e green on debian (Garage), fedora (Garage)
and debian (external store); `verify:full` 18/19 scenarios, the one miss `ingest-whip` WebKit
TTFF 15.16 s against 15 s on the loaded local VM (13.0 s and 10.7 s rerun alone, green on CI).
CI on `56ba674`: everything green but the registry timeout fixed in `9a72f3e`.

**Left for real servers** (R0-release.md §3): S1-a's capacity sweep on dedicated droplets; a
restore onto a second droplet, timed; ACME renewal; Fedora 42 with SELinux enforcing; arm64; a
rollback on a real host. Then rc.3 from a green `ci-ok`, and `v0.1.0`.

**Still open from batch 1:** R0-d's optional compose `depends_on` change; an `IRC_LISTEN=systemd`
opt-in (R0-a); S1-a's requests 1 and 3 (harness env move, `inconclusive` status); S1-g's accepted
risks (versioning vs a stolen key, Spaces lifecycle rule, staging monitoring); chat acknowledges
before storing, so a SIGKILL loses the last flush interval (ADR 0032 accepts it).

## Web gaps from the first real-host install (2026-10-26, branch `claude/web-gaps-resend-upload`)

The two product gaps session thirteen found on staging-stream.abolish.us, closed in the web app:

- **Resend verification email.** `ResendVerification` (`apps/web/src/components/resend-verification.tsx`)
  on `/signin` after an `EMAIL_NOT_VERIFIED` refusal and on the sign-up "Check your email" screen.
  It posts to better-auth's `send-verification-email` (`AUTH_ROUTES.sendVerificationEmail`, new).
  Every answer but a 429 shows one neutral confirmation (better-auth answers alike for unknown and
  verified addresses; a mail failure for a real one is a 500 the UI hides too). The per-IP auth
  limit in `http.ts` covers it; the button also cools down for 60 s.
- **Avatar and banner upload.** `ChannelAppearanceCard` on `/dashboard`: contract type/size checks,
  `uploadChannelFile` (presigned PUT, scanning commit), the generic rejection message, a local
  preview while uploading, then `channels.update` with the committed key merged into the theme as
  the server has it at save time (a takedown may have cleared the other key). Remove buttons clear
  a key. Upload limits moved to `@commonair/contracts/shapes` (`UPLOAD_TYPES`, `MAX_UPLOAD_BYTES`)
  and are shared by the contract, the API and the web.
- Harness: `e2e-basic` now resends the verification mail (expects two in Mailpit) and uploads an
  avatar from the dashboard, then fetches it from `/media`. New ids in `e1-selectors.md`.
- Open: the channel page does not show the banner yet (`bannerUrl` is in the DTO, no UI renders it).
  The `send-verification-email` endpoint still answers 500 when SMTP fails for a real unverified
  address (an enumeration signal at the HTTP level; the UI hides it).

## Session thirteen (2026-10-23/26): v0.1.0-rc.1 and rc.2 released, verified, installed and upgraded on a real host (Phase 5 Part 3 done)

Continues session twelve's "User to run (Part 3)". Notes on branch `phase5/release-rc1`
(worktree `.claude/worktrees/p5-release`).

| Step                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Protection                    | Repository rulesets (admins bypass both, so `main` can still be pushed directly): **25748771** `main requires ci-ok` (no deletion, no force-push, `ci-ok` from GitHub Actions, app 15368); **25748772** `release tags v* are immutable` (only admins create, move or delete `v*`)                                                                                                                                                                                                                                                                                                                                                                      |
| 2. Tag                           | `v0.1.0-rc.1` → `ef9f2b3`, SSH-signed (ED25519 `SHA256:nT6+OCR5…`; key on `abolishadmin` as a signing key; signing config passed per command, no git config written). `git tag -v` good                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2. `release.yml` run 40057330617 | **green in 6 min 16 s** (03:12:07–03:18:23Z): prepare 13 s; 28 image builds 20 s–2 min 13 s (web amd64 the longest), all done by 03:15:17; relay binaries 2 min 17 s; 14 publish jobs 1 min 3 s–2 min 15 s; manifest, bundle, checksums 20 s; GitHub release 21 s; `move latest` skipped (prerelease). Release is a prerelease with 76 assets (74 in `SHA256SUMS` + the file and its bundle)                                                                                                                                                                                                                                                           |
| 3. Packages public               | nothing to do: all 14 `ghcr.io/abolishus/commonair/<image>` manifests answer 200 to an anonymous token (packages inherit the public repository's visibility)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4. `verifying.md`, as written    | from a clean directory with the pinned cosign 3.1.3: `SHA256SUMS` verifies against the tag regexp and the exact `refs/tags/v0.1.0-rc.1` identity, and is refused for `refs/heads/main`; `sha256sum --check` 74/74 OK; 6 relay binaries: signature and `slsaprovenance1` attestation OK; 14/14 images `cosign verify` OK; api CycloneDX and provenance attestations OK (one SBOM per platform, 5163/5180 components); provenance: `refs/tags/v0.1.0-rc.1`, commit `ef9f2b3` = the tag's, run 40057330617. Every tag resolves to the manifest digest; the bundle's 13 `Image=` lines equal the manifest's (relay has no unit). No doc step needed fixing |

### 5. Real install: DigitalOcean droplet, Debian 13 (2026-10-24/26)

The user chose DigitalOcean over Hetzner for this test (and, pending an ADR, for staging and
production: tooling an agent can drive, `doctl` and an official MCP server). Droplet
`commonair-rc-test` (`s5-4vcpu-8gb-80gb`, 4 shared vCPU, 8 GB, 80 GB, mkc1, IPv4 + IPv6), a
DigitalOcean cloud firewall with exactly the requirements.md ports (SSH only from the operator),
`staging-stream.abolish.us` A/AAAA in Cloudflare (DNS only). Debian 13.7, kernel 6.12, systemd 257.

| Check                                     | Result                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| install.md §1–§2 as written               | worked: full-upgrade + reboot, cosign 3.1.3 against the pinned SHA-256, `SHA256SUMS` signature (tag identity) and bundle checksum OK. Gap: §1 gave no cosign install command (fixed below)                                                                                                               |
| §3 `install --version v0.1.0-rc.1 …`      | **exit 0 in 302 s**. quay.io answered 503 once; the pull retry (`78f43e4`) recovered on its own                                                                                                                                                                                                          |
| ACME                                      | **Let's Encrypt** (`YE1`) certificate for the host, valid to 2027-01-22, also on IRC 6697. HTTPS 200 over IPv4 and IPv6, HTTP → 308, `alt-svc: h3`, HSTS                                                                                                                                                 |
| `status` (as `commonair` over SSH, §5)    | all 18 services active and healthy                                                                                                                                                                                                                                                                       |
| Real client addresses (over the internet) | the auth bucket: 10 POSTs from the operator's IPv4 pass, the 11th is 429; a spoofed `X-Forwarded-For` is still 429; the operator's IPv6 and the droplet's own IPv4 are separate clients; claiming the operator's address in `X-Forwarded-For` is not believed                                            |
| `podman kill commonair-worker`            | **back and healthy in 16 s**, NRestarts 0 → 1, no "Device or resource busy": the first real-host run of the cgroup reset (`ffb3bc7`)                                                                                                                                                                     |
| Mail (Resend)                             | **DigitalOcean blocks outbound 25, 465 and 587**: the first verification mail timed out (`ETIMEDOUT` in nodemailer). Resend's 2587 (STARTTLS) works; `install --reinstall` 111–112 s                                                                                                                     |
| Sign-up, admin role                       | sign-up through the web UI (ALTCHA, terms, verification mail); the role CLI from install.md §5 made `rctest1` admin                                                                                                                                                                                      |
| Avatar (browser)                          | presigned PUT through Caddy's same-origin S3 route 200, `commitUpload` (hash matcher + classifier) 200, `channels.update` theme 200, `/media/channels/<id>/avatar/<id>.png` 200 `image/png`, bytes equal to the upload. Driven from the signed-in page: **the web app has no avatar upload control yet** |
| Data export (browser UI)                  | requested from /settings/privacy, ready in about 10 s (2.5 kB); the signed link on the same host returns 200 `application/zip` with `content-disposition: attachment`; the same path unsigned is 404                                                                                                     |

Found on the host, fixed on this branch: install.md §1 now has the pinned cosign download (a test
keeps it equal to `scripts/release/tools.ts`); requirements.md and install.md describe blocked SMTP
egress and alternate ports; `machinectl` needs `systemd-container` on Debian; **`status`, `backup`
and `upgrade` refuse root and a session without a user manager with the fix** (before: `status`
printed `?` for every unit under `su - commonair`).

Found, not fixed (product gaps): the sign-in page offers no way to resend a lost verification mail
(the first one was lost to the SMTP block; the API's `send-verification-email` endpoint works);
the web app never calls `uploadChannelFile`, so there is no avatar/banner upload UI.

`main` went red after rc.1 for two reasons unrelated to it (CI run 40179448209 at `683be21`):
`bun audit` found happy-dom GHSA-834v-8h66-3h79 (published 2026-10-23; the fix 21.0.4 clears the
7-day cooldown on 2026-10-27), taken as a dated exception until 2026-10-28 (test-only
devDependency); and ingest-whip's Chromium first frame timed out again, now with the diagnostics
from `a38438f`: path mse, session up, 3.3 MB received, 0 stalls, 2 heartbeats, no decoded frame.

### 6. v0.1.0-rc.2 and the upgrade (2026-10-26)

- `main` `60b2206` (the fixes above): CI 40351033323 green except ingest-whip; a rerun of that job
  passed (attempt 2), but another session had by then found the root cause, an hls.js 1.7.3
  GAP-start wedge (`5e4ce6c`, see the note below). CI 40359523245 at `8b8a0a2`: **`ci-ok` green on
  the first attempt**, ingest-whip included; local gate green in 526 s.
- `v0.1.0-rc.2` → `8b8a0a2`, SSH-signed like rc.1. `release.yml` run 40380664493 **green in
  6 min 59 s**, prerelease, 76 assets, `latest` untouched. Verified against the exact
  `refs/tags/v0.1.0-rc.2` identity: `SHA256SUMS` signature, 74/74 checksums, 14/14 images, 6/6
  relay binaries; the manifest names `8b8a0a2`.
- On the droplet, as `commonair`: `selfhost.sh upgrade --version v0.1.0-rc.2 --require-signature`
  **exit 0 in 224 s** (signature, checksum, pre-upgrade base backup, migrations, every service
  healthy); `selfhost.sh backup` exit 0 in 1 s (four base backups listed); `status`: rc.2, previous
  rc.1, all 18 services healthy, last backup success. The same Let's Encrypt certificate; HTTPS 200;
  the rc.1 avatar still served (200, same bytes), so database and objects survived. As root,
  `status` now refuses with the fix, and under `su - commonair` it names the missing user manager
  (both from `9e4a5e4`, on the host). `podman kill commonair-worker` on rc.2: healthy in 18 s,
  NRestarts 0 → 1.

### Left

- happy-dom 21.0.4 on or after 2026-10-27 (vet, bump both package.json files, drop the exception).
- ADR 0025 **accepted** (2026-10-26): `docs/deploy/digitalocean.md`, 0010 superseded, Railway
  retired from the repository. The droplet `commonair-rc-test` is the staging host until S1-g's
  OpenTofu recreates it. The Railway project was deleted on 2026-10-27 (its mediamtx service was
  still failing on every push, looking for the removed Containerfile).
- Decided with the user the same day: managed Postgres and Valkey at S1 stage 1, with
  `selfhost.sh` support for external managed services for every operator; 99.5% at launch, 99.9%
  from stage 1; `v0.1.0` waits for R0-g (resend verification email, done in `6a1983f`); P1 moves into batch 2
  (`.claude/briefs/next/README.md`).
- Not exercised on a real host: Fedora (SELinux labels) and a rollback (CI's e2e covers rollback).

## Session twelve (2026-10-22/23): validating and finishing Phase 5 (Parts 1–2 done, `ci-ok` green; release pending the user)

Plan: `.claude/briefs/phase5/handoff-validation.md`. Work happens on `phase5/validate`
(worktree `.claude/worktrees/p5-validate`), merged to `main` only after review and a green gate.

### What ran

| Check                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run verify` on `452752c`                            | red: 1 unit test (fixed `793db63`)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `verify` with the user's stack up                        | `infra up` refuses another checkout's compose project; the gate runs with `VERIFY_INFRA=external` against those data services (same `.env`). The worktree also needs `.cache/models/*.onnx` copied in                                                                                                                                                                                                                                                                         |
| `infra/tests/caddy.int.test.ts`                          | 10/10                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GitHub `ci` run 39829039874 (push of `452752c`)          | verify red (regex benchmark on a slow runner, fixed `793db63`); lint-workflows green; release dry run green, arm64 runners work; e2e fedora red (runner AppArmor, fixed `9599ef6`); e2e debian: see below                                                                                                                                                                                                                                                                     |
| Signed release dry run, run 39830136878                  | green. `release-dist`: 74 files, `sha256sum -c` all OK; `parseManifest` accepts the manifest; 6 relay binaries each with SBOM, signature, in-toto provenance; per-arch image SBOMs and image provenance; `SHA256SUMS.sigstore.json`. `cosign verify-blob` with identity `release.yml@refs/heads/main`: SHA256SUMS and all 6 binaries and their provenance verify; the tag regexp is refused, as it should be. The bundle's 13 `Image=` lines pin exactly the manifest digests |
| Self-host e2e, Debian (local podman machine)             | run 1: missing `nft`/`aardvark-dns` (`7f3d401`); run 2: mixed trees (process, see below); run 3: Garage/Loki/Tempo health checks never pass (`562f8c9`); **run 4 at `562f8c9` (D, E, H) passed**: install 289 s, upgrade 155 s, worker restart 22 s, rollback 415 s; **run 5 at `2025ff3` (+F) passed**: 64 checks, 0 failed (install 318 s, upgrade 159 s, rollback 417 s)                                                                                                   |
| `bun run verify` at `461f830` (external infra)           | **GREEN** in 609 s, every step (also at `5e8e683` in 450 s)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Self-host e2e, Debian, run 6 at `b527dfa` (+G)           | **passed**: 81 checks, 0 failed (install 321 s, upgrade 158 s, rollback 425 s): two source addresses are two clients, a spoofed `X-Forwarded-For` is ignored, Valkey refuses unauthenticated clients, HTTPS over IPv6, only allowlisted listeners. The idle instance uses 531 tasks                                                                                                                                                                                           |
| Self-host e2e, Fedora (local podman machine)             | run 1 at `24d7eba` (D, E, F, H) **passed**: 64 checks, 0 failed (install 283 s, upgrade 138 s, rollback 410 s); run 3 failed: disk full from accumulated e2e images (`9547d1e`)                                                                                                                                                                                                                                                                                               |
| CI run 39844313957 (`phase5/validate`, before F)         | **self-host e2e debian and fedora green** (rootful Podman 4.9 runners); release dry run green; verify red on the regex benchmark (fixed `44ab164`)                                                                                                                                                                                                                                                                                                                            |
| CI main run 39881412275 at `8f5baec`                     | every job green but `verify (harness)`: platform up passes (405 s), the full scenario, never run on CI before, passes 9 of 18                                                                                                                                                                                                                                                                                                                                                 |
| CI dispatch 39886965284 (`phase5/harness-ci`)            | everything green but the harness: **17 of 18** (data-export: one soft web check)                                                                                                                                                                                                                                                                                                                                                                                              |
| CI dispatch 39890667562 (`phase5/harness-ci`)            | everything green but the harness: **17 of 18** (data-export passes; e2e-relay: one soft web check, the same load race). Both self-host e2e distros green (about 25 min)                                                                                                                                                                                                                                                                                                       |
| `bun run verify` on `phase5/harness-ci` (external infra) | **GREEN** in 370 s                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CI dispatch 39896210222 (sharded, `4ce2acd`)             | shards relay 15 min and long 13 min green; rest 13/15 (ingest-whip, integrity-basic, see below); Debian e2e red (Postgres init, fixed `6a4acd9`)                                                                                                                                                                                                                                                                                                                              |
| CI dispatch 39955333600 (`a38438f`)                      | **all three harness shards green** (13–16 min); everything else green but Debian e2e ("layer not known" retry, fixed `fb3e9cd`)                                                                                                                                                                                                                                                                                                                                               |
| `bun run verify` at `9d2ec72` (external infra)           | **GREEN** in 374 s                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CI main run 39966231110 at `292a067`                     | every job green but the Fedora e2e: the worker never restarted after `podman kill` (EBUSY, the same as Debian in 39958894162; fixed `ffb3bc7`). Debian green; its "layer not known" retry fired once and worked                                                                                                                                                                                                                                                               |
| Local Debian e2e at `292a067` (`--keep`)                 | passed (the race did not fire); the kept host then reproduced the worker failure on demand and proved the fix (below)                                                                                                                                                                                                                                                                                                                                                         |
| `bun run verify` at `78f43e4` (external infra)           | **GREEN** in 599 s, every step                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| CI main run 39988149327 at `78f43e4`                     | every verify group, all three harness shards (12–15 min), lint, release dry run and the **Fedora e2e green** (worker back in 21 s, NRestarts 0 → 1). Debian e2e red before install: the host image build hit "layer not known" (fixed `cbc8786`)                                                                                                                                                                                                                              |
| `verify --only static,integration` at `cbc8786`          | **GREEN** in 278 s (a full run before it was red only on `stack.int.test.ts` timing out at 60 s under load 12; 8/8 alone in 46 s)                                                                                                                                                                                                                                                                                                                                             |
| CI main run 39994146130 at `cbc8786`                     | **`ci-ok` GREEN**: every verify group, all three harness shards (12–16 min), lint, release dry run, and both self-host e2e distros: Debian and Fedora 81 checks, 0 failed each (install 238 s, upgrade 135/137 s, rollback 396/399 s), worker back after `podman kill` (NRestarts 0 → 1)                                                                                                                                                                                      |

### Fixes (symptom → root cause → fix)

- `793db63` **strict-stop test threw a TypeError** → the test's `BroadcastSession` stub
  predates `audioCompat` (186acf4) → stub it. **Regex benchmark failed on CI (7.3 ms > 5 ms)**
  → an absolute wall-clock limit on a shared runner several times slower than a workstation →
  the limit is the larger of 5 ms and 8× one quadratic scan (`.{2,}!`) on the same machine.
- `ed648c3` **`drivers.int.test.ts`: heartbeats 0 after the API saw one** → `HttpViewer.stop()` took its
  report before awaiting its loops and wrote it back, dropping a heartbeat in flight → keep the
  settled heartbeat counters; regression test in `hls-viewer.test.ts` that fails without it.
- `9599ef6` **Fedora e2e on CI: "the user manager for commonair did not start"** → the
  ubuntu-24.04 runner's AppArmor profile `unix-chkpwd` attaches by path inside the privileged
  test host and denies `dac_read_search`; Fedora's `/etc/shadow` is mode 000, so PAM fails for
  `user@1000` → the CI job unloads that profile on the runner (not the host under test), with a
  test that the step precedes the e2e.
- `7f3d401` **Debian e2e: every container fails, `netavark: unable to execute nft`** →
  `aardvark-dns` and `nftables` are only Recommends of netavark on Debian; the e2e host had
  Podman without recommends, and `selfhost.sh` installed packages only when `podman` was
  missing → `selfhost.sh` checks for both helpers, installs them as root and names them in its
  errors; the e2e hosts now start without Podman, like a fresh server, so the e2e exercises the
  script's own package installation.

- `f2e8c49` **`auth-avatar-revocation.int.test.ts` failed in a full run, and 3/3 when run alone**
  → both NCII avatar race tests (and the one in `fixes.int.test.ts`) used made-up keys
  (`race.png`, `revoked.png`) that the API refuses on their shape before it takes the upload's
  advisory lock, so nothing ever waited; the unscoped `pg_stat_activity` poll passed only when
  another test file's lock waiter in the shared cluster matched → committed uploads (key shape
  plus object in storage), a poll scoped to `current_database()` with a deadline, and a control
  showing the same setup is accepted without a tombstone.
- `8147fb8`, `9b33130` review follow-ups: a robust benchmark baseline with a ceiling; the
  AppArmor step unloads only a loaded profile; CI shellchecks `infra/postgres/*.sh` (with source
  directives).
- `f0f755a` **every unit start in the e2e host waited 90 s** (`podman-user-wait-network-online`
  timed out) → a container has no wait-online service, so `network-online.target` never
  activates → the e2e host enables a oneshot that stands in for the distribution's wait-online
  service, as on a real server. Proven in a throwaway container (`network-online.target` active).
- Process: e2e run 2 mixed trees. The e2e builds images and the bundle from the live worktree
  at different times, and unit D merged in between (units with the new health check, a Postgres
  image without it). e2e runs now use a snapshot worktree (`.claude/worktrees/p5-e2e`) pinned to
  a commit.
- Review of the head fixes (`wf_987b1e1b-c78`, correctness + security): no HIGH; the MEDIUM (e2e
  host no longer installs `fuse-overlayfs`) checked on the host: the service user's Podman 5.4.2
  uses `overlay`, not `vfs`.

- `fabb954` **CI: `fixtures.test.ts` regenerated PNGs with different bytes** → ffmpeg's PNG
  encoder output depends on its build (zlib); the PDQ lists matched → compare decoded rgb24
  pixels for the PNGs, bytes for the hash lists.
- `062889c` **CI Debian e2e: `layer not known` while building loki** → a transient Podman 4.9
  build-cache lookup failure right after pulling a base (the same build passed in the run
  before) → retry a build once on exactly that error.
- `aaac647` **CI Fedora e2e: "Podman unknown is too old (need 5.0 or newer)"** → `podman
  version` failed for the service user and the empty output was read as a version; the cause
  was `newuidmap`/`newgidmap` without file capabilities in the Fedora _container_ image
  (`rpm -V`: P), which a real Fedora install has → `selfhost.sh` reports podman's own error, with
  the fix for the newuidmap case; the Fedora e2e host reinstalls `shadow-utils`.
- `562f8c9` **Debian e2e: Garage killed every two minutes, nothing behind it started** → Podman
  reads a plain `HealthCmd` string as CMD-SHELL (`/bin/sh -c`); Garage's image has no shell, and
  Loki, Tempo and the OTel collector only a static busybox. A JSON array is no fix: Podman 5.4
  splits it on whitespace → every unit uses `HealthCmd=CMD <argv>`, exec form on Podman 4.9, 5.4
  and 6.1 (checked on 5.4.2 and 6.1.4); the Quadlet mirror test asserts the exact form compose
  uses. Proven live on the kept e2e host: after patching the installed units, Garage, Loki,
  Tempo, the collector and then api, chat, media, origin, worker and tracker went healthy.
- `3529dcd` (unit E review LOW) the Caddy S3 matchers no longer match the exports bucket root
  (a signed listing) or the `incoming/` prefix itself.

- `24d7eba`… CI verify had **never** been green (51 failed runs in history); each fix got it one
  step further:
  - `1c2ea60` **`selfhost.sh is clean` failed on CI only** → the test ran ubuntu-24.04's
    `/usr/bin/shellcheck` 0.9.0 (SC2015 on a line 0.11.0 accepts) → the selfhost tests use only
    the pinned 0.11.0 (local binary of that version, else its pinned image).
  - `cfc53ab` **`infra up`: cannot connect to the Podman socket** → `podman compose` picked the
    runner's docker-compose plugin → `PODMAN_COMPOSE_PROVIDER=podman-compose` in the job.
  - `b527dfa` **migrations: password authentication failed for `commonair`** → init-env generated
    `POSTGRES_PASSWORD` but copied the example's fixed `DATABASE_URL` (`commonair:commonair`);
    existing checkouts never noticed (old volumes, hand-fixed URLs) → a fresh `DATABASE_URL`
    carries the generated password; a kept one is left as it is.
  - `869a6d3` **`onnx.int.test.ts`: model file missing** → CI never fetched the weights → the job
    runs `scripts/fetch-model.ts` (sha256-checked), cached on `model.ts`.
  - `461f830` the harness integration tests drive Chromium and WebKit on every gate, but CI
    installed the browsers only for the full gate → installed on every run.
- `c76a1cb` **CI Fedora e2e: api, irc and media aborted, Caddy 502** → `pthread_create`/`fork`
  EAGAIN: Podman's default pids limit (2048) on the privileged test-host container capped the
  whole instance → `--pids-limit=-1`. A real server has no such cap: systemd's user-slice limit is
  about 21K tasks even on an 8 GB host (reviewer's estimate); the idle instance uses 531.
- `803c720` **CI Fedora e2e: listener allowlist failed on `systemd-resolved`** (5355, 127.0.0.53/54)
  → the check judged the operating system's sockets too → it reads `ss -Hltne` and keeps the
  service user's sockets.
- `9547d1e` **local Fedora e2e: no space left on device** → each run builds 14 images (about
  5 GB) tagged by commit and nothing removed them → the e2e removes its own earlier-commit images
  (only its namespace; no global prune, which would drop a developer's build cache).

- `5ff2e53` (review HIGH on `9547d1e`) **the e2e image cleanup freed nothing** → the release
  images are built FROM the commit images, so removing a parent only untagged it → children first,
  then dangling former children by their own label, then other commits' images. (Review MEDIUM on
  `803c720`) the listener check now judges every listener except `cgroup:/system.slice/` (the
  operating system's services), so root-owned sockets are judged too.
- `7910a24` **CI harness tests: WHIP and two WebKit tests** → Ubuntu's ffmpeg 6.1 has no WHIP
  muxer; Playwright's Linux WebKit has no native HLS, and the tests assumed WebKit always takes
  the native path → the streamer falls back to the pinned MediaMTX image's ffmpeg 8.1 through
  `podman run --network host` when the local one lacks WHIP (also for the scenarios' `whip`
  need); the tests expect the player's own rule (native only for a non-Chromium engine that can
  play HLS). 10/10 twice locally with the container path forced.
- `0d182ec` CI Debian e2e: another Podman 4.9 build-cache loss ("creating build container …: image
  not known") → retried once, like "layer not known". Reviewed (no HIGH/MEDIUM); `54b127c` adds the LOW's
  negative case (a missing base named by id is not transient).
- Branch `phase5/harness-ci` (this unit; `phase5/validate` merged in): the full harness on Linux CI.
  - `0c9b70e` **9 harness scenarios failed on CI** (account-deletion, vod-clips: ops hooks off;
    trust-safety: moderation hooks off; e5-coop: long governance periods; data-export "Invalid
    RTMP URL" and simulcast's dashboard timeout: the API refused the mock target's private
    address; e2e-relay: `OUTBOUND_ALLOW_PRIVATE_NETWORKS` false) → the gate's `platform up` ran
    the plain `infra.ts stack`, without the harness overrides; locally the stack is started by
    hand with `--harness` and `VERIFY_INFRA=external` skips the step, so it never ran → it runs
    `stack --harness`. **ingest-rtmp/ingest-whip: "webkit: playback path mse"** → the scenarios
    assumed WebKit always plays HLS natively → `BrowserFleet.expectedPlaybackPath` asks the
    fleet's own browser (`canPlayType`, with the player's 2 s wait) and applies the player's
    rule; `drivers.int.test.ts` uses it too. Tests: `verify.test.ts`, `playback-path.test.ts`.
  - `94d4bb2` the harness job also runs on `workflow_dispatch`, so a branch can be proven
    before main (it ran nothing on a dispatch). Security review: no HIGH/MEDIUM.
  - `f191fd7` (review HIGH on `0c9b70e`) **on a fresh volume `verify:full` would fail e5-coop**:
    `infra up`'s migrate seeded default governance before platform up, and the bootstrap applies
    only at the first migration (ADR 0020) → `infra.ts test` takes the same overrides as `stack`,
    and the gate passes `--harness` to it when harness scenarios follow (`infraUpCmd`, tested).
  - `dda7020`, `d4a7bbb` **data-export: "the ready account row has a download link" failed on
    CI** while every API check passed → the page builds its export list after hydration and
    `count()` does not wait → wait for the export's row first; the review found the same race on
    the cooldown button (enabled until the list loads), fixed the same way.
  - `9edae39` **e2e-relay: "relays page starts empty" failed on CI** → the same load race
    (skeleton rows until the list loads) → wait for the empty state or a row.
  - `4ce2acd`, `362d88e`, `682c7ad` **the harness job took ~34 min** (4 min image builds, 1.5 min
    start, 27 min scenarios) → at the user's request (this session took over the CI items) `full`
    runs as three shards on parallel runners: `full:relay` (e2e-relay), `full:long` (trust-safety,
    e5-coop), `full:rest` (the complement, so a new scenario always runs); `verify --full --shard
    <name>`; tests pin that the shards partition `full` and that the CI matrix is the shard list.
    Each shard job takes 13–16 min. A registry layer cache for the image builds was built and
    **removed** after its security review (three MEDIUMs: the cache shared the ghcr namespace with
    the release packages, so its `packages: write` token, readable by unpinned pipx code on the
    host, could overwrite release tags; a poisoned layer would be re-pushed forever; nothing prunes
    it). Doing it safely needs a separate package namespace and admin rights to prune, for at most
    ~3 min per shard. Shard step limits sit above verify's own (85 > 25 + 10 + 45), job 110.
  - `6a4acd9`, `682c7ad` **CI Debian e2e: "migrations did not finish within 900s"** → on an empty
    volume the stock entrypoint's temporary initdb server got the same `archive_mode=on` flags;
    stopping it waited on `wal-push` to Garage (not ready on a first install: Postgres does not wait
    for garage-init), `pg_ctl` gave up after 60 s and the unit failed (its restart then hit "Device
    or resource busy" in the e2e host) → the entrypoint sources the stock script, overrides
    `docker_temp_server_start` with `-c archive_mode=off` and re-execs itself as postgres; the real
    server archives as before (the init WAL is worthless to a restore, and is archived later anyway).
    `postgres-init.int.test.ts` (S3 unreachable) fails on the old entrypoint with the CI error and
    passes now. A self-host product bug a real first install could hit.
  - `9d2ec72` **the local gate once failed `verify reads the upload back` (uploaded: null)** → the
    stand-in S3 bound the wildcard address and the script dialed 127.0.0.1:<port>; with test files
    in parallel, another test's server bound to 127.0.0.1 on that port wins on BSD sockets → bind
    127.0.0.1 (the review reproduced the misrouting on macOS; Linux refuses that bind). The
    trigger is a check-then-bind race: `freePort()` in `harness/src/relay.ts` probes a port and
    closes it before `relay.test.ts`/`liar-relay.test.ts` bind 127.0.0.1 on it; that race can now
    only show as a loud EADDRINUSE there. Open LOW.
  - `fb3e9cd` **CI Debian e2e: "layer not known", and the retry failed identically** → the retry
    looked the same broken cache entry up again → it builds with `--no-cache`.
  - `a38438f` **sharded run 39896210222: ingest-whip (Chromium first frame, no player errors) and
    integrity-basic (count 3,3,3,3,3,2,2,3) failed once each**; both passed the runs before and
    after, and CI's logs cannot say why → not loosened: the timeout now names the player's path,
    session, source, bytes and heartbeats, and each stability sample records active sessions by
    verdict (a missed heartbeat vs a verdict change). Open until one recurs with that data.
- The CI split (another session, at the user's request): `9ba12c7` verify runs as parallel jobs
  per group (static, unit, integration, relay) plus a harness job on main/nightly, through a
  shared setup action; `9d216dd` ffmpeg 8.1.3 from a pinned, SHA-256-checked static build (WHIP
  included) and apt only for Playwright's libraries. The old single-job CI assertions moved to
  `scripts/tests/verify.test.ts` (`dd67d8a`). `main` was fast-forwarded to `7910a24` and pushed
  at the user's request, then `9d216dd`.

- `ffb3bc7` **e2e (Debian 39958894162, Fedora 39966231110): a killed worker never came back**,
  once Postgres too (39896210222): every restart failed before our code with "Failed to spawn
  executor: Device or resource busy" / "Failed to spawn 'start-pre' task" → systemd 257 (Debian 13,
  Fedora 42) with Quadlet: `podman run --cgroups=split` enables cpu, memory and pids in the unit
  cgroup's `subtree_control`; systemd prunes that cgroup when a unit goes inactive, which with
  `RestartMode=direct` it never does (`service_enter_dead` skips the `*_BEFORE_AUTO_RESTART`
  states), so the only prune left is a cgroup-empty event handled in auto-restart. When the event
  is handled in stop-post instead, before the last control process's SIGCHLD, nothing prunes,
  and `ExecStartPre=` (spawned into the unit cgroup itself, not `.control`) hits cgroup v2's
  no-internal-processes rule on every retry. Upstream's related fix (systemd PR 41304, after 257)
  does not cover a prune that never runs. Real servers are affected, not only the test host:
  reproduced on demand on the kept Debian 13 e2e host's real `commonair-worker` (systemd 257.13,
  Podman 5.4.2) and on a Fedora 42 host (Podman 5.8.2) by making the last `ExecStopPost=` leave
  the cgroup before exiting → `scripts/selfhost/cgroup-reset.sh`, the first `ExecStopPost=` of
  all 20 `RestartMode=direct` units (Quadlet appends its `podman rm` after it): from `.control`
  it waits up to 10 s for podman's sub-cgroups to empty, removes them and disables the
  controllers; a container still running is left alone. With the race forced, the worker came
  back after every kill; without the script it reproduced the CI error exactly. The bundle ships
  files named by `ExecStopPost=`; the e2e dumps the unit's cgroup tree when a restart check fails;
  troubleshooting.md tells older installs to `systemctl --user restart <unit>`. `RestartMode=direct`
  stays (ADR 0023 §10). Reviews: correctness (one HIGH, the e2e dump placed after a throwing
  check: fixed, re-reviewed clean) and security (no HIGH/MEDIUM; LOWs taken: the test root is an
  argument, not an env var; the script refuses anything but a user service's `.control`).
- `78f43e4` **Fedora e2e upgrade: Docker Hub answered 500 for Garage's manifest** (39958894162;
  the pull failed in 0.5 s) → Podman's own `--retry` covers only 502–504 and network errors →
  `pull_images` tries up to four times (5/15/45 s) on 5xx, 429, 408, timeouts, dropped
  connections and failed DNS servers; never on auth, not-found, digest-mismatch or unrecognised
  errors; Podman's error is printed. 15 tests (the retry cases fail without it).
- `cbc8786` **CI Debian e2e (39988149327): "layer not known" building the host image** → the
  `fb3e9cd` retry covered the release images only; the host image's build called podman
  directly → it goes through `build()`; a test fails on any other `podman build`. A run-wide
  `--no-cache` after the first loss was tried and dropped on review (it would rebuild the shared
  Bun stages for every image).
- `5e4ce6c` **ingest-whip: Chromium never showed a first frame** (39896210222, 40179448209:
  session, 3.3 MB over MSE, no errors, no stalls). Reproduced locally with 10% inbound WebRTC loss
  on MediaMTX (`nft` drop on udp/8189 in its netns); hls.js debug logs showed the main stream
  controller stuck in FRAG_LOADING from startup → hls.js 1.7.3 (latest) bug: new MediaMTX muxers pad
  their playlists with `#EXT-X-GAP`, and a WHIP viewer always meets a new one (held by the origin's
  503 until the AAC copy is live). When the live start fragment is a GAP, its init load is still in
  flight when the next fragment starts. That fragment's init load aborts it, and the GAP fragment's
  catch then aborts the fragment loader, which by now carries the next fragment. Before the first
  parse nothing resets the state → `patches/hls.js@1.7.3.patch` aborts only when the failed fragment
  is still current (both players; the web image copies `patches/`). `harness/tests/hls-gap-start.int.test.ts`
  (MediaMTX-shaped fixture in Chromium) fails 3/3 without it and passes 5/5 with it. Under 10% loss
  Chromium reached a first frame in 6/6 ingest-whip runs. Reviewed: sign-off, no HIGH/MEDIUM. Open
  LOWs: the AES init-decrypt catch has the same unconditional abort (encrypted init only, unused); the
  test needs a host ffmpeg; the patch must be redone on an hls.js upgrade (worth filing upstream).
  Seen only under the forced loss, not addressed: WebKit TTFF over 15 s and missing latency samples
  in both engines (lost IDRs degrade the copy); a macOS WebKit `play()` NotAllowedError once.

### Self-hosting gaps

- S3 for browsers: designed as ADR 0024 (`f50fe9e`): path-style bucket URLs on the main host,
  unstripped, with a Caddy allowlist of two shapes (signed `PUT` into `incoming/`, signed
  `GET`/`HEAD` of the exports bucket). Same origin, so no CORS, DNS, certificate or CSP change;
  a separate `s3.<host>` would have needed all four. Unit E (brief written) builds it.
- Units D (Postgres WAL replay), E (S3 route), F (per-unit secrets), G (client IPs, loopback,
  Valkey password, IPv6), H (relay Makefile, Garage object backup, read-only drill key):
  briefs in `.claude/briefs/phase5/`.
- **Unit D merged** (`e9fd60e`; workflow `wf_a58d856f-30b`): `infra/postgres/health.sh`
  (`commonair-pg-health`) is ready only "in production" and accepting connections; a Podman
  startup health check (`HealthStartupRetries=0`) lets a replay that makes progress run, and the
  script stops a start stuck for 10 min (2 min without replay); `TimeoutStartSec=12h` is a
  backstop. `e39d406`: a WAL fetch that fails for any reason other than "not found" now stops
  recovery instead of promoting early. backups.md has no manual replay procedure any more. Two
  review rounds, MEDIUMs fixed, LOWs left: no signal escalation for a stuck start; state file in
  `/tmp`; HealthStartup behaviour on CI's Podman 4.9 unproven until the CI e2e runs it.
- **Unit E merged** (`117c2e3`; workflow `wf_b8a09f20-826`): Caddy `@s3-upload` (signed `PUT`
  into `incoming/`, 10 MB cap, decimal as the contract) and `@s3-export` (signed `GET`/`HEAD`)
  to `garage:3900` with Host and path kept; signed responses skip `encode` so `Content-Length`
  and `ETag` stay; `selfhost.sh` writes `S3_PUBLIC_ENDPOINT=https://<host>` (a re-install keeps
  an operator's own endpoint) and `upgrade` backfills a missing or empty one; the e2e presigns
  with the API's own storage config inside `commonair-api` and checks the upload, the export
  download (bytes and `content-disposition`) and ten refusals, on install and after the
  upgrade; 21 new live Caddy tests. Review: no HIGH; the MEDIUM was an edit to
  `infra/tests/caddy.test.ts` outside its list, needed because that test asserted Caddy has no
  Garage upstream: accepted. Open LOW: an external S3 store is still not scripted (the units
  set `S3_ENDPOINT=http://garage:3900`).
- **Unit H merged** (`5034cab`): `relay/Makefile` targets and names follow `RELAY_TARGETS` and
  `relayAssetName` (test `relay-makefile.test.ts`); backups.md documents Garage object backup
  with rclone and a read-only Garage key for the restore drill (commands run against the pinned
  Garage image). Open LOWs: the drill's bucket name is hardcoded; the rclone restore remote
  lacks `no_check_bucket`.
- **Unit F merged** (`2025ff3`; workflow `wf_a204de86-f65`): every unit with configuration runs
  `ExecStartPre=render-env.sh <keys> commonair.env <unit-env>` and reads only that rendered file
  (0600 in a 0700 directory, fails closed, picks up edits on restart); key lists in
  `infra/selfhost/env/*.keys` are generated from the services' Zod schemas by
  `scripts/selfhost/unit-env.ts` (`--check` in tests); Caddy gets no secrets; Valkey, Loki, Tempo,
  Prometheus and the collector get no env file; compose's third-party services have no shared
  `env_file`; `MEDIAMTX_RTMP_URL` removed. Reviews: no HIGH; MEDIUMs were stale docs (fixed in
  the merge); the renderer now reads indented assignments as Podman does. e2e run 5 checks it:
  `commonair-caddy` holds no database, session or S3 secret; api has `DATABASE_URL`.
- Review of all head fixes `452752c..2025ff3` (`wf_d2aa8db2-74f`): no HIGH or MEDIUM; LOWs fixed
  in `24d7eba` (fixture regeneration into a scratch dir, benchmark claim wording, aardvark-dns
  under `/usr/local`).
- **Unit G merged** (`f93d9db`; workflow `wf_53630d41-25d`): Caddy takes 80/443 from a systemd
  socket unit in the host's network namespace (`commonair-caddy.socket`, dual-stack), so it sees
  real client addresses; no `trusted_proxies`; Caddy (10.89.42.10) and web (.11) have fixed
  addresses outside the network's `IPRange=10.89.42.128/25`, and `TRUSTED_PROXY_CIDRS` is their
  /32s; loopback publishes only Garage 3900 (rclone) and Grafana 3030 (SSH tunnel); Valkey requires
  `VALKEY_PASSWORD` (generated, never on a command line, URL through a Podman secret); IRC and
  MediaMTX ports dual-stack. Reviews: no HIGH; accepted MEDIUMs: files outside the brief that the
  design needed (the socket unit, the Valkey key list), and IRC/RTMP still see one address
  (needs socket activation in `services/irc`; MediaMTX has none: documented). Orchestrator fix
  `1bb96cd` + `33e7609`: a correct network is kept (rollbacks never touch it) and every restart
  first checks that no container outside the instance (by the units' `ContainerName=`) holds a
  network that must be re-created, so upgrade, re-install and rollback cannot strand the instance.
- Review of the orchestrator fixes `2025ff3..b527dfa` (`wf_fe158865-bef`): no HIGH or MEDIUM; LOWs
  fixed in `33e7609`.

### Still open

- `ci-ok` went green in main run 39994146130 (all groups, shards and both distros). The worker
  race is intermittent, so later runs are further samples; the proof of the fix is the on-demand
  reproduction (see `ffb3bc7`).
- Open from the sharded run: integrity-basic failed once (now self-diagnosing, see `a38438f`).
  ingest-whip's Chromium no-first-frame is fixed (`5e4ce6c`).
- `infra/tests/stack.int.test.ts` ("re-running migrate keeps the role working") can exceed its
  60 s limit on a loaded workstation (76 s once at load 12); not seen on CI.
- Not covered by a test: that Quadlet keeps appending its own `ExecStopPost=` after the unit's
  (checked by hand on Podman 5.4.2 and 5.8.2). A rollback to a release before `ffb3bc7` loses
  the cgroup reset again.
- IRC (6667/6697) and MediaMTX RTMP/ICE still see one client address under rootless Podman:
  IRC needs systemd socket activation in `services/irc` (`LISTEN_FDS`, `Bun.listen({ fd })`),
  MediaMTX has none. Documented in `infra/README.md`.
- SELinux labels (`:z`/`:Z`) are not exercised by the e2e: the privileged test host has no
  `/sys/fs/selinux`, so its rootless Podman runs without SELinux. Only a real Fedora VM checks
  them.
- The e2e uses `--tls internal`; ACME (Let's Encrypt) is proven only by a real install.
- Local e2e runs pull third-party images from Docker Hub in every fresh host and can hit its
  anonymous rate limit after many runs (seen once); CI runners are unaffected. A pull-through
  Zot mirror would fix it.
- An external S3 store on a self-hosted instance is not scripted (the units set
  `S3_ENDPOINT=http://garage:3900`).
- LOWs left from reviews: unit D (no signal escalation for a stuck start; health state in
  `/tmp`), unit H (drill bucket name hardcoded; rclone remote lacks `no_check_bucket`).

### User to run (Part 3, each needs your go-ahead)

1. Branch protection on `main` requiring `ci-ok` (and tag protection for `v*`).
2. `git tag -s v0.1.0-rc.1 -m v0.1.0-rc.1 && git push origin v0.1.0-rc.1` (a real release:
   keyless signing writes to the public Rekor log), then watch `release.yml`.
3. Make each `ghcr.io/abolishus/commonair/<image>` package public.
4. Verify the release with `docs/self-hosting/verifying.md` against the tag identity
   (`release.yml@refs/tags/v0.1.0-rc.1`).
5. A clean Debian 13 VM with DNS (Hetzner per ADR 0010, paid): follow
   `docs/self-hosting/install.md`, ending with `selfhost.sh install --version v0.1.0-rc.1 --domain …
   --email … --yes`; check TLS, an avatar upload and an export download in a browser; then tag
   `v0.1.0-rc.2` and run `selfhost.sh upgrade --version v0.1.0-rc.2`, `selfhost.sh backup` and
   `selfhost.sh status`.

## Session eleven (2026-10-22): Phase 5 release and self-hosting (built; user validation pending)

Started from `eefb597` (E6 done, supply-chain policy ADR 0022 landed as `9dd395a`). Policy
ADR 0023. The user decided:

- ghcr.io (`ghcr.io/abolishus/commonair/<image>`) plus a `cosign copy` mirror recipe for a
  self-run FOSS registry;
- keyless cosign through GitHub OIDC;
- `selfhost.sh` supports Debian 13 and Fedora 42+;
- semver from `v0.1.0` (first tag `v0.1.0-rc.1`);
- arm64 is required at launch.

Contract step: ADR 0023, `scripts/release/manifest.ts` (release manifest schema, image list,
refs and asset names; 26 tests), and `infraEnv` `TLS_MODE`/`ACME_EMAIL`/`ACME_CA`. Briefs are
in `.claude/briefs/phase5/`. Units:

- **A**: CI + release workflow (`.github/**`, `scripts/release/**`).
- **B**: Quadlet/Caddy/systemd + `selfhost.sh` (`infra/quadlet|caddy|systemd/**`,
  `scripts/selfhost*`).
- **C**: docs (`docs/self-hosting/**`, the release runbook, README, `hetzner.md`,
  `infra/README.md`).

A and B run as one batch in worktrees; C runs after they merge.

**Batch 1 merged** (workflows `wf_51a89d8a-599` and `wf_2dd564fd-e73`).

- **A, CI + release** (`5d1771d`, `8bcbf93`, fixes `f971aef`, `1ffec78`):
  - `release.yml` builds the 14 images with podman for amd64 and arm64 on native runners, and
    pushes them by digest as multi-arch indexes.
  - It adds `cosign sign`, CycloneDX SBOM and SLSA v1 attestations, the six relay binaries
    with SBOMs and Sigstore bundles, the manifest, the bundle, and a signed `SHA256SUMS`.
  - `gh release create` runs only after everything else has succeeded; `latest` moves last.
  - Dry runs push to a Zot service container.
  - `ci.yml` gets per-job permissions, caches that cannot reach release jobs, diagnostics
    uploaded on failure or timeout, `lint-workflows` (actionlint, zizmor, shellcheck), the
    `ci-ok` aggregate, and a release dry run plus the self-host e2e on main and nightly.
  - Logic lives in tested `scripts/release/*.ts`.
  - Review: one HIGH (a real release dispatched from a branch would sign with an identity
    that does not verify). Fixed: real releases need the tag ref.
- **B, Quadlet/Caddy/`selfhost.sh`** (`67b093f` … `cc9f671`, head fix `0c52ff6`):
  - Every unit has `RunInit=true`, `Restart=always` with backoff, `RestartMode=direct`,
    `HealthOnFailure=kill` and `StartLimitIntervalSec=0`.
  - `Requires=` only on the one-shots (migrate, garage-init); `Wants=`+`After=` for
    long-running dependencies, so the stack converges after a failed start.
  - IRC cert sync runs in the tools image (no Bun on the host).
  - `~/commonair` is a symlink to `~/.local/share/commonair/releases/<version>`.
  - Caddy: `import tls-{$TLS_MODE:acme}`, with internal CA mode.
  - `scripts/selfhost/{render,bundle,e2e}.ts`; `selfhost.sh install|upgrade|backup|status`
    as POSIX sh.
  - Why the session-ten worker stayed down: podman-compose turns `depends_on` into
    `--requires`, and Podman applies a restart policy only while every required container
    runs; the one-shots have exited.
  - Review over four rounds. HIGH findings fixed:
    - root staging through symlinks;
    - rollback blocked by the start limit;
    - dependency start failure left the stack down;
    - signature stripping when cosign is installed;
    - a migrate start that hung forever behind an unhealthy Postgres.
  - Head fix (found while verifying): `init-env --merge` dropped keys not in
    `.env.example`, so every upgrade lost `MTX_WEBRTCADDITIONALHOSTS` (remote WHIP).
- **Integration** (`phase5/integrate`):
  - the compose `tls` profile passes `TLS_MODE`/`ACME_EMAIL`/`ACME_CA`;
  - `zot-minimal` license entry;
  - `scripts/tsconfig.json` includes `selfhost`.

Tests on the merged tree:

- scripts unit 350/350;
- infra unit 448/448, plus `caddy.int.test.ts` 10/10 (B);
- tsc for scripts and infra;
- `check-licenses`, `check-domains`, `check-supply-chain`;
- actionlint and zizmor clean;
- shellcheck 0.11.0 clean;
- a sample `bundle.ts` build renders pinned `Image=` lines.

Not run: the self-host e2e (builds 14 images) and anything on GitHub's runners.

Open, not fixed (MEDIUM, design work for a later unit):

- Every unit reads the whole `commonair.env`, so Caddy, MediaMTX, Grafana and Garage see
  database passwords. The fix is a secret-free shared env plus per-unit `Secret=`, mirrored
  in compose.
- Rootless port forwarding hides client addresses from Caddy (all clients arrive from the
  bridge gateway), and `trusted_proxies private_ranges` then trusts client-sent
  `X-Forwarded-For`. Per-IP rate limits need source-address preservation (e.g. pasta, or
  Caddy on the host network).
- Valkey (no password), the OTel collector and Prometheus are published on host loopback.
- An optional observability unit in a crash loop holds back app starts (`After=`).
- `relay/Makefile` targets and names differ from `RELAY_TARGETS`.

**Unit C merged** (workflow `wf_9223f701-530`): `48d6122`, fix `fd8431a`.

- `docs/self-hosting/` has 12 pages: requirements, install, configuration, TLS, upgrades,
  backups, scaling, relays, verifying, mirroring, troubleshooting, and known limitations.
- `docs/maintainers/releasing.md`.
- README quickstart refresh.
- `hetzner.md` and `infra/README.md` rewritten around `selfhost.sh`.
- `scripts/config-reference.ts` generates the env reference; its test (40) also checks every
  relative link and anchor.
- Review: one HIGH, fixed. The restore drill copied the production env file onto the scratch
  server and then ran `install --reinstall`, starting a second production.
- Head fixes `9f30839`: operator drop-in directories (`*.container.d/`, `*.service.d/`) made
  install and upgrade fail under `set -e`; the `ACME_CA` JSDoc wrongly promised a ZeroSSL
  fallback.

Code gaps unit C found, documented as limitations, not fixed:

- `S3_PUBLIC_ENDPOINT` is never set by `selfhost.sh` and Caddy has no route to Garage.
  Presigned browser uploads (avatars, panels) and data-export downloads therefore point at
  `garage:3900` and fail on a self-hosted instance. Needs a Caddy site or path for S3, plus
  install setting the variable. **This blocks a fully working instance.**
- Garage objects (VODs, clips, exports, evidence) have no backup; WAL-G covers Postgres only.
- A long WAL replay after a restore hits the Postgres unit's health kill and its 300 s start
  timeout. Postgres needs a recovery-aware health check or a longer start window.
- The restore drill needs a read-only S3 key, or the promoted drill database archives WAL
  into the production prefix.
- Forks: `release.env` records `SITE.repository.url`. A fork that keeps upstream `SITE` must
  set `COMMONAIR_REPOSITORY_URL` on every `upgrade`. ADR 0023 §2 says forks need no code
  changes; that is true for publishing, not for upgrades.
- Public ports bind IPv4 only (unchanged from E6).

Head `481227b` covers the round-2 review findings:

- one-line JSDoc for 88 env variables, so the reference has no blank descriptions (a test
  enforces it);
- scoped secrets (`EVIDENCE_PRIVATE_KEY`, `S3_EVIDENCE_*`) are labelled as blanked in the
  units, not pinned;
- the runbook explains how `CHANGELOG.md` is kept;
- the replay note in troubleshooting is fixed.

`MEDIAMTX_RTMP_URL` is set by compose and the units, but nothing reads it.

Checks on `phase5/integrate`:

- scripts unit tests pass (`config-reference` 43);
- `packages/config` tests 10;
- tsc;
- `config-reference --check`;
- `check-domains`;
- `reuse lint`.

**User to run** (nothing below has been run):

1. `bun run verify` (needs network for the advisory checks).
2. Self-host e2e, about an hour; it builds 14 images. Run
   `bun scripts/selfhost/e2e.ts`, then `bun scripts/selfhost/e2e.ts --distro fedora`. It
   needs a podman machine that allows `--privileged`. Logs and `timings.json` go to
   `.cache/selfhost-e2e/`.
3. `cd infra && bun --bun vp test run tests/caddy.int.test.ts`.
4. Push `main`, then in GitHub:
   - make branch protection require `ci-ok`;
   - run the release dry run:
     `gh workflow run release.yml --ref main -f dry_run=true -f sign=true`;
   - check the `release-dist` artifact.
5. On a fork, or here when ready: `git tag -s v0.1.0-rc.1 -m v0.1.0-rc.1 && git push origin v0.1.0-rc.1`.
   After the first real release, make each `commonair/<image>` ghcr package public.
6. Verify the release with the commands in `docs/self-hosting/verifying.md`.
7. On a clean Debian 13 VM with DNS, follow `docs/self-hosting/install.md`
   (`selfhost.sh install --version v0.1.0-rc.1 --domain … --email … --yes`). Then build a
   second tag and run `selfhost.sh upgrade --version …`.
8. Read through `docs/self-hosting/` as a newcomer.

## Session ten (2026-10-22): E6 Phase 4 completion (in flight)

Started from `388f69f` after E5 closed (e5-coop passed twice, e4b-money and trust-safety once).
Spec `docs/testing/e6-selectors.md`, policy ADR 0021 (the user decided: JSON-only export with a
7-day link and one per kind per 24 h; overlay tokens with optional expiry (none, quick picks up
to 6 months, or any exact date), one active per channel; the restore drill on a throwaway
Postgres; `full` keeps load small and `load-plan` (20 × 200 per streamer) stays out; `full`
includes e5-coop, trust-safety and e2e-relay on one harness stack; polls, predictions, raids and
goals stay 501). Contract step on `main`: `93bab15` (spec, ADR, migration `0022_e6_ops`
(overlay token expiry + one-active index, `vods_broadcast_idx`, export expiry index; db int 3/3),
contracts (overlay token expiry/status/revoke, `OverlayAlert`, `BUS.overlay`,
`OVERLAY_EVENTS_PATH`, `EXPORT_JOBS` and export constants, `opsTick`), `OPS_TEST_HOOKS`,
`infra.ts stack --harness`, `harness/compose.e6.yaml`), `64ddf72` + `6a3d3d0` (fflate 0.8.3 MIT
for worker and harness; worker → `@commonair/email`; harness → ledger, storage). Found while
surveying: account deletion left `events`/`webhook_deliveries` payloads (usernames) and export
objects in place, and `tips.message`; unit B fixes that. Briefs in `.claude/briefs/e6/`.
Batches (workflows of three): 1 = A API, B worker, C `packages/ui`; 2 = D web, E1 harness
feature scenarios, E2 harness ops (drill, load-plan, full, no-proprietary, SDK bot).

**Batch 1 merged** (workflow `wf_4d6d02b7-197`): C `packages/ui` (`6b4ca30`, fix `a96261b`;
ui tests 2227), A API (`26331d3`, fix `7127746`; new unit 38, int 26), B worker (`9b534b5`, fixes
`1e78a4c`, `33a641d`; unit 324, int exports/deletion/housekeeping). Reviews: A one HIGH (a clip
made a `subscribers` VOD public) fixed and re-reviewed; B four HIGH (the live user's
`stream.offline` survived the scrub; the scrub deleted unrelated events platform-wide; worker
tsconfig lacked `jsx`) fixed and re-reviewed; C none. Head fixes `24c7f61` (reviewed, no HIGH):
export mail may carry the presigned link (`storageLinks`, https or local storage origin only);
`lockLegalHold` taken by every hold insert and every media purge; account deletion records
`pending_objects` (migration 0023) and retries them, media only without a hold; Caddy routes
`/overlay/events` to the API.

**Batch 2 merged** (workflow `wf_00a70280-12b`): D web (`d12a918`, fix `adae0c2`; web 943),
E2 harness ops (`41f02e5`, fixes `31449f0`, `8dad99a`; harness 391 + drill int 1), E1 harness
feature scenarios (`d62c5b9`, fix `4f3799d`; 65 new). Reviews (each unit had a security reviewer
too): D none HIGH; E2 one HIGH (the SDK-bot step tripped chat's 30 s duplicate filter) fixed; E1
four HIGH (deletion audit check by count only; overlay token could reach the report through a
Playwright error; the listed `downloadUrl` scope and expiry were never checked; the payer check
read only `alert` frames) fixed and re-reviewed. Head `72a7d48`: harness redacts URL credentials
from every step/run error; overlay-alert scans all three streams; username `content` reserved.

**Live runs (2026-10-22, head agent at the user's request).** On the harness stack
(`bun scripts/infra.ts stack --harness`, E5-bootstrapped volume): all seven E6 scenarios pass
(`simulcast` 18/18, `overlay-alert` 41/41, `vod-clips` 28/28, `data-export` 42/42,
`account-deletion` 25/25, `backup-restore` 11/11, `e2e-social` with the SDK bot), `e2e-relay`
passes (21/21, 8 min), and `full` and `full --profile no-proprietary` pass 17/18 each; the
only skip is the Stripe variant of `e4b-money`. **`ingest-whip` fails** (WebKit never shows a
first frame): WHIP brings Opus audio, MediaMTX muxes it into HLS as is, and WebKit's native HLS
does not play it (RTMP brings AAC and plays). Pre-existing, not E6; fixing it needs an Opus → AAC
audio transcode for WHIP ingests in media (decision pending with the user). `bun run verify` is
GREEN.

Fixed while bringing it up (symptom → root cause → fix):

- Postgres reset itself five times (backend "terminated by signal 13"), each time taking the
  worker down → the postmaster ran as PID 1 and reaped orphans (timed-out `podman exec` /
  healthchecks); one dying by SIGPIPE looked like a crashed backend → `init: true` (compose) and
  `RunInit=true` (Quadlet), with a test (`ee904e0`).
- Migrations 0022–0023 never ran → podman's `rm --depend <name>` removed migrate's dependents but
  kept migrate, and compose restarted the old container → survivors removed by id; `stack` now
  fails loudly if any container is still on an old image (`3624153`, `ae62f79`).
- The tmi.js bot could never sign in through the IRC gateway (since Phase 1) → tmi.js lowercases
  `PASS oauth:<token>` and bot tokens were mixed-case base64url → lowercase hex access tokens
  (`randomTokenSecret`); chat logs refused upgrades with status and code (`089265c`).
- Simulcast target changes while live were ignored → API publishes `simulcast-targets` on
  BUS.live; media reconciles the live pushes; a disabled target reads idle (`b4a65b6`).
- Export mail linked the privacy page → `createWorker` dropped `storageOrigin` (`3624153`).
- e2e-relay refused to run → its preflight read `.env`; the API now reports
  `outboundPrivateNetworks` on `/healthz` (`9357148`).
- Harness: simulcast reloaded the dashboard into the session rate limit; overlay-alert tipped
  below `tipMinCents`; manifest row rule for object files; SDK bot reply race; ingest viewers
  stopped before the first heartbeat on a fast stack; simulcast re-enable budget 45 s.
- Gate: chat filter-runner raced JavaScriptCore's ~400 ms backtracking cap (test timeout 250 ms;
  production's is 50 ms); infra stack tests re-running one-shot containers got 60 s.

WHIP/WebKit (user-approved follow-up): media now publishes an AAC copy of a non-AAC source
(`live/<slug>/aac`, video copied, `KEYS.sourceAac`), and origin serves it in place of the source
under the same URLs (`186acf4`; media unit 4, origin int 14, API auth 26). Live: MediaMTX muxes
the copy as H.264 + AAC and Chromium plays it. The harness native player was refusing to start in
WebKit (`play()` NotAllowedError even muted/inline): it now records player errors and clicks once
like a viewer (`aefda3b`); WebKit then reached first frame on both ingests. Final green runs of
`ingest-whip`/`ingest-rtmp` were blocked by host load (load average ≈ 44 from another repo's
suites). On a quieter machine a WebKit viewer that started before the copy was live got Opus and
failed to decode; media now marks the channel `pending` and origin answers the source with a
retryable 503 until the copy is live (20 s cap, then the original is served) (`22031a1`; origin
int 14, media unit 6). Result: `ingest-rtmp` passes, `ingest-whip` passes 2 of 3; the failing run
missed only WebKit glass-to-glass (p50 10.8 / 14.5 / 17.5 s over three runs against a 15 s limit;
RTMP in WebKit ≈ 9.7 s, Chromium on WHIP 3–6 s). Likely cause: the copy's LL-HLS part durations
vary (MediaMTX warns for iOS clients); decision pending: re-encode WHIP video for steady parts, or
give WHIP + WebKit its own latency budget. MediaMTX warns that the copy's LL-HLS part durations vary
("will cause an error in iOS clients"); watch for it on real iOS.

Open follow-ups: WHIP + WebKit latency (above); the worker's Postgres client
crashed the process on a connection reset and Podman did not restart it despite
`unless-stopped` (the trigger is gone; make the worker survive and look at the restart policy).

**User to run** (nothing here was run against the live stack): recreate the Postgres volume once
with the E5 bootstrap (ADR 0020), `bun scripts/init-env.ts --merge` (new `OPS_TEST_HOOKS`), then
`bun scripts/infra.ts stack --harness` (rebuilds api, worker, web, media images; migrations
0022–0023), then `bun harness/src/cli.ts run <name>` for `simulcast`, `overlay-alert`,
`vod-clips`, `data-export`, `account-deletion`, `backup-restore`, `e2e-social` (SDK bot), then
`run full` and `run full --profile no-proprietary` (expected skip: the Stripe variant of
`e4b-money` only), and `run load-plan` by hand. Plus `bun run verify`, Storybook (`Pages/Creator
studio/Overlays`, `Content`, `Settings`, `StreamSetup`, the overlay view) and browser checks of
`/dashboard` simulcast, `/overlays`, `/content`, `/settings/privacy` and `/overlay/alerts?token=…`
(both themes, 320 px, OBS browser source).

Known gaps, not blocking: alert strings render in English (no instance locale); alert-config
cache is per API process (10 s); clips cut from `subscribers` VODs follow the VOD now, but clips
have no visibility of their own; the export mail links the privacy page instead of the archive
when `S3_PUBLIC_ENDPOINT` is unset or plain http on a public host; e4b-money's Stripe variant is
declared in the registry's `DEFAULT_PARAM_NEEDS` rather than on the scenario.

## Session nine (2026-10-21/22): E5 co-op

Spec `docs/testing/e5-selectors.md`, policy ADR 0020 (the user decided: shares refunded at once
on exit, two-person patronage approval, any seated council member responds, the local stack's
database is recreated once with short bootstrap periods). Contract step on `main`: `231b2c0`
(spec, ADR), `ede4cdd` (migrations 0019–0021: share statuses, patronage `computed_by_id`,
council term `txid`, triggers for tallies, council, shares, patronage and comments; db int
95/95, governance int 21/21, patronage int 14/14), `12d930b` (contracts: `finance` access,
`coop.shares.*`, `proposals.update`, `patronage.periods`, internal co-op events, `QUEUES.coop`,
`COOP_JOBS`, `/internal/coop/tick`, `COOP_TEST_HOOKS`). Briefs in `.claude/briefs/e5/`. Units run
as workflows of three: batch 1 = A API, B worker + governance lifecycle, C `packages/ui` boards;
batch 2 = D web, E harness `e5-coop`.

**Batch 1 merged** (workflow `wf_3f6e676f-c8d`): A API (`ac4b979`, fix `d8c1020`), B worker +
governance lifecycle (`61dd4eb`, fix `e097e2b`), C `packages/ui` co-op compositions and boards
(`f231af9`, fix `04da33a`). Reviews: no HIGH in any unit (A and B also had a security reviewer);
MEDIUMs fixed (A: share reference retry, withdrawn drafts stayed public, draft titles on the
public event; B: vote notices batched, transient apply errors no longer permanent, unfilled
council refilled, viewer exits kept; C: run-form surplus parsed to cents). Head after merge:
`d77a23e` — votes were judged by the API host's clock against a database-stamped window (the
Podman database runs ~35 ms ahead), so a vote right after voting opened was refused; now the
database clock. Spec/ADR clarifications `9144093`. On `main`: API int 221/221, worker int 76/76,
governance int 37/37, db int 95/95, patronage int 16/16, unit tests of every touched package and
tsc of every package pass.

## E5 `e5-coop` milestone reached (2026-10-22)

`e5-coop` passes twice in a row on the local Podman stack (87/87 assertions each, 3m04s and
3m00s, streamer qualification ≈ 48 s), and on the same stack `e4b-money` (82/82) and
`trust-safety` (95/95) pass. Stack: `bun scripts/infra.ts stack harness/compose.trust-safety.yaml
harness/compose.e5-coop.yaml` on a Postgres volume recreated once (ADR 0020), then
`HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e5-coop` (`--set via=api` for the
backend only).

**Batch 2 merged** (workflow `wf_d2aba403-51c`): D web (`cd01013`, fix `5768099`), E harness
(`9f52950`, fix `1001c4a`). No HIGH. Head follow-ups: `/admin/coop` guard and sidebar (`084eda8`,
the layout guard sent admins to not-found), a pending share shows its payment reference again
(`f54dafe`, contract + API + web), council size 50 on the test stack (`4240985`).

Bring-up (symptom → root cause → fix):

- Votes refused as `voting_closed` right after voting opened, ~1 in 3 integration runs → the API
  judged the window by its host clock against the database-stamped window (the Podman database
  runs ~35 ms ahead) → database clock (`d77a23e`).
- `e5-coop` step 4 `RATE_LIMITED` → the scenario polled proposal status anonymously twice per
  tick every second (~240/min against 120/min) → one list call every 2 s (`e65edcb`).
- `/coop/council` read empty → the wrapper renders with an empty `data-term-id` while loading;
  the driver read it at once (`369fdc1`, `74eeeab`); its retry reloaded the page every second,
  ~300 calls/min as the viewer, so the session check got a 429 and the page rendered signed out
  → re-read every 3 s (`7c82f40`).
- Share refund step timed out → the treasury shares tab lists `refund_pending` only, so the row
  leaves it; wait for that and the API status (`369fdc1`).
- The co-op Overview tab stayed active on every `/coop/*` page → exact link match (`4df5d9b`).
- Streamer qualification took 2–4 min waiting for the 5-minute integrity schedule → tick-only
  `COOP_JOBS.streamHours` runs the pass under its own lock (`ff27a2d`).
- With faster runs, sign-in and appoint-worker forms were filled before hydration (React reset
  the state behind the visible values) → `html[data-hydrated]` set by the web root, and the
  harness waits for it after every navigation (`39ce23c`; benefits every web scenario).

Unverified (user): `bun run verify`, Storybook for the new co-op boards (`Pages/Co-op/*`,
`Pages/Platform/TreasuryCoop`, `AdminCoop`), a browser pass over `/coop/*`, `/treasury` shares and
patronage tabs, `/admin/coop` and `/transparency` (both themes, 320 px, keyboard).

## E4c `trust-safety` harness bring-up (2026-10-21/22, done)

`trust-safety` passes twice in a row against the local Podman stack (92/92 assertions both runs;
T0 off air ≈ 5 s against a 9 s limit, T2 label ≈ 4 s, T1 restrict ≈ 3 s), and `e4b-money` still
passes on the same stack (82/82). Run it with `bun scripts/infra.ts stack harness/compose.trust-safety.yaml`,
then `bun harness/src/cli.ts run trust-safety` (`--set steps=7` runs one step).

Fixed (each with a regression test checked against the old code; API/worker/media changes
reviewed independently):

- Env/infra: `TRUSTED_PROXY_CIDRS` was unset locally, so all simulated users shared one auth
  rate-limit bucket (local `.env` only). `infra.ts stack [override.yaml...]` layers compose
  overrides and recreates containers whose image was rebuilt (podman-compose does not).
  Compose defaults `S3_PUBLIC_ENDPOINT` to the published Garage port (presigned uploads and media
  URLs carried `garage:3900`). ffmpeg is now in the api and worker images (uploads and live T1/T2
  scans failed without it).
- API: the `/internal/moderation/*` test hooks were never served; `startModeration` now runs at
  boot (fail closed) and `/healthz` reports the hooks; `bullmq` was not a dependency, so every
  real T0/escalation/NCII enqueue threw; `vods.list/get` and `clips.create/list/get` implemented
  (were 501) with T0/NCII/T1 hiding, a removed-source backstop for clips and the 18+ gate on media
  URLs; removing a VOD also removes its broadcast's clips. Live clips end 10 s behind the live edge.
- Media: a live clip whose window the recorder has not written yet (ffmpeg writes the playlist
  only when a segment closes, ~15–25 s after going live) failed at once with "not live here and
  has no VOD" on channels without VODs. The lookup now returns `pending` and the clip job waits
  (delayed BullMQ retry every 1 s, up to 60 s after it was queued); a window that starts before
  the recording began moves to its start. (The earlier `Bun.file().exists()` theory was a timing
  artefact: the playlist did not exist yet when the job ran.)
- Worker: `t0-media` job ids had `:` in a form BullMQ rejects, so evidence moves after T0 (and the
  daily reconciler and digest checks) never ran; the T0 evidence count is logged as
  `evidenceCount`. The `ncii-hash` job skipped every item because it read `removed_at` (set by the
  API at decision time, and relied on by the 0017 avatar guard) as "already hashed"; it now marks
  `ncii_request_items.hashed_at` (migration 0018).
- Web: a T1-restricted stream shows `stream-restricted` and plays only for confirmed adults; a
  decided moderation case stays open and refreshed.
- Harness: deletion timestamps read as strings; queue rows open through their button; the NCII
  form driver re-fills text fields that hydration reset; clip frames are read through the public
  media URL (ADR 0009).

Open:

- ~~Public media URLs not fetchable on the local stack~~ closed (2026-10-21, ADR 0009): media URLs
  are `MEDIA_PUBLIC_URL/<key>`, served by the origin's `/media` route from the media bucket for
  the public prefixes only (`channels/`, `clips/`, `thumbnails/`, `vods/`); `incoming/` and
  `moderation/` (NCII-hidden, review frames) answer 404. The trust-safety scenario reads clip 2
  through its public URL and checks clip 1's URL and hidden copy answer 404.
- `ncii-hash` does not hash `broadcast` items yet (a `/live/<channel>` URL: the API ends the
  broadcast and deletes its VODs/clips, but their objects stay and no hashes are added); those
  items stay without `hashed_at` so a later fix picks them up. Requests decided before migration
  0018 need a one-off `ncii-hash` re-enqueue (none exist on a real instance yet).
- vods/clips `update/remove` remain 501 (E6). ~~`vods.broadcast_id` has no index~~ closed: indexed in
  0022; `clips.broadcast_id` indexed in the E7 contract step (0024).

## E4b validation (2026-10-21)

Resumed at the user's request. Local `e4b-money` passes: manual API **77/77** assertions,
manual browser **82/82**, Stripe API against stripe-mock **95/95**. Stripe used the pinned
v0.206.0 upstream fixtures with `balance_transaction.fee=50` and matching `net`; stock fixtures
report zero fees and cannot confirm payments. Temporary mock keys and a compose override were
used; no real Stripe account or money. The manual adapter was restored afterward.

Storybook builds; Support dark/light, mobile 320, gift controls, instructions, no-tiers,
PageTabs disabled tabs and wrapped ChoiceToggle inspected. Fixed oversized option-card radios
(horizontal Field orientation), treasury actions racing a debounced search, and the harness
reading the provider before Support loaded. Added option-card and worker health-port regressions.
The gate also exposed formatting/lint issues and a macOS watcher-test race, now fixed.

Full `bun run verify` passed before the last money/infra fixes. The rerun stopped at infra up
because the local `.env` predated the E4c evidence keys (`garage-init: S3_EVIDENCE_ACCESS_KEY_ID
is required`); after `init-env --merge`, `bun scripts/infra.ts test` is healthy. Final gate: user.
Local setup: web uses port 3100; the existing Podman network is `10.89.0.0/24`, so API trust was
set to that actual subnet for these runs. No Railway deployment was performed. ADR 0007
follow-ups remain deferred.

Gate flakes fixed on 2026-10-21. These were load-related failures, and none was a product bug:

- The harness player now waits up to 2 s for WebKit's native-HLS answer.
- Compose Postgres runs with `max_connections=400` (`POSTGRES_MAX_CONNECTIONS`, applied by the
  entrypoint). The parallel suites peaked at the default of 100 and got "remaining connection slots
  are reserved". A restore needs at least the primary's value, and `restore.sh` now says so.
- Integration files that use a test database allow 30 s per test and 60 s for hooks: the suites
  run in parallel, and Postgres runs DROP DATABASE one at a time.
- The chat emote-only test waits for the settings frame on the other instance.
- Media VOD fixture rows are inserted after the upload, so the service's stale-VOD reconcile
  cannot finalize them first. The barrier tests fail fast instead of hanging.
- The chat filter latency test asserts p50 < 2 ms and p99 < 50 ms.
- The stack test tears down by label with `--depend`.
- `infra.ts test` now removes test containers and stacks older than 2 h and idle test databases
  created more than 2 h ago. Killed runs had leaked 4 running stacks, 22 containers and 60
  databases.

## Session eight (2026-10-20–21): E4c trust & safety (implemented; user validation pending)

ADR 0006's open questions resolved (native TypeScript PDQ/vPDQ, default classifier
`AdamCodd/vit-base-nsfw-detector` on ONNX Runtime for sexual content only, NCMEC drafted by the
platform and filed by a `legal` user, evidence sealed in append-only Postgres because Garage
cannot deny delete) and the license judgments recorded in ADR 0008. Both were accepted
2026-10-20.
**Contract step done** (head agent, on `main`, since pushed): spec, enums, migrations
0015/0016 with DB-enforced protections, hold CLI (`3d51fbc`); contracts with internal events,
moderation jobs and payloads, T&S entities, `moderation.*`/`ncii.*` procedures and 501 stubs,
`legal`/`safety-staff` access (`7501bb9`, `0e948da`); `moderationEnv` and the evidence keypair in
init-env (`f038c0e`); `packages/moderation` scaffold with the evidence seal implemented and
tested (`2813f99`); the worker-only Garage evidence bucket and key, evidence secrets scoped per
service in compose/Quadlet (`6377f0c`); `scripts/fetch-model.ts` with the pinned digest
(`5658eef`); unit briefs A–F (`738532e`). **Units A–F are reviewed and merged** on local `main`
(HEAD `132a402`, pushed). B, C and D had additional security reviewers; HIGH findings were
fixed and focused re-reviews passed. Final targeted checks: API integration 171/171 (13 files),
worker integration 68/68, media integration 23/23, web unit 677/677 plus typecheck/lint/build,
harness unit 289/289 plus typecheck/lint. The operator guide and production mounts are integrated;
hash lists mount read-only with an empty FOSS default, the ONNX model mounts read-only into API
and worker, and deprecated `HASH_MATCH_*` settings are removed. User validation remains: full
`bun run verify`, `bun run verify --scenario trust-safety`, image rebuilds, Storybook, browser and
Railway checks.

## Session six (2026-10-19): E4b money (in progress)

Manual adapter first, then Stripe against stripe-mock (PLAN.md E4b). Plan and units in
HANDOFF.md "Session six in flight" and `.claude/briefs/e4b/`.
Session seven (2026-10-20): all nine units (A–I) reviewed and merged — manual adapter, Stripe adapter, web pages, harness `e4b-money` (manual and `provider=stripe`), ledger/worker and ui follow-ups. E4b is code-complete; not yet run by the user: verify, e4b-money, Storybook, browser.

Paused 2026-10-20 at the user's request. On `main`: the contract step, migrations 0013–0014, the
operator role CLI, `packages/payments` scaffold, the spec `docs/testing/e4b-selectors.md`, and
the worker money jobs (expiry, renewal, hold release; reviewed, fix round merged). Built but not
merged (branches listed in HANDOFF.md "Resume point"): API checkout, API reports, web Support
dialog, harness `e4b-money`; web money pages unfinished. Not run live by the user yet.

## Session five (2026-10-18): E4a design system (in progress; resumed 2026-10-19)

Application design only (PLAN.md E4a). Mockup canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>
(29 boards). Units in `.claude/briefs/e4/`: U1 primitives (shadcn CLI 4.21.1, preset `b1ZhhFNpx`),
U2 shells/headers, U3 data blocks, U4 form blocks, U5 media/player/chat blocks, U6 page stories +
enforcement + apps/web migration. U1–U5 are now reviewed, merged and pushed to `main` at
`3b882054`. U1 brought in the primitives and gallery; U2 shells/navigation/headers; U3 data blocks
plus cataloged TanStack Table 8.21.3; U4 form/settings blocks; U5 media/player/chat blocks. Review
HIGHs were fixed and focused re-reviews passed. Targeted tests/typecheck/lint/format passed; UI
Storybook builds passed for U1, U2, U4 and U5. The aggregate unit-test command also completed
successfully during integration. U6b (apps/web migration + apps/web source-policy test) merged
2026-10-19 after review and re-review (`6d31d95`). U6a (board page stories + packages/ui
source-policy test) merged after review and re-review (`2a5c2c7`). U7 packages/ui follow-ups (new compositions,
allowlist cleared, `formatUnitCost`) merged ahead of its independent review at the user's request;
its review found no HIGH; the four MEDIUMs are fixed (`4c2829e`). E4a is complete pending the user's gate, Storybook and browser checks.

## Session four (2026-10-18): E3 slice built

All merged and pushed to `main`; live testing is the user's (HANDOFF.md "For the user to run").
Review was lighter at the user's request (HIGHs only, no re-review of fix rounds).

- **E3 built**: API relay lifecycle (retire/rejoin/drain/suspend), Go relay draining + heartbeat
  state machine, web `/relays` + player `data-source`, harness `e2e-relay` with a liar relay.
  Contract: `docs/testing/e3-selectors.md`. Milestone E3 is reached when the user's live
  `e2e-relay` run passes.
- P2P: `services/tracker` built; integrity judges P2P only on per-session evidence with a
  channel-wide per-network cap (ADR 0005, `KEYS.p2pChannelNet`).
- Legal drafts seeded by the migrate job; legal API; consent rate-limited.
- Next: E4 opens with the design-system track, then money (PLAN.md).

## Session three (2026-10-18): E2 slice built, review-gated

All merged after independent review (HIGH findings re-reviewed), pushed to `main`; live testing is
the user's (see HANDOFF.md "For the user to run").

- Worker integrity wiring merged (jobs, run locks, fetch evidence, viewer-count republish).
- API round 3: appeals, heartbeat floor, canonical IP hashes, `pinnedGet` deadline,
  `channels.get.viewer.following`. P2P source recording deferred until the tracker gives
  server-side swarm evidence.
- Shared `@commonair/safe-regex` with a sound cost model; chat filters re-validated on load and run
  in a worker pool with a hard timeout and quarantine.
- **E2 built**: directory home, follow button, chat moderation (web) + `e2e-social` scenario with a
  tmi.js bot through the IRC gateway (harness). Contract: `docs/testing/e2-selectors.md`.
  Milestone E2 is reached when the user's live `e2e-social` run passes.
- Contracts/config: auth routes, appeal subjects, `ircEnv`, `ORIGIN_ISSUANCE_ENABLED`; harness
  Mailpit basic auth for Railway staging; IRC health port published.

## Session two (2026-10-18): end-to-end first

**Milestone E1 reached locally:** `bun scripts/infra.ts stack && bun harness/src/cli.ts run e2e-basic`
passes (web sign-up + email verification, stream key, RTMP publish, Chromium signed-in + WebKit
anonymous playback, chat both ways, offline). First run: TTFF 1.0 s (Chromium) / 1.8 s (WebKit),
glass-to-glass 2.1 s / 3.9 s. `verify --full` and `--scenario` now bring the platform up and install
browsers; CI on main runs `verify:full`.

Landed this session (all reviewed before merge, gate green):

- Infra (2I) merged: WAL-G push under a timeout (DROP DATABASE hang), Garage + migrate in the
  test subset, `infra.ts stack`, `init-env --merge`, tracker behind the `p2p` profile, fixed compose
  subnet trusted for `x-forwarded-for`.
- Web app (3A-e1): TanStack Start on Bun, `/api` + `/rpc` proxy, sign-up/in, dashboard, channel
  page (hls.js / native HLS + heartbeats), chat, embed. Contract: `docs/testing/e1-selectors.md`.
- Harness `e2e-basic` + fix: API-path sign-ups now verify via web-origin links.
- DB: integrity scan indexes (0006), users identity immutability trigger (0007), appeals subject
  index (0008). Storage: presigned PUT signs content type and length.
- Config: media disk budget / ladder cap, `OUTBOUND_ALLOW_PRIVATE_NETWORKS`.

Also merged after review: API (2A) rounds one and two, integrity (2H2) and media (2E) review
fixes, web review fixes. Open: worker integrity wiring (branch `worktree-agent-a07b926d662d5d4bd`,
WIP), API round 3 and the contract requests listed in HANDOFF.md.

## Handoff status (end of session one, 2026-10-18; superseded by HANDOFF.md)

`main` at the handoff commit passes the full `bun run verify` (format, lint, typecheck, unit,
integration, licenses, domains, reuse, relay). All units below are merged except infra.

| Unit                       | Branch (`worktree-agent-…`)      | Merged                                | Open items (not done)                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A api-core                | a6c3e9d45066950e6                | yes                                   | **API review (see HANDOFF): ReDoS-capable filter check, minors can edit birthDate**, category mature gate, third-party image URLs, better-auth admin endpoints unaudited, rate-limit subject behind proxy / IPv6 /64, relay+simulcast URL SSRF, upload size, per-recipient mail limits, interim verify too fast; `BUS.userControl` publishing; `developer.tokens.list/revoke`; TOTP integration tests |
| 2B chat                    | a10faca9017b35f37                | yes                                   | README for round-two behavior; test for OAuth revocation on an open socket                                                                                                                                                                                                                                                                                                                            |
| 2C irc                     | afc07554b4056edf3                | yes                                   | move `IRC_*` connection-limit env vars into `packages/config`                                                                                                                                                                                                                                                                                                                                         |
| 2D origin                  | a5d29e5776daab709                | yes (includes a `wip(origin)` commit) | integration tests for relay 401→429, CDN URIs without `t=`, HEAD not recorded; multi-replica issuance integration test; `ORIGIN_ISSUANCE_ENABLED` and `ISSUANCE_KEYS` into config/contracts                                                                                                                                                                                                           |
| 2E media                   | a910b90d0855b019d                | yes                                   | stale `processing` VOD reconcile; crash recovery of recordings + work-dir sweep; global disk budget; transcode slot limit; simulcast SSRF + protocol whitelist + generic errors; simulcast key out of argv; thumbnail history cleanup                                                                                                                                                                 |
| 2F relay                   | af349641b1a04d351                | yes                                   | none                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2G ui                      | a346bf0796b847ef4                | yes                                   | wire `test:node` into verify                                                                                                                                                                                                                                                                                                                                                                          |
| 2H1 ledger + patronage     | a0f0430ca5204e3c7                | yes                                   | READMEs for payout clearing, hold lots, `postReversal`, period close; callers must use the new APIs                                                                                                                                                                                                                                                                                                   |
| 2H2 governance + integrity | a3375f41100c11fad                | yes (governance fixes)                | **all integrity review items** (fetch-less bots, stream-hour eligibility, appeal stickiness, false positives, relay suspension, scale + indexes — exact SQL in HANDOFF); `subscriptionQualifies` unit test; `closeElection` test                                                                                                                                                                      |
| 2I infra                   | a856cff1eae87abf9 (head 0b1f3f9) | **no**                                | blocks on: WAL-G `archive_command` hangs when Garage is down, which makes `DROP DATABASE` hang (signal barrier) — needs a timeout wrapper and Garage in the test subset; `scripts/infra.ts` TEST_SERVICES change; compose needs the new infra env vars (now in `.env.example`)                                                                                                                        |
| 2J harness                 | a39c0557744e767c7                | yes                                   | export better-auth routes + ALTCHA field name from contracts; document heartbeat counters as deltas                                                                                                                                                                                                                                                                                                   |
| 2L worker                  | ad54ee1f3dbd2b43b                | yes                                   | decision: `chat:read` events bind to the subscriber's `user_id` (Twitch semantics), kept                                                                                                                                                                                                                                                                                                              |
| 2M email + OTel            | a9ba774c6001ac6db                | yes                                   | none                                                                                                                                                                                                                                                                                                                                                                                                  |

## Next

After rc.1: the milestone plans in [`.claude/briefs/next/`](.claude/briefs/next/README.md)
(R0 first, with S1's capacity, replica and IaC units; then E7 + W0).

## Previous next steps

- Integrate each Phase 2 branch as it lands: merge locally, reconcile `bun.lock`, apply contract
  requests, `bun run verify`, reviewer subagent, commit, push.
- Then the first end-to-end bring-up (`podman compose up` + harness `ingest-rtmp`, `viewers`).
- Phase 3 briefs (web app, money, developer platform, channel bot, co-op, integrity pipeline,
  trust & safety, compliance, operations).
