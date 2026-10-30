<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0017: Watch Rooms retention and safety

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `ccf9c17`)
- Gates: W3-watch-rooms ([W3 plan](../../.claude/briefs/next/W3-feature-wave.md))

**Counsel has not reviewed this ADR.** Small private group spaces that minors can use touch the
UK Online Safety Act's children's duties, the DSA's minor-protection article (Art. 28) and US
child-safety law. Acceptance covers the mechanism (who may join, what is kept, where reports go),
not its legal sufficiency. Counsel reviews it with the L1 launch checklist, before rooms are on for
a public instance. This is not legal advice.

## Context

Watch Rooms (feature-wins §4.13) let up to 8 friends lock their players together on one live
channel and share a side chat. Debate log items 6 and 25 moved it to Wave 3 because it carries the
highest trust-and-safety risk on the list, and because its first design kept room chat only in
memory, which leaves nothing to review when someone reports abuse. What the code has today:

- **Age is a birth date, fixed at signup.** `users.birth_date` is collected for the 13+ gate and
  18+ content (`packages/db/src/schema/auth.ts:35-36`), may be null, and cannot be changed after
  signup (`services/api/src/auth/index.ts:58`). `isAdult` treats a missing or invalid date as not
  adult (`services/api/src/auth/identity.ts:150-153`). Mature viewing also needs an adult's
  confirmation (`users.mature_confirmed_at`, `auth.ts:39-40`), checked by the playback gate
  (`services/api/src/routes/playback.ts:116-151`).
- **Mature labels** sit on channels, broadcasts and categories (`channels.mature`,
  `packages/db/src/schema/channels.ts:51`; `broadcasts.mature`, `media.ts:47`; `categories.mature`,
  `channels.ts:26-27`).
- **Bans.** Platform: `users.banned` (`auth.ts:26`) and suspension, which blocks every write but
  appeals (`services/api/src/lib/access.ts:82-84`). Channel: `chat_bans`, one active row per
  channel and user (`packages/db/src/schema/chat.ts:40-62`).
- **No user-to-user blocks exist.** There is no block table or route in `packages/db` or
  `packages/contracts`, and no milestone plans one. Feature-wins §4.13 assumes them ("a host can't
  invite someone who has blocked a member").
- **Reports** are rows in `reports` with a subject type, an optional channel and an `evidence` jsonb
  captured at report time (`packages/db/src/schema/safety.ts:218-237`). A chat-message report copies
  the message body there (`services/api/src/routes/safety.ts:74-80`). Subjects are
  `user, channel, chat_message, vod, clip, broadcast` (`packages/contracts/src/enums.ts:126`).
- **Sealed evidence** (`evidence_objects`, `packages/db/src/schema/moderation.ts:144-170`) needs a
  legal hold and a case and stores media kinds only (`enums.ts:264`); it is the T0 and legal-hold
  store (ADR 0006 Q4), not a report store.
- **Account deletion** already deletes the user's chat messages in its transaction
  (`services/worker/src/deletion/account-deletion.ts:287`).
- **Channel chat rooms** are in-memory fan-out (`services/chat/src/rooms.ts`); feature-wins puts
  watch rooms in a new `services/chat/src/watch-rooms.ts` and leaves `rooms.ts` alone.

There are no users yet, so the rules below can start strict with nothing to migrate.

## Decisions

### 1. Rooms are database rows with a 30-day retention, covered by the deletion worker

New tables (orchestrator's contract step, `packages/db`): `watch_rooms` (host, channel, broadcast,
age band, created and ended times), `watch_room_members` (room, user, joined and left times) and
`watch_room_messages` (room, author id, body, time). Members and authors are referenced by user id.
Valkey holds only live presence and sync state.

A room ends when its broadcast ends, when the host closes it, or when it has been empty for 10
minutes. **Room data is kept 30 days after the room ends, then deleted** by a worker retention job.
Thirty days is the report window: a member can report a room until then, and after that nothing is
left to report or to leak. Account deletion removes the user's room messages and memberships in the
same transaction that removes their chat messages, and ends rooms they host.

Why the database: a report needs the conversation as it was, and in-memory rooms lose it on a
restart. Why 30 days and not the 72 h feature-wins proposed: grooming is often reported late, by the
child or a parent, and 72 h would have deleted the evidence before most such reports.

### 2. Reports go to platform moderation; rooms inherit the host channel's bans

**Reports.** A new report subject `watch_room` goes to the platform moderation queue only. The
report row's `channel_id` is null, so nothing about the room reaches the host channel's moderators:
the room is a private space of its members, and the channel's moderators have no standing in it.
At report time the room's messages and member list are copied into the report's `evidence`
(authors by user id), as a chat-message report copies the body today. That copy lives as long as
the report; if staff escalate to a legal hold, the existing hold and case flow applies. Room data
itself still expires at 30 days.

**Ban inheritance.** Joining or creating a room is refused, and a member is removed, when they are
platform-banned or suspended, or hold an active `chat_bans` row on the host channel. A ban issued
during a room removes the member at once. Room chat goes through the host channel's word filter and
the platform filter.

**Blocks.** ~~User-to-user blocks do not exist. W3's contract step adds them (a `user_blocks` table
and `me.blocks` routes, new);~~ Superseded 2026-10-30 by [ADR 0012](0012-media-clock.md)
amendment 1 decision 8: blocks (`user_blocks`, `me.blocks.*`, the block action) ship in W1, so W3
reuses them. A room refuses a join when the joiner and any member have blocked each other in
either direction. Rooms do not ship without this check.

