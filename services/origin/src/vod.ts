// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * VODs that are not public (ADR 0009 amendment 1, decision 2): `GET|HEAD /vod/<vodId>/<file>?t=…`.
 * The token is a `PlaybackClaims` the API minted for a caller `vodShown` admits, with
 * `path = vodTokenPath(vodId)` and `src = "origin"` (a live token, or a VOD token for another VOD,
 * is refused; the live `/hls` route refuses a VOD token the same way, by path). Then the VOD's
 * state: ready, not removed, broadcast not restricted, channel not suspended, cached per VOD for
 * 5 s, so a removal revokes every token within 5 s. The object is read from the row's
 * `storage_prefix`, or from the VOD's other own prefix while a placement move is in flight. The
 * playlist is rewritten so every URI carries the token. `cache-control: private`; no integrity
 * samples, segment log or receipts.
 *
 * Also here: the state lookup and its cache, shared with `/media/vods/…` (`media.ts`).
 */
import { eq, sql } from "drizzle-orm";
import {
  isVodOwnPrefix,
  VOD_PLAYLIST,
  VOD_ROUTE,
  vodPrefix,
  vodTokenPath,
  type VodPlacementState,
} from "@commonair/contracts/storage";
import { schema, type Executor } from "@commonair/db";
import { verifyPlaybackToken } from "@commonair/tokens";
import { Coalescer, TtlCache } from "./cache.ts";
import {
  CORS,
  mediaFail,
  objectHeaders,
  readObject,
  safeSegments,
  UUID,
  type MediaDeps,
  type MediaFetch,
} from "./media.ts";
import { rewritePlaylist } from "./playlist.ts";

/** Per-instance cache window of a VOD's state ("immediately" = 5 s, accepted with the amendment). */
export const VOD_STATE_TTL_MS = 5_000;

export interface VodState {
  channelId: string;
  storagePrefix: string;
  state: VodPlacementState;
}

/** One VOD's state, or null when there is no such VOD. Throws on a database error. */
export type VodStateLookup = (vodId: string) => Promise<VodState | null>;

/** The lookup against Postgres: one query joining the VOD, its broadcast, its channel and the NCII and DMCA items covering it. */
export function dbVodStateLookup(db: Executor): VodStateLookup {
  const { vods, broadcasts, channels } = schema;
  return async (vodId) => {
    const [row] = await db
      .select({
        channelId: vods.channelId,
        storagePrefix: vods.storagePrefix,
        status: vods.status,
        visibility: vods.visibility,
        removedReason: vods.removedReason,
        broadcastRestricted: sql<boolean>`${broadcasts.restrictedAt} is not null`,
        channelSuspended: sql<boolean>`${channels.suspendedAt} is not null`,
        nciiHidden: sql<boolean>`exists (select 1 from ${schema.nciiRequestItems} i where i.subject_type = 'vod' and i.subject_id = ${vods.id} and (i.hidden_at is not null or i.removed_at is not null))`,
        dmcaHidden: sql<boolean>`exists (select 1 from ${schema.dmcaNoticeItems} d where ((d.subject_type = 'vod' and d.subject_id = ${vods.id}) or (d.subject_type = 'broadcast' and d.subject_id = ${vods.broadcastId})) and d.removed_at is not null and d.restored_at is null)`,
      })
      .from(vods)
      .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
      .innerJoin(channels, eq(channels.id, vods.channelId))
      .where(eq(vods.id, vodId));
    if (!row) return null;
    const { channelId, storagePrefix, ...state } = row;
    return { channelId, storagePrefix, state };
  };
}

/** VOD states cached per id for `ttlMs` (absent VODs too); a failed lookup is not cached. */
export class VodStateCache {
  private readonly cache: TtlCache<VodState | null>;
  private readonly lookups = new Coalescer<VodState | null>();
  private readonly ttlMs: number;

  constructor(
    private readonly lookup: VodStateLookup,
    opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? VOD_STATE_TTL_MS;
    this.cache = new TtlCache(opts.maxEntries ?? 50_000, opts.now ?? Date.now);
  }

