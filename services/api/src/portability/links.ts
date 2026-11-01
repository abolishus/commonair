// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Move links (ADR 0037 decision 2, batch 7 decision (k)): `/m/<slug>/<nonce>`, pinned by a creator
 * wherever their old audience is. The nonce is 128 random bits (base64url); only its SHA-256 is
 * stored, and the full link is shown once, at create. A lookup accepts only an unrevoked,
 * unexpired link of the named channel.
 *
 * Limits: `MOVE_LINK_RULES.maxActive` (10) active links per channel (the 0046 trigger, checked here
 * first for a clear answer) and `MOVE_LINK_RULES.perDay` (20) created per channel per rolling day
 * (counted from the table, revoked links included). Conversions count non-excluded follows only.
 */
import { MOVE_LINK_RULES } from "@commonair/contracts/enums";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import { sha256Hex } from "@commonair/tokens";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { badRequest, conflict, notFound, pgCode, rateLimited } from "../lib/errors.ts";

const { moveLinks, follows } = schema;
type LinkRow = typeof moveLinks.$inferSelect;
export type LinkState = "active" | "revoked" | "expired";

const DAY_MS = 86_400_000;

/** 128 random bits, base64url (22 characters). */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

export const nonceHash = (nonce: string): Promise<string> => sha256Hex(nonce);

/** A link's state at `now`: revoked wins over expired. */
export function linkState(link: Pick<LinkRow, "revokedAt" | "expiresAt">, now: Date): LinkState {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

/** The landing URL for a link (shown once). */
export const moveLinkUrl = (publicUrl: string, slug: string, nonce: string): string =>
  `${publicUrl.replace(/\/+$/, "")}/m/${encodeURIComponent(slug)}/${nonce}`;

export interface MoveLinkDto {
  id: string;
  createdAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  conversions: number;
}

const toDto = (r: LinkRow, conversions: number): MoveLinkDto => ({
  id: r.id,
  createdAt: iso(r.createdAt),
  revokedAt: isoOrNull(r.revokedAt),
  expiresAt: isoOrNull(r.expiresAt),
  conversions,
});

/** Non-excluded follows made through each link. */
export async function conversionsFor(db: Executor, linkIds: readonly string[]): Promise<Map<string, number>> {
  if (linkIds.length === 0) return new Map();
  const rows = await db
    .select({ id: follows.moveLinkId, n: sql<number>`count(*)::int` })
    .from(follows)
    .where(and(inArray(follows.moveLinkId, [...linkIds]), isNull(follows.excludedAt)))
    .groupBy(follows.moveLinkId);
  return new Map(rows.flatMap((r) => (r.id ? [[r.id, Number(r.n)] as const] : [])));
}

/** Newest first; at most 200 (10 active plus history). */
export async function listLinks(deps: Deps, channelId: string): Promise<MoveLinkDto[]> {
  const rows = await deps.db
    .select()
    .from(moveLinks)
    .where(eq(moveLinks.channelId, channelId))
    .orderBy(desc(moveLinks.createdAt), desc(moveLinks.id))
    .limit(200);
  const counts = await conversionsFor(
    deps.db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toDto(r, counts.get(r.id) ?? 0));
}

export async function createLink(
  deps: Deps,
  input: { channelId: string; slug: string; actorId: string; expiresAt: string | null },
): Promise<MoveLinkDto & { nonce: string; url: string }> {
  const now = deps.now();
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) throw badRequest("The expiry must be in the future");
  const nonce = newNonce();
  const hash = await nonceHash(nonce);
  try {
    const row = await deps.db.transaction(async (tx) => {
      // One channel's creates are serialized, so the day count and the active cap are exact.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`portability:move-links:${input.channelId}`}))`);
      const recent = await tx
        .select({ createdAt: moveLinks.createdAt })
        .from(moveLinks)
        .where(and(eq(moveLinks.channelId, input.channelId), gt(moveLinks.createdAt, new Date(now.getTime() - DAY_MS))))
        .orderBy(moveLinks.createdAt);
      if (recent.length >= MOVE_LINK_RULES.perDay) {
        const oldest = recent[0]?.createdAt ?? now;
        throw rateLimited(Math.max(1, Math.ceil((oldest.getTime() + DAY_MS - now.getTime()) / 1000)));
      }
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(moveLinks)
        .where(
          and(
            eq(moveLinks.channelId, input.channelId),
            isNull(moveLinks.revokedAt),
            or(isNull(moveLinks.expiresAt), gt(moveLinks.expiresAt, now)),
          ),
        );
      if (Number(n) >= MOVE_LINK_RULES.maxActive)
        throw conflict(`A channel has at most ${MOVE_LINK_RULES.maxActive} active move links`);
      const [inserted] = await tx
        .insert(moveLinks)
        .values({
          id: uuidv7(),
          channelId: input.channelId,
          nonceHash: hash,
          createdById: input.actorId,
          createdAt: now,
          expiresAt,
        })
        .returning();
      if (!inserted) throw new Error("move link insert returned no row");
      return inserted;
    });
    return { ...toDto(row, 0), nonce, url: moveLinkUrl(deps.site.publicUrl, input.slug, nonce) };
  } catch (err) {
    // The 0046 trigger's cap (a create racing another path): the same answer as the check above.
    if (pgCode(err) === "23514") throw conflict(`A channel has at most ${MOVE_LINK_RULES.maxActive} active move links`);
    throw err;
  }
}

export async function revokeLink(
  deps: Deps,
  input: { channelId: string; id: string; actorId: string },
): Promise<MoveLinkDto> {
  const row = await deps.db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(moveLinks)
      .where(and(eq(moveLinks.id, input.id), eq(moveLinks.channelId, input.channelId)))
      .for("update");
    if (!cur) throw notFound("Move link not found");
    if (cur.revokedAt) return cur;
    const [updated] = await tx
      .update(moveLinks)
      .set({ revokedAt: deps.now() })
      .where(eq(moveLinks.id, cur.id))
      .returning();
    await audit(tx, {
      actorType: "user",
      actorId: input.actorId,
      action: "portability.link.revoke",
      subjectType: "move_link",
      subjectId: cur.id,
      channelId: input.channelId,
    });
    return updated ?? cur;
  });
  const counts = await conversionsFor(deps.db, [row.id]);
  return toDto(row, counts.get(row.id) ?? 0);
}

/** The link row for a presented nonce on a channel, whatever its state; null when unknown. */
export async function findLink(db: Executor, channelId: string, nonce: string): Promise<LinkRow | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null;
  const [row] = await db
    .select()
    .from(moveLinks)
    .where(and(eq(moveLinks.channelId, channelId), eq(moveLinks.nonceHash, await nonceHash(nonce))));
  return row ?? null;
}
