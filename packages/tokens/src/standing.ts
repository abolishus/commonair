// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed standing statement (batch 7 decision (n), ADR 0037): what a channel's moderation
 * standing was on the instance it is leaving, so an import elsewhere is not ban evasion. Signed
 * by the worker with `PORTABILITY_SIGNING_KEY` (Ed25519); public keys are listed at
 * `/.well-known/commonair-portability` in the attestation key-history shape.
 *
 * It follows the attestation envelope (`attestation.ts`): `{ payload, signature }`, both
 * base64url; `payload` is the UTF-8 JSON of the zod-parsed statement in schema key order, and a
 * verifier refuses bytes that are not that canonical encoding. Unlike attestations it is
 * AGPL-only (the SDK does not inline it), so it imports the shared helpers.
 *
 * Counts and flags only: no names, no reasons, no user ids (ADR 0004).
 *
 * The statement is bound to the bundle that carries it: `bundleSha256` is the digest of that
 * bundle with `standing` set to null (`standingBundleDigest`), and its `issuer` is the bundle's
 * exporting instance. `checkStandingBinding` refuses a statement spliced into another bundle.
 */
import { z } from "zod";
import { PortabilityBundle } from "@commonair/contracts/portability";
import { type AttestationKey, deriveKid, fromB64url, toB64url } from "./attestation.ts";

export const STANDING_VERSION = 1;
/** A statement is valid for at most 30 days from `issuedAt`. */
export const STANDING_TTL_DAYS = 30;
/** Upheld actions are counted over the 12 months before `issuedAt`. */
export const STANDING_WINDOW_MONTHS = 12;
/** Tolerated clock difference between instances when checking `issuedAt`. */
export const STANDING_SKEW_SECONDS = 300;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

const KID = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const timestamp = z
  .string()
  .regex(ISO_UTC)
  .refine((s) => new Date(s).toISOString() === s, "not a real instant");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Upheld platform actions by tier (`MODERATION_TIERS` in `@commonair/contracts`). */
export const StandingActionCounts = z.strictObject({ t0: count, t1: count, t2: count });

/** Key order is the byte order of the payload: never reorder, add fields only with a new `v`. */
export const StandingStatement = z
  .strictObject({
    v: z.literal(STANDING_VERSION),
    /** The issuing instance's origin (`instanceSite()`); the verifier fetches its keys from there. */
    issuer: z.string().max(255).regex(ORIGIN),
    kid: z.string().regex(KID),
    channelId: z.string().regex(UUID),
    /** `standingBundleDigest` of the bundle this statement travels in. */
    bundleSha256: z.string().regex(HEX64),
    issuedAt: timestamp,
    expiresAt: timestamp,
    activeSuspension: z.boolean(),
    legalHold: z.boolean(),
    /** Upheld platform actions in the `STANDING_WINDOW_MONTHS` before `issuedAt`. */
    upheldActions: StandingActionCounts,
    dmcaStrikes: count,
  })
  .superRefine((s, ctx) => {
    const span = Date.parse(s.expiresAt) - Date.parse(s.issuedAt);
    if (span <= 0 || span > STANDING_TTL_DAYS * 86_400_000)
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt is not within 30 days after issuedAt" });
  });
export type StandingStatement = z.infer<typeof StandingStatement>;

export interface SignedStanding {
  payload: string;
  signature: string;
}

/** Rows of `/.well-known/commonair-portability`: the attestation key-history shape. */
export type StandingKey = AttestationKey;

export interface StandingSigningKey {
  privateKey: CryptoKey;
  publicKey: string;
  kid: string;
}

export type StandingError =
  | "malformed"
  | "non_canonical"
  | "bad_signature"
  | "kid_mismatch"
  | "unknown_kid"
  | "compromised_kid"
  | "expired"
  | "not_yet_valid";

export type StandingVerifyResult =
  | { ok: true; statement: StandingStatement; key: StandingKey | null }
  | { ok: false; error: StandingError };

