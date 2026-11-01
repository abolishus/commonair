// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-media: broadcasts, VODs, clips, playback, simulcast, relays and `seed live`. Brief: `.claude/briefs/seed-full/seed-media.md`. */
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "broadcasts",
  "stream_hours",
  "broadcast_health_samples",
  "egress_samples",
  "vods",
  "clips",
  "playback_sessions",
  "simulcast_targets",
  "simulcast_sessions",
  "relay_nodes",
  "relay_issuance",
  "relay_receipts",
  // W2: captions, rehearsal invitees and the audience rollup.
  "broadcast_caption_tracks",
  "caption_edits",
  "rehearsal_invitees",
  "broadcast_audience_minutes",
  "broadcast_audience_totals",
  "broadcast_costs",
  "analytics_share_links",
  // Batch 7: relay purge rows.
  "relay_purges",
  // Batch 7: watch rooms open on a live broadcast, so they come from seed-media's recordings.
  "watch_rooms",
  "watch_room_members",
  "watch_room_messages",
] as const;

export const unit: SeedUnit = {
  name: "media",
  after: ["social"],
  tables: TABLES,
  pending: TABLES,
  async run() {
    return { rows: {}, notes: ["seed-media: not implemented yet"] };
  },
};
