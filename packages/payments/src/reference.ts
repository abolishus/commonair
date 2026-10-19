// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Manual-adapter payment references (`MANUAL_REFERENCE_PATTERN`): short enough to read out or type
 * into a bank transfer, unambiguous (Crockford base32), 40 random bits. Uniqueness is enforced by
 * `payments_provider_ref_uq`; callers retry on the rare conflict.
 */
import { MANUAL_REFERENCE_PATTERN } from "@commonair/contracts/currency";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `random` must yield 5 uniformly random bytes; injectable for tests. */
export function manualReference(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const bytes = random(5);
  if (bytes.length !== 5) throw new RangeError("manualReference needs 5 random bytes");
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 7; i >= 0; i--) out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `CA-${out}`;
}

/** Canonical form of what a payer or treasurer typed (case, spaces, look-alike letters), or null. */
export function normalizeManualReference(input: string): string | null {
  const compact = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/^CA/, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  const ref = `CA-${compact}`;
  return MANUAL_REFERENCE_PATTERN.test(ref) ? ref : null;
}
