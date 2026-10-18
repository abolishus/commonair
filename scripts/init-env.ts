// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Create `.env` from `.env.example`, replacing every `__generate__` placeholder
 * with a fresh random secret. Never overwrites an existing `.env` unless --force.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateSigningKey, randomSecret } from "../packages/tokens/src/index.ts";

const outIdx = process.argv.indexOf("--out");
const target = outIdx === -1 ? ".env" : process.argv[outIdx + 1];
if (!target || target.startsWith("--")) {
  console.error("usage: bun scripts/init-env.ts [--out <path>] [--force]");
  process.exit(2);
}
if (existsSync(target) && !process.argv.includes("--force")) {
  console.error(`${target} already exists (use --force to regenerate)`);
  process.exit(1);
}

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const { pkcs8B64 } = await generateSigningKey();

const out = readFileSync(".env.example", "utf8")
  .replace(/\r\n/g, "\n")
  .split("\n")
  .map((line) => {
    const [key] = line.split("=");
    if (line.endsWith("=__generate_ed25519__")) return `${key}=${pkcs8B64}`;
    if (!line.endsWith("=__generate__")) return line;
    // Garage requires its own key formats: GK + 24 hex for ids, 64 hex for secrets.
    if (key === "S3_ACCESS_KEY_ID") return `${key}=GK${hex(12)}`;
    if (key === "S3_SECRET_ACCESS_KEY") return `${key}=${hex(32)}`;
    return `${key}=${randomSecret("", 32)}`;
  })
  .join("\n");

writeFileSync(target, out, { mode: 0o600 });
chmodSync(target, 0o600); // the mode option does not apply when overwriting an existing file
console.log(`wrote ${target}`);
