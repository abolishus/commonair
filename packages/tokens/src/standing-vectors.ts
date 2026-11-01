// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `standing` and `purge` sections of vectors.json (`bun run vectors`). Ed25519 is
 * deterministic and every input is fixed, so the output is stable. Test keys only.
 */
import { b64url, importSigningKey } from "./index.ts";
import { type PurgeBatch, type SignedPurgeBatch, signPurgeBatch } from "./purge.ts";
import {
  canonicalizeStanding,
  importStandingSigningKey,
  type SignedStanding,
  type StandingKey,
  type StandingStatement,
  signStanding,
  standingExpiry,
} from "./standing.ts";

/** PKCS#8 of the RFC 8032 §7.1 test vector 3 seed (c5aa8d…58f7). */
export const STANDING_TEST_KEY = "MC4CAQAwBQYDK2VwBCIEIMWqjfQ/n4N77bdELzHct7Fm04U1B28JS4XOOi4LRFj3";
/** PKCS#8 of the RFC 8032 test vector 1 seed: the playback test key, and the "other" key here. */
export const PLAYBACK_TEST_KEY = "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";

const enc = new TextEncoder();

async function rawSign(privateKey: CryptoKey, text: string): Promise<{ payload: string; signature: string }> {
  const bytes = enc.encode(text);
  return {
    payload: b64url(bytes),
    signature: b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, bytes))),
  };
}

export async function standingVectors() {
  const key = await importStandingSigningKey(STANDING_TEST_KEY);
  const other = await importStandingSigningKey(PLAYBACK_TEST_KEY);
  const issuedAt = "2023-11-14T22:13:20.000Z";
  const statement: StandingStatement = {
    v: 1,
    issuer: "https://instance.example",
    kid: key.kid,
    channelId: "01890000-0000-7000-8000-00000000c001",
    issuedAt,
    expiresAt: standingExpiry(issuedAt),
    activeSuspension: false,
    legalHold: false,
    upheldActions: { t0: 0, t1: 2, t2: 1 },
    dmcaStrikes: 1,
  };
  const canonical = new TextDecoder().decode(canonicalizeStanding(statement));
  const signed = await signStanding(key, statement);
  const keys: StandingKey[] = [
    {
      kid: key.kid,
      algorithm: "Ed25519",
      publicKey: key.publicKey,
      firstUsedAt: issuedAt,
      retiredAt: null,
      compromisedAt: null,
    },
  ];
  const [active] = keys as [StandingKey];
  /** Inside the window. */
  const now = "2023-11-20T00:00:00.000Z";
  const suspended = await signStanding(key, { ...statement, activeSuspension: true, legalHold: true });

  const cases: { name: string; signed: SignedStanding; keys?: StandingKey[]; now: string; error: string | null }[] = [
    { name: "valid statement", signed, now, error: null },
    { name: "valid statement reporting a suspension and a legal hold", signed: suspended, now, error: null },
    { name: "a retired key still verifies", signed, keys: [{ ...active, retiredAt: now }], now, error: null },
    { name: "just before expiry", signed, now: "2023-12-14T22:13:19.999Z", error: null },
    { name: "at expiry", signed, now: statement.expiresAt, error: "expired" },
    { name: "issued in the future", signed, now: "2023-11-14T22:00:00.000Z", error: "not_yet_valid" },
    {
      name: "suspension flag cleared after signing",
      signed: { payload: signed.payload, signature: suspended.signature },
      now,
      error: "bad_signature",
    },
    {
      name: "count changed after signing",
      signed: { payload: b64url(enc.encode(canonical.replace('"t1":2', '"t1":0'))), signature: signed.signature },
      now,
      error: "bad_signature",
    },
    {
      name: "signed by another key under this kid",
      signed: await rawSign(other.privateKey, canonical),
      now,
      error: "bad_signature",
    },
    {
      name: "kid not in the key history",
      signed: await rawSign(key.privateKey, canonical.replace(key.kid, other.kid)),
      now,
      error: "unknown_kid",
    },
    { name: "compromised kid", signed, keys: [{ ...active, compromisedAt: now }], now, error: "compromised_kid" },
    {
      name: "valid signature over whitespace-formatted JSON",
      signed: await rawSign(key.privateKey, JSON.stringify(statement, null, 1)),
      now,
      error: "non_canonical",
    },
    {
      name: "valid signature over a 31-day validity",
      signed: await rawSign(
        key.privateKey,
        canonical.replace(statement.expiresAt, new Date(Date.parse(statement.expiresAt) + 86_400_000).toISOString()),
      ),
      now,
      error: "malformed",
    },
    {
      name: "valid signature over a personal-data field",
      signed: await rawSign(key.privateKey, canonical.replace('"dmcaStrikes":1', '"dmcaStrikes":1,"email":"x"')),
      now,
      error: "malformed",
    },
  ];

  return {
    note: "Decision (n). RFC 8032 test vector 3 key; kid is base64url of SHA-256(raw public key)[0:16].",
    privateKeyPkcs8: STANDING_TEST_KEY,
    publicKey: key.publicKey,
    kid: key.kid,
    keys,
    statement,
    canonical,
    signed,
    cases,
  };
}

