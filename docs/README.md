<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# CommonAir Documentation

An index of the `docs/` tree, grouped by who it is for.

## Everyone

| Path                                                                                   | Contents                                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [architecture.md](architecture.md)                                                     | System overview: services, data flow, relay network                   |
| [decisions/](decisions/)                                                               | Architecture Decision Records (ADRs): context, decision, consequences |
| [governance/decision-process.md](governance/decision-process.md)                       | Proposal lifecycle, protected decisions, quorum, tallies              |
| [governance/integrity-ruleset-changelog.md](governance/integrity-ruleset-changelog.md) | Every change to the integrity ruleset                                 |
| [product/feature-wins.md](product/feature-wins.md)                                     | What CommonAir can ship that Twitch can't                             |

## Viewers and streamers

| Path                                                                 | Contents                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [viewers/payment-breakdown.md](viewers/payment-breakdown.md)         | Where your payment goes: the breakdown, fee schedule and estimate |
| [viewers/data-mode.md](viewers/data-mode.md)                         | Data saver: the budget, the audio-only floor and the meter        |
| [viewers/calm-chat.md](viewers/calm-chat.md)                         | Calm Chat and blocking users                                      |
| [streamers/channel-bot.md](streamers/channel-bot.md)                 | The channel bot                                                   |
| [streamers/channel-points.md](streamers/channel-points.md)           | Channel points                                                    |
| [streamers/polls-predictions.md](streamers/polls-predictions.md)     | Polls and predictions                                             |
| [streamers/raids-goals.md](streamers/raids-goals.md)                 | Raids and goals                                                   |
| [streamers/chat-replay.md](streamers/chat-replay.md)                 | Chat replay and how long chat is kept                             |
| [streamers/verified-watch-gate.md](streamers/verified-watch-gate.md) | The verified-watch gate and the surge guard                       |
| [streamers/discord.md](streamers/discord.md)                         | Optional Discord go-live posts, and the open alternatives         |

## Developers building on the platform

[developers/](developers/README.md): getting started, OAuth apps, EventSub, the SDK, rate limits
and porting from Twitch.

## Self-hosters and operators

| Path                                                                   | Contents                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [self-hosting/](self-hosting/README.md)                                | From a fresh server to a running instance, and day-two operations     |
| [deploy/digitalocean.md](deploy/digitalocean.md)                       | Staging and production on DigitalOcean droplets (ADR 0025)            |
| [operators/on-call.md](operators/on-call.md)                           | On-call                                                               |
| [operators/incidents.md](operators/incidents.md)                       | Incidents                                                             |
| [operators/monitoring.md](operators/monitoring.md)                     | Metrics, dashboards and alerts                                        |
| [operators/status-page.md](operators/status-page.md)                   | The status page and the outside-in alerts                             |
| [operators/capacity.md](operators/capacity.md)                         | How far one host goes                                                 |
| [operators/trust-safety.md](operators/trust-safety.md)                 | Trust & safety duties, hash lists, evidence, holds (not legal advice) |
| [operators/dmca.md](operators/dmca.md)                                 | DMCA notice and takedown                                              |
| [operators/payment-fraud-review.md](operators/payment-fraud-review.md) | Payment fraud review: flags, four eyes, confirming, the admin release |

## Contributors and maintainers

| Path                                                       | Contents                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [testing/seeding.md](testing/seeding.md)                   | Seeding demo data                                                    |
| [testing/](testing/)                                       | Stable test selectors, one file per work unit                        |
| [operators/flakes.md](operators/flakes.md)                 | The flake log: every CI flake, its cause and fix                     |
| [design/](design/)                                         | Design reviews and their screenshots                                 |
| [maintainers/releasing.md](maintainers/releasing.md)       | Cutting and signing a release                                        |
| [maintainers/translations.md](maintainers/translations.md) | Hosted Weblate setup, components, checks, DCO, reviewing Weblate PRs |
| [translators/](translators/README.md)                      | Guide for volunteer translators: where, message format, style        |

## Project documents

These live at the repository root:

- [CONTRIBUTING.md](../CONTRIBUTING.md): how to contribute
- [AGENTS.md](../AGENTS.md): the engineering rules every change follows
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md): expected behavior and reporting
- [GOVERNANCE.md](../GOVERNANCE.md): how technical decisions are made
- [SECURITY.md](../SECURITY.md): reporting vulnerabilities
- [TRADEMARKS.md](../TRADEMARKS.md): use of the name and logo
- [ROADMAP.md](../ROADMAP.md): what is planned and what is not
- [CHANGELOG.md](../CHANGELOG.md): release history
