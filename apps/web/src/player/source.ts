// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The delivery source of the playlist the player is playing (the player's `data-source`). It
 * comes from `PlaybackStart.source`, and after a heartbeat `switchTo` from the `src` claim of the
 * refreshed playback token that comes with it.
 */
import { DELIVERY_SOURCES } from "@commonair/contracts/enums";

export type DeliverySource = (typeof DELIVERY_SOURCES)[number];

/** What the player reports: `p2p` never, since segments always come over HTTP from a playlist. */
export type PlayerSource = Exclude<DeliverySource, "p2p">;

/** The HTTP source behind a session's delivery source (a P2P session's playlist is the origin's). */
export function playerSource(source: DeliverySource): PlayerSource {
  return source === "p2p" ? "origin" : source;
}

function decodeBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b64 = s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "=");
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * The `src` claim of a playback token (`PlaybackClaims`, `<base64url json>.<signature>`), or null
 * when it cannot be read. Informational only: the server verifies tokens, the client never does.
 */
export function tokenSource(token: string | undefined): DeliverySource | null {
  const body = token?.split(".")[0];
  if (!body) return null;
  const json = decodeBase64Url(body);
  if (json === null) return null;
  try {
    const src: unknown = (JSON.parse(json) as { src?: unknown }).src;
    return typeof src === "string" && (DELIVERY_SOURCES as readonly string[]).includes(src)
      ? (src as DeliverySource)
      : null;
  } catch {
    return null;
  }
}

/**
 * The source after a `switchTo`. The server sends one when the assigned relay leaves the active
 * set and moves the session to the origin, so the origin is the fallback when the token that
 * came with it is missing or unreadable.
 */
export function sourceAfterSwitch(token: string | undefined): PlayerSource {
  return playerSource(tokenSource(token) ?? "origin");
}

export interface HeartbeatResult {
  token?: string | undefined;
  switchTo?: string | undefined;
  throttled?: boolean | undefined;
}

/** The playlist to move to after this heartbeat, and its source; null to stay put. */
export function heartbeatSwitch(res: HeartbeatResult): { url: string; source: PlayerSource } | null {
  // A throttled beat was ignored by the server; it carries no move.
  if (res.throttled || !res.switchTo) return null;
  return { url: res.switchTo, source: sourceAfterSwitch(res.token) };
}
