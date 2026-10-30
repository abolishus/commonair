// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which users get a verified-watch key, and with what value (ADR 0015 decisions 1, 3, 4, 5). Pure:
 * the writer feeds it one row per (user, address) of gate-eligible watching on a live broadcast.
 */
import { createHmac } from "node:crypto";
import { VERIFIED_WATCH_JITTER, type VerifiedWatchValue } from "@commonair/contracts/internal";

/** `privacy_relay:<label>` in `playback_sessions.datacenter` (packages/integrity/README.md). */
export const PRIVACY_RELAY_PREFIX = "privacy_relay:";

/**
 * Decision 4: `HMAC-SHA256(secret, "vw-jitter-v1:" + broadcastId + ":" + userId) mod 31`, the digest
 * read as one big-endian integer. Fixed per user and broadcast, so the unlock never flaps.
 */
export function verifiedWatchJitter(secret: string, broadcastId: string, userId: string): number {
  const digest = createHmac("sha256", secret)
    .update(`${VERIFIED_WATCH_JITTER.prefix}${broadcastId}:${userId}`)
    .digest("hex");
  return Number(BigInt(`0x${digest}`) % BigInt(VERIFIED_WATCH_JITTER.modulo));
}

/** Gate-eligible watching of one user on one live broadcast from one address. */
export interface WatchRow {
  channelId: string;
  broadcastId: string;
  userId: string;
  /** `playback_sessions.ip_hash` (HMAC of the full address). */
  ipHash: string;
  /** The sessions on this address were on a privacy relay. */
  privacyRelay: boolean;
  seconds: number;
  /** Start of the user's first gate-eligible session on this broadcast from this address. */
  firstAt: Date;
}

export interface Unlock {
  channelId: string;
  userId: string;
  value: VerifiedWatchValue;
}

/**
 * The per-address cap (decision 3) and the fallback (decision 5). On each exact address, users are
 * ranked by their first session there and the first `perAddress` count; privacy-relay addresses are
 * not capped and mark the user `f: 1`. A user counted on any ordinary address gets `f: 0`. Seconds
 * are summed over all the user's gate-eligible sessions on the broadcast, minus the jitter. Rows
 * must already exclude the exempt roles (they neither need a key nor take a place in the cap).
 */
export function unlocks(rows: readonly WatchRow[], perAddress: number, secret: string): Unlock[] {
  const users = new Map<string, { row: WatchRow; seconds: number; counted: boolean; relay: boolean }>();
  const userKey = (r: WatchRow) => `${r.channelId}:${r.broadcastId}:${r.userId}`;
  for (const r of rows) {
    const u = users.get(userKey(r)) ?? { row: r, seconds: 0, counted: false, relay: false };
    u.seconds += Math.max(0, r.seconds);
    if (r.privacyRelay) u.relay = true;
    users.set(userKey(r), u);
  }

  const byAddress = new Map<string, WatchRow[]>();
  for (const r of rows) {
    if (r.privacyRelay) continue;
    const k = `${r.channelId}:${r.broadcastId}:${r.ipHash}`;
    const list = byAddress.get(k) ?? [];
    list.push(r);
    byAddress.set(k, list);
  }
  for (const list of byAddress.values()) {
    // First come, first counted; the user id breaks exact ties so every pass ranks the same way.
    const ranked = [...list].sort(
      (a, b) => a.firstAt.getTime() - b.firstAt.getTime() || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
    for (const r of ranked.slice(0, Math.max(0, perAddress))) {
      const u = users.get(userKey(r));
      if (u) u.counted = true;
    }
  }

  const out: Unlock[] = [];
  for (const u of users.values()) {
    if (!u.counted && !u.relay) continue;
    const j = verifiedWatchJitter(secret, u.row.broadcastId, u.row.userId);
    out.push({
      channelId: u.row.channelId,
      userId: u.row.userId,
      value: { b: u.row.broadcastId, s: Math.max(0, Math.floor(u.seconds) - j), f: u.counted ? 0 : 1 },
    });
  }
  return out;
}