export async function purgeVectors() {
  const key = await importSigningKey(PLAYBACK_TEST_KEY);
  const other = await importStandingSigningKey(STANDING_TEST_KEY);
  const batch: PurgeBatch = {
    seq: 42,
    items: [
      { seq: 40, prefix: "dvr/01890000-0000-7000-8000-000000000009/", reason: "vod_removed" },
      { seq: 41, prefix: "live/alice/", reason: "suspended" },
      { seq: 42, prefix: "live/alice/captions/", reason: "restricted" },
    ],
  };
  const empty: PurgeBatch = { seq: 42, items: [] };
  const reset: PurgeBatch = { seq: 120, items: [], reset: true };
  const signed = await signPurgeBatch(key, batch);
  const canonical = JSON.stringify(batch);
  const raw = (text: string) => rawSign(key.privateKey, text);
  const withItems = (items: unknown[], seq = 42) => JSON.stringify({ seq, items });
  const [a, b, c] = batch.items as [PurgeBatch["items"][0], PurgeBatch["items"][0], PurgeBatch["items"][0]];

  const cases: { name: string; signed: SignedPurgeBatch; error: string | null }[] = [
    { name: "valid batch", signed, error: null },
    { name: "valid empty batch", signed: await signPurgeBatch(key, empty), error: null },
    {
      name: "prefix changed after signing",
      signed: {
        payload: b64url(enc.encode(canonical.replace("live/alice/", "live/bob/"))),
        signature: signed.signature,
      },
      error: "bad_signature",
    },
    { name: "signed by another key", signed: await rawSign(other.privateKey, canonical), error: "bad_signature" },
    {
      name: "signature truncated",
      signed: { ...signed, signature: signed.signature.slice(0, 80) },
      error: "bad_signature",
    },
    {
      name: "valid signature over whitespace-formatted JSON",
      signed: await raw(JSON.stringify(batch, null, 1)),
      error: "non_canonical",
    },
    {
      name: "valid signature over reordered keys",
      signed: await raw(`{"items":${JSON.stringify(batch.items)},"seq":42}`),
      error: "non_canonical",
    },
    { name: "items out of order", signed: await raw(withItems([a, c, b])), error: "malformed" },
    { name: "duplicate item seq", signed: await raw(withItems([a, { ...b, seq: 40 }, c])), error: "malformed" },
    { name: "seq is not the last item's", signed: await raw(withItems([a, b, c], 43)), error: "malformed" },
    {
      name: "path traversal prefix",
      signed: await raw(withItems([{ ...c, prefix: "live/../secret/" }])),
      error: "malformed",
    },
    {
      name: "prefix outside live and dvr",
      signed: await raw(withItems([{ ...c, prefix: "vod/x/" }])),
      error: "malformed",
    },
    {
      name: "prefix without a trailing slash",
      signed: await raw(withItems([{ ...c, prefix: "live/alice" }])),
      error: "malformed",
    },
    { name: "unknown field", signed: await raw(canonical.replace('"seq":42,', '"seq":42,"x":1,')), error: "malformed" },
    { name: "fractional seq", signed: await raw(withItems([], 42.5)), error: "malformed" },
    { name: "padded base64url payload", signed: { ...signed, payload: `${signed.payload}=` }, error: "malformed" },
    // ADR 0016 A1.2: the signed reset for a relay behind the retained rows.
    { name: "valid reset", signed: await signPurgeBatch(key, reset), error: null },
    {
      name: "reset carrying items",
      signed: await raw(JSON.stringify({ seq: 42, items: batch.items, reset: true })),
      error: "malformed",
    },
    { name: "reset false", signed: await raw('{"seq":120,"items":[],"reset":false}'), error: "malformed" },
    { name: "reset null", signed: await raw('{"seq":120,"items":[],"reset":null}'), error: "malformed" },
    { name: "reset as a string", signed: await raw('{"seq":120,"items":[],"reset":"true"}'), error: "malformed" },
    {
      name: "valid signature over a reset before items",
      signed: await raw('{"seq":120,"reset":true,"items":[]}'),
      error: "non_canonical",
    },
  ];

  return {
    note: "Decision (x). Signed with the playback test key (privateKeyPkcs8 / publicKey at the top of this file).",
    batch,
    canonical,
    signed,
    cases,
  };
}
