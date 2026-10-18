// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";

const { legalDocuments, legalAcceptances } = schema;

export interface CurrentDocument {
  id: string;
  kind: (typeof legalDocuments.$inferSelect)["kind"];
  version: string;
}

/** The newest published version of each document kind that requires acceptance. */
export async function currentRequiredDocuments(db: Executor, now: Date): Promise<CurrentDocument[]> {
  const rows = await db
    .select({
      id: legalDocuments.id,
      kind: legalDocuments.kind,
      version: legalDocuments.version,
      requiresAcceptance: legalDocuments.requiresAcceptance,
    })
    .from(legalDocuments)
    .where(lte(legalDocuments.publishedAt, now))
    .orderBy(desc(legalDocuments.publishedAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.kind)) latest.set(r.kind, r);
  return [...latest.values()].filter((r) => r.requiresAcceptance).map(({ id, kind, version }) => ({ id, kind, version }));
}

export async function pendingDocuments(db: Executor, userId: string, now: Date): Promise<CurrentDocument[]> {
  const current = await currentRequiredDocuments(db, now);
  if (current.length === 0) return [];
  const accepted = await db
    .select({ documentId: legalAcceptances.documentId })
    .from(legalAcceptances)
    .where(
      and(
        eq(legalAcceptances.userId, userId),
        inArray(
          legalAcceptances.documentId,
          current.map((c) => c.id),
        ),
      ),
    );
  const done = new Set(accepted.map((a) => a.documentId));
  return current.filter((c) => !done.has(c.id));
}

/** Record acceptance of the given documents (ignores ids that are not current required documents). */
export async function recordAcceptances(
  db: Executor,
  userId: string,
  documentIds: readonly string[],
  now: Date,
): Promise<{ accepted: string[]; missing: CurrentDocument[] }> {
  const current = await currentRequiredDocuments(db, now);
  const wanted = new Set(documentIds);
  const accepted = current.filter((c) => wanted.has(c.id)).map((c) => c.id);
  if (accepted.length > 0)
    await db
      .insert(legalAcceptances)
      .values(accepted.map((documentId) => ({ userId, documentId, acceptedAt: now })))
      .onConflictDoNothing();
  return { accepted, missing: current.filter((c) => !wanted.has(c.id)) };
}
