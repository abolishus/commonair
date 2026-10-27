<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# P2P delivery, STUN and the TURN relay

CommonAir can deliver live video peer to peer: viewers of the same stream who opted in fetch some
segments from each other over WebRTC instead of from your server, which lowers your egress. This
page covers what your instance runs for it, the one setting that decides who uses it by default,
and the TURN relay, which is off unless you turn it on. The design is
[ADR 0005](../decisions/0005-p2p-tracker.md) and its amendment 1.

## What runs

- **The tracker** (`commonair-tracker`, behind Caddy at `/tracker`) introduces viewers of the
  same stream to each other. Only sessions the API granted P2P can join.
- **coturn** (`commonair-coturn`) is your own STUN server on **3478/udp**. A browser asks it
  "which address do you see me at?" so that two viewers behind home routers can reach each
  other directly. STUN carries no video.
- **The TURN relay** is part of coturn and **off by default**. When on, coturn forwards video
  between two viewers who cannot connect directly.

Each segment a viewer gets from a peer is checked against a digest only your origin serves, so a
peer cannot inject video. If a peer connection fails, the player fetches over HTTPS as usual.

## Why your own STUN server, never a public one

Every viewer who uses P2P sends its address to the STUN server. A public STUN server (Google's,
Twilio's) would learn the address of every P2P viewer of your instance, and the player would
depend on a third party. CommonAir uses only your coturn: the API hands players
`P2P_STUN_URLS` (`stun:<your host>:3478`, written by `install`) and nothing else.

## Who uses P2P: `P2P_DEFAULT`

P2P shows a viewer's IP address to the other viewers it exchanges video with. So it is
**opt-in by default**: `P2P_DEFAULT=off` means a viewer who has not chosen does not take part,
and the player offers a switch, with the disclosure, to turn it on.

You may set `P2P_DEFAULT=on` only if you have a lawful basis for showing viewers' IP addresses to
other viewers without their explicit opt-in. In the EU, counsel has not reviewed one for the
reference instance; until you have your own advice, leave it `off`. Even with `on`, the player
keeps P2P off on phones and other touch-first devices, on metered connections and in data
saving mode, shows a notice before P2P first starts, and turning it off is one click. 18+,
mature-category and restricted streams never use P2P. `P2P_ENABLED=false` turns the feature off
for everyone.

## The TURN relay: off by default

Some viewers cannot connect to each other directly (strict NATs, some corporate and mobile
networks). Without a relay they fall back to HTTPS, the same bytes and cost as without P2P. A
relay connects them, but every relayed byte crosses your server twice (in from one viewer, out
to the other), while your origin would have sent it out once. **A relay saves no egress; it
costs more.** Turn it on only if you want P2P to reach those viewers anyway, for example to test
P2P from a network that needs it.

```sh
sh ~/commonair/selfhost.sh install --reinstall --turn-relay     # on
sh ~/commonair/selfhost.sh install --reinstall --no-turn-relay  # off again
```

The choice is stored in `commonair.env` (`P2P_TURN_URLS`) and kept across upgrades and
reinstalls until you pass the other flag. With the relay on:

- the API hands granted sessions short-lived TURN credentials (`TURN_CREDENTIAL_TTL_SECONDS`,
  default one hour), signed with `TURN_SHARED_SECRET`, which `install` generated. The username
  holds an HMAC of the session, never the session id;
- coturn relays UDP only, through ports 49160-49199 (`TURN_RELAY_PORT_MIN`/`MAX`), with quotas:
  8 allocations per credential, 400 in all, and 1.25 MB/s per session;
- `selfhost.sh status` shows `TURN relay on (UDP 49160-49199)`.

## Never into your private network

coturn runs on the host network (STUN must see each viewer's real address), so a relay could in
principle reach anything the host reaches. It refuses every private, loopback, link-local,
cloud-metadata, CGNAT, multicast, documentation and reserved range, and the IPv6 transition
ranges that tunnel to them (NAT64, Teredo, 6to4), in IPv4, IPv6 and IPv4-mapped form. Valkey,
Postgres, Garage (127.0.0.1:3900) and Grafana (127.0.0.1:3030) stay out of reach, and the relay
carries UDP only. With the relay off, coturn forwards nothing at all.

## Ports and firewalls

| Port        | Protocol | When                     |
| ----------- | -------- | ------------------------ |
| 3478        | UDP      | always (STUN)            |
| 49160-49199 | UDP      | only with `--turn-relay` |

`install` checks that 3478/udp is free and prints the firewalld or nftables rule for your host
firewall, including the relay range when the relay is on. In a provider firewall, open 3478/udp
yourself. **DigitalOcean:** the cloud firewall the Terraform module creates opens single ports
only, so with the relay on, add a rule for UDP 49160-49199 in the control panel (Networking →
Firewalls → your firewall → Inbound Rules → Custom, UDP, 49160-49199, all IPv4 and IPv6).

coturn writes no logs, so no viewer address reaches your journal or Grafana.

## Check that it works

STUN, from any machine with coturn's utilities (Debian's `coturn` package, or the image):

```sh
turnutils_stunclient stream.example.org
# or, on the server:
podman exec commonair-coturn turnutils_stunclient 127.0.0.1
```

It prints the address it sees you at; it should be your public address. A timeout means
3478/udp is closed somewhere between you and coturn.

The relay, when on: get credentials as a player does, then allocate with them. Start a stream,
open it in a browser with P2P on, and copy the `sessionId` and `token` from the
`/api/channels/<channel>/playback` response in the browser's network panel. Then:

```sh
curl -s https://stream.example.org/api/playback/ice-servers \
  -H 'content-type: application/json' \
  -d '{"sessionId":"<sessionId>","token":"<token>"}'
# -> {"iceServers":[{"urls":["stun:…"]},{"urls":["turn:…"],"username":"…","credential":"…"}],…}
turnutils_uclient -u '<username>' -w '<credential>' -y -n 1 stream.example.org
```

The token lasts two minutes, so do this promptly. `turnutils_uclient` allocates a relay and
exchanges test packets between two allocations of its own; success prints the packets sent and
received. A `401` means the credentials expired or `TURN_SHARED_SECRET` differs between the API
and coturn (restart both after changing it). With the relay off the endpoint returns only the
`stun:` entry, and `turnutils_uclient` gets no answer: coturn ignores TURN requests.