  async get(vodId: string): Promise<VodState | null> {
    const cached = this.cache.get(vodId);
    if (cached !== undefined) return cached;
    return this.lookups.run(vodId, async () => {
      const value = await this.lookup(vodId);
      this.cache.set(vodId, value, this.ttlMs);
      return value;
    }).promise;
  }
}

/** What `/vod/` serves: a ready VOD nothing removed, restricted or suspended (any visibility). */
export function vodRouteServable(s: VodPlacementState): boolean {
  return (
    s.status === "ready" &&
    s.removedReason === null &&
    !s.broadcastRestricted &&
    !s.channelSuspended &&
    !s.nciiHidden &&
    !s.dmcaHidden
  );
}

/** `/vod/<vodId>/<file>` → its parts, or null for anything else (same refusals as `/media/`). */
export function parseVodPath(rawPath: string): { vodId: string; file: string } | null {
  if (!rawPath.startsWith(VOD_ROUTE)) return null;
  const segments = safeSegments(rawPath.slice(VOD_ROUTE.length));
  if (!segments || segments.length !== 2) return null;
  const [vodId, file] = segments as [string, string];
  if (!UUID.test(vodId) || file.length > 255) return null;
  return { vodId, file };
}

export interface VodDeps extends Omit<MediaDeps, "vodStates"> {
  publicKey: CryptoKey;
  states: VodStateCache;
  /** Milliseconds, like the rest of the origin. */
  now?: () => number;
}

export function createVodHandler(deps: VodDeps): MediaFetch {
  const now = deps.now ?? Date.now;
  return async (req, rawPath) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "GET" && req.method !== "HEAD")
      return mediaFail(405, "method_not_allowed", { allow: "GET, HEAD, OPTIONS" });
    const path = parseVodPath(rawPath);
    if (!path) return mediaFail(404, "not_found");

    // The token first: a wrong or expired one learns nothing about the VOD (no body detail).
    const token = new URL(req.url).searchParams.get("t");
    if (!token || token.length > 4096) return mediaFail(401, "unauthorized");
    const v = await verifyPlaybackToken(deps.publicKey, token, Math.floor(now() / 1000));
    if (!v.ok || v.value.path !== vodTokenPath(path.vodId) || v.value.src !== "origin")
      return mediaFail(401, "unauthorized");

    let vod: VodState | null;
    try {
      vod = await deps.states.get(path.vodId);
    } catch {
      deps.logger?.warn("VOD state check failed");
      return mediaFail(404, "not_found");
    }
    if (!vod || !vodRouteServable(vod.state) || !isVodOwnPrefix(path.vodId, vod.storagePrefix))
      return mediaFail(404, "not_found");
    if (v.value.cid !== vod.channelId) return mediaFail(401, "unauthorized");

    const isPlaylist = path.file === VOD_PLAYLIST;
    // The row's prefix, then the other own one: a VOD mid-move keeps playing.
    const other =
      vod.storagePrefix === vodPrefix(path.vodId, "public")
        ? vodPrefix(path.vodId, "private")
        : vodPrefix(path.vodId, "public");
    let res: Response | null = null;
    for (const prefix of [vod.storagePrefix, other]) {
      const read = await readObject(deps, req, prefix + path.file, { range: !isPlaylist });
      if ("failed" in read) return read.failed;
      if ("found" in read) {
        res = read.found;
        break;
      }
    }
    if (!res) return mediaFail(404, "not_found");

    if (isPlaylist) {
      const text = await res.text();
      const dir = `vod/${path.vodId}`;
      const body = rewritePlaylist(text, { dir, root: dir, target: { kind: "relative", token } });
      const headers = objectHeaders(res, "private, no-store");
      headers.delete("content-range");
      headers.delete("etag");
      headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
      return new Response(req.method === "HEAD" ? null : body, { status: 200, headers });
    }
    const headers = objectHeaders(res, "private, max-age=300");
    if (req.method === "HEAD") {
      await res.body?.cancel();
      return new Response(null, { status: res.status, headers });
    }
    return new Response(res.body, { status: res.status, headers });
  };
}
