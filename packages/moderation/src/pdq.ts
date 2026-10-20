// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PDQ perceptual hashing (ported from ThreatExchange `pdq/`, tag hma-v1.1.7, BSD-3-Clause; the
 * port carries Meta's copyright and a BSD-3-Clause SPDX header, ADR 0008). Unit A replaces the
 * bodies; the signatures are the contract.
 */
import { pending } from "./pending.ts";
import type { PdqHash } from "./types.ts";

export const PDQ_HEX = /^[0-9a-f]{64}$/;

/** PDQ of a raw 8-bit luma image of any size (the reference algorithm's float path). */
export function pdqHash(_luma: Uint8Array, _width: number, _height: number): PdqHash {
  return pending("pdqHash");
}

/** Hamming distance of two 64-hex PDQ hashes (0–256). Throws on malformed input. */
export function hammingDistance(_a: string, _b: string): number {
  return pending("hammingDistance");
}
