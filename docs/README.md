<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# CommonAir Documentation

An index of the `docs/` tree. Entries marked "(coming)" are planned but not
written yet.

| Path                                                                   | Contents                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [decisions/](decisions/)                                               | Architecture Decision Records (ADRs): context, decision, consequences |
| [operators/trust-safety.md](operators/trust-safety.md)                 | Trust & safety duties, hash lists, evidence, holds (not legal advice) |
| [operators/payment-fraud-review.md](operators/payment-fraud-review.md) | Payment fraud review: flags, four eyes, confirming, the admin release |
| [viewers/](viewers/)                                                   | Guides for viewers                                                    |
| [viewers/payment-breakdown.md](viewers/payment-breakdown.md)           | Where your payment goes: the breakdown, fee schedule and estimate     |
| [viewers/data-mode.md](viewers/data-mode.md)                           | Data saver: the budget, the audio-only floor and the meter            |
| [viewers/calm-chat.md](viewers/calm-chat.md)                           | Calm Chat and blocking users                                          |
| [streamers/chat-replay.md](streamers/chat-replay.md)                   | Chat replay and how long chat is kept                                 |
| [streamers/verified-watch-gate.md](streamers/verified-watch-gate.md)   | The verified-watch gate and the surge guard                           |
| [streamers/discord.md](streamers/discord.md)                           | Optional Discord go-live posts, and the open alternatives             |
| [self-hosting/web-push.md](self-hosting/web-push.md)                   | Browser push: VAPID keys, `--web-push`, what the push services see    |
| [deploy/digitalocean.md](deploy/digitalocean.md)                       | Staging and production on DigitalOcean droplets (ADR 0025)            |
| [runbooks/](runbooks/)                                                 | Operational procedures for running an instance (coming)               |
| [self-hosting/](self-hosting/)                                         | How to deploy and operate your own instance (coming)                  |
| [architecture.md](architecture.md)                                     | System overview: services, data flow, relay network                   |
| [governance/](governance/)                                             | How the co-op makes decisions                                         |
| [governance/decision-process.md](governance/decision-process.md)       | Proposal lifecycle, protected decisions, quorum, tallies              |
| [api/](api/)                                                           | Public API and SDK reference (coming)                                 |
| [developers/](developers/README.md)                                    | Building on the platform: OAuth apps, EventSub, the SDK, porting      |

## Decisions

- [0001: Platform name — CommonAir](decisions/0001-name.md)

## Project documents

These live at the repository root:

- [CONTRIBUTING.md](../CONTRIBUTING.md): how to contribute
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md): expected behavior and reporting
- [GOVERNANCE.md](../GOVERNANCE.md): how technical decisions are made
- [SECURITY.md](../SECURITY.md): reporting vulnerabilities
- [TRADEMARKS.md](../TRADEMARKS.md): use of the name and logo
- [ROADMAP.md](../ROADMAP.md): what is planned and what is not
- [CHANGELOG.md](../CHANGELOG.md): release history
