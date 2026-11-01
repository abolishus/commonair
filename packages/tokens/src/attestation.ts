// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0

/**
 * Signed audience attestations (ADR 0014 decisions 1, 2, 5): the statement, its exact signed
 * bytes, Ed25519 signing and verification, the derived `kid`, the chain's `entryHash`, and the
 * hash commitments for the owner-only breakdown and the thresholds.
 *
 * Dual-licensed because the Apache-2.0 SDK inlines it (ADR 0035, batch 6 decision (q)), so it is
 * self-contained: WebCrypto, `TextEncoder`, `btoa`/`atob` and zod only, no Node APIs and no
 * imports from the rest of this package or from `@commonair/contracts`. It runs in Bun, Node and
 * browsers. `vectors.json` (`attestation`) pins the bytes.
 *
 * Wire format: `{ payload, signature }`, both base64url without padding (the relay receipt
 * shape). `payload` is the UTF-8 JSON of the zod-parsed statement in schema key order, with no
 * whitespace; that is what `canonicalize` returns and what is signed. Verifiers check the
 * signature over the bytes, then parse, then refuse bytes that are not the canonical encoding of
 * what they parse to, so one statement has exactly one payload and one `entryHash`. Every figure
 * is a non-negative safe integer: there is no float for TS and Go to print differently. Hashes are
 * lowercase hex SHA-256 (64 characters); `kid` is base64url (22 characters).
 */
import { z } from "zod";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/** Statement schema version. */
export const ATTESTATION_VERSION = 1;
export const ATTESTATION_ALGORITHM = "Ed25519";
/** Mirrors `ATTESTATION_KINDS` in `@commonair/contracts/enums` (batch 6 decision (r)); not imported, see above. */
export const ATTESTATION_KINDS = ["broadcast", "supersede", "reissue"] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

const HEX64 = /^[0-9a-f]{64}$/;
const KID = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `Date.prototype.toISOString()` output only (UTC, milliseconds), so a timestamp has one spelling. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A bare origin: scheme and host (and port), no path, no trailing slash. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

const hash = z.string().regex(HEX64);
const timestamp = z.string().regex(ISO_UTC);
const figure = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Delivery bytes by source (ADR 0014 decision 2). */
export const AttestationDeliveryBytes = z.strictObject({ origin: figure, relay: figure, cdn: figure });

/**
 * The signed statement. Key order here is the byte order of the payload: never reorder fields,
 * and add new ones only with a new `v`. Ids and counts only, never user ids or personal data
 * (ADR 0004).
 */
export const AttestationStatement = z
  .strictObject({
    v: z.literal(ATTESTATION_VERSION),
    kind: z.enum(ATTESTATION_KINDS),
    /** The instance origin that signed it (`instanceSite()`), shown prominently by verifiers. */
    origin: z.string().max(255).regex(ORIGIN),
    kid: z.string().regex(KID),
    channelId: z.string().regex(UUID),
    broadcastId: z.string().regex(UUID),
    /** Position in the channel's chain, from 1. */
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    /** The channel's previous `entryHash`; null only for `seq` 1. */
    prevHash: hash.nullable(),
    /** The `entryHash` this entry replaces; null only for a `broadcast` entry. */
    supersedes: hash.nullable(),
    periodStart: timestamp,
    periodEnd: timestamp,
    signedAt: timestamp,
    rulesetVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    thresholdsHash: hash,
    peakVerifiedConcurrent: figure,
    verifiedViewerSeconds: figure,
    durationSeconds: figure,
    /** Pending and `fetch_unjudged` sessions: not judged to be bots, so not exclusions. */
    unverifiedViewerSeconds: figure,
    excludedViewerSeconds: figure,
    /** `reasonsCommitment(salt, breakdown)` over the per-reason exclusion breakdown. */
    reasonsCommitment: hash,
    deliveryBytes: AttestationDeliveryBytes,
  })
  .superRefine((s, ctx) => {
    if ((s.seq === 1) !== (s.prevHash === null))
      ctx.addIssue({ code: "custom", path: ["prevHash"], message: "prevHash is null exactly when seq is 1" });
    if ((s.kind === "broadcast") !== (s.supersedes === null))
      ctx.addIssue({
        code: "custom",
        path: ["supersedes"],
        message: "supersedes is null exactly for a broadcast entry",
      });
    if (s.periodEnd < s.periodStart)
      ctx.addIssue({ code: "custom", path: ["periodEnd"], message: "periodEnd is before periodStart" });
  });
