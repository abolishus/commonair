// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `GET /media/<key>`: public media objects (avatars, thumbnails, clips, VODs) read from the media
 * bucket with the service key (ADR 0009). Garage's S3 API serves no anonymous reads, and a
 * website-enabled bucket would publish every key, including the private prefixes (`incoming/`
 * unscanned uploads, `moderation/` review frames and NCII-hidden objects). Only the allowlisted
 * prefixes below are served; anything else is a 404 whether or not it exists.
 */
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";

export const MEDIA_ROUTE = "/media/";

/** First key segments that hold published objects. Everything else is private. */
export const PUBLIC_MEDIA_PREFIXES: readonly string[] = ["channels", "clips", "thumbnails", "vods"];

export interface MediaDeps {
  storage: Pick<ObjectStorage, "get">;
  bucket: string;
  logger?: Logger;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "range",
  "access-control-expose-headers": "accept-ranges, content-length, content-range, content-type",
  "access-control-max-age": "86400",
};

const PASSTHROUGH = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];
// A single byte range (what players send); multi-range responses are not worth supporting.
const RANGE = /^bytes=(\d+-\d*|-\d+)$/;

/**
 * The object key for a raw request path under `/media/`, or null when it is not a public key.
 * Segments are percent-decoded one by one, so an encoded `/` or `..` cannot climb out of a prefix.
 */
export function publicMediaKey(rawPath: string): string | null {
  if (!rawPath.startsWith(MEDIA_ROUTE)) return null;
  const segments: string[] = [];
  for (const raw of rawPath.slice(MEDIA_ROUTE.length).split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused
    if (seg === "" || seg === "." || seg === ".." || /[/\\\u0000-\u001f\u007f]/.test(seg)) return null;
    segments.push(seg);
  }
  if (segments.length < 2 || !PUBLIC_MEDIA_PREFIXES.includes(segments[0] as string)) return null;
  const key = segments.join("/");
  return key.length <= 1024 ? key : null;
}

export type MediaFetch = (req: Request, rawPath: string) => Promise<Response>;

export function createMediaHandler(deps: MediaDeps): MediaFetch {
  const fail = (status: number, error: string, headers: Record<string, string> = {}) =>
    Response.json({ error }, { status, headers: { ...CORS, "cache-control": "no-store", ...headers } });

  return async (req, rawPath) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "GET" && req.method !== "HEAD")
      return fail(405, "method_not_allowed", { allow: "GET, HEAD, OPTIONS" });
    const key = publicMediaKey(rawPath);
    if (!key) return fail(404, "not_found");
    const range = req.headers.get("range") ?? undefined;
    if (range !== undefined && !RANGE.test(range.trim())) return fail(416, "range_not_satisfiable");

    let res: Response | null;
    try {
      res = await deps.storage.get(deps.bucket, key, range ? { range: range.trim() } : undefined);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (status === 416) return fail(416, "range_not_satisfiable");
      // The key never reaches a log: it can name a user's upload.
      deps.logger?.warn("media read failed", { status: typeof status === "number" ? status : undefined });
      return fail(502, "upstream_unavailable");
    }
    if (!res) return fail(404, "not_found");

    const headers = new Headers(CORS);
    for (const h of PASSTHROUGH) {
      const v = res.headers.get(h);
      if (v !== null) headers.set(h, v);
    }
    if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
    // Short-lived: an object hidden or removed by moderation must drop out of shared caches soon.
    headers.set("cache-control", "public, max-age=300");
    headers.set("x-content-type-options", "nosniff");
    // Opened directly (not as an <img>/<video> source), an object gets no script, no forms, no origin.
    headers.set("content-security-policy", "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
    if (req.method === "HEAD") {
      await res.body?.cancel();
      return new Response(null, { status: res.status, headers });
    }
    return new Response(res.body, { status: res.status, headers });
  };
}
