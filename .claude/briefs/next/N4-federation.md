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
- ADR 0030.

## Decisions first: ADR 0030 (federation)

- Scope v1: channels are `Service`/`Person` actors that publish; local users do not federate
  as actors yet (no federated chat, no federated follows by local users).
- Objects: `Note` for go-live (with a link and a thumbnail), `Video` for VODs/clips (link to
  the home instance; media is not pushed).
- HTTP Signatures (draft-cavage, what Mastodon speaks) on all deliveries; key per actor, stored
  encrypted; rotation.
- Inbox handles `Follow`, `Undo{Follow}`, `Delete` (actor), and ignores everything else;
  incoming follows are visible to the streamer and removable.
- Moderation: instance-level domain blocks (admin page, audit rows); mature-labelled channels
  federate with `sensitive: true`; suspended channels send `Delete`.
- Delivery: through the outbox and the worker with the existing SSRF guard and backoff.
- Privacy: follower lists not published; no IPs or emails in any object.
- Library: in-repo (JSON-LD handled as plain JSON with the AS2 context), or a vetted package.

## Units

| Unit         | Owns                                                        | Builds                                                         |
| ------------ | ----------------------------------------------------------- | -------------------------------------------------------------- |
| N4-discovery | `services/api/src/federation/{webfinger,actor,nodeinfo}.ts` | WebFinger, actor documents, NodeInfo                           |
| N4-inbox     | `services/api/src/federation/inbox.ts`, signatures module   | signature verification, Follow/Undo/Delete                     |
| N4-delivery  | `services/worker/src/federation/**`                         | fan-out of go-live, VOD and clip posts; retries; domain blocks |
| N4-web       | studio federation settings, admin domain blocks             | toggle per channel, follower list, blocks                      |

## Done means

`federation` scenario with two harness instances (or one instance and a minimal AP test
server): follow across instances, go live, the follower's inbox receives a signed `Create{Note}`;
unfollow stops delivery; a blocked domain is refused.
