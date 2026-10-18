// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The three ways to be allowed to pull video from the origin:
 *
 * - viewers: an Ed25519 playback token (`?t=`) signed by the API, bound to the
 *   channel path and a delivery source of `origin` or `cdn`;
 * - relays: `Authorization: Bearer <relay token>`, looked up by SHA-256 in
 *   `relay_nodes` (status active or degraded), cached 30 s;
 * - a CDN doing origin-pull: `x-cdn-auth: <hex HMAC-SHA256(INTERNAL_API_SECRET, "cdn-origin-pull-v1")>`.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DELIVERY_SOURCES } from "@commonair/contracts/enums";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import type { Executor } from "@commonair/db";
import { schema } from "@commonair/db";
import { hmacHex, sha256Hex, timingSafeEqual, verifyPlaybackToken } from "@commonair/tokens";
import { Coalescer, TtlCache } from "./cache.ts";
import type { MediaRequest } from "./paths.ts";

type DeliverySource = (typeof DELIVERY_SOURCES)[number];

/** Sources whose viewers fetch playlists from the origin itself. Relay viewers fetch from their relay. */
export const ORIGIN_SERVED_SOURCES: readonly DeliverySource[] = ["origin", "cdn"];

export type ViewerAuthResult =
  | { ok: true; claims: PlaybackClaims; token: string }
  | {
      ok: false;
      reason: "missing" | "malformed" | "bad_signature" | "expired" | "not_yet_valid" | "wrong_path" | "wrong_source";
    };

export async function authorizeViewer(
  publicKey: CryptoKey,
  token: string | null,
  req: MediaRequest,
  nowSeconds?: number,
): Promise<ViewerAuthResult> {
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > 4096) return { ok: false, reason: "malformed" };
  const v = await verifyPlaybackToken(publicKey, token, nowSeconds);
  if (!v.ok) return { ok: false, reason: v.error };
  if (v.value.path !== req.channelPath) return { ok: false, reason: "wrong_path" };
  if (!ORIGIN_SERVED_SOURCES.includes(v.value.src)) return { ok: false, reason: "wrong_source" };
  return { ok: true, claims: v.value, token };
}

/** Relay tokens are `randomSecret("relay_")`: the prefix plus 32 random bytes in base64url (43 chars). */
export const RELAY_BEARER = /^Bearer (relay_[A-Za-z0-9_-]{43})$/;

export interface RelayAuthOptions {
  db: Executor;
  ttlMs?: number;
}

export interface AuthorizedRelay {
  id: string;
}

export class RelayAuth {
  private readonly cache = new TtlCache<AuthorizedRelay | null>(50_000);
  private readonly lookups = new Coalescer<AuthorizedRelay | null>();

  constructor(private readonly opts: RelayAuthOptions) {}

  /** Resolve an `Authorization` header to an active relay, or null. */
  async authenticate(header: string | null): Promise<AuthorizedRelay | null> {
    // Shape check first: anything that is not a relay token never reaches Postgres.
    const m = header ? RELAY_BEARER.exec(header) : null;
    if (!m?.[1]) return null;
    // Cache by hash so plaintext relay tokens never sit in memory longer than the request.
    const hash = await sha256Hex(m[1]);
    const cached = this.cache.get(hash);
    if (cached !== undefined) return cached;
    return this.lookups.run(hash, async () => {
      const r = schema.relayNodes;
      const [row] = await this.opts.db
        .select({ id: r.id })
        .from(r)
        .where(and(eq(r.tokenHash, hash), inArray(r.status, ["active", "degraded"])))
        .limit(1);
      const value = row ? { id: row.id } : null;
      this.cache.set(hash, value, this.opts.ttlMs ?? 30_000);
      return value;
    }).promise;
  }
}

export const CDN_AUTH_HEADER = "x-cdn-auth";
const CDN_AUTH_CONTEXT = "cdn-origin-pull-v1";

/** The shared header value an operator configures on their CDN's origin-pull settings. */
export const cdnAuthValue = (internalSecret: string) => hmacHex(internalSecret, CDN_AUTH_CONTEXT);

export function checkCdnAuth(expected: string, header: string | null): boolean {
  return header !== null && timingSafeEqual(expected, header.trim().toLowerCase());
}
