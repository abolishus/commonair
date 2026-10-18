// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ALTCHA proof-of-work for signups (self-hosted, no third party). Challenges are
 * HMAC-signed and short-lived; a solved challenge is accepted once (its signature
 * is recorded in Valkey until it expires) so a solution cannot be replayed.
 */
import { createChallenge, randomInt, verifySolution, type Challenge, type Solution } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/sha";
import type { ValkeyClient } from "@commonair/service";
import { hmacHex } from "@commonair/tokens";

export const ALTCHA_ALGORITHM = "SHA-256";
export const ALTCHA_TTL_SECONDS = 600;
/** Expected work: the solver tries on average half this many hashes. */
export const ALTCHA_MAX_COUNTER = 50_000;

export interface AltchaOptions {
  hmacKey: string;
  maxCounter?: number;
  now?: () => number;
}

/** Separate key for derived-key signatures, so the challenge key alone cannot mint solutions. */
const keySignatureSecret = (hmacKey: string) => hmacHex(hmacKey, "altcha-key-signature-v1");

export async function newChallenge(opts: AltchaOptions): Promise<Challenge> {
  const nowSeconds = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  return createChallenge({
    algorithm: ALTCHA_ALGORITHM,
    cost: 1,
    counter: randomInt(opts.maxCounter ?? ALTCHA_MAX_COUNTER),
    deriveKey,
    expiresAt: nowSeconds + ALTCHA_TTL_SECONDS,
    hmacSignatureSecret: opts.hmacKey,
    hmacKeySignatureSecret: await keySignatureSecret(opts.hmacKey),
  });
}

export type AltchaFailure = "missing" | "malformed" | "invalid" | "expired" | "replayed";

/** Decode the widget payload: base64(JSON {challenge, solution}). */
export function decodePayload(raw: unknown): { challenge: Challenge; solution: Solution } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as { challenge?: Challenge; solution?: Solution };
    if (!p.challenge?.parameters || !p.solution) return null;
    return { challenge: p.challenge, solution: p.solution };
  } catch {
    return null;
  }
}

export async function verifyAltcha(
  raw: unknown,
  opts: AltchaOptions & { valkey: ValkeyClient },
): Promise<AltchaFailure | null> {
  if (raw === undefined || raw === null || raw === "") return "missing";
  const payload = decodePayload(raw);
  if (!payload) return "malformed";
  let result;
  try {
    result = await verifySolution({
      challenge: payload.challenge,
      solution: payload.solution,
      deriveKey,
      hmacSignatureSecret: opts.hmacKey,
      hmacKeySignatureSecret: await keySignatureSecret(opts.hmacKey),
    });
  } catch {
    return "malformed";
  }
  if (result.expired) return "expired";
  if (!result.verified) return "invalid";
  const sig = payload.challenge.signature ?? "";
  const first = await opts.valkey.set(`altcha:used:${sig}`, "1", "EX", ALTCHA_TTL_SECONDS, "NX");
  return first === "OK" ? null : "replayed";
}
