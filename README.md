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

```bash
git clone https://github.com/abolishus/commonair.git
```

```bash
cd commonair && bun install
```

```bash
bun scripts/init-env.ts
```

```bash
podman compose up -d
```

Then open http://localhost:3000. Mail sent by the platform shows up in Mailpit at
http://localhost:8025. Before committing, run the gate:

```bash
bun run verify
```

`bun run verify:full` adds the full end-to-end harness scenario. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the workflow (DCO sign-off, Conventional Commits) and
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

A guide that takes an operator from a fresh Linux server to a running instance lives in
[docs/self-hosting/](docs/self-hosting/). No proprietary services are required: payments default
to a manual (treasurer-recorded) adapter, storage to Garage, and OAuth sign-in providers are
optional.

## License and trademarks

Code: [AGPL-3.0-or-later](LICENSE). Documentation: CC BY-SA 4.0. The repository is
[REUSE](https://reuse.software) compliant. The CommonAir name and logo belong to the co-op; forks
rebrand as described in [TRADEMARKS.md](TRADEMARKS.md). Security issues: [SECURITY.md](SECURITY.md).
