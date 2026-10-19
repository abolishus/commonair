// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Password hashes that better-auth 1.7.10 (services/api) accepts, written without depending on
 * better-auth from the db package. Mirrors `@better-auth/utils/password` (node build, 0.5.0):
 * scrypt N=16384, r=16, p=1, 64-byte key over the NFKC-normalized password, salted with the
 * *hex string* of 16 random bytes, stored as `<salt hex>:<key hex>`. If better-auth changes
 * this format, the sign-in test in services/api/tests/demo-seed.int.test.ts fails.
 */
import { randomBytes, scrypt } from "node:crypto";

const SCRYPT = { N: 16_384, r: 16, p: 1, dkLen: 64 } as const;

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      SCRYPT.dkLen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await deriveKey(password, salt)).toString("hex")}`;
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  return (await deriveKey(password, salt)).toString("hex") === key;
}

/** better-auth's limits in services/api (minPasswordLength 10, maxPasswordLength 256). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

/** A strong random password (24 base64url characters, ~144 bits). */
export const generatePassword = (): string => randomBytes(18).toString("base64url");

/** Why `password` cannot be used for demo accounts, or null. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `must be at most ${PASSWORD_MAX} characters`;
  return null;
}
