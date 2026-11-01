// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API can never sign an attestation (batch 6 decision (l), ADR 0014 decision 1): no source
 * file reads `INTEGRITY_SIGNING_KEY`, loads `attestationEnv`, imports a signing primitive from
 * `@commonair/tokens/attestation`, or imports the worker. Plus the pure entry mapping.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { toEntry } from "../src/routes/attestation-verify.ts";
import { attestationShareUrl } from "../src/routes/integrity.ts";

const SRC = path.resolve(import.meta.dirname, "../src");

async function sources(): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for (const f of await readdir(SRC, { recursive: true })) {
    if (!f.endsWith(".ts")) continue;
    out.push({ file: f, text: await readFile(path.join(SRC, f), "utf8") });
  }
  return out;
}

describe("the API holds no attestation signing key", () => {
  test("no source names the key, its env schema, or a signing primitive", async () => {
    const offenders: string[] = [];
    for (const { file, text } of await sources()) {
      // Comments may say why the key is absent; code may not touch it.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (/INTEGRITY_SIGNING_KEY|attestationEnv|importAttestationSigningKey|AttestationSigningKey/.test(code))
        offenders.push(file);
      for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@commonair\/tokens\/attestation"/g))
        if (/\bsign\b|newReasonsSalt/.test(m[1] ?? "")) offenders.push(`${file} (imports a signing primitive)`);
      if (/from\s+"[^"]*services\/worker|from\s+"@commonair\/worker/.test(code))
        offenders.push(`${file} (imports the worker)`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("toEntry", () => {
  const row = {
    id: "01890000-0000-7000-8000-0000000000e1",
    channelId: "01890000-0000-7000-8000-00000000c001",
    broadcastId: "01890000-0000-7000-8000-00000000b001",
    seq: 2,
    kind: "supersede" as const,
    kid: "OfcT0KZEJT8EUpQhufUbmw",
    payload: "p",
    signature: "s",
    entryHash: "a".repeat(64),
    prevHash: "b".repeat(64),
    supersedes: "b".repeat(64),
    signedAt: new Date("2026-11-01T00:00:00.000Z"),
    breakdown: { datacenter: 60 },
    salt: "salt",
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
  };
  test("reveals breakdown and salt only when asked", () => {
    expect(toEntry(row, { channelSlug: "c", superseded: false, reveal: true })).toMatchObject({
      breakdown: { datacenter: 60 },
      salt: "salt",
      envelope: { payload: "p", signature: "s" },
      signedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(toEntry(row, { channelSlug: "c", superseded: true, reveal: false })).toMatchObject({
      breakdown: null,
      salt: null,
      superseded: true,
    });
  });
});

test("share URLs point at the API's shared view, token encoded", () => {
  const deps = { env: { API_PUBLIC_URL: "https://api.example.test/" } } as Parameters<typeof attestationShareUrl>[0];
  expect(attestationShareUrl(deps, "abc")).toBe("https://api.example.test/api/attestations/shared/abc");
});
