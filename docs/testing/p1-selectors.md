<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# P1 web ↔ harness contract (peer-to-peer delivery)

P1-player and the `viewers` scenario agree on these rules, storage keys and `data-testid` values.
Source: [ADR 0005](../decisions/0005-p2p-tracker.md) amendment 1 (accepted 2026-10-27). This file
extends [e1](e1-selectors.md) to [e7](e7-selectors.md) and [w0](w0-selectors.md), and everything in
those still holds. Changing anything here is a contract change: update this file,
`harness/src/web/selectors.ts` (`P1_TEST_IDS`, `P2P_STATES`, `P2P_PREFERENCE_KEY`,
`P2P_NOTICE_KEY`), the player and the scenario together. Tests select elements by `data-testid`,
never by visible text. Counsel has not reviewed the disclosure text.

## Rules (a reviewer marks any breach HIGH)

- **Opt in by default.** A viewer who has not chosen gets the operator default,
  `instance.info` `features.p2pDefault` (`off` unless the operator set `P2P_DEFAULT=on`). The
  player sends `p2pCapable: true` to `playback.start` only when the effective choice is on and
  the policy below allows it; otherwise `false`.
- **Never on gated streams.** 18+, mature-category and T1-restricted streams never run P2P (the
  API answers `p2p.available: false` and writes no grant).
- **Off where it costs the viewer.** Metered connections, touch-primary devices and data mode keep
  P2P off even when the operator default is `on`; an explicit opt-in from the viewer still counts.
- **Disclosure first.** Before P2P first starts, the viewer has seen that other viewers in the same
  swarm see their IP address: the first-run notice (operator default `on`, no choice yet), or the
  same text next to the switch in the dialog or in `/settings/privacy`. Seeing it sets
  `commonair:p2p-notice=seen`.
- **One click off.** The indicator opens the dialog; its switch turns P2P off at once (the loader
  stops, the page keeps playing over HTTP) and stores `commonair:p2p=off`.
- **Every peer-delivered segment is checked** against the origin's digest
  (`PlaybackStart.p2p.digestUrl`); a mismatch is refetched over HTTP and that peer disconnected.

## Storage (localStorage, essential: privacy choices)

| Key                    | Values      | Meaning                                                            |
| ---------------------- | ----------- | ------------------------------------------------------------------ |
| `commonair:p2p`        | `on`, `off` | The viewer's choice; absent means the operator default             |
| `commonair:p2p-notice` | `seen`      | The viewer has seen the IP disclosure (notice, dialog or settings) |

## Test ids

| Test id              | Element / meaning                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `player-p2p`         | Indicator on the player while P2P is on; `player` carries `data-p2p` = `off`, `on` or `sharing` (`P2P_STATES`) in every state |
| `player-p2p-notice`  | First-run notice that peers see the viewer's IP address; only when the operator default is `on` and the viewer has not chosen |
| `player-p2p-dialog`  | Dialog opened from the indicator (or the player menu): what P2P does, the disclosure, the switch                              |
| `player-p2p-toggle`  | The switch in the dialog                                                                                                      |
| `privacy-p2p-toggle` | The switch in the P2P section of `/settings/privacy`, with the same disclosure next to it                                     |

## Scenarios

- **`viewers`** with `--set p2p=<n>` opted-in web Chromium viewers (init script sets
  `commonair:p2p=on` and `commonair:p2p-notice=seen`) and `--set p2pDefault=<n>` viewers with no
  storage keys at all. `p2p` defaults to `0` until P1-player merges, then `10`. Assertions: see
  `harness/README.md` ("viewers").
