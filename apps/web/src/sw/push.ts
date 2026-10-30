// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Push messages and notification clicks (ADR 0028 decisions 1 and 6). The payload is validated by
 * hand (the worker does not bundle zod) against `PushPayload` in `@commonair/contracts/notify`.
 */
import type { PushPayload } from "@commonair/contracts/notify";
import { PWA_ICONS } from "../pwa/icons.ts";
import { workerLocale, workerMessage } from "./messages.ts";

/** `PushPayload.title`'s bound. */
export const MAX_PUSH_TITLE = 140;
/** Path-safe slugs only: the click opens `/<slug>` and nothing else. */
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;

/** A valid go-live payload, or null (the worker then shows nothing). Extra fields are ignored. */
export function parsePushPayload(data: unknown): PushPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const { v, type, slug, title } = data as Record<string, unknown>;
  if (v !== 1 || type !== "go_live") return null;
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  if (typeof title !== "string" || title.length > MAX_PUSH_TITLE) return null;
  return { v: 1, type: "go_live", slug, title };
}

export interface GoLiveNotification {
  title: string;
  options: {
    body: string;
    tag: string;
    icon: string;
    badge: string;
    lang: string;
    data: { url: string };
  };
}

/** What `registration.showNotification` gets for a go-live: a repeat for the channel replaces it. */
export function goLiveNotification(payload: PushPayload, languages: readonly string[]): GoLiveNotification {
  const locale = workerLocale(languages);
  return {
    title: workerMessage("pwa.push.live", { channel: payload.slug }, locale),
    options: {
      // Empty when the stream is mature and the follower has not confirmed 18+ (ADR 0028).
      body: payload.title,
      tag: `go-live-${payload.slug}`,
      icon: PWA_ICONS.icon192,
      badge: PWA_ICONS.icon192,
      lang: locale,
      data: { url: `/${payload.slug}` },
    },
  };
}

/**
 * The absolute URL a notification click opens: its `data.url` when that is a path on this origin,
 * otherwise the home page. A notification can never send the viewer to another site.
 */
export function clickTarget(data: unknown, origin: string): string {
  const home = new URL("/", origin).href;
  const url = typeof data === "object" && data !== null ? (data as { url?: unknown }).url : undefined;
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//") || url.includes("\\")) return home;
  try {
    const target = new URL(url, origin);
    return target.origin === new URL(origin).origin ? target.href : home;
  } catch {
    return home;
  }
}
