// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Client ids and client secrets for OAuth apps (ADR 0027 §1). */
import { randomTokenSecret, sha256Hex } from "@commonair/tokens";

export const CLIENT_ID_LENGTH = 30;
export const CLIENT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Client secrets carry this prefix so a leaked one is greppable (docs/testing/e9-selectors.md). */
export const CLIENT_SECRET_PREFIX = "cas_";

// The largest multiple of the alphabet size not above 256: bytes at or above it are redrawn, so
// every character is equally likely (a plain modulo would favour the first 256 % 36 characters).
const LIMIT = 256 - (256 % CLIENT_ID_ALPHABET.length);

/** 30 lowercase alphanumerics, Twitch's client id shape. Public, but unguessable all the same. */
export function mintClientId(): string {
  let out = "";
  while (out.length < CLIENT_ID_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(CLIENT_ID_LENGTH * 2))) {
      if (b >= LIMIT) continue;
      out += CLIENT_ID_ALPHABET[b % CLIENT_ID_ALPHABET.length];
      if (out.length === CLIENT_ID_LENGTH) break;
    }
  }
  return out;
}

/** A fresh client secret (shown once) and the sha256 the database keeps. */
export async function mintClientSecret(): Promise<{ secret: string; hash: string }> {
  const secret = randomTokenSecret(CLIENT_SECRET_PREFIX);
  return { secret, hash: await sha256Hex(secret) };
}
