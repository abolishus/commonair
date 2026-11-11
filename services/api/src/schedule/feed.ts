// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `GET /api/channels/<slug>/schedule.ics` (overhaul wave 5, "Add to calendar"): the channel's
 * upcoming streams as a first-party `text/calendar` feed, public, cached briefly, rate limited on
 * the per-IP default bucket like the other public raw GETs. `?next=1` answers the next stream
 * alone, as a download.
 */
import { instanceSite } from "@commonair/config/env";
import type { Deps } from "../deps.ts";
import { channelBySlug } from "../lib/dto.ts";
import { rateLimitKey } from "../lib/ratelimit.ts";
import { buildFeed } from "./ics.ts";
import { loadSchedule, upcomingOf } from "./service.ts";

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export async function scheduleFeed(
  deps: Deps,
  raw: Request,
  url: URL,
  slug: string,
  rateLimitHash: string,
): Promise<Response> {
  if (raw.method !== "GET" && raw.method !== "HEAD")
    return json({ code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, { allow: "GET, HEAD" });
  const nowMs = deps.now().getTime();
  const rl = await deps.rateLimitStore.hit(
    rateLimitKey("default", `ip:${rateLimitHash}`),
    deps.rateLimits.default,
    nowMs,
    `${nowMs}:${crypto.randomUUID()}`,
  );
  if (!rl.allowed)
    return json({ code: "RATE_LIMITED", message: "Too many requests" }, 429, {
      "retry-after": String(rl.retryAfterSeconds),
    });
  const c = await channelBySlug(deps, slug);
  if (!c) return json({ code: "NOT_FOUND", message: "Channel not found" }, 404);
  const now = new Date(nowMs);
  const loaded = await loadSchedule(deps.db, c.id, now);
  const nextOnly = url.searchParams.get("next") === "1";
  const upcoming = upcomingOf(loaded, now, c.suspendedAt !== null, nextOnly ? 1 : undefined);
  const site = instanceSite(deps.env);
  const body = buildFeed({
    instanceName: site.name,
    publicUrl: site.publicUrl,
    channel: { slug: c.slug, displayName: c.displayName },
    occurrences: upcoming,
    stamp: loaded.updatedAt ?? now,
  });
  return new Response(raw.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "public, max-age=300",
      "content-disposition": `${nextOnly ? "attachment" : "inline"}; filename="${c.slug}${nextOnly ? "-next" : ""}.ics"`,
      "x-content-type-options": "nosniff",
    },
  });
}
