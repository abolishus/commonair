// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overlay tokens (ADR 0021): 32 random bytes, base64url, shown once; only the SHA-256 is stored.
 * One unrevoked token per channel (`overlay_tokens_active_uq`). A token resolves only while it is
 * unrevoked and unexpired, and it authenticates nothing but the overlay state and alert stream.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { BUS } from "@commonair/contracts/events";
import { schema, type Database } from "@commonair/db";
import { sha256Hex } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { overlayTokenLive } from "./alerts.ts";

const { overlayTokens } = schema;

export function newOverlayToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export const overlayTokenHash = (token: string) => sha256Hex(token);

export interface ResolvedOverlayToken {
  id: string;
  channelId: string;
  expiresAt: Date | null;
}

/** The live token row for this hash, or null (unknown, revoked or expired). */
export async function resolveOverlayHash(db: Database, hash: string, now: Date): Promise<ResolvedOverlayToken | null> {
  const [row] = await db
    .select({
      id: overlayTokens.id,
      channelId: overlayTokens.channelId,
      expiresAt: overlayTokens.expiresAt,
      revokedAt: overlayTokens.revokedAt,
    })
    .from(overlayTokens)
    .where(and(eq(overlayTokens.tokenHash, hash), isNull(overlayTokens.revokedAt)))
    .limit(1);
  if (!row || !overlayTokenLive(row, now)) return null;
  return { id: row.id, channelId: row.channelId, expiresAt: row.expiresAt };
}

export async function resolveOverlayToken(db: Database, token: string, now: Date) {
  // Base64url of 32 bytes is 43 characters; anything far off is not ours and needs no lookup.
  if (token.length < 16 || token.length > 128) return null;
  return resolveOverlayHash(db, await overlayTokenHash(token), now);
}

/** The channel's current (unrevoked) token row, for `overlays.status`. */
export async function currentOverlayToken(db: Database, channelId: string) {
  const [row] = await db
    .select({
      createdAt: overlayTokens.createdAt,
      expiresAt: overlayTokens.expiresAt,
      revokedAt: overlayTokens.revokedAt,
    })
    .from(overlayTokens)
    .where(and(eq(overlayTokens.channelId, channelId), isNull(overlayTokens.revokedAt)))
    .orderBy(desc(overlayTokens.createdAt))
    .limit(1);
  return row ?? null;
}

/** Internal message on `BUS.overlay(channelId)`: open streams re-check their token at once. */
export const OVERLAY_REVOKE_MESSAGE = JSON.stringify({ op: "revoke" });

export async function publishOverlayRevoke(deps: Deps, channelId: string): Promise<void> {
  try {
    await deps.valkey.publish(BUS.overlay(channelId), OVERLAY_REVOKE_MESSAGE);
  } catch (err) {
    // Streams still re-check on their own timer (at most 30 s).
    deps.logger.warn("overlay revoke publish failed", { channelId, err: (err as Error).name });
  }
}
