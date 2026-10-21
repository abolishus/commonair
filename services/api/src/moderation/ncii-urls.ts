// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * NCII request URLs → subjects on this instance (docs/testing/e4c-selectors.md "NCII request").
 * `parseContentUrl` is pure: it recognizes, on this instance's web, API or media hosts,
 *
 * - `/videos/<id>`, `/vods/<id>`, `/<channel>/videos/<id>`, `/api/vods/<id>` → a VOD
 * - `/clips/<id>`, `/clip/<id>`, `/<channel>/clip(s)/<id>`, `/api/clips/<id>` → a clip
 * - `/<channel>`, `/embed/<channel>` → the channel's live broadcast (if live when submitted)
 * - `<media bucket URL>/channels/<id>/<purpose>/<file>` → an upload (by key)
 *
 * Anything else stays unresolved (staff resolve it by hand); the request is still valid.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { isCommittedKeyShape, UPLOAD_PURPOSES, type UploadPurpose } from "./upload-keys.ts";

export type ParsedContentUrl =
  | { kind: "vod" | "clip"; id: string }
  | { kind: "channel"; slug: string }
  | { kind: "upload"; channelId: string; purpose: UploadPurpose; key: string }
  | { kind: "unknown" };

export interface InstanceHosts {
  /** Origins of the web app and API (e.g. `https://example.coop`). */
  origins: readonly string[];
  /** Public URL prefix of the media bucket, ending in `/`. */
  mediaBase: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9_]{2,40}$/i;
/** First path segments that are app routes, never channels. */
const RESERVED = new Set([
  "api",
  "rpc",
  "admin",
  "settings",
  "signin",
  "signup",
  "dashboard",
  "takedown",
  "legal",
  "transparency",
  "directory",
  "search",
  "categories",
]);

export function parseContentUrl(raw: string, hosts: InstanceHosts): ParsedContentUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "unknown" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "unknown" };
  const href = `${url.origin}${url.pathname}`;
  if (href.startsWith(hosts.mediaBase)) {
    let key: string;
    try {
      key = decodeURIComponent(href.slice(hosts.mediaBase.length));
    } catch {
      return { kind: "unknown" };
    }
    const m = /^channels\/([0-9a-f-]{36})\/([a-z_]+)\//.exec(key);
    const purpose = m?.[2] as UploadPurpose | undefined;
    if (m?.[1] && purpose && UPLOAD_PURPOSES.includes(purpose) && isCommittedKeyShape(key, m[1], purpose))
      return { kind: "upload", channelId: m[1], purpose, key };
    return { kind: "unknown" };
  }
  if (!hosts.origins.includes(url.origin)) return { kind: "unknown" };
  const seg = url.pathname.split("/").filter(Boolean);
  const idAfter = (names: string[]) => {
    for (let i = 0; i < seg.length - 1; i++)
      if (names.includes((seg[i] ?? "").toLowerCase()) && UUID.test(seg[i + 1] ?? "")) return seg[i + 1]?.toLowerCase();
    return undefined;
  };
  const vod = idAfter(["videos", "vods", "video", "vod"]);
  if (vod) return { kind: "vod", id: vod };
  const clip = idAfter(["clips", "clip"]);
  if (clip) return { kind: "clip", id: clip };
  const first = seg[0]?.toLowerCase();
  const second = seg[1];
  if (first === "embed" && seg.length === 2 && second && SLUG.test(second))
    return { kind: "channel", slug: second.toLowerCase() };
  if (seg.length === 1 && first && SLUG.test(first) && !RESERVED.has(first)) return { kind: "channel", slug: first };
  return { kind: "unknown" };
}

export interface ResolvedItem {
  url: string;
  subjectType: "broadcast" | "vod" | "clip" | "upload" | null;
  subjectId: string | null;
  uploadKey: string | null;
  channelId: string | null;
}

/** Resolve a parsed URL to a subject that exists (and is not already gone) on this instance. */
export async function resolveContentUrl(db: Executor, url: string, hosts: InstanceHosts): Promise<ResolvedItem> {
  const p = parseContentUrl(url, hosts);
  const none: ResolvedItem = { url, subjectType: null, subjectId: null, uploadKey: null, channelId: null };
  switch (p.kind) {
    case "vod": {
      const [v] = await db
        .select({ id: schema.vods.id, channelId: schema.vods.channelId })
        .from(schema.vods)
        .where(and(eq(schema.vods.id, p.id), ne(schema.vods.status, "deleted")));
      return v ? { ...none, subjectType: "vod", subjectId: v.id, channelId: v.channelId } : none;
    }
    case "clip": {
      const [c] = await db
        .select({ id: schema.clips.id, channelId: schema.clips.channelId })
        .from(schema.clips)
        .where(and(eq(schema.clips.id, p.id), ne(schema.clips.status, "deleted")));
      return c ? { ...none, subjectType: "clip", subjectId: c.id, channelId: c.channelId } : none;
    }
    case "channel": {
      const [row] = await db
        .select({ b: schema.broadcasts.id, channelId: schema.channels.id })
        .from(schema.channels)
        .innerJoin(schema.broadcasts, eq(schema.broadcasts.id, schema.channels.liveBroadcastId))
        .where(and(eq(schema.channels.slug, p.slug), isNull(schema.broadcasts.endedAt)));
      return row ? { ...none, subjectType: "broadcast", subjectId: row.b, channelId: row.channelId } : none;
    }
    case "upload": {
      const [c] = await db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.id, p.channelId));
      // An upload has no row of its own: the subject is its channel, the key says which object.
      return c ? { ...none, subjectType: "upload", subjectId: c.id, uploadKey: p.key, channelId: c.id } : none;
    }
    case "unknown":
      return none;
  }
}
