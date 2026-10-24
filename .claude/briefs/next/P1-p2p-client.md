<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# P1: the browser P2P client

**Goal.** Viewers who opt in share segments with each other over WebRTC through the native
tracker (ADR 0005), cutting origin egress, with integrity counts unchanged.

## State

- Tracker built (`services/tracker`, ADR 0005), with playback-token auth and swarm evidence.
- Player has no P2P: `apps/web/src/player/controller.ts:83` `p2pCapable: false`, `:180`
  `bytesP2p: 0`; `source.ts:13` reports `p2p` "never". Only hls.js.
- ADR 0005:61 left an interop test with a real client as a follow-up; info hashes are
  client-chosen (HANDOFF.md:436).
- feature-wins §8 item 4: no P2P claims in Waves 1–3 until this exists.

## Decisions first: ADR 0005 amendment

- Client library: p2p-media-loader (MIT, the tracker was designed for it) vetted at a pinned
  version, or an in-repo loader. WebRTC ICE servers: the instance's own STUN/TURN (coturn,
  BSD) as the FOSS default; no public Google STUN.
- Opt-in default (recommended: on for desktop, off on metered connections and when W1b data
  mode is on); a visible indicator; no P2P for 18+ gated or private streams.
- Privacy: peers see each other's IPs. Disclose it in the player and the privacy notice; the
  option to turn it off is one click.
- Allowed info hashes derived from the channel's swarm ids (closes the junk-swarm note).
- Integrity: P2P bytes reported in heartbeats count toward nothing that pays; the receipt
  cross-check stays origin- and relay-based.

## Units

| Unit       | Owns                                               | Builds                                                      |
| ---------- | -------------------------------------------------- | ----------------------------------------------------------- |
| P1-player  | `apps/web/src/player/p2p/**`, `controller.ts` seam | loader integration, opt-in, `bytesP2p`, indicator           |
| P1-tracker | `services/tracker/**`                              | derived info hashes, interop fixes found by the real client |
| P1-turn    | `infra/coturn/**`, compose and Quadlet entries     | self-hosted STUN/TURN, credentials from the API             |

## Done means

`viewers` scenario: with ten Chromium viewers opted in, `bytesP2p` > 0 and origin egress drops;
counts and verdicts match a run without P2P; an opted-out viewer never connects to peers.
