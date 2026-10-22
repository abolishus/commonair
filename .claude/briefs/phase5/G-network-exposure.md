<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit G: real client addresses, nothing needless on loopback, Valkey password, IPv6

You are implementing unit G of the Phase 5 follow-up for CommonAir (repo:
/Users/joshe/Repos/bcon; you work in your own git worktree, branched from the base the
orchestrator names). Read AGENTS.md, PLAN.md "Phase 5", `.claude/briefs/phase5/_common.md`,
ADR 0023, ADR 0024, `infra/README.md` and `docs/self-hosting/` first. Do not look outside the
repository.

## The problems

1. **Client addresses under rootless Podman.** The public ports (Caddy 80/443, IRC 6667/6697,
   RTMP 1935, WebRTC 8189/udp) are `PublishPort=` on the `commonair` bridge network of a
   rootless Podman. Connections then reach the container from the bridge gateway (rootlessport),
   not from the client. Consequences:
   - every per-IP rate limit and abuse control sees one client;
   - Caddy's `trusted_proxies static private_ranges` trusts the gateway, so a client-sent
     `X-Forwarded-For` is believed and forwarded to the services (which trust Caddy through
     `TRUSTED_PROXY_CIDRS=10.89.42.0/24`): clients can spoof their address;
   - IRC and RTMP see one address too.
2. **Loopback exposure.** Valkey (no password), Postgres, Garage, the OTel collector,
   Prometheus, Grafana, the app services and MediaMTX's API are published on `127.0.0.1`. Any
   local process (or a local SSRF) reaches them. Nothing on the host needs most of them.
3. **Valkey has no password.**
4. **IPv4 only.** Public ports bind `0.0.0.0` only.

## You own (write only these)

- `infra/quadlet/*.container` and `infra/quadlet/commonair.network`: `PublishPort=`,
  `Network=`, and Valkey's command/health lines
- `infra/caddy/Caddyfile`: only the global `servers { trusted_proxies … }` / client-IP options
- `scripts/selfhost.sh`: host checks/prep for the networking you choose, and writing the Valkey
  password into the env file on install (and backfilling it on upgrade)
- `scripts/selfhost/e2e.ts`: new checks only
- `compose.yaml`: `ports:` lines and the valkey service; development must keep working with
  the harness (it uses published ports from the host — check `harness/` and `scripts/infra.ts`
  before unpublishing anything in compose; compose may well keep its ports)
- `.env.example`, `packages/config/src/env.ts` (Valkey URL/password docs or schema if needed),
  `scripts/init-env.ts` (generate the Valkey password) — these are orchestrator files: change
  only what Valkey needs, and list each change in your final message
- `infra/tests/compose.test.ts` (port and network assertions), new `infra/tests/*.test.ts`,
  `scripts/tests/selfhost*.test.ts`, `scripts/tests/init-env*.test.ts`
- docs: `docs/self-hosting/` pages that mention ports, firewalls, client IPs or IPv6, and
  `infra/README.md`

## Contracts you must honor (read-only for you)

- ADR 0023 §10 restart rules, Podman 4.9 compatibility for Quadlet keys (CI e2e), Podman 5.4+
  on targets (Debian 13, Fedora 42+). The e2e host is a privileged Debian/Fedora container with
  a rootless Podman inside: a good place to prove behaviour.
- Services read the client address from `X-Forwarded-For` only when the peer is in
  `TRUSTED_PROXY_CIDRS`; keep that contract (`packages/*` request-IP helpers are read-only).
- The `selfhost.sh` CLI, POSIX sh, shellcheck-clean.
- Do not edit `scripts/verify.ts`, `package.json`, `bun.lock`, `infra/containers/**`,
  `REUSE.toml`.

## Build

1. **Client addresses.** Evaluate and pick, with the reason in a comment and in
   `infra/README.md`:
   - pasta port forwarding that keeps the source address (Podman 5: `Network=pasta` options,
     or the bridge network's port forwarder; check what actually preserves the source for a
     container that must also reach `api`, `web`, `garage`, … by name);
   - Caddy (and IRC, MediaMTX's public ports) on the host network, reaching the bridge
     services through addresses that are not published to the world;
   - anything else that works rootless on both distros.
     Then make Caddy trust `X-Forwarded-For` from nobody on the public side (no
     `private_ranges` unless it is provably only Caddy's own upstream path), and make sure the
     services still trust Caddy's header and only Caddy's.
2. **Loopback.** Unpublish every port nothing on the host uses. Keep what `selfhost.sh`
   (backup, status, restore docs) or an operator procedure needs, or replace those uses with
   `podman exec`. List each port and its fate in `infra/README.md`.
3. **Valkey password.** `init-env` generates `VALKEY_PASSWORD`; Valkey runs with
   `--requirepass` (from the env, not on a command line visible in `ps` if avoidable);
   `VALKEY_URL` carries it for every client; its health check authenticates. Compose
   development works with and without it (the default `.env` gets one from `init-env`).
4. **IPv6.** Public ports also listen on IPv6 where the host has it, without failing on a host
   without IPv6.

## Tests you must add

- Unit tests for the ports each unit publishes (an explicit allowlist), Valkey's auth, the
  Caddy trust setting, and init-env generating the password.
- e2e additions (cannot be run by you; must type-check): from two different source addresses
  inside the test host's network namespace (e.g. two extra network namespaces or two podman
  containers on different networks hitting the host's public port), `/api/…` sees two
  distinct client addresses (find an endpoint or log that reveals what the API thinks the
  client address is, or add a check through rate-limit behaviour); a request with a spoofed
  `X-Forwarded-For: 203.0.113.7` is not seen as 203.0.113.7; `valkey-cli` without the password
  is refused; `ss -ltn` on the host shows only the allowlisted listeners.

## Done means

- `bun run verify --quick` passes, plus the infra and scripts tests you touched, shellcheck on
  `scripts/selfhost.sh`. Do not run the self-host e2e; do try the networking choice by hand in
  a rootless podman if you can (the local podman machine is rootless) and report what you saw.
- No files outside your ownership list changed.
- Commit on your branch: Conventional Commits, `git commit -s`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Final message: the design and why, evidence for the source-address behaviour, test counts,
  contract requests, anything left undone.
