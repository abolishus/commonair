// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Open captions (ADR 0011, W2-captions) and rehearsal invitees (W2-rehearsal, decisions (f), (g)).
 * Cue text lives in the WebVTT objects under the VOD's prefix and, while live, in Valkey; never
 * here. A broadcast whose channel keeps no VOD drops its transcript at the end (ADR 0011 decision 6).
 */
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import { broadcasts, vods } from "./media.ts";
import { captionTrackStatus, createdAt, id, ts, updatedAt } from "./_shared.ts";

export const broadcastCaptionTracks = pgTable(
  "broadcast_caption_tracks",
  {
    id: id(),
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    /** The VOD the stitched track belongs to; null while live or when no VOD is kept. */
    vodId: uuid().references(() => vods.id, { onDelete: "set null" }),
    /** BCP 47 tag of the spoken language. */
    language: text().notNull(),
    status: captionTrackStatus().notNull().default("queued"),
    /** Object key of the stitched `.vtt` (`vodCaptionsKey`), once `ready`. */
    storageKey: text(),
    cueCount: integer().notNull().default(0),
    startedAt: ts(),
    endedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("broadcast_caption_tracks_language_uq").on(t.broadcastId, t.language),
    index("broadcast_caption_tracks_vod_idx").on(t.vodId),
    check("broadcast_caption_tracks_language", sql`${t.language} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$'`),
  ],
);

/**
 * Who corrected a VOD track, and how many cues (text only: timing is fixed in v1). Ids and counts
 * only; account deletion detaches the editor (`services/worker/src/deletion`).
 */
export const captionEdits = pgTable(
  "caption_edits",
  {
    id: id(),
    trackId: uuid()
      .notNull()
      .references(() => broadcastCaptionTracks.id, { onDelete: "cascade" }),
    editorUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    cuesChanged: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("caption_edits_track_idx").on(t.trackId, t.createdAt),
    index("caption_edits_editor_idx").on(t.editorUserId),
    check("caption_edits_cues_changed", sql`${t.cuesChanged} > 0`),
  ],
);

/**
 * Up to `REHEARSAL_RULES.maxInvitees` per arm (0043 trigger); the list carries over into the
 * rehearsal broadcast the arm starts (`broadcast_id` set then).
 */
export const rehearsalInvitees = pgTable(
  "rehearsal_invitees",
  {
    /** `RehearsalArm.armId`. */
    armId: uuid().notNull(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    broadcastId: uuid().references(() => broadcasts.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.armId, t.userId] }),
    index("rehearsal_invitees_broadcast_idx").on(t.broadcastId),
    index("rehearsal_invitees_user_idx").on(t.userId),
  ],
);