/** `expiresAt` for a statement issued at `issuedAt`: exactly `STANDING_TTL_DAYS` later. */
export function standingExpiry(issuedAt: string): string {
  return new Date(Date.parse(issuedAt) + STANDING_TTL_DAYS * 86_400_000).toISOString();
}

/** The exact signed bytes. Throws (a `ZodError`) on anything not a valid statement. */
export function canonicalizeStanding(statement: StandingStatement): Uint8Array<ArrayBuffer> {
  return enc.encode(JSON.stringify(StandingStatement.parse(statement)));
}

export { deriveKid as deriveStandingKid } from "./attestation.ts";

/** Import `PORTABILITY_SIGNING_KEY` (PKCS#8 DER, standard base64). */
export async function importStandingSigningKey(pkcs8B64: string): Promise<StandingSigningKey> {
  const der = Uint8Array.from(atob(pkcs8B64), (c) => c.charCodeAt(0));
  const temp = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", temp);
  if (!jwk.x) throw new Error("not an Ed25519 private key");
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  return { privateKey, publicKey: jwk.x, kid: await deriveKid(jwk.x) };
}

/** Sign a statement. Its `kid` must be the signing key's. */
export async function signStanding(key: StandingSigningKey, statement: StandingStatement): Promise<SignedStanding> {
  const bytes = canonicalizeStanding(statement);
  if (statement.kid !== key.kid) throw new Error("statement kid is not the signing key's kid");
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, bytes));
  return { payload: toB64url(bytes), signature: toB64url(signature) };
}

/**
 * Verify against one public key (base64url, raw 32 bytes) or the issuer's key history, then the
 * validity window at `now`. A compromised key fails every signature; a retired one still verifies.
 */
export async function verifyStanding(
  signed: SignedStanding,
  keys: string | readonly StandingKey[],
  now: Date = new Date(),
): Promise<StandingVerifyResult> {
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
  const claimedKid = (json as { kid?: unknown } | null)?.kid;
  let key: StandingKey | null = null;
  let publicKey: string;
  if (typeof keys === "string") publicKey = keys;
  else {
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
  if (key && key.kid !== kid) return { ok: false, error: "kid_mismatch" };
  if (sig.length !== 64 || !(await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sig, bytes)))
    return { ok: false, error: "bad_signature" };
  const parsed = StandingStatement.safeParse(json);
  if (!parsed.success) return { ok: false, error: "malformed" };
  if (JSON.stringify(parsed.data) !== dec.decode(bytes)) return { ok: false, error: "non_canonical" };
  if (parsed.data.kid !== kid) return { ok: false, error: "kid_mismatch" };
  const t = now.getTime();
  if (Date.parse(parsed.data.issuedAt) - STANDING_SKEW_SECONDS * 1000 > t) return { ok: false, error: "not_yet_valid" };
  if (Date.parse(parsed.data.expiresAt) <= t) return { ok: false, error: "expired" };
  return { ok: true, statement: parsed.data, key };
}

/**
 * The digest a statement binds: lowercase hex SHA-256 of the UTF-8 JSON of the Zod-parsed bundle
 * (schema key order) with `standing` set to null. The exporter computes it before signing; the
 * importer recomputes it from the `bundle.json` it parsed. Throws on an invalid bundle.
 */
export async function standingBundleDigest(bundle: unknown): Promise<string> {
  const parsed = PortabilityBundle.parse({ ...(bundle as Record<string, unknown>), standing: null });
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(JSON.stringify(parsed))));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type StandingBindingError = "bundle_mismatch" | "issuer_mismatch";

/**
 * Whether a verified statement belongs to this bundle: its digest matches, and its issuer is the
 * bundle's exporting instance (`instance.domain`, host and port). Null when it does.
 */
export async function checkStandingBinding(
  statement: StandingStatement,
  bundle: PortabilityBundle,
): Promise<StandingBindingError | null> {
  if (new URL(statement.issuer).host !== bundle.instance.domain) return "issuer_mismatch";
  if (statement.bundleSha256 !== (await standingBundleDigest(bundle))) return "bundle_mismatch";
  return null;
}
