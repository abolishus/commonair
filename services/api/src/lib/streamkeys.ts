// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stream key format and leak scanning (pure). A key is `live_` + 43 base64url
 * characters (32 random bytes). Only its SHA-256 and a short prefix are stored;
 * OBS gets `<slug>?key=<secret>` as the "stream key" for server `rtmp://<host>/live`.
 */
import { randomSecret } from "@commonair/tokens";

export const STREAM_KEY_PREFIX = "live_";
export const STREAM_KEY_BODY_LENGTH = 43;
/** Characters of the secret kept for display ("live_" + 7). */
export const STREAM_KEY_DISPLAY_LENGTH = 12;

export const newStreamKeySecret = () => randomSecret(STREAM_KEY_PREFIX);
export const displayPrefix = (secret: string) => secret.slice(0, STREAM_KEY_DISPLAY_LENGTH);
/** What the streamer pastes into OBS's "Stream Key" field. */
export const obsStreamKey = (slug: string, secret: string) => `${slug}?key=${secret}`;

const KEY_PATTERN = /(?<![A-Za-z0-9_-])live_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

export const isStreamKeySecret = (s: string) => /^live_[A-Za-z0-9_-]{43}$/.test(s);

/** Every distinct stream-key-shaped secret in `text`. */
export function findLeakedKeys(text: string): string[] {
  return [...new Set(text.match(KEY_PATTERN) ?? [])];
}

/** Replace key-shaped secrets so the stored text does not keep a (now revoked) credential. */
export const redactKeys = (text: string, replacement = "[redacted stream key]") =>
  text.replace(KEY_PATTERN, replacement);
