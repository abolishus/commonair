// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Giveaways in the account export (batch 8 contract step §3.6): the member's own entries and wins.
 *
 * - `entries`: each giveaway the member entered, with its title, channel, when they entered and
 *   their own pseudonym (the one the public draw list shows for them).
 * - `wins`: each giveaway they won, with their rank and when it was drawn.
 *
 * Never another member's pseudonym or id, and never the salt (it would map pseudonyms back to
 * accounts) or the seed. A deleted giveaway takes its entries and wins with it (`on delete
 * cascade`), so it is not exported. An entry stays the member's own after they are banned.
 */
import { schema as s } from "@commonair/db";
import { asc, eq } from "drizzle-orm";
import type { ExportFile } from "./collectors.ts";

const entryFields = {
  giveawayId: s.giveawayEntries.giveawayId,
  giveawayTitle: s.giveaways.title,
  channelSlug: s.channels.slug,
  enteredAt: s.giveawayEntries.createdAt,
  pseudonym: s.giveawayEntries.pseudonym,
};

const winFields = {
  giveawayId: s.giveawayWinners.giveawayId,
  giveawayTitle: s.giveaways.title,
  channelSlug: s.channels.slug,
  rank: s.giveawayWinners.rank,
  drawnAt: s.giveaways.drawnAt,
};

export const GIVEAWAY_EXPORT_FILES: readonly ExportFile[] = [
  {
    name: "interact-giveaways.json",
    kind: "account",
    sections: {
      entries: {
        fields: entryFields,
        query: (tx, { userId }) =>
          tx
            .select(entryFields)
            .from(s.giveawayEntries)
            .innerJoin(s.giveaways, eq(s.giveaways.id, s.giveawayEntries.giveawayId))
            .innerJoin(s.channels, eq(s.channels.id, s.giveaways.channelId))
            .where(eq(s.giveawayEntries.userId, userId))
            .orderBy(asc(s.giveawayEntries.createdAt), asc(s.giveawayEntries.giveawayId)),
      },
      wins: {
        fields: winFields,
        query: (tx, { userId }) =>
          tx
            .select(winFields)
            .from(s.giveawayWinners)
            .innerJoin(s.giveaways, eq(s.giveaways.id, s.giveawayWinners.giveawayId))
            .innerJoin(s.channels, eq(s.channels.id, s.giveaways.channelId))
            .where(eq(s.giveawayWinners.userId, userId))
            .orderBy(asc(s.giveawayWinners.createdAt), asc(s.giveawayWinners.giveawayId)),
      },
    },
  },
];
