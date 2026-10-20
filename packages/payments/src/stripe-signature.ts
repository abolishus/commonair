// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe webhook signatures (Stripe's documented scheme): the `Stripe-Signature` header is
 * `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`, each `v1` an HMAC-SHA256 of `${t}.${raw body}` keyed
 * with the endpoint's signing secret. Several `v1` values appear while a secret is rolled.
 */

/** Stripe's default tolerance: events older (or newer) than five minutes are refused (replay). */
export const STRIPE_SIGNATURE_TOLERANCE_S = 300;

const encoder = new TextEncoder();

function bytesOf(payload: string | Uint8Array): Uint8Array {
  return typeof payload === "string" ? encoder.encode(payload) : payload;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hex HMAC-SHA256 of `${t}.${payload}`. */
export async function stripeSignature(
  secret: string,
  payload: string | Uint8Array,
  timestampS: number,
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const body = bytesOf(payload);
  const prefix = encoder.encode(`${timestampS}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);
  return toHex(await crypto.subtle.sign("HMAC", key, signed));
}

/** A `Stripe-Signature` header for a payload (the harness and tests sign events with it). */
export async function signStripePayload(secret: string, payload: string | Uint8Array, timestampS: number) {
  return `t=${timestampS},v1=${await stripeSignature(secret, payload, timestampS)}`;
}

/** Length-independent comparison of two strings (no early exit on the first difference). */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function parseSignatureHeader(header: string): { timestamp: number | null; v1: string[] } {
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return { timestamp, v1 };
}

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

/** Verify the raw body against `Stripe-Signature`; `nowS` is the current time in Unix seconds. */
export async function verifyStripeSignature(
  payload: string | Uint8Array,
  header: string | null,
  secret: string,
  opts: { nowS: number; toleranceS?: number },
): Promise<SignatureCheck> {
  if (!header) return { ok: false, reason: "missing" };
  const { timestamp, v1 } = parseSignatureHeader(header);
  if (timestamp === null || v1.length === 0) return { ok: false, reason: "malformed" };
  const tolerance = opts.toleranceS ?? STRIPE_SIGNATURE_TOLERANCE_S;
  if (Math.abs(opts.nowS - timestamp) > tolerance) return { ok: false, reason: "expired" };
  const expected = await stripeSignature(secret, payload, timestamp);
  // Compare every candidate so the time taken does not reveal which one matched.
  let matched = false;
  for (const candidate of v1) if (constantTimeEqual(candidate, expected)) matched = true;
  return matched ? { ok: true, timestamp } : { ok: false, reason: "mismatch" };
}
