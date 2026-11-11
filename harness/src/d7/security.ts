// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d7-security (D7.2) harness helpers: an RFC 6238 TOTP (SHA-1, 6 digits, 30 s, as better-auth's
 * two-factor plugin), so a scenario can answer the authenticator step without a dependency, and a
 * locator for the d7-security test ids.
 */
import { createHmac } from "node:crypto";
import type { Locator, Page } from "playwright";
import { D7_SECURITY_IDS } from "../web/selectors.ts";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (case-insensitive; spaces and padding ignored). */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new Error("not base32");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP over a raw key. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/** RFC 6238 TOTP from a base32 secret (as an authenticator app shows it, spaces allowed). */
export function totp(secret: string, atMs = Date.now(), periodSeconds = 30): string {
  return hotp(base32Decode(secret), Math.floor(atMs / 1000 / periodSeconds));
}

/** Milliseconds until the next 30 s period starts. */
export const msToNextPeriod = (atMs = Date.now(), periodSeconds = 30) =>
  periodSeconds * 1000 - (atMs % (periodSeconds * 1000));

export type D7SecurityId = (typeof D7_SECURITY_IDS)[keyof typeof D7_SECURITY_IDS];

export function d7Locator(page: Page, id: D7SecurityId, data: Record<string, string> = {}): Locator {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`)
    .join("");
  return page.locator(`[data-testid="${id}"]${attrs}`);
}
