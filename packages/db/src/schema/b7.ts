// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 (W3, N3, N4; .claude/briefs/w3/contract-step.md §3.1): watch rooms, portability,
 * giveaways, the advisory jury, federation and relay purges. Move links, portability grants and the
 * channel and follow columns live in `channels.ts`; the prediction columns in `interactive.ts`.
 * The protections are in migration 0046.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { GiveawayEligibility } from "@commonair/contracts/shapes";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import { broadcasts } from "./media.ts";
import {
  createdAt,
  federationDeliveryStatus,
  federationInboxOutcome,
  federationObjectKind,
  federationSubjectKind,
  giveawayStatus,
  id,
  importStatus,
  juryReasonCode,
  jurySubjectKind,
  juryVote,
  juryWithdrawReason,
  portabilitySource,
  relayPurgeReason,
  roomAgeBand,
  roomEndReason,
  ts,
  updatedAt,
} from "./_shared.ts";

const HEX64 = "^[0-9a-f]{64}$";

// Watch rooms (ADR 0017, decision (q)) --------------------------------------------------------

/**
 * A watch room on one live broadcast. Its band is the host's on the day; members must match (the
 * 0046 trigger, which also refuses minors on mature content and a 9th member). Data is kept
 * `ROOM_LIMITS.retentionDays` after `ended_at`, then the retention job deletes the room.
 */
