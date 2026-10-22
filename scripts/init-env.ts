// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Create `.env` from `.env.example`, replacing every `__generate__` placeholder
 * with a fresh random secret. Never overwrites an existing `.env` unless --force.
 * --merge keeps every value already in the target and only fills keys it lacks, so new
 * variables can be added without rotating secrets (an existing Postgres volume keeps its
 * password). VALKEY_PASSWORD is generated with the rest and written into VALKEY_URL as well.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateSigningKey, randomSecret } from "../packages/tokens/src/index.ts";

const outIdx = process.argv.indexOf("--out");
const target = outIdx === -1 ? ".env" : process.argv[outIdx + 1];
if (!target || target.startsWith("--")) {
  console.error("usage: bun scripts/init-env.ts [--out <path>] [--force | --merge]");
  process.exit(2);
}
const merge = process.argv.includes("--merge");
const existing = new Map<string, string>();
if (merge && existsSync(target)) {
  for (const line of readFileSync(target, "utf8").replace(/\r\n/g, "\n").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) existing.set(m[1], m[2]);
  }
}
if (existsSync(target) && !merge && !process.argv.includes("--force")) {
  console.error(`${target} already exists (use --force to regenerate)`);
  process.exit(1);
}

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const { pkcs8B64 } = await generateSigningKey();
// Evidence keypair (ADR 0006 Q4): raw 32-byte public key and PKCS#8 private key, base64.
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const evidence = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
const evidencePublic = b64(await crypto.subtle.exportKey("raw", evidence.publicKey));
const evidencePrivate = b64(await crypto.subtle.exportKey("pkcs8", evidence.privateKey));
// A merge must never pair a kept half of the keypair with a fresh other half.
if (existing.has("EVIDENCE_PUBLIC_KEY") !== existing.has("EVIDENCE_PRIVATE_KEY")) {
  console.error(`${target} has only one half of the evidence keypair; restore the other half or remove both`);
  process.exit(1);
}

// Valkey's password also goes into VALKEY_URL (redis://:<password>@host:port), so the two are
// written together: a fresh password is added to a URL without one, which is also how a merge
// upgrades an older file. A kept password (even an empty one: no password) leaves a kept URL be.
const valkeyPasswordIsNew = !existing.has("VALKEY_PASSWORD");
const valkeyPassword = existing.get("VALKEY_PASSWORD") ?? hex(32);
function valkeyUrl(url: string): string {
  if (!valkeyPassword || (existing.has("VALKEY_URL") && !valkeyPasswordIsNew)) return url;
  try {
    const u = new URL(url);
    if (u.password || !u.host) return url;
    u.password = valkeyPassword;
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

const out = readFileSync(".env.example", "utf8")
  .replace(/\r\n/g, "\n")
  .split("\n")
  .map((line) => {
    const [key] = line.split("=");
    if (key === "VALKEY_PASSWORD") return `${key}=${valkeyPassword}`;
    if (key === "VALKEY_URL") return `${key}=${valkeyUrl(existing.get(key) ?? line.slice(line.indexOf("=") + 1))}`;
    if (key !== undefined && existing.has(key)) return `${key}=${existing.get(key)}`;
    if (line.endsWith("=__generate_ed25519__")) return `${key}=${pkcs8B64}`;
    if (line.endsWith("=__generate_hex64__")) return `${key}=${hex(32)}`;
    if (line.endsWith("=__generate_x25519_public__")) return `${key}=${evidencePublic}`;
    if (line.endsWith("=__generate_x25519_private__")) return `${key}=${evidencePrivate}`;
    if (!line.endsWith("=__generate__")) return line;
    // Garage requires its own key formats: GK + 24 hex for ids, 64 hex for secrets.
    if (key === "S3_ACCESS_KEY_ID" || key === "S3_EVIDENCE_ACCESS_KEY_ID") return `${key}=GK${hex(12)}`;
    if (key === "S3_SECRET_ACCESS_KEY" || key === "S3_EVIDENCE_SECRET_ACCESS_KEY") return `${key}=${hex(32)}`;
    return `${key}=${randomSecret("", 32)}`;
  })
  .join("\n");

writeFileSync(target, out, { mode: 0o600 });
chmodSync(target, 0o600); // the mode option does not apply when overwriting an existing file
console.log(`wrote ${target}`);
