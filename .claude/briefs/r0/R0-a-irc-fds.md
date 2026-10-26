<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# R0-a: IRC on systemd socket activation, so it sees real client addresses

You are implementing unit R0-a for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/R0-release.md` (the milestone)
and `.claude/briefs/r0/README.md` (the waves this batch runs in). Do not look outside the
repository. Work in your own git worktree on a branch named `r0/a-irc-fds`.

## Why

IRC (6667, 6697/TLS) is published with `PublishPort=`, so rootless port forwarding hands it every
client from one internal address. Its per-address caps (`IRC_MAX_CONNECTIONS_PER_IP`, the connect
burst) then count all IRC users together: one busy instance and everyone is refused. Caddy solved
the same problem with systemd socket activation (`infra/systemd/commonair-caddy.socket`,
`infra/README.md:379-387`), proved on the rc droplet over IPv4 and IPv6. IRC gets the same.

## You own (write only these)

- `services/irc/**`
- `infra/systemd/commonair-irc.socket` (new)
- `infra/quadlet/commonair-irc.container`
- `infra/tests/network.test.ts` (the IRC port allowlist and the "IRC behind rootlessport" block)
- `infra/tests/irc-socket.test.ts` (new)
- `scripts/selfhost/e2e-irc.ts` (new: e2e check functions; R0-e wires them into `e2e.ts`)
- `infra/README.md`: only the socket-activation section and the published-port table
  (about lines 379-420)

R0-b owns the S3 lines of every other unit and sends the orchestrator a contract request for the
S3 lines of `commonair-irc.container`; do not touch those lines yourself.

## Contracts you must honor (read-only for you)

- `scripts/selfhost.sh` installs every file in `infra/systemd/` and enables and starts every
  `commonair-*.socket` (`install_units` :784-810, `sockets()` :828-833, `restart_stack` :909-922).
  A new `.socket` file needs no change there. If you find it does, that is a contract request.
- `infra/tests/quadlet.test.ts` (R0-d's in wave 2) already allows `Wants=` on a `.socket` that
  exists in `infra/systemd/` (:25-27) and requires a matching `After=`.
- `clientAddress` (`services/irc/src/net.ts:107`) and `TRUSTED_PROXY_CIDRS` stay as they are.
- The WebSocket listener (6680) stays behind Caddy; only 6667 and 6697 move.

## What is there today (verified at `8bbdb52`)

- `services/irc/src/listeners.ts:87-125` `listenSocket` calls `Bun.listen({ hostname, port, tls?, socket })`
  (:95-98) and reads the address with `clientAddress(socket.remoteAddress, null, [])` (:103).
  `gateway.ts:84` and `:88` create the TCP and TLS listeners. `main.ts:33-35` passes the ports, and
  `main.ts:22-27` loads TLS once at startup (`tls.ts:144`).
- No `LISTEN_FDS` handling exists anywhere in `services/irc`.
- `bun-types` 1.4.3 declares `FdSocketOptions { fd: number; tls? }` (`bun.d.ts:7413-7422`), but no
  `Bun.listen` overload accepts it (:7442 takes `hostname` + `port`; :7448 takes `unix`).
  **First prove the runtime**: write a small test that opens a listening socket in the test,
  passes its fd to `Bun.listen({ fd, socket })` (cast through a local typed wrapper), connects and
  reads `remoteAddress`. Do the same with `tls`. If Bun cannot listen on an inherited fd, stop and
  report: the fallback options are a small accept loop in `node:net`
  (`net.createServer().listen({ fd })`, which Bun implements) or keeping `PublishPort=`. Pick
  `node:net` only if it also gives TLS (`tls.createServer`) and the same backpressure behavior as
  the current listener; say what you measured.
- `infra/quadlet/commonair-irc.container`: `PublishPort=6667:6667`, `PublishPort=6697:6697`,
  `Network=commonair.network`, the certificate from `%h/.config/commonair/irc-tls`, and
  `Wants=`/`After=commonair-otel-collector.service` (:15-16; R0-d changes that line in wave 2,
  so leave it).
- `infra/tests/network.test.ts`: the allowlist `irc: ["6667:6667","6697:6697"]` (:56-65), the
  Caddy socket tests (:78-115, the model to copy) and "IRC behind rootlessport" (:204-…).
- `scripts/selfhost/e2e.ts:623-626` lists 6667 and 6697 in `PUBLIC_TCP_PORTS`, and has no IRC
  connection test. `checkClientAddresses` (:713-741) is the model: distinct `127.0.0.x` sources
  on the host.

## Build

1. **Inherited listeners in `services/irc`.** A pure `systemdListeners(env, pid)` that returns
   the fds when `LISTEN_PID` equals the process id and `LISTEN_FDS` ≥ 1, with
   `LISTEN_FDNAMES` mapping names to fds (name the sockets `irc` and `ircs` in the `.socket`
   file, so order is not load-bearing; fall back to fd 3 = plain, fd 4 = TLS when names are
   absent). Unset the three variables after reading them, as `sd_listen_fds(unset=1)` does. Under
   Podman, `LISTEN_PID` is rewritten to the container's pid 1; check that this holds for the IRC
   image's entrypoint (is Bun pid 1, or is there an init?), and handle it.
2. `listenSocket` takes either `{ hostname, port }` or `{ fd }`. Everything after the accept
   (frame limits, admission, TLS options, the certificate reload path if any) is unchanged.
   Unknown or missing fds when `LISTEN_FDS` is set: exit with a clear log line, never fall back
   to binding the port silently (the socket unit would then hold the port and the bind would fail
   anyway).
3. **`infra/systemd/commonair-irc.socket`**, modelled on the Caddy socket: `ListenStream=6667`
   with `FileDescriptorName=irc`, `ListenStream=6697` with `FileDescriptorName=ircs` (one
   `.socket` can hold both; check that `FileDescriptorName=` applies per `ListenStream=`, or
   use two socket units if not), `BindIPv6Only=both`, `WantedBy=sockets.target`. The
   `ListenStream=` ports must match the unit's `IRC_PORT`/`IRC_TLS_PORT`.
4. **The unit**: drop both `PublishPort=` lines and add `Wants=`/`After=commonair-irc.socket`.
   Keep `IRC_PORT`/`IRC_TLS_PORT` (logs and the fallback for compose, which stays on plain
   binding: `compose.yaml` is not yours and compose has no socket activation).
5. **e2e checks** in `scripts/selfhost/e2e-irc.ts`, written as functions that take the e2e's
   helpers so R0-e can wire them without changes:
   `export function checkIrcClientAddresses(inHost: InHost, expectThat: Expect): void` where
   `type InHost = (script: string, opts?: { user?: boolean; env?: Record<string, string>; allowFail?: boolean }) => string`
   and `type Expect = (ok: boolean, what: string) => void` (the shapes of `inHost` and
   `expectThat` in `e2e.ts:100-145`). The check: with `IRC_MAX_CONNECTIONS_PER_IP` at its
   default, open that many connections from `127.0.0.2` and one more (refused with "Too many
   connections from your address"), then one from `127.0.0.3` (accepted). Use a tool present on
   both e2e distros (`bash` `/dev/tcp` cannot pick a source address; check for `ncat`/`socat`
   in the host image, or run a tiny Bun script in the release's `tools` image with
   `--network host`). Also a TLS variant on 6697 with the internal CA. Export pure helpers and
   unit-test them; R0-e runs the e2e.
6. **Docs in your section of `infra/README.md`**: IRC moves to the socket-activation list, the
   table row says "public, systemd sockets", and the "until then, raise
   `IRC_MAX_CONNECTIONS_PER_IP`" advice goes. The self-hosting docs (`README.md:71-76`,
   `troubleshooting.md:178-179` say IRC clients share one address) are R0-f's: list the exact
   changes in your final message.

## Tests you must add

- Unit: `systemdListeners` (pid mismatch, `LISTEN_FDS=0`, one fd, two fds with and without
  names, names in the other order, garbage values, variables unset afterwards).
- Integration (`services/irc/tests/*.int.test.ts`): a listener on an inherited fd accepts plain
  and TLS clients, and two source addresses (`127.0.0.2`, `127.0.0.3`) count as two clients
  for the per-address cap. Keep the existing `gateway.int.test.ts` cases passing.
- `infra/tests/irc-socket.test.ts`: the socket file's ports equal the unit's
  `IRC_PORT`/`IRC_TLS_PORT`, `BindIPv6Only=both`, `WantedBy=sockets.target`, names match what
  `systemdListeners` expects. `network.test.ts`: IRC publishes nothing, the rootlessport block
  becomes a socket block.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun run test` and `bun run test:int` in
`services/irc`, `bun --bun vp test run infra/tests/irc-socket.test.ts infra/tests/network.test.ts`,
`bunx tsc -p services/irc --noEmit`, `vp lint --deny-warnings` and `vp fmt` on your paths. Commit
in your worktree. Final message: the runtime finding from "First prove the runtime", test counts,
branch and sha, contract requests (exact lines), the R0-f doc changes, and how R0-e should wire
`checkIrcClientAddresses` (which step, before or after `checkClientAddresses`).