export type AttestationStatement = z.infer<typeof AttestationStatement>;

/** The envelope, as stored and served. */
export interface SignedAttestation {
  payload: string;
  signature: string;
}

/** One row of the public key history (`/.well-known/commonair-attestation`). */
export interface AttestationKey {
  kid: string;
  algorithm: typeof ATTESTATION_ALGORITHM;
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
  firstUsedAt: string | null;
  retiredAt: string | null;
  /** Set: every signature by this kid is rejected, whatever its date (a stolen key can backdate). */
  compromisedAt: string | null;
}

export interface AttestationSigningKey {
  privateKey: CryptoKey;
  /** Raw 32-byte public key, base64url (43 characters). */
  publicKey: string;
  kid: string;
}

export type AttestationError =
  /** Not base64url, not JSON, or not a valid statement. */
  | "malformed"
  /** Valid statement, but the payload is not its canonical encoding. */
  | "non_canonical"
  | "bad_signature"
  /** The statement's kid is not the given key's (single-key verification). */
  | "kid_mismatch"
  /** The statement's kid is not in the given key history. */
  | "unknown_kid"
  | "compromised_kid";

export type AttestationVerifyResult =
  | { ok: true; statement: AttestationStatement; entryHash: string; key: AttestationKey | null }
  | { ok: false; error: AttestationError };

// ---- encodings -------------------------------------------------------------------------------

const B64URL = /^[A-Za-z0-9_-]*$/;

export function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url decode: no padding, no foreign characters, canonical trailing bits only. */
export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  if (!B64URL.test(s) || s.length % 4 === 1) throw new Error("invalid base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (toB64url(bytes) !== s) throw new Error("non-canonical base64url");
  return bytes;
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Deterministic JSON for hash inputs (the breakdown and the thresholds), not for the signed
 * payload: object keys sorted by UTF-16 code unit, no whitespace, finite numbers only.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("stableJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  throw new Error(`stableJson: unsupported value (${typeof value})`);
}

// ---- statement bytes and hashes ----------------------------------------------------------------

/** The exact signed bytes of a statement. Throws (a `ZodError`) on anything not a valid statement. */
export function canonicalize(statement: AttestationStatement): Uint8Array<ArrayBuffer> {
  return enc.encode(JSON.stringify(AttestationStatement.parse(statement)));
}

/** `entryHash`: hex SHA-256 over the payload bytes (the chain link, ADR 0014 decision 5). */
export async function entryHash(signed: SignedAttestation | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = signed instanceof Uint8Array ? signed : fromB64url(signed.payload);
  return hex(await sha256(bytes));
}

/** `kid`: the first 16 bytes of SHA-256 over the raw public key, base64url (22 characters). */
export async function deriveKid(publicKey: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const raw = typeof publicKey === "string" ? fromB64url(publicKey) : publicKey;
  if (raw.length !== 32) throw new Error("Ed25519 public keys are 32 bytes");
  return toB64url((await sha256(raw)).slice(0, 16));
}

/** A fresh per-entry salt for `reasonsCommitment`: 32 random bytes, base64url. */
export function newReasonsSalt(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * `reasonsCommitment`: hex SHA-256 over the raw salt bytes followed by the UTF-8 `stableJson` of
 * the per-reason breakdown (reason → excluded viewer-seconds, integers). The salt and breakdown
 * are revealed only to the owner or through a share link, which checks them against this.
 */
export async function reasonsCommitment(salt: string, breakdown: Readonly<Record<string, number>>): Promise<string> {
  const saltBytes = fromB64url(salt);
  if (saltBytes.length < 16) throw new Error("reasons salt must be at least 16 bytes");
  for (const [reason, seconds] of Object.entries(breakdown))
    if (!figure.safeParse(seconds).success) throw new Error(`breakdown "${reason}" is not a non-negative integer`);
  const body = enc.encode(stableJson(breakdown));
  const bytes = new Uint8Array(saltBytes.length + body.length);
  bytes.set(saltBytes, 0);
  bytes.set(body, saltBytes.length);
  return hex(await sha256(bytes));
}

/** `thresholdsHash`: hex SHA-256 over the UTF-8 `stableJson` of `{ rulesetVersion, thresholds }`. */
export async function thresholdsHash(rulesetVersion: number, thresholds: unknown): Promise<string> {
  return hex(await sha256(enc.encode(stableJson({ rulesetVersion, thresholds }))));
}

// ---- keys, signing, verification ---------------------------------------------------------------

/** Import a PKCS#8 (DER, standard base64) Ed25519 private key, e.g. `INTEGRITY_SIGNING_KEY`. */
export async function importAttestationSigningKey(pkcs8B64: string): Promise<AttestationSigningKey> {
  const der = fromB64(pkcs8B64);
  // Extractable once only to read the public half; the key kept for signing is not extractable.
  const temp = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", temp);
  if (!jwk.x) throw new Error("not an Ed25519 private key");
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  return { privateKey, publicKey: jwk.x, kid: await deriveKid(jwk.x) };
}

/** Sign a statement. Its `kid` must be the signing key's. */
export async function sign(key: AttestationSigningKey, statement: AttestationStatement): Promise<SignedAttestation> {
  const bytes = canonicalize(statement);
  if (statement.kid !== key.kid) throw new Error("statement kid is not the signing key's kid");
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, bytes));
  return { payload: toB64url(bytes), signature: toB64url(signature) };
}

