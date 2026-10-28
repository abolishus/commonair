// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Segments from peers are checked against the origin's digest (ADR 0005 amendment 1,
 * decision 7). The loader calls `validate` (its `validateP2PSegment`) for every peer-delivered
 * segment; `false` makes it drop the bytes, disconnect that peer (`p2p-media-loader-core`
 * `p2p/peer.ts`, `#destroyOnPeerError("validation-failed")`) and load the segment again.
 * Everything that is not a clean match fails closed. Nothing here logs URLs, tokens or digests.
 */

/** Media paths as `/hls/` serves them: `live/<slug>[/<rendition>]/<file>` after any route prefix. */
const MEDIA_TAIL = /\/live\/[a-z0-9_]{3,25}(?:\/[a-z0-9]+)?\/[A-Za-z0-9_-]{1,128}\.[a-z0-9]{2,4}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The object's path after the source's route prefix (`/live/...`), or null. */
export function mediaTail(segmentUrl: string): string | null {
  let path: string;
  try {
    path = new URL(segmentUrl).pathname;
  } catch {
    return null;
  }
  return MEDIA_TAIL.exec(path)?.[0] ?? null;
}

/**
 * `<digestUrl>/live/<slug>[/<rendition>]/<file>?t=<token>` for a segment served by the origin,
 * a relay or the CDN (the path after `/live/` is the same everywhere); null when the URL is not a
 * media path.
 */
export function digestUrlFor(digestBase: string, segmentUrl: string, token: string): string | null {
  const tail = mediaTail(segmentUrl);
  if (!tail) return null;
  return `${digestBase.replace(/\/+$/, "")}${tail}?t=${encodeURIComponent(token)}`;
}

/** Lowercase hex SHA-256 of `data`. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DigestValidatorOptions {
  /** `PlaybackStart.p2p.digestUrl`. */
  digestBase: string;
  /** The current playback token (heartbeats refresh it). */
  token: () => string | undefined;
  /** A segment failed validation (a mismatch, or anything that is not a clean answer). */
  onRejected: () => void;
  /** Bytes received for digest requests; they count as HTTP bytes. */
  onHttpBytes: (bytes: number) => void;
  fetch?: FetchLike;
  /** Digests kept per session (objects never change); oldest dropped first. */
  maxEntries?: number;
}

/** One validator per playback session: digests are cached per object for the session. */
export class DigestValidator {
  private readonly digests = new Map<string, Promise<string | null>>();
  private readonly fetchImpl: FetchLike;
  private readonly maxEntries: number;

  constructor(private readonly opts: DigestValidatorOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.maxEntries = opts.maxEntries ?? 64;
  }

  /** The loader's `validateP2PSegment(url, byteRange, data)`. */
  validate = async (url: string, byteRange: unknown, data: ArrayBuffer): Promise<boolean> => {
    let ok = false;
    try {
      // The origin publishes digests of whole segments only.
      if (byteRange === undefined || byteRange === null) {
        const [expected, actual] = await Promise.all([this.expected(url), sha256Hex(data)]);
        ok = expected !== null && expected === actual;
      }
    } catch {
      ok = false;
    }
    if (!ok) this.opts.onRejected();
    return ok;
  };

  private expected(url: string): Promise<string | null> {
    const tail = mediaTail(url);
    if (!tail) return Promise.resolve(null);
    const hit = this.digests.get(tail);
    if (hit) return hit;
    const pending = this.fetchDigest(url).then((hex) => {
      // Only a good answer is kept; a failure may be retried with the next delivery.
      if (hex === null) this.digests.delete(tail);
      return hex;
    });
    this.digests.set(tail, pending);
    while (this.digests.size > this.maxEntries) {
      const oldest = this.digests.keys().next().value;
      if (oldest === undefined) break;
      this.digests.delete(oldest);
    }
    return pending;
  }

  private async fetchDigest(url: string): Promise<string | null> {
    const token = this.opts.token();
    if (!token) return null;
    const target = digestUrlFor(this.opts.digestBase, url, token);
    if (!target) return null;
    try {
      const res = await this.fetchImpl(target, { credentials: "omit", cache: "default" });
      const body = await res.text();
      this.opts.onHttpBytes(new TextEncoder().encode(body).byteLength);
      if (res.status !== 200) return null;
      const hex = body.trim();
      return HEX64.test(hex) ? hex : null;
    } catch {
      return null;
    }
  }
}
