<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E3 web ↔ harness contract

Milestone E3 has two parts. A member-run Go relay joins and serves viewers: the origin computes
issuance, and the worker verifies the relay's receipts against it. A viewbot swarm is excluded
from the viewer counts. This file extends [e1-selectors.md](e1-selectors.md) and
[e2-selectors.md](e2-selectors.md), and everything in those still holds.

Changing anything here is a contract change: update this file, `apps/web`, the relay, and the
`e2e-relay` scenario together. Tests select elements by `data-testid`, never by visible text.

## API used (in the contract)

- `relays.create`: the member gets `registrationToken`, which is shown once.
- `relays.mine` returns `RelayNode`, which includes `status`, `bytesVerified30d`,
  `lastReceiptAt` and `receipts30d`.
- `relays.remove` retires the relay (`retiredAt` set). Its token then never authenticates again, and `relays.mine` no longer lists it.
- The relay protocol: `relays.register`, `relays.heartbeat` and `relays.receipt`.
  - A heartbeat with `draining: true` takes the relay out of assignment at once (status
    `offline`), and players move to the origin on their next heartbeat (`switchTo`).
  - A relay that went `offline` (drained, or timed out by the worker) registers again with the
    same token. A retired relay cannot.
  - A `suspended` relay stays out of assignment until an admin reinstates it.
- `playback.start` returns `source` (`origin` | `relay` | `cdn`) and a relay `playlistUrl`.
  `playback.heartbeat` returns `switchTo` when the assigned relay leaves the active set.
- `stream.health` returns `viewers.{verified,pending,excluded}`. It is read by the channel owner
  and is the harness's view of exclusion.

## Routes

| Route        | Change in E3                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `/relays`    | New, signed-in only. Lists your relays, creates one (the token and run command are shown once), retires one             |
| `/dashboard` | Adds a link to `/relays`                                                                                                |
| `/$channel`  | The player reports its delivery source. It plays from the relay `playlistUrl` and follows `switchTo` back to the origin |

## Test ids

| Test id                  | Element / meaning                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `player`                 | (E1) It now also carries `data-source` = `origin` \| `relay` \| `cdn` (never `p2p`): the delivery source of the playlist it is currently playing. This is `PlaybackStart.source`, updated after a `switchTo`.                     |
| `relays-link`            | On `/dashboard`, a link to `/relays`                                                                                                                                                                                              |
| `relays`                 | Wrapper of the `/relays` page                                                                                                                                                                                                     |
| `relays-empty`           | An `<EmptyState>` shown when you have no relays                                                                                                                                                                                   |
| `relay-create-name`      | Name input (1–50 characters)                                                                                                                                                                                                      |
| `relay-create-submit`    | Creates the relay (`relays.create`). It is disabled while the request is in flight                                                                                                                                                |
| `relay-token`            | The full registration token. It is rendered only right after creation, as text content, with a copy `<IconButton tooltip>`                                                                                                        |
| `relay-run-command`      | The command to run the relay with that token, shown alongside it. It is the exact text of a shell command: `commonair-relay --api <PUBLIC_URL> --token <token> --public-url https://<your-host>` (placeholders for the host part) |
| `relay-row`              | One relay. `data-relay-id` is the id, `data-status` is a `RELAY_STATUSES` value. It refreshes every 10 s while the tab is visible                                                                                                 |
| `relay-status`           | Inside a row, the status badge (text is translated)                                                                                                                                                                               |
| `relay-bytes-verified`   | Inside a row. `data-bytes` is `bytesVerified30d` as an integer; the text is formatted                                                                                                                                             |
| `relay-receipts`         | Inside a row. `data-pending`, `data-verified` and `data-rejected` are the `receipts30d` counts                                                                                                                                    |
| `relay-suspended-reason` | Inside a row. Rendered only when `suspendedReason` is set                                                                                                                                                                         |
| `relay-remove`           | Inside a row. It retires the relay through a `ConfirmDialog`; confirm with `confirm-dialog-confirm`                                                                                                                               |

## Running a relay locally

The harness runs the relay binary on the host and does not put it in a container. Built with
`go build ./cmd/commonair-relay` from `relay/`, it is started as:

```
commonair-relay --api <PUBLIC_URL> --token <token> \
  --public-url http://<host LAN IPv4>:<port> --listen :<port> --data-dir <tmp> --capacity-mbps 1000
```

- **`--public-url` is the host's LAN address.** The API container must be able to reach it for
  the registration health check, and so must the viewers on the host. `localhost` would point at
  the API container itself.
- **The API needs `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` in `.env`.** Without it the API refuses
  http and private-network relay URLs. The scenario checks this up front and stops with a clear
  message.
- **`--set relayHost=<addr>` overrides the detected LAN address.**
- **The relay pulls from the origin at `PLAYBACK_PUBLIC_URL`.** That is
  `http://localhost:3003` locally, reachable from the host.

## The `e2e-relay` scenario

1. **Setup.**
   - Streamer `S` (API-path sign-up) goes live over RTMP.
   - Member `M` signs up in the web UI, opens `/relays` from `relays-link`, and creates relay
     `harness-relay`. The harness reads `relay-token`.
   - The harness builds and starts the Go relay with that token.
   - `relay-row` reaches `data-status="active"` within 60 s.
2. **Viewers on the relay.**
   - Honest viewers open `/$S`. Chromium players are signed in and anonymous; HTTP viewers use
     `--set httpViewers=N`.
   - They keep opening sessions until at least 2 are relay-assigned (`player[data-source=relay]`,
     `data-state="playing"`, or `source: "relay"` for HTTP viewers). Assignment is deterministic
     per session and capacity-weighted, so the scenario opens new sessions rather than retrying
     one.
   - Relay `/healthz` reports `viewers ≥ 2`.
3. **Viewbot swarm.**
   - The harness viewbots run against `S`: datacenter source IPs, a headless fingerprint, too few
     segments, and few device ids. That is about 12 bots, some of which are relay-assigned.
4. **Verification, within 6 minutes.**
   - **Receipts.** The relay's receipts are verified: `relay-receipts[data-verified]` ≥ 1,
     `data-rejected` = 0, and `relay-bytes-verified[data-bytes]` > 0.
   - **Counts.** `stream.health.viewers.verified` equals the number of honest sessions still
     open (run this check before step 5; afterwards, sessions ever assigned to the liar may stay
     pending, so the bound is `honest − liar-assigned ≤ verified ≤ honest`). The relay-assigned
     honest sessions are among them, and they verify only on receipts. `excluded` ≥ the number
     of bots.
   - **Public count.** The public verified count (`ViewerCount` / `channels.get`) never exceeds
     the honest count.
5. **Over-reporting relay (`--set liar=true`, default on).**
   - The harness registers a second relay, `liar`, implemented in TypeScript. It serves
     `/healthz` from a tiny local HTTP server and is not a Go relay.
   - The liar submits correctly signed receipts claiming 5× the bytes for sessions assigned to it.
   - The worker rejects them, and `relay-row[data-relay-id=liar]` turns `data-status="suspended"`
     with `relay-suspended-reason`.
   - Viewers assigned to the liar move to the origin on their next heartbeat.
6. **Drain.**
   - The harness stops the Go relay with SIGTERM. It sends a `draining` heartbeat, so
     `relay-row` shows `data-status="offline"` within 15 s.
   - Relay-assigned Chromium players switch to `data-source="origin"` and keep `playing` within
     30 s.
   - Restarting the relay with the same token brings it back to `active`.
   - `M` retires it with `relay-remove`; the row disappears (`relays.mine` omits retired relays). Then the harness stops the stream.