### 3. Strict age separation

- **Every room has a fixed age band**, set from the host at creation: `minor` (13 to 17) or `adult`.
- **An under-18 account can only join a `minor` room**, where every member is under 18. **Adults
  cannot join `minor` rooms**, as members or as hosts.
- **Mature-labelled content excludes minors entirely.** Rooms on a channel, broadcast or category
  labelled mature are `adult` rooms, and every member must also have confirmed mature viewing. If a
  live broadcast becomes mature-labelled, its `minor` rooms end.
- **Unknown age fails closed.** An account with no valid birth date cannot create or join a room.
- **Minor rooms are never publicly listed.** Public presence (opt-in for adults) is unavailable in
  `minor` rooms; members join only by the host's invite.
- **The band is checked at every join** against the birth date on that day; a member whose band has
  changed since joining is removed at their next reconnect.

The rule is enforced in the database (AGENTS.md non-negotiable 9): a trigger on
`watch_room_members` refuses an insert whose member's age band, computed from `users.birth_date`
and the database date, differs from the room's band, or whose room is `adult` on mature content
without mature confirmation. The chat service checks the same rule first to give a clear error
(an i18n message), but the trigger is what holds.

Why strict: small, semi-private group spaces are where grooming risk concentrates, and this is the
riskiest feature on the list. A strict rule is easy to loosen later and very hard to tighten once
mixed rooms exist.

### 4. Room content is personal data and stays out of append-only columns

Room messages are free text from users. They never go into `audit_log` details, ledger metadata or
history tables (AGENTS.md "Never write personal data … into append-only columns"). Audit rows for
room moderation reference the room and users by id.

## Consequences

- W3-watch-rooms needs a contract step before it starts: the three room tables and the age-band
  trigger, the room-join block check (`user_blocks` and the block routes come from W1; note of
  2026-10-30), the `watch_room` report subject, room frames and
  `CHAT_LIMITS` entries.
- A family where a parent and a child want to watch together cannot use a room. That is the cost of
  the strict rule, accepted.
- Moderators get a full transcript for any report filed within 30 days; nobody gets anything after.
- Room messages show up in the user's data export while they exist (W3-portability's bundle).
- `watch-room` harness: a mixed-age join is refused by the API and by the trigger (direct insert);
  a minor cannot join a mature channel's room; a channel-banned user cannot join; a blocked pair
  cannot share a room; a report captures the transcript; the retention job deletes a room 30 days
  after it ends.

## Alternatives considered

- **In-memory rooms with no retention.** Rejected (debate log 6): nothing to review on report.
- **A 72 h report window.** Rejected as too short for late reports (decision 1).
- **Snapshot into `evidence_objects`.** Rejected for reports in general: that store is sealed,
  hold-bound and media-only. It stays available through the legal-hold flow when staff escalate.
- **Allowing mixed ages with adult supervision rules, or only blocking adult strangers.** Rejected:
  "stranger" is not something the platform can verify, and a loose rule cannot be tightened later
  without breaking rooms people already use.
- **Routing room reports to the channel's moderators.** Rejected: channel moderators are volunteers
  chosen by the streamer, and DSA and OSA duties for this content cannot be delegated to them.

## Decisions at acceptance (2026-10-27)

The maintainer accepted this ADR with the recommended answers. **Counsel has still not reviewed it.**

1. **Retention.** Rooms are database-backed and TTL'd, covered by the deletion worker. Room data is
   kept 30 days (the report window), then deleted.
2. **Reports and bans.** Reports go to platform moderation; rooms inherit bans from the host
   channel.
3. **Age.** Strict separation: an under-18 account can only join rooms where every member is under
   18, and adults cannot join them; mature-labelled channels exclude minors entirely. Why: small
   semi-private group spaces are where grooming risk concentrates; this is the riskiest feature on
   the list, and a strict rule is easy to loosen later and very hard to tighten.

Also settled here (no separate question was asked): unknown age fails closed, minor rooms are
invite-only with no public presence, the age rule is a database trigger, and user-to-user blocks
are built in W3's contract step because rooms depend on them.

**Note (2026-10-30).** The "blocks are built in W3's contract step" lines above are superseded by
ADR 0012 amendment 1 decision 8: blocks ship in W1 (batch 4). W3's contract step adds only the
room-join block check on top of W1's `user_blocks` table.
