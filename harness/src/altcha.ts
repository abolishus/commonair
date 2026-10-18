// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Solve the API's ALTCHA proof-of-work challenge the way the browser widget does, using
 * `altcha-lib`'s own solver. Supports both the v2 challenge format (`{ parameters, signature }`)
 * and the v1 format (`{ algorithm, challenge, salt, signature, maxnumber }`), so the harness works
 * whichever one the API emits. Returns the base64 payload the widget would submit.
 */
import { solveChallenge } from "altcha-lib";
import type { Challenge, DeriveKeyFunction } from "altcha-lib/types";
import { solveChallenge as solveChallengeV1 } from "altcha-lib/v1";

interface V1Challenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber?: number;
}

function isV2(c: unknown): c is Challenge {
  return typeof c === "object" && c !== null && "parameters" in c;
}

function isV1(c: unknown): c is V1Challenge {
  return typeof c === "object" && c !== null && "challenge" in c && "salt" in c && "algorithm" in c;
}

async function deriveKeyFor(algorithm: string): Promise<DeriveKeyFunction> {
  const upper = algorithm.toUpperCase();
  if (upper.startsWith("PBKDF2")) return (await import("altcha-lib/algorithms/pbkdf2")).deriveKey;
  if (upper === "SCRYPT") return (await import("altcha-lib/algorithms/scrypt")).deriveKey;
  if (upper === "ARGON2ID") return (await import("altcha-lib/algorithms/argon2id")).deriveKey;
  return (await import("altcha-lib/algorithms/sha")).deriveKey;
}

function toBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Solve a challenge object (as returned by the challenge endpoint) into a submit payload. */
export async function solveAltcha(challenge: unknown, timeoutMs = 60_000): Promise<string> {
  if (isV2(challenge)) {
    const started = performance.now();
    const solution = await solveChallenge({
      challenge,
      deriveKey: await deriveKeyFor(challenge.parameters.algorithm),
      timeout: timeoutMs,
    });
    if (!solution) throw new Error("ALTCHA challenge not solved before the timeout");
    const { codeChallenge: _omit, ...rest } = challenge;
    return toBase64({ challenge: rest, solution: { ...solution, time: solution.time ?? performance.now() - started } });
  }
  if (isV1(challenge)) {
    const started = performance.now();
    const { promise, controller } = solveChallengeV1(
      challenge.challenge,
      challenge.salt,
      challenge.algorithm,
      challenge.maxnumber ?? 1_000_000,
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const solution = await promise;
      if (!solution) throw new Error("ALTCHA challenge not solved before the timeout");
      return toBase64({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number: solution.number,
        salt: challenge.salt,
        signature: challenge.signature,
        took: Math.round(performance.now() - started),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("unrecognized ALTCHA challenge format");
}
