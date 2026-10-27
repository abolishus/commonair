<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# coturn

The instance's own STUN server for P2P playback, and its optional TURN relay
([ADR 0005](../../docs/decisions/0005-p2p-tracker.md) amendment 1, decision 2). Operators read
[docs/self-hosting/p2p.md](../../docs/self-hosting/p2p.md); this page is for whoever changes
the configuration.

| File                      | What it is                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `turnserver.conf`         | The static part of the configuration, including the generated `denied-peer-ip` block                      |
| `start.sh`                | The container's entrypoint: renders the rest from the environment into `/tmp`, then runs `turnserver`     |
| `denied-peers.ts`         | Generates the `denied-peer-ip` block from `BLOCKED_V4`/`BLOCKED_V6` in `services/api/src/lib/netrange.ts` |
| `compose.turn-relay.yaml` | Development only: publishes the relay range                                                               |

The image is the official `docker.io/coturn/coturn:4.18.0-trixie`, pinned by digest in
`compose.yaml` and `infra/quadlet/commonair-coturn.container` (BSD-3-Clause,
`infra/image-licenses.json`). It runs unmodified; we only replace its entrypoint.

## Networking

Production (`commonair-coturn.container`) runs on the host network. STUN tells a client the
address its request came from, and through rootless Podman's port forwarding every client would
come from one internal address. A systemd socket would fix 3478/udp, but the relay allocates
its ports at run time and systemd cannot hand those over. Host networking costs isolation: coturn
shares the host's loopback. Hence the `denied-peer-ip` list, which covers loopback. The host's
own public address stays allowed, because two relayed viewers reach each other through two
relay ports on it; the relay is UDP only, and the host's other public UDP ports (443, 8189) are
open to everyone anyway.

Compose publishes 3478/udp on `BIND_ADDRESS` like every other port. Development clients are on
the same machine, so the address STUN reports does not matter there.

## Relay off (the default): STUN only

With `P2P_TURN_URLS` empty, `start.sh` writes `stun-only`: coturn answers STUN binding requests
and ignores every TURN request (Allocate, Refresh, CreatePermission, ChannelBind, Send), so it
holds no relay port and forwards nothing. No credentials exist in this mode.

## Relay on

`P2P_TURN_URLS` non-empty (`selfhost.sh --turn-relay`) makes `start.sh` write `use-auth-secret`
and `static-auth-secret=$TURN_SHARED_SECRET` (TURN REST credentials, minted by the API's
`p2p.iceServers`, `services/api/src/p2p/turn.ts`), the relay range and the quotas:

- `user-quota=8`: allocations per username. The API mints one username per session and refresh,
  and the player keeps only a handful of peer connections, each needing one allocation.
- `total-quota=400`: allocations in all. The default range has 40 ports, which is the tighter
  limit; the quota matters once an operator widens the range.
- `max-bps=1250000`: 1.25 MB/s (10 Mbit/s) per session, above any rendition's bitrate, so a
  relayed peer is never starved while one session cannot take the whole uplink.

Credentials expire after `TURN_CREDENTIAL_TTL_SECONDS` (default 3600). coturn checks the expiry
when an allocation is refreshed, so a relayed connection drops at expiry unless the player
fetched new credentials, and the player then falls back to HTTP.

UDP only: `no-tcp`, `no-tls` and `no-tcp-relay`. TLS 1.0 and 1.1 are off because coturn 4.18
enables them only with `tlsv1`/`tlsv1_1` (it no longer has `no-tlsv1` options, and an unknown
option is only a warning, so writing one would hide a typo), and DTLS starts only with `dtls`.

## Never into private space

The `denied-peer-ip` lines cover every range the API refuses for user-supplied URLs (private,
loopback, link-local and cloud metadata, CGNAT, multicast, documentation, benchmarking, reserved,
NAT64, Teredo, 6to4), as `start-end` ranges because coturn takes no CIDR, and the IPv4-mapped
IPv6 form of each IPv4 range. Regenerate after a change to `netrange.ts`:

```sh
bun infra/coturn/denied-peers.ts            # rewrite the block
bun infra/coturn/denied-peers.ts --check    # what infra/tests/coturn.test.ts runs
```

There is no switch to allow private peers. A harness scenario that needs a relay between two
local players would add an override of its own, off by default and never in the Quadlet unit.

## Logs and metrics

coturn logs every session with the client's address, its username and its peers' addresses, so
the configuration turns logging off entirely (`no-stdout-log`, `log-file=/dev/null`): nothing
from coturn reaches the journal or Loki. `start.sh` still prints its own configuration errors to
stderr. The image is built without coturn's Prometheus exporter, and on the host network it
would listen on every interface, so there are no coturn metrics.

### Debugging

Check from outside first:

```sh
turnutils_stunclient stream.example.org     # from any machine with coturn's utilities
podman exec commonair-coturn turnutils_stunclient 127.0.0.1
```

To see coturn's own log, stop the unit and run the same container in the foreground with
logging to stdout, then start the unit again. The log then holds client addresses: keep it off
the journal and do not share it.

```sh
systemctl --user stop commonair-coturn
podman run --rm -it --network host --env-file ~/.config/commonair/unit-env/commonair-coturn.env \
  -e TURN_PORT=3478 -v ~/commonair/infra/coturn:/etc/coturn/commonair:ro,Z \
  --entrypoint /bin/sh docker.io/coturn/coturn:4.18.0-trixie \
  -c 'COTURN_CONF=/tmp/t.conf sh /etc/coturn/commonair/start.sh --render-only &&
      exec turnserver -c /tmp/t.conf --log-file=stdout --verbose'
systemctl --user start commonair-coturn
```

## TURNS (follow-up)

`turns:` (TURN over TLS on 5349, or on 443 for clients behind strict firewalls) is not offered.
It would need: a certificate for `PUBLIC_HOSTNAME` readable by the container (Caddy's, synced
like IRC's by `commonair-irc-cert.service`, with a restart on renewal), `cert`/`pkey` and a TLS
listener instead of `no-tls`, `no-tlsv1_2` left unset, the port in `check_ports`, the firewall
hints and the DigitalOcean firewall, and `turns:` URLs in `P2P_TURN_URLS`. Sharing 443 with Caddy
would need ALPN-based demultiplexing, which Caddy's layer-4 app could do but this stack does not
ship.
