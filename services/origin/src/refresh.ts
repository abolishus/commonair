// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Playlist token refresh. Rewritten playlists echo the viewer's token into every
 * URI. hls.js players swap in the token the API returns with each heartbeat, but
 * native HLS players (Safari, iOS) never change URIs: they keep following what the
 * playlists say. So when the presented token has less than a minute left, the origin
 * embeds a freshly signed token (same claims, new iat/exp) instead.
 *
 * A data-mode token (ADR 0018) is re-signed with its `dm`; reuse is keyed on (`sid`, `dm`), so a
 * token minted after the viewer changed their budget is never answered with an older one.
 *
 * Refresh is granted only while the playback session exists and has not ended
 * (`playback_sessions.ended_at` is null), so an ended or unknown session cannot keep
 * itself alive through the origin; that check is cached per session for 15 s.
 */
import { PLAYBACK_TOKEN_TTL_SECONDS, type PlaybackClaims } from "@commonair/contracts/tokens";
import { eq } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { schema } from "@commonair/db";
import { signPlaybackToken, type SigningKey } from "@commonair/tokens";
import { Coalescer, TtlCache } from "./cache.ts";

export const REFRESH_THRESHOLD_SECONDS = 60;

export interface TokenRefresherOptions {
  key: SigningKey;
  db: Executor;
  thresholdSeconds?: number;
  ttlSeconds?: number;
  sessionCacheMs?: number;
  /** Seconds. */
  now?: () => number;
}

export class TokenRefresher {
  private readonly active = new TtlCache<boolean>(100_000);
  private readonly lookups = new Coalescer<boolean>();
  private readonly issued = new TtlCache<{ token: string; exp: number }>(100_000);
  private readonly now: () => number;
  private readonly threshold: number;

  constructor(private readonly opts: TokenRefresherOptions) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.threshold = opts.thresholdSeconds ?? REFRESH_THRESHOLD_SECONDS;
  }

  /** The token to embed in playlist URIs for this request. */
  async tokenFor(claims: PlaybackClaims, presented: string): Promise<string> {
    const now = this.now();
    if (claims.exp - now >= this.threshold) return presented;
    const cacheKey = `${claims.sid}|${claims.dm ?? ""}`;
    const reuse = this.issued.get(cacheKey);
    if (reuse && reuse.exp - now >= this.threshold) return reuse.token;
    if (!(await this.sessionActive(claims.sid))) return presented;
    const exp = now + (this.opts.ttlSeconds ?? PLAYBACK_TOKEN_TTL_SECONDS);
    const token = await signPlaybackToken(this.opts.key, { ...claims, iat: now, exp });
    this.issued.set(cacheKey, { token, exp }, (exp - now) * 1000);
    return token;
  }

  private async sessionActive(sid: string): Promise<boolean> {
    const cached = this.active.get(sid);
    if (cached !== undefined) return cached;
    return this.lookups.run(sid, async () => {
      const ps = schema.playbackSessions;
      const [row] = await this.opts.db.select({ endedAt: ps.endedAt }).from(ps).where(eq(ps.id, sid)).limit(1);
      const ok = row !== undefined && row.endedAt === null;
      this.active.set(sid, ok, this.opts.sessionCacheMs ?? 15_000);
      return ok;
    }).promise;
  }
}