export const watchRooms = pgTable(
  "watch_rooms",
  {
    id: id(),
    hostId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    ageBand: roomAgeBand().notNull(),
    /** Hex SHA-256 of the current invite nonce; null once the room ended. */
    inviteHash: text(),
    createdAt: createdAt(),
    endedAt: ts(),
    endReason: roomEndReason(),
  },
  (t) => [
    uniqueIndex("watch_rooms_invite_hash_uq").on(t.inviteHash),
    index("watch_rooms_host_idx").on(t.hostId),
    index("watch_rooms_broadcast_idx").on(t.broadcastId),
    index("watch_rooms_ended_idx").on(t.endedAt),
    check("watch_rooms_end", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
    check("watch_rooms_invite_hash", sql`${t.inviteHash} is null or ${t.inviteHash} ~ '${sql.raw(HEX64)}'`),
    // Decision (q): every v1 room is invite-only; the hash is cleared only once the room ends.
    check("watch_rooms_invite_live", sql`${t.inviteHash} is not null or ${t.endedAt} is not null`),
  ],
);

export const watchRoomMembers = pgTable(
  "watch_room_members",
  {
    id: id(),
    roomId: uuid()
      .notNull()
      .references(() => watchRooms.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: ts().notNull().defaultNow(),
    leftAt: ts(),
  },
  (t) => [
    uniqueIndex("watch_room_members_active_uq")
      .on(t.roomId, t.userId)
      .where(sql`${t.leftAt} is null`),
    index("watch_room_members_user_idx").on(t.userId),
  ],
);

/** Room chat. Never copied to an append-only column (ADR 0017 decision 4); reports copy it into `reports.evidence`. */
export const watchRoomMessages = pgTable(
  "watch_room_messages",
  {
    id: id(),
    roomId: uuid()
      .notNull()
      .references(() => watchRooms.id, { onDelete: "cascade" }),
    authorId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("watch_room_messages_room_idx").on(t.roomId, t.createdAt),
    index("watch_room_messages_author_idx").on(t.authorId),
    check("watch_room_messages_body", sql`length(${t.body}) between 1 and 500`),
  ],
);

// Portability (ADR 0037, decisions (j)–(p)) -------------------------------------------------

/**
 * One bundle or Twitch import into a channel. `preview` holds public data only; `result` one line
 * per item (imported, skipped or rejected, with an opaque reason).
 */
export const portabilityImports = pgTable(
  "portability_imports",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    source: portabilitySource().notNull(),
    status: importStatus().notNull().default("previewed"),
    /** The uploaded archive under `incoming/` (bundle imports); deleted with the import. */
    archiveKey: text(),
    preview: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    choices: jsonb().$type<Record<string, unknown>>(),
    result: jsonb().$type<Record<string, unknown>[]>(),
    /** ADR 0031: the streamer asserted the right to re-host emote art, and which wording they saw. */
    assertedAt: ts(),
    assertionVersion: text(),
    /** Null for Twitch bundles (no statement); false = "standing not verified" (decision (o)). */
    standingVerified: boolean(),
    standingIssuer: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: ts(),
  },
  (t) => [
    index("portability_imports_channel_idx").on(t.channelId, t.createdAt),
    index("portability_imports_user_idx").on(t.userId),
    check("portability_imports_assertion", sql`(${t.assertedAt} is null) = (${t.assertionVersion} is null)`),
    check("portability_imports_twitch_standing", sql`${t.source} <> 'twitch' or ${t.standingVerified} is null`),
  ],
);

/** Standing-statement public keys (decision (n)), shaped like `integrity_signing_keys`; served at `/.well-known/commonair-portability`. */
export const portabilitySigningKeys = pgTable(
  "portability_signing_keys",
  {
    /** First 16 bytes of SHA-256 over the raw public key, base64url (22 characters). */
    kid: text().primaryKey(),
    algorithm: text().notNull().default("Ed25519"),
    /** Raw 32-byte public key, base64url. */
    publicKey: text().notNull(),
    firstUsedAt: ts().notNull().defaultNow(),
    retiredAt: ts(),
    compromisedAt: ts(),
  },
  (t) => [
    uniqueIndex("portability_signing_keys_public_key_uq").on(t.publicKey),
    check("portability_signing_keys_algorithm", sql`${t.algorithm} = 'Ed25519'`),
    check("portability_signing_keys_kid", sql`${t.kid} ~ '^[A-Za-z0-9_-]{22}$'`),
  ],
);

// Giveaways (decision (t)) ------------------------------------------------------------------

/**
 * One giveaway. `seed_commitment` = hex SHA-256 of the seed, published at open and immutable;
 * `sealed_seed` keeps the seed encrypted (`encryptSecret`) until the draw reveals it in `seed`,
 * which the database accepts once and only if it hashes to the commitment. One open per channel.
 */
export const giveaways = pgTable(
  "giveaways",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    title: text().notNull(),
    prize: text().notNull(),
    eligibility: jsonb().$type<GiveawayEligibility>().notNull(),
    winnerCount: smallint().notNull(),
    /** A chat keyword that enters the sender, or null for button entry only. */
    keyword: text(),
    status: giveawayStatus().notNull().default("open"),
    seedCommitment: text().notNull(),
    sealedSeed: text().notNull(),
    /** Revealed at the draw (hex). */
    seed: text(),
    /**
     * The pseudonym salt (hex). Never revealed: user ids are public, so the salt would let anyone
     * map pseudonyms back to accounts. Re-running the draw needs only the seed and the pseudonyms.
     */
    salt: text().notNull(),
    opensAt: ts().notNull().defaultNow(),
    closesAt: ts(),
    closedAt: ts(),
    drawnAt: ts(),
    cancelledAt: ts(),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("giveaways_channel_open_uq")
      .on(t.channelId)
      .where(sql`${t.status} = 'open'`),
    index("giveaways_channel_idx").on(t.channelId, t.createdAt),
    index("giveaways_due_idx")
      .on(t.closesAt)
      .where(sql`${t.status} = 'open'`),
    check("giveaways_winner_count", sql`${t.winnerCount} between 1 and 10`),
    check("giveaways_commitment", sql`${t.seedCommitment} ~ '${sql.raw(HEX64)}'`),
    // Whole bytes (16-64), as packages/draw `newSalt()` and `commonair_seed_matches`.
    check("giveaways_salt", sql`${t.salt} ~ '^([0-9a-f]{2}){16,64}$'`),
    check("giveaways_text", sql`length(${t.title}) between 1 and 60 and length(${t.prize}) between 1 and 200`),
  ],
);

