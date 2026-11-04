<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, minor
versions may contain breaking changes.

A minor release comes out about every two weeks, and patch releases as needed
([docs/self-hosting/upgrades.md](docs/self-hosting/upgrades.md#release-cadence)). Each release's
notes on GitHub also list every commit since the previous release
(`scripts/release/changelog.ts`); this file says what changed in plain words.

## [Unreleased]

## [0.1.0] - unreleased

The first release: a live streaming platform owned by a co-operative of its streamers and
viewers, which anyone can run on one Linux server. Everything below is new in it. It is grouped
by what you use, not by change type. The design decisions behind each part are the ADRs in
[docs/decisions/](docs/decisions/).

### Streaming and playback

- Stream from OBS or FFmpeg over **RTMP or WHIP** (WebRTC) to MediaMTX, with stream keys that are
  scanned for leaks, and an adaptive transcode ladder (CPU or NVENC) that starts once a stream has
  viewers.
- **HLS playback** through the origin: signed playback tokens, a coalescing cache, egress
  accounting, and LL-HLS. A **data mode** caps a viewer's bitrate (presets of 50, 800 and
  1900 MB/h; ADR 0018).
- **One clock for all of it** (ADR 0012): segments, captions, chat and predictions share media
  time, so a rewind lines up chat with the picture, and viewers far behind see a "catching up"
  label.
- **Member relays** (ADR 0005): a small Go binary that anyone can run to serve a stream's segments
  to nearby viewers, with signed receipts that the worker checks against what viewers fetched, and
  a signed purge feed.
- **Peer-to-peer playback** (P1): viewers who opt in fetch some segments from each other over
  WebRTC, each checked against a digest only the origin serves. It is off by default
  (`P2P_DEFAULT=off`), off on phones and metered connections, and never for 18+ streams. The
  instance runs its own STUN server (coturn); a TURN relay is optional.
- **Free live DVR** (ADR 0016): scrub back through a live stream, with a concurrency limit per
  device and account; relays serve DVR too.
- **VODs and clips**, with thumbnails, private storage until published, public watch pages and
  a chat replay panel that follows the playhead.
- **Live captions** (ADR 0011): whisper.cpp on the instance's own CPU, so no audio leaves it;
  live WebVTT tracks, a caption editor for VODs, and a CC toggle with styles. Off unless the
  operator turns it on and the streamer enables it.
- **Simulcast** to other platforms, **overlays** for alerts and goals, **rehearsal mode** to test
  a stream with invited viewers before going live, and **watch rooms** (ADR 0017) where a group
  watches in sync.
- **Verified viewer counts** (ADR 0015): integrity signals (datacenter networks, concurrency,
  headless browsers, chat ratio, follow and raid bursts) exclude viewbots from the count, with
  reasons and group appeals. **Signed audience attestations** let a streamer prove their numbers
  to a sponsor, verifiable on a public page and with the SDK.

### Chat

- WebSocket chat with slow mode, follower and subscriber modes, filters, moderators and their
  commands (ban, timeout, delete, clear), a plugin pipeline, and history kept
  `CHAT_RETENTION_DAYS` (30 by default).
- A **Twitch-compatible IRC gateway** (plain and TLS), so tmi.js bots and IRC clients work
  unchanged, and it sees each client's own address.
- **Calm Chat**: a flood is shown as a digest a screen reader can follow. A **surge guard** and a
  **verified-watch gate** (both off until their criteria are met) protect a channel during a raid.
- **The channel bot**: commands, timers, variables and filters, run as a channel moderator.
- **Interactivity** (ADR 0026, ADR 0039): polls, predictions on media time with a grace window,
  raids that carry verified viewers, goals, channel points with no cash value, and giveaways drawn
  by commit-reveal so anyone can check the draw (giveaways are off by default).
- **Notifications** (ADR 0028): go-live alerts in the app, by email (with one-click
  unsubscribe), by browser push and to a Discord webhook; and an installable web app.

### Money

- **Subscriptions in three tiers, gift subscriptions and tips**, through a manual adapter that a
  treasurer confirms (no proprietary service needed) or Stripe (Checkout and Billing). A gift is
  paid within `GIFT_PAYMENT_HOURS` (24 h), one open gift per gifter and channel.
- **A double-entry ledger** that the database itself keeps append-only and balanced (ADR 0004),
  with a revenue dashboard and a breakdown of every payment: fees, tax, the co-op's share and when
  it is released.
- **Refunds, chargebacks and clawbacks**, including the automatic refund of money Stripe collected
  for a subscription that had already ended, a refund request queue for the treasurer, and an
  "outcome unknown" state when Stripe does not answer.
- **Payouts** with a minimum and a monthly run, and **Stripe Connect transfers** to each
  recipient's account; a failed or reversed transfer returns the money to the payable, and the
  treasurer sees it.
- **Crew splits** (ADR 0013): a streamer shares revenue with moderators and editors, with holds
  per recipient, a suspense account and two-person write-offs.
- **A payment fraud floor** (ADR 0036): flagged payments hold the payee's payouts until an admin
  releases them, with four-eyes approval.
- Money is integer cents throughout, and Stripe runs only against stripe-mock until the co-op has
  a legal entity and live keys.

### Co-op

- **Memberships** in classes, with eligibility from verified watching and streaming, and
  **shares**.
- **Governance** (ADR 0004, ADR 0020): proposals, discussion, council review, votes and tallies.
  Protected decisions need a majority in every member class, which the database enforces, not
  only the application.
- **The creator council**, recomputed from the members, and **elections**.
- **Patronage**: a versioned formula with caps turns a period's surplus into allocations, each
  member gets a statement explaining theirs, and payouts follow.
- **Transparency**: the ledger's aggregates, infrastructure costs and the enforcement report
  are public on `/transparency`.
- **An advisory jury** (ADR 0038): randomly drawn members review moderation cases and advise; off
  by default.

### Safety

- **Automated moderation** (ADR 0006): known-image hash matching (CSAM and NCII lists you
  install), a classifier for mature content, legal hold of evidence that survives account deletion,
  an NCMEC report draft, and an NCII takedown form with its 48-hour clock.
- **Reports, a moderation queue, appeals** and a moderator audit log; **mature labels** with an
  18+ gate and a 13+ sign-up gate.
- **Statements of reasons** for every enforcement action (ADR 0019), and a public
  **enforcement report** with small groups suppressed.
- **DMCA** notices and counter-notices with repeat-infringer strikes.
- **Account deletion** that pseudonymizes history instead of rewriting it, **data export**, user
  blocks, and versioned legal documents with re-acceptance and cookie consent. The legal texts are
  drafts that no counsel has reviewed.
- Sign-in with email and password, magic link, passkey and TOTP, with ALTCHA proof of work at
  sign-up and optional OAuth providers.

### Federation and portability

- **ActivityPub federation** (ADR 0030), off by default: a channel that opts in can be followed
  from Mastodon and other servers as `@channel@instance`, and they see its go-lives, VODs and
  clips. Nothing comes back in. Domain blocks and key rotation are on the admin pages.
- **Portability** (ADR 0037): a streamer moves their channel to another instance with a signed
  bundle and a standing statement, and their followers are told where it went.
- **The Twitch import** (ADR 0031), off by default: copy your public Twitch profile, panels and
  emotes, field by field, after proving you own the account. It asks Twitch for no scopes, and
  the imported Twitch data is cleared 30 days later.

### Web app, languages and accessibility

- A web app built on one design system (shadcn on Base UI, Rubik, dark first with a full light
  theme): the directory with fair discovery and categories, search, channel pages with panels,
  the studio, settings, analytics, the co-op pages and the admin pages.
- **Spanish** beside English (ADR 0029), right-to-left support, translations through Weblate, and a
  pseudo-locale run in CI.
- Every page has a title, a skip link and error states with a way out; keyboard navigation and
  reduced motion throughout.

### Self-hosting

- **`selfhost.sh install`**: one command takes a fresh Debian 13 or Fedora 42+ server to a running
  instance, as rootless Podman containers under systemd (Quadlet), with Caddy for HTTPS (ACME or
  its own CA). Each unit gets only the keys of `commonair.env` it needs.
- **Releases you can verify** (ADR 0022, ADR 0023): images for amd64 and arm64 pinned by digest,
  signed keylessly with cosign, with CycloneDX SBOMs and SLSA provenance, and a signed
  `SHA256SUMS`; `--require-signature` refuses anything that does not verify. A mirror recipe for
  your own registry.
- **Upgrades** that take a backup, run the migrations before any service starts, and roll back on
  their own when the new release does not come up healthy.
- **Backups**: WAL-G continuous archiving of the bundled Postgres with a restore drill, and
  `backup --objects` to copy media and evidence to another S3 store.
- **State where you want it**: Garage on the same host by default, or any S3-compatible store
  (`--s3-*`); the bundled Postgres and Valkey by default, or managed ones (`--database-url`,
  `--valkey-url`) over verified TLS, with a preflight that checks rights, version and the
  connection budget (ADR 0032).
- **Optional features by flag**: `--captions` (checks the CPU for AVX2 first), `--turn-relay` and
  `--web-push`.
- **Observability**: Prometheus, Loki, Tempo and Grafana, with host, Postgres and Valkey metrics,
  dashboards and burn-rate alerts for an availability target.
- A staging seed mode that fills a staging instance with realistic demo data (ADR 0040).

### Developer platform

- **OAuth apps** with scopes and a consent screen, **bot accounts**, and app tokens
  (ADR 0027).
- **EventSub** over webhooks (signed, retried, safe from server-side request forgery) and over a
  WebSocket, with delivery logs and test events.
- **`@commonair/sdk`** (Apache-2.0, ADR 0035), a developer console, and an OpenAPI description of
  the whole API.

## [0.1.0-rc.9] - 2026-11-02

Release candidate for staging. Notes: [v0.1.0-rc.9][0.1.0-rc.9].

## [0.1.0-rc.8] - 2026-11-02

Release candidate for staging. Notes: [v0.1.0-rc.8][0.1.0-rc.8].

## [0.1.0-rc.7] - 2026-11-02

Release candidate for staging. Notes: [v0.1.0-rc.7][0.1.0-rc.7].

## [0.1.0-rc.6] - 2026-11-02

Release candidate for staging. Notes: [v0.1.0-rc.6][0.1.0-rc.6].

## [0.1.0-rc.5] - 2026-11-02

Release candidate for staging. Notes: [v0.1.0-rc.5][0.1.0-rc.5].

## [0.1.0-rc.4] - 2026-11-02

Release candidate for staging. An `0.1.0-rc.2` selfhost.sh can upgrade to it. Notes:
[v0.1.0-rc.4][0.1.0-rc.4].

## [0.1.0-rc.3] - 2026-11-02

Release candidate for staging. Notes: [v0.1.0-rc.3][0.1.0-rc.3].

## [0.1.0-rc.2] - 2026-10-26

Second release candidate: the first upgrade on a real host (from rc.1). It fixes a player wedge
on a live stream that starts with a gap, and `status`, `backup` and `upgrade` refuse root and a
session without a user manager. Notes: [v0.1.0-rc.2][0.1.0-rc.2].

## [0.1.0-rc.1] - 2026-10-23

First release candidate: the platform, the release workflow and `selfhost.sh`, installed on a real
Debian 13 host. Notes: [v0.1.0-rc.1][0.1.0-rc.1].

[Unreleased]: https://github.com/abolishus/commonair/compare/v0.1.0-rc.9...main
[0.1.0]: https://github.com/abolishus/commonair/commits/main
[0.1.0-rc.9]: https://github.com/abolishus/commonair/releases/tag/v0.1.0-rc.9
[0.1.0-rc.8]: https://github.com/abolishus/commonair/releases/tag/v0.1.0-rc.8
[0.1.0-rc.7]: https://github.com/abolishus/commonair/releases/tag/v0.1.0-rc.7
[0.1.0-rc.6]: https://github.com/abolishus/commonair/releases/tag/v0.1.0-rc.6
[0.1.0-rc.5]: https://github.com/abolishus/commonair/releases/tag/v0.1.0-rc.5
[0.1.0-rc.4]: https://github.com/abolishus/commonair/releases/tag/v0.1.0-rc.4
[0.1.0-rc.3]: https://github.com/abolishus/commonair/releases/tag/v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/abolishus/commonair/releases/tag/v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/abolishus/commonair/releases/tag/v0.1.0-rc.1
