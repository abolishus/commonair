// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Verifiable draws for giveaways and the advisory jury (batch 7 decision (s), ADR 0039).
 *
 * Commit-reveal: at open the server publishes `commit(seed)`; at close it reveals the seed, and
 * anyone can check `verifyReveal` and re-run `draw` over the published, sorted entry list. Web
 * Crypto and `TextEncoder` only (no Node APIs), so the public verify page runs the same code in
 * the browser. `vectors.json` pins every output.
 *
 * Formats (all lowercase hex):
 * - **seed** and **salt**: 16 to 64 random bytes (`newSeed`/`newSalt` give 32), hex-encoded.
 * - **commitment**: SHA-256 over the seed's raw bytes (not its hex text). In SQL, for a hex text
 *   column: `encode(sha256(decode(seed, 'hex')), 'hex')`; for a bytea column: `sha256(seed)`.
 * - **pseudonym**: HMAC-SHA256 keyed with the salt's raw bytes over the UTF-8 user id.
 * - **draw**: a partial Fisher-Yates shuffle (`core.ts`) fed by HMAC-SHA256 keyed with the seed's
 *   raw bytes over the UTF-8 text `commonair-draw/v1\n<domain>\n<entriesHash>\n<counter>`, where
 *   `entriesHash` is the hex SHA-256 of `JSON.stringify(entries)` and `counter` counts PRF blocks
 *   in decimal from 0. The first 6 bytes of each block are a 48-bit sample; samples at or above
 *   the largest multiple of the remaining range are rejected and the next counter is tried.
 *
 * Entries must be strictly ascending by UTF-16 code unit (`[...entries].sort()`), which is not
 * a database collation order: sort in TypeScript. The domain separates draws that share a seed
 * (the jury draws seats and cases from one seed).
 */
import { MAX_ENTRIES, shuffleIndices } from "./core.ts";

export { MAX_ENTRIES } from "./core.ts";

export const DRAW_VERSION = "commonair-draw/v1";
/** Bytes of a fresh seed or salt. */
export const SEED_BYTES = 32;
const MIN_SECRET_BYTES = 16;
const MAX_SECRET_BYTES = 64;
const MAX_DOMAIN_LENGTH = 64;

const enc = new TextEncoder();
const HEX = /^(?:[0-9a-f]{2})+$/;

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function secretBytes(value: string, what: string): Uint8Array<ArrayBuffer> {
  if (!HEX.test(value)) throw new Error(`${what} must be lowercase hex`);
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  if (bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES)
    throw new Error(`${what} must be ${MIN_SECRET_BYTES} to ${MAX_SECRET_BYTES} bytes`);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function hmacKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** A fresh random seed: 32 bytes, hex. */
export function newSeed(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(SEED_BYTES)));
}

/** A fresh random pseudonym salt: 32 bytes, hex. */
export function newSalt(): string {
  return newSeed();
}

/** The seed commitment: hex SHA-256 over the seed's raw bytes. Throws on a malformed seed. */
export async function commit(seed: string): Promise<string> {
  return sha256Hex(secretBytes(seed, "seed"));
}

/** True when `seed` is well formed and hashes to `commitment`. Never throws. */
export async function verifyReveal(seed: string, commitment: string): Promise<boolean> {
  let actual: string;
  try {
    actual = await commit(seed);
  } catch {
    return false;
  }
  if (actual.length !== commitment.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ commitment.charCodeAt(i);
  return diff === 0;
}

/** A salted pseudonym for an entrant or juror: hex HMAC-SHA256(salt bytes, userId). */
export async function pseudonym(salt: string, userId: string): Promise<string> {
  if (userId.length === 0) throw new Error("userId must not be empty");
  const key = await hmacKey(secretBytes(salt, "salt"));
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(userId))));
}

/** True when the list is strictly ascending by UTF-16 code unit (so sorted with no duplicates). */
export function isSortedUnique(entries: readonly string[]): boolean {
  for (let i = 1; i < entries.length; i++) if (!((entries[i - 1] as string) < (entries[i] as string))) return false;
  return true;
}

/** Hex SHA-256 of `JSON.stringify(entries)`: binds a draw to the exact published list. */
export async function entriesHash(entries: readonly string[]): Promise<string> {
  return sha256Hex(enc.encode(JSON.stringify(entries)));
}

/**
 * Draw `count` distinct indices into `entries`, in drawn order. A `count` at or above the list
 * length returns every index (a full permutation); an empty list returns `[]`. Deterministic in
 * (seed, entries, count, domain), and `draw(.., k)` is always a prefix of `draw(.., k + 1)`.
 */
export async function draw(seed: string, entries: readonly string[], count: number, domain = ""): Promise<number[]> {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer");
  if (entries.length > MAX_ENTRIES) throw new RangeError(`at most ${MAX_ENTRIES} entries`);
  if (!isSortedUnique(entries)) throw new Error("entries must be sorted ascending with no duplicates");
  if (domain.length > MAX_DOMAIN_LENGTH || domain.includes("\n"))
    throw new Error(`domain must be at most ${MAX_DOMAIN_LENGTH} characters with no newline`);
  const key = await hmacKey(secretBytes(seed, "seed"));
  if (entries.length === 0 || count === 0) return [];
  const prefix = `${DRAW_VERSION}\n${domain}\n${await entriesHash(entries)}\n`;
  return shuffleIndices(
    async (counter) => new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${prefix}${counter}`))),
    entries.length,
    count,
  );
}

/** `draw`, mapped to the drawn entries themselves. */
export async function drawEntries(
  seed: string,
  entries: readonly string[],
  count: number,
  domain = "",
): Promise<string[]> {
  // Indices come from shuffleIndices over 0..entries.length-1, so every lookup is defined.
  return (await draw(seed, entries, count, domain)).map((i) => entries[i] as string);
}
