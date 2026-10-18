<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Roadmap

This is the public roadmap for CommonAir. It lists what is being built, what
comes next, and what we have decided not to do. Detailed work is tracked in
GitHub issues. To propose a change, open an issue or a PR against this file;
see [GOVERNANCE.md](GOVERNANCE.md) for how the order is set.

## Phase 1: the full platform (in progress)

Phase 1 delivers a complete, self-hostable platform that runs with no
proprietary services.

- **Ingest**: go live from standard broadcasting software, with stream keys
  and transcoding.
- **Delivery**: adaptive playback served from the origin, with member relay
  nodes (`relay/`) contributing bandwidth.
- **Chat**: real-time chat with moderation tools, emotes, and rate limits.
- **IRC gateway**: connect to chat with standard IRC clients.
- **Bots and developer platform**: public API, SDK, OAuth apps, webhooks,
  bot accounts.
- **Subscriptions and tips**: through payment adapters, with a ledger that
  records every split. The default split is 90% to the streamer and 10% to the
  co-op.
- **VODs and clips**: recording, playback, clipping, retention controls.
- **Simulcast**: restream to other platforms.
- **Overlays**: browser-source overlays for alerts and chat.
- **Fair discovery**: directory and recommendations that do not just reward
  the already-large.
- **Integrity**: view-count integrity and viewbot detection, tested against
  the harness.
- **Co-op governance and patronage**: membership classes, elections,
  proposals, votes with protected-decision enforcement, the creator council,
  patronage calculation.
- **Trust and safety**: reporting, moderation queues, appeals, transparency
  reporting.
- **Compliance**: privacy controls, data export and deletion, required notices.
- **Operations**: metrics, logs, runbooks, backups, signed releases with SBOMs.
- **Self-hosting**: documented deployment with Podman, with every proprietary
  integration optional.

## Phase 2: next

Not being built in Phase 1. Order will be set by the board with member input.

- Import of channel data and followers from Twitch.
- Notifications by email, web push, and Discord.
- Live automatic captions.
- Internationalization, with community translations through a self-hosted
  Weblate instance.
- Installable progressive web app.
- Federation over ActivityPub.
- An ads policy, decided by member vote. Phase 1 ships without ads; whether
  the co-op ever allows them is a governance question, not an engineering one.

## Non-goals

These are out of scope for the current build. Some may be revisited later.

- Native mobile or TV apps. The web app is the client.
- Multi-region deployment.
- Advertising.
- Moving real money. Payment adapters run in test mode only.
- Integration with a real CSAM detection vendor. The interface exists; a real
  vendor needs a legal entity and agreements.
- Legal incorporation of the cooperative.
- Buying domains.