/**
 * Verify an envelope against one public key (base64url, raw 32 bytes) or against the instance's
 * key history. With a history, the statement's `kid` selects the key and a compromised key fails
 * every signature; a retired key still verifies what it signed.
 */
export async function verify(
  signed: SignedAttestation,
  keys: string | readonly AttestationKey[],
): Promise<AttestationVerifyResult> {
  let bytes: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  let json: unknown;
  try {
    bytes = fromB64url(signed.payload);
    sig = fromB64url(signed.signature);
    json = JSON.parse(dec.decode(bytes));
  } catch {
    return { ok: false, error: "malformed" };
  }
  // The kid only selects a key here; nothing else is read before the signature checks out.
  const claimedKid = (json as { kid?: unknown } | null)?.kid;
  let key: AttestationKey | null = null;
  let publicKey: string;
  if (typeof keys === "string") {
    publicKey = keys;
  } else {
    key = keys.find((k) => k.kid === claimedKid) ?? null;
    if (!key) return { ok: false, error: typeof claimedKid === "string" ? "unknown_kid" : "malformed" };
    if (key.compromisedAt !== null) return { ok: false, error: "compromised_kid" };
    publicKey = key.publicKey;
  }
  let cryptoKey: CryptoKey;
  let kid: string;
  try {
    const raw = fromB64url(publicKey);
    kid = await deriveKid(raw);
    cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { ok: false, error: "malformed" };
  }
  // A history row whose kid is not derived from its own key is not trusted for anything.
  if (key && key.kid !== kid) return { ok: false, error: "kid_mismatch" };
  if (sig.length !== 64 || !(await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sig, bytes)))
    return { ok: false, error: "bad_signature" };
  const parsed = AttestationStatement.safeParse(json);
  if (!parsed.success) return { ok: false, error: "malformed" };
  if (JSON.stringify(parsed.data) !== dec.decode(bytes)) return { ok: false, error: "non_canonical" };
  if (parsed.data.kid !== kid) return { ok: false, error: "kid_mismatch" };
  return { ok: true, statement: parsed.data, entryHash: await entryHash(bytes), key };
}
