<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# CommonAir

Live streaming, owned by the people who make it. CommonAir is a member-owned cooperative
streaming platform: streamers, viewers and workers are members, the platform takes a small cut,
and the surplus goes back to members as patronage. One member, one vote.

It is free software (AGPL-3.0-or-later). Anyone can read, run, self-host and fork it. Every
running instance links to the exact source it runs.

> Status: pre-1.0, under active construction. See [ROADMAP.md](ROADMAP.md),
> [PLAN.md](PLAN.md) and [PROGRESS.md](PROGRESS.md).

## Quick start for contributors

You need: [Bun](https://bun.sh) 1.4.3, [Podman](https://podman.io) 5+ with `podman-compose`,
Go 1.27 (for the relay), FFmpeg (for the harness), and [`reuse`](https://reuse.software).

```sh
git clone https://github.com/abolishus/commonair.git
cd commonair
bun install
bun scripts/init-env.ts          # .env with fresh secrets (never committed)
```

Start the data services (Postgres, Valkey, Mailpit, Garage) and run the fast checks:

```sh
bun scripts/infra.ts test        # waits until they are healthy
bun run verify --quick           # the gate without integration tests: the inner loop only
```

Run the whole platform:

```sh
podman compose up -d
```

Then open http://localhost:3000. Mail sent by the platform shows up in Mailpit at
http://localhost:8025.

Drive it the way real people do with the [harness](harness/README.md): streamers, viewers in
real browsers, chat bots and viewbots.

```sh
bun run --filter @commonair/harness browsers   # Playwright Chromium and WebKit, once
bun harness/src/cli.ts run smoke
```

Before committing, run the gate. `bun run verify:full` adds the full end-to-end harness
scenario.

```sh
bun run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow (DCO sign-off, Conventional Commits) and
[AGENTS.md](AGENTS.md) for the engineering rules.

### Podman setup

CommonAir uses Podman, not Docker, for all container work. The compose file is rootless-friendly:
no privileged containers, no host ports below 1024, no socket mounts.

**Linux** (Fedora, Debian, Ubuntu, Arch): install `podman` and `podman-compose` from your
distribution. Rootless works out of the box; make sure your user has subuid/subgid ranges
(`grep $USER /etc/subuid`).

**macOS**: install Podman and podman-compose (for example with Homebrew), then create and start
a VM sized for the full stack:

```bash
podman machine init --cpus 8 --memory 12288 --disk-size 120
```

```bash
podman machine start
```

Check that `podman compose version` reports a provider. Containers reach your host as
`host.containers.internal`.

## Repository layout

| Path                                | What lives there                                                         |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `apps/web`                          | Web app (TanStack Start, React 19)                                       |
| `services/api`                      | Public API (oRPC, OpenAPI), auth, ingest hooks, playback sessions        |
| `services/chat`, `services/irc`     | Chat service and the Twitch-compatible IRC gateway                       |
| `services/origin`, `services/media` | HLS edge and the media pipeline (MediaMTX, FFmpeg)                       |
| `services/worker`                   | Background jobs (webhooks, exports, patronage, integrity)                |
| `packages/*`                        | Shared libraries: contracts, database schema, UI, ledger, governance, …  |
| `relay/`                            | Member relay node (Go, single static binary)                             |
| `harness/`                          | Local simulation harness: streamers, viewers, bots, viewbots, load tests |
| `infra/`                            | Compose configuration, container images, observability, Quadlet units    |
| `docs/`                             | Architecture, decisions (ADRs), runbooks, self-hosting guide             |

Start with [docs/architecture.md](docs/architecture.md).

## Self-hosting

[docs/self-hosting/](docs/self-hosting/) takes an operator from a fresh Debian 13 or Fedora 42+
server to a running instance. No proprietary services are required: payments default to a
manual (treasurer-recorded) adapter, storage to Garage, and OAuth sign-in providers are
optional.

Download the latest release's bundle and verify it
([how](docs/self-hosting/install.md#2-download-and-verify-the-release)). Then install it as
root with one command:

```sh
sh commonair-selfhost_0.1.0-rc.1/selfhost.sh install --yes \
  --bundle "$PWD/commonair-selfhost_0.1.0-rc.1.tar.gz" \
  --domain stream.example.org --email ops@example.org
```

Replace `0.1.0-rc.1` with the latest version on the
[releases page](https://github.com/abolishus/commonair/releases). Releases are signed with
cosign, and [verifying.md](docs/self-hosting/verifying.md) shows how to check them. Maintainers
cut releases as described in [docs/maintainers/releasing.md](docs/maintainers/releasing.md).

## License and trademarks

Code: [AGPL-3.0-or-later](LICENSE). Documentation: CC BY-SA 4.0. The repository is
[REUSE](https://reuse.software) compliant. The CommonAir name and logo belong to the co-op; forks
rebrand as described in [TRADEMARKS.md](TRADEMARKS.md). Security issues: [SECURITY.md](SECURITY.md).
