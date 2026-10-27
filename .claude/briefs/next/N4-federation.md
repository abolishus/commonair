<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N4: ActivityPub federation

**Goal.** A Mastodon (or any ActivityPub) user can follow `@channel@instance`, sees a post when
it goes live and when a VOD or clip is published; two CommonAir instances can follow each
other's channels. Watching and chat stay on the home instance.

## State

Nothing exists (no WebFinger, no actors). feature-wins.md:777 puts portability phase 3 "after
the federation unit".

## Gates

- N1 (the `stream.online` fan-out path is reused for federated delivery).
- W3-portability, if move links should also carry fediverse followers (optional).
- [ADR 0030](../../../docs/decisions/0030-federation.md) (accepted 2026-10-27).

## Decisions: [ADR 0030](../../../docs/decisions/0030-federation.md) (accepted 2026-10-27)

- Scope v1: channels are `Service` actors (ids built from the channel id) that publish; local
  users do not federate as actors (no federated chat, no federated follows by local users).
  Off unless the operator sets `FEDERATION_ENABLED` (default false), then off per channel until
  the streamer turns it on.
- Objects: `Note` for go-live (with a link and a thumbnail), `Video` for VODs/clips (link to
  the home instance; media is not pushed).
- HTTP Signatures (draft-cavage, what Mastodon speaks) on all deliveries; RSA-2048 key per
  actor, stored encrypted; yearly and on-demand rotation, each with an audit row.
- Inbox handles `Follow`, `Undo{Follow}`, `Delete` (actor), and ignores everything else;
  incoming follows (`federation_followers`, new) are visible to the streamer and removable. The
  API inbox only does cheap checks, enqueues and answers 202; the worker (N4-delivery) verifies
  signatures, because the SSRF guard for key fetches lives there.
- Moderation: instance-level domain blocks (`federation_domain_blocks`, new; admin page, audit
  rows); mature-labelled channels federate with `sensitive: true` and no thumbnail; suspended
  channels send `Delete` of the actor and their follower rows are removed. Recorded head-agent
  choices awaiting the maintainer: remote followers are lost for good on suspension, and an inbox
  failing for 7 days has its followers dropped (open: maintainer).
- Delivery: through the outbox and the worker with the existing SSRF guard and backoff.
- Privacy: follower lists not published; no IPs or emails in any object.
- Library: in-repo (JSON-LD handled as plain JSON with the AS2 context), no library (decided).

## Contract step

- New events: VOD or clip made public, channel suspended, and their reversals. Every suspension
  path (`services/api/src/routes/moderation.ts`, `services/api/src/moderation/suspension.ts`,
  `services/worker/src/moderation/t0.ts`) writes the suspension event.
- Tables `federation_followers` and `federation_domain_blocks`; `FEDERATION_ENABLED` in
  `packages/config/src/env.ts` and `.env.example`.
- The outbox relay must hand internal events (`moderation.restriction` and the suspension event)
  to the federation worker; today it only marks them published
  (`services/worker/src/outbox.ts:82-94`). N1's contract step also changes `outbox.ts`, so the
  two changes are made together or coordinated with N1.

## Units

| Unit         | Owns                                                        | Builds                                                                                                        |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| N4-discovery | `services/api/src/federation/{webfinger,actor,nodeinfo}.ts` | WebFinger, actor documents, NodeInfo                                                                          |
| N4-inbox     | `services/api/src/federation/inbox.ts`, signatures module   | cheap checks (type, size, block list, rate limit), enqueue, 202                                               |
| N4-delivery  | `services/worker/src/federation/**`                         | signature verification and Follow/Undo/Delete; fan-out of go-live, VOD and clip posts; retries; domain blocks |
| N4-web       | studio federation settings, admin domain blocks             | toggle per channel, follower list, blocks                                                                     |

## Done means

`federation` scenario with two harness instances (or one instance and a minimal AP test
server): follow across instances, go live, the follower's inbox receives a signed `Create{Note}`;
unfollow stops delivery; a blocked domain is refused.
