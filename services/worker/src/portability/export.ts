// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Portability in the data export (ADR 0037): the member's "tell me if they move" grants and their
 * imports, and their channel's move links. Registered in `EXPORT_FILES` by the batch 7 contract
 * step. Explicit column allow-lists: never a nonce hash, an archive key, an import's raw choices or
 * anything about other people (conversions are counts).
 */
import { schema as s } from "@commonair/db";
import { asc, eq, sql } from "drizzle-orm";
import type { ExportFile } from "../exports/collectors.ts";

const grantFields = { channelSlug: s.channels.slug, createdAt: s.followPortabilityGrants.createdAt };

const importFields = {
  id: s.portabilityImports.id,
  channelSlug: s.channels.slug,
  source: s.portabilityImports.source,
  status: s.portabilityImports.status,
  standingVerified: s.portabilityImports.standingVerified,
  standingIssuer: s.portabilityImports.standingIssuer,
  assertedAt: s.portabilityImports.assertedAt,
  assertionVersion: s.portabilityImports.assertionVersion,
  createdAt: s.portabilityImports.createdAt,
  finishedAt: s.portabilityImports.finishedAt,
};

const moveLinkFields = {
  id: s.moveLinks.id,
  createdAt: s.moveLinks.createdAt,
  revokedAt: s.moveLinks.revokedAt,
  expiresAt: s.moveLinks.expiresAt,
  conversions: sql<number>`(select count(*)::int from ${s.follows} where ${s.follows.moveLinkId} = ${s.moveLinks.id} and ${s.follows.excludedAt} is null)`,
};

export const PORTABILITY_EXPORT_FILES: readonly ExportFile[] = [
  {
    name: "portability.json",
    kind: "account",
    sections: {
      grants: {
        fields: grantFields,
        query: (tx, { userId }) =>
          tx
            .select(grantFields)
            .from(s.followPortabilityGrants)
            .innerJoin(s.channels, eq(s.channels.id, s.followPortabilityGrants.channelId))
            .where(eq(s.followPortabilityGrants.userId, userId))
            .orderBy(asc(s.followPortabilityGrants.createdAt)),
      },
      imports: {
        fields: importFields,
        query: (tx, { userId }) =>
          tx
            .select(importFields)
            .from(s.portabilityImports)
            .innerJoin(s.channels, eq(s.channels.id, s.portabilityImports.channelId))
            .where(eq(s.portabilityImports.userId, userId))
            .orderBy(asc(s.portabilityImports.createdAt)),
      },
      moveLinks: {
        fields: moveLinkFields,
        query: (tx, { userId }) =>
          tx
            .select(moveLinkFields)
            .from(s.moveLinks)
            .innerJoin(s.channels, eq(s.channels.id, s.moveLinks.channelId))
            .where(eq(s.channels.ownerId, userId))
            .orderBy(asc(s.moveLinks.createdAt)),
      },
    },
  },
];