/** One entry per account; the pseudonym is `HMAC(salt, userId)` and is what the public sees. */
export const giveawayEntries = pgTable(
  "giveaway_entries",
  {
    giveawayId: uuid()
      .notNull()
      .references(() => giveaways.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pseudonym: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.giveawayId, t.userId] }),
    uniqueIndex("giveaway_entries_pseudonym_uq").on(t.giveawayId, t.pseudonym),
  ],
);

/** Append-only (0046). `draw_index` is the index into the sorted entry list the draw picked. */
export const giveawayWinners = pgTable(
  "giveaway_winners",
  {
    giveawayId: uuid()
      .notNull()
      .references(() => giveaways.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rank: smallint().notNull(),
    drawIndex: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.giveawayId, t.rank] }),
    uniqueIndex("giveaway_winners_user_uq").on(t.giveawayId, t.userId),
    check("giveaway_winners_rank", sql`${t.rank} between 1 and 10 and ${t.drawIndex} >= 0`),
  ],
);

// The advisory jury (decision (u)) ----------------------------------------------------------

/** A member's opt-in; live while `opted_out_at` is null. */
export const juryOptins = pgTable("jury_optins", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  optedInAt: ts().notNull().defaultNow(),
  optedOutAt: ts(),
});

/** A monthly panel. Commitment and reveal follow the giveaway rule (0046). */
export const juryPanels = pgTable(
  "jury_panels",
  {
    id: id(),
    /** `YYYY-MM`. */
    period: text().notNull(),
    seedCommitment: text().notNull(),
    sealedSeed: text().notNull(),
    seed: text(),
    openedAt: ts().notNull().defaultNow(),
    closedAt: ts(),
  },
  (t) => [
    uniqueIndex("jury_panels_period_uq").on(t.period),
    check("jury_panels_period", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("jury_panels_commitment", sql`${t.seedCommitment} ~ '${sql.raw(HEX64)}'`),
  ],
);

/** A juror's seat. The 0046 trigger refuses a non-member, staff, or a user without a live opt-in. */
export const jurySeats = pgTable(
  "jury_seats",
  {
    id: id(),
    panelId: uuid()
      .notNull()
      .references(() => juryPanels.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("jury_seats_panel_user_uq").on(t.panelId, t.userId), index("jury_seats_user_idx").on(t.userId)],
);

/**
 * A sampled case. Never open, T0, NCII, minor safety, involving a minor, under legal hold, or a
 * `watch_room` report (0046, checked at insert). A case that turns ineligible later is withdrawn
 * (`withdrawn_at`, once), never deleted; withdrawn cases take no votes.
 * `pseudonym_map` (subject and party ids to panel pseudonyms) is server-side only.
 */
export const juryCases = pgTable(
  "jury_cases",
  {
    id: id(),
    panelId: uuid()
      .notNull()
      .references(() => juryPanels.id, { onDelete: "cascade" }),
    subjectKind: jurySubjectKind().notNull(),
    subjectId: uuid().notNull(),
    ruleRef: text(),
    pseudonymMap: jsonb().$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    withdrawnAt: ts(),
    withdrawnReason: juryWithdrawReason(),
  },
  (t) => [
    uniqueIndex("jury_cases_subject_uq").on(t.panelId, t.subjectKind, t.subjectId),
    check("jury_cases_withdrawn", sql`(${t.withdrawnAt} is null) = (${t.withdrawnReason} is null)`),
  ],
);

/** Append-only. Only a seat of the case's panel votes, once per case; no free text. */
export const juryVotes = pgTable(
  "jury_votes",
  {
    id: id(),
    caseId: uuid()
      .notNull()
      .references(() => juryCases.id, { onDelete: "cascade" }),
    seatId: uuid()
      .notNull()
      .references(() => jurySeats.id, { onDelete: "cascade" }),
    vote: juryVote().notNull(),
    reasonCode: juryReasonCode().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("jury_votes_case_seat_uq").on(t.caseId, t.seatId)],
);

/** A case a majority of jurors disagreed with, for staff re-review. Never changes the outcome. */
export const juryFlags = pgTable(
  "jury_flags",
  {
    id: id(),
    caseId: uuid()
      .notNull()
      .references(() => juryCases.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    resolvedById: uuid().references(() => users.id, { onDelete: "set null" }),
    resolvedAt: ts(),
  },
  (t) => [uniqueIndex("jury_flags_case_uq").on(t.caseId), index("jury_flags_open_idx").on(t.resolvedAt, t.createdAt)],
);

// Federation (ADR 0030, decision (c)) ------------------------------------------------------

/** A channel's ActivityPub actor. The private key is encrypted under the federation purpose. */
export const federationActors = pgTable("federation_actors", {
  channelId: uuid()
    .primaryKey()
    .references(() => channels.id, { onDelete: "cascade" }),
  enabled: boolean().notNull().default(false),
  /** `<actor id>#main-key`. */
  keyId: text().notNull(),
  publicKeyPem: text().notNull(),
  privateKeyEnc: text().notNull(),
  keyCreatedAt: ts().notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Every key an actor has used, written at rotation. Append-only; not served. */
export const federationActorKeys = pgTable(
  "federation_actor_keys",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    keyId: text().notNull(),
    publicKeyPem: text().notNull(),
    keyCreatedAt: ts().notNull(),
    retiredAt: ts().notNull().defaultNow(),
  },
  (t) => [index("federation_actor_keys_channel_idx").on(t.channelId)],
);

export const federationFollowers = pgTable(
  "federation_followers",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** The remote actor id (a URL). */
    actorId: text().notNull(),
    inbox: text().notNull(),
    sharedInbox: text(),
    /** `@user@domain`, when the actor document gave one. */
    handle: text(),
    domain: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("federation_followers_channel_actor_uq").on(t.channelId, t.actorId),
    index("federation_followers_domain_idx").on(t.domain),
  ],
);

export const federationDomainBlocks = pgTable("federation_domain_blocks", {
  domain: text().primaryKey(),
  createdById: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/** Inbox items after the API's cheap checks; the worker processes them. Swept after 7 days. */
export const federationInboxItems = pgTable(
  "federation_inbox_items",
  {
    id: id(),
    /** Null for the shared inbox. */
    channelId: uuid().references(() => channels.id, { onDelete: "cascade" }),
    headers: jsonb().$type<Record<string, string>>().notNull(),
    body: text().notNull(),
    receivedAt: ts().notNull().defaultNow(),
    processedAt: ts(),
    outcome: federationInboxOutcome(),
  },
  (t) => [
    index("federation_inbox_items_received_idx").on(t.receivedAt),
    check("federation_inbox_items_processed", sql`(${t.processedAt} is null) = (${t.outcome} is null)`),
  ],
);

/** Per-inbox delivery health: a failing inbox is dropped after `FEDERATION_RULES.dropAfterDays`. */
export const federationDeliveries = pgTable(
  "federation_deliveries",
  {
    id: id(),
    inbox: text().notNull(),
    status: federationDeliveryStatus().notNull().default("ok"),
    firstFailedAt: ts(),
    lastAttemptAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("federation_deliveries_inbox_uq").on(t.inbox)],
);

/** Stable ActivityPub object ids for broadcasts, VODs and clips; `deleted_at` once a `Delete` went out. */
export const federationObjects = pgTable(
  "federation_objects",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    kind: federationObjectKind().notNull(),
    subjectKind: federationSubjectKind().notNull(),
    subjectId: uuid().notNull(),
    publishedAt: ts().notNull().defaultNow(),
    deletedAt: ts(),
  },
  (t) => [
    uniqueIndex("federation_objects_subject_uq").on(t.kind, t.subjectKind, t.subjectId),
    index("federation_objects_channel_idx").on(t.channelId, t.publishedAt),
  ],
);

// Relay purges (decision (x)) --------------------------------------------------------------

/** Prefixes relays must evict and stop serving; long-polled by seq. Swept after 7 days. */
export const relayPurges = pgTable(
  "relay_purges",
  {
    seq: bigserial({ mode: "number" }).primaryKey(),
    prefix: text().notNull(),
    reason: relayPurgeReason().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("relay_purges_created_idx").on(t.createdAt),
    check("relay_purges_prefix", sql`length(${t.prefix}) between 1 and 256`),
  ],
);
