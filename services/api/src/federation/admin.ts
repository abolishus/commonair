// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Instance domain blocks (ADR 0030 decision 7). Adding a block drops that domain's followers
 * (domain and subdomains) in the same transaction; the worker stops delivering to it and the inbox
 * refuses it. Every change writes an `audit_log` row with the domain and the acting admin's id.
 */
import { schema } from "@commonair/db";
import { asc, eq } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { iso } from "../lib/dto.ts";
import { notFound } from "../lib/errors.ts";
import { followersOnDomain, normalizeDomain } from "./blocks.ts";

const { federationDomainBlocks, federationFollowers, users } = schema;

type BlockRow = { domain: string; createdAt: Date; userId: string | null; username: string | null };

const toBlock = (r: BlockRow) => ({
  domain: r.domain,
  createdBy: r.userId && r.username ? { id: r.userId, username: r.username } : null,
  createdAt: iso(r.createdAt),
});

const blockColumns = {
  domain: federationDomainBlocks.domain,
  createdAt: federationDomainBlocks.createdAt,
  userId: users.id,
  username: users.username,
};

export async function listBlocks(deps: Pick<Deps, "db">) {
  const rows = await deps.db
    .select(blockColumns)
    .from(federationDomainBlocks)
    .leftJoin(users, eq(users.id, federationDomainBlocks.createdById))
    .orderBy(asc(federationDomainBlocks.domain));
  return rows.map(toBlock);
}

export async function addBlock(deps: Pick<Deps, "db">, adminId: string, rawDomain: string) {
  const domain = normalizeDomain(rawDomain);
  await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(federationDomainBlocks)
      .values({ domain, createdById: adminId })
      .onConflictDoNothing()
      .returning({ domain: federationDomainBlocks.domain });
    // Already blocked: nothing changed, so nothing to audit.
    if (inserted.length === 0) return;
    const dropped = await tx
      .delete(federationFollowers)
      .where(followersOnDomain(domain))
      .returning({ id: federationFollowers.id });
    await audit(tx, {
      actorType: "admin",
      actorId: adminId,
      action: "federation.domain.block",
      subjectType: "federation_domain",
      subjectId: domain,
      details: { followersDropped: dropped.length },
    });
  });
  const [row] = await deps.db
    .select(blockColumns)
    .from(federationDomainBlocks)
    .leftJoin(users, eq(users.id, federationDomainBlocks.createdById))
    .where(eq(federationDomainBlocks.domain, domain));
  if (!row) throw notFound("Block not found");
  return toBlock(row);
}

export async function removeBlock(deps: Pick<Deps, "db">, adminId: string, rawDomain: string) {
  const domain = normalizeDomain(rawDomain);
  await deps.db.transaction(async (tx) => {
    const gone = await tx
      .delete(federationDomainBlocks)
      .where(eq(federationDomainBlocks.domain, domain))
      .returning({ domain: federationDomainBlocks.domain });
    if (gone.length === 0) throw notFound("That domain is not blocked");
    await audit(tx, {
      actorType: "admin",
      actorId: adminId,
      action: "federation.domain.unblock",
      subjectType: "federation_domain",
      subjectId: domain,
    });
  });
  return { ok: true as const };
}
