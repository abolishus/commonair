// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `GET /media/<key>`: public media objects (avatars, thumbnails, clips, VODs) read from the media
 * bucket with the service key (ADR 0009). Garage's S3 API serves no anonymous reads, and a
 * website-enabled bucket would publish every key, including the private prefixes (`incoming/`
 * unscanned uploads, `recordings/` VODs that are not public, `moderation/` review frames and
 * NCII-hidden objects). Only the allowlisted prefixes (`PUBLIC_MEDIA_PREFIXES`,
 * `@commonair/contracts/storage`) are served; anything else is a 404 whether or not it exists.
 *
 * `vods/<id>/…` also needs the VOD's database state to be public and playable (ADR 0009 amendment
 * 1): checked before storage is read, cached per VOD for 5 s (`VodStateCache`, `vod.ts`), so a
 * removal or re-scope answers 404 within 5 s on every instance, before its objects have moved.
 */
import { PUBLIC_MEDIA_PREFIXES, vodPlacement } from "@commonair/contracts/storage";
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import type { VodStateCache } from "./vod.ts";

export const MEDIA_ROUTE = "/media/";

export interface MediaDeps {
  storage: Pick<ObjectStorage, "get">;
  bucket: string;
  /** VOD state check for `vods/` keys. Without it every `vods/` key is a 404 (fail closed). */
  vodStates?: VodStateCache;
  logger?: Logger;
}

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "range",
  "access-control-expose-headers": "accept-ranges, content-length, content-range, content-type",
  "access-control-max-age": "86400",
};

export const PASSTHROUGH = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];
// A single byte range (what players send); multi-range responses are not worth supporting.
export const RANGE = /^bytes=(\d+-\d*|-\d+)$/;
/** Opened directly (not as an <img>/<video> source), an object gets no script, no forms, no origin. */
export const MEDIA_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Percent-decode a raw path one segment at a time, or null when any segment is empty, a dot
 * segment, or carries a slash, backslash or control character (so an encoded `/` or `..` cannot
 * climb out of a prefix).
 */
export function safeSegments(raw: string): string[] | null {
  const segments: string[] = [];
  for (const part of raw.split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused
    if (seg === "" || seg === "." || seg === ".." || /[/\\\u0000-\u001f\u007f]/.test(seg)) return null;
    segments.push(seg);
  }
  return segments;
}

/**
 * The object key for a raw request path under `/media/`, or null when it is not a public key.
 * Segments are percent-decoded one by one, so an encoded `/` or `..` cannot climb out of a prefix.
 */
export function publicMediaKey(rawPath: string): string | null {
  if (!rawPath.startsWith(MEDIA_ROUTE)) return null;
  const segments = safeSegments(rawPath.slice(MEDIA_ROUTE.length));
  if (!segments || segments.length < 2 || !PUBLIC_MEDIA_PREFIXES.includes(segments[0] as string)) return null;
  const key = segments.join("/");
  return key.length <= 1024 ? key : null;
}

export type MediaFetch = (req: Request, rawPath: string) => Promise<Response>;

export const mediaFail = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { ...CORS, "cache-control": "no-store", ...headers } });

/** The response headers for a stored object: passthrough, CORS, the cache policy, nosniff and the sandbox CSP. */
export function objectHeaders(res: Response, cacheControl: string): Headers {
  const headers = new Headers(CORS);
  for (const h of PASSTHROUGH) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  headers.set("cache-control", cacheControl);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", MEDIA_CSP);
  return headers;
}

export type ObjectRead = { found: Response } | { missing: true } | { failed: Response };

/**
 * Read an object (with a single validated `Range` when `range`), or the failure to answer: 416 for
 * a bad or unsatisfiable range, 502 when storage fails (the key is never logged).
 */
export async function readObject(
  deps: Pick<MediaDeps, "storage" | "bucket" | "logger">,
  req: Request,
  key: string,
  opts: { range: boolean } = { range: true },
): Promise<ObjectRead> {
  const range = opts.range ? (req.headers.get("range") ?? undefined) : undefined;
  if (range !== undefined && !RANGE.test(range.trim())) return { failed: mediaFail(416, "range_not_satisfiable") };
  try {
    const res = await deps.storage.get(deps.bucket, key, range ? { range: range.trim() } : undefined);
    return res ? { found: res } : { missing: true };
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 416) return { failed: mediaFail(416, "range_not_satisfiable") };
    // The key never reaches a log: it can name a user's upload.
    deps.logger?.warn("media read failed", { status: typeof status === "number" ? status : undefined });
    return { failed: mediaFail(502, "upstream_unavailable") };
  }
}

/** True when the VOD named by a `vods/<id>/…` key is public and playable right now (cached 5 s). */
async function vodServable(deps: MediaDeps, key: string): Promise<boolean> {
  const id = key.split("/")[1] ?? "";
  if (!deps.vodStates || !UUID.test(id)) return false;
  try {
    const s = await deps.vodStates.get(id);
    return s !== null && vodPlacement(s.state) === "public";
  } catch {
    // Fail closed. Neither the key nor the error text is logged.
    deps.logger?.warn("VOD state check failed");
    return false;
  }
}

export function createMediaHandler(deps: MediaDeps): MediaFetch {
  return async (req, rawPath) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "GET" && req.method !== "HEAD")
      return mediaFail(405, "method_not_allowed", { allow: "GET, HEAD, OPTIONS" });
    const key = publicMediaKey(rawPath);
    if (!key) return mediaFail(404, "not_found");
    // Before storage: a VOD that is not public and playable is the same 404 as a missing object.
    if (key.startsWith("vods/") && !(await vodServable(deps, key))) return mediaFail(404, "not_found");
    const read = await readObject(deps, req, key);
    if ("failed" in read) return read.failed;
    if ("missing" in read) return mediaFail(404, "not_found");
    const res = read.found;
    // Short-lived: an object hidden or removed by moderation must drop out of shared caches soon.
    const headers = objectHeaders(res, "public, max-age=300");
    if (req.method === "HEAD") {
      await res.body?.cancel();
      return new Response(null, { status: res.status, headers });
    }
    return new Response(res.body, { status: res.status, headers });
  };
}
