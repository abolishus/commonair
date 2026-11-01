// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { ZodError } from "zod";
import vectors from "../vectors.json" with { type: "json" };
import {
  type AttestationKey,
  type AttestationStatement,
  canonicalize,
  deriveKid,
  entryHash,
  fromB64url,
  importAttestationSigningKey,
  newReasonsSalt,
  reasonsCommitment,
  type SignedAttestation,
  sign,
  stableJson,
  thresholdsHash,
  toB64url,
  verify,
} from "../src/attestation.ts";
import { attestationVectors } from "../src/attestation-vectors.ts";

const v = vectors.attestation;
const statement = v.statement as AttestationStatement;
const keys = v.keys as AttestationKey[];

describe("attestation vectors", () => {
  test("the committed section is what the generator produces (bun run vectors)", async () => {
    expect(JSON.parse(JSON.stringify(await attestationVectors()))).toEqual(v);
  });

  test("the RFC 8032 test vector 2 key and its derived kid", async () => {
    const key = await importAttestationSigningKey(v.privateKeyPkcs8);
    expect(key.publicKey).toBe(v.publicKey);
    expect(Buffer.from(v.publicKey, "base64url").toString("hex")).toBe(
      "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    );
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.from(v.publicKey, "base64url")));
    expect(v.kid).toBe(Buffer.from(digest.slice(0, 16)).toString("base64url"));
    expect(v.kid).toHaveLength(22);
    expect(await deriveKid(v.publicKey)).toBe(v.kid);
    expect(key.kid).toBe(v.kid);
  });

  test("canonical bytes, signature and entry hash match", async () => {
    const key = await importAttestationSigningKey(v.privateKeyPkcs8);
    expect(new TextDecoder().decode(canonicalize(statement))).toBe(v.canonical);
    expect(Buffer.from(v.signed.payload, "base64url").toString("utf8")).toBe(v.canonical);
    expect(await sign(key, statement)).toEqual(v.signed);
    expect(await entryHash(v.signed)).toBe(v.entryHash);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v.canonical)));
    expect(v.entryHash).toBe(Buffer.from(digest).toString("hex"));
  });

  test("the supersede entry links to the broadcast entry", async () => {
    expect(v.supersede.statement.prevHash).toBe(v.entryHash);
    expect(v.supersede.statement.supersedes).toBe(v.entryHash);
    expect(v.supersede.statement.seq).toBe(2);
    expect(await entryHash(v.supersede.signed)).toBe(v.supersede.entryHash);
  });

  test("commitments match", async () => {
    expect(await reasonsCommitment(v.reasons.salt, v.reasons.breakdown)).toBe(v.reasons.commitment);
    expect(await thresholdsHash(v.thresholds.rulesetVersion, v.thresholds.thresholds)).toBe(v.thresholds.hash);
    expect(statement.reasonsCommitment).toBe(v.reasons.commitment);
    expect(statement.thresholdsHash).toBe(v.thresholds.hash);
  });

  test.each(v.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const r = await verify(c.signed, (c.keys ?? keys) as AttestationKey[]);
    expect(r.ok ? null : r.error).toBe(c.error);
  });

  test("valid cases also verify against the bare public key", async () => {
    const r = await verify(v.signed, v.publicKey);
    expect(r).toMatchObject({ ok: true, entryHash: v.entryHash, key: null, statement });
  });
});

describe("canonicalize", () => {
  test("input key order does not change the bytes", () => {
    const reversed = Object.fromEntries(Object.entries(statement).reverse()) as AttestationStatement;
    expect(new TextDecoder().decode(canonicalize(reversed))).toBe(v.canonical);
  });

  test.each<[string, Partial<Record<keyof AttestationStatement, unknown>>]>([
    ["a float figure", { verifiedViewerSeconds: 1.5 }],
    ["a negative figure", { durationSeconds: -1 }],
    ["an unsafe integer", { verifiedViewerSeconds: Number.MAX_SAFE_INTEGER + 1 }],
    ["a string figure", { peakVerifiedConcurrent: "42" }],
    ["seq 0", { seq: 0 }],
    ["a second entry with no prevHash", { seq: 2 }],
    ["a first entry with a prevHash", { prevHash: "0".repeat(64) }],
    ["a broadcast entry that supersedes", { supersedes: "0".repeat(64) }],
    ["a supersede that supersedes nothing", { kind: "supersede" }],
    ["an unknown kind", { kind: "edit" }],
    ["a non-UTC timestamp", { signedAt: "2023-11-15T02:13:20+00:00" }],
    ["a timestamp without milliseconds", { signedAt: "2023-11-15T02:13:20Z" }],
    ["a period ending before it starts", { periodEnd: "2023-11-14T22:13:19.000Z" }],
    ["an origin with a path", { origin: "https://instance.example/" }],
    ["an uppercase hash", { thresholdsHash: "A".repeat(64) }],
    ["a short kid", { kid: "abc" }],
    ["a missing field", { reasonsCommitment: undefined }],
  ])("refuses %s", (_name, patch) => {
    expect(() => canonicalize({ ...statement, ...patch } as AttestationStatement)).toThrow(ZodError);
  });

  test("refuses unknown fields and unknown delivery sources", () => {
    expect(() => canonicalize({ ...statement, note: "x" } as AttestationStatement)).toThrow(ZodError);
    expect(() =>
      canonicalize({ ...statement, deliveryBytes: { ...statement.deliveryBytes, p2p: 1 } } as AttestationStatement),
    ).toThrow(ZodError);
  });
});

describe("sign and verify", () => {
  test("sign refuses a statement whose kid is not the key's", async () => {
    const key = await importAttestationSigningKey(v.privateKeyPkcs8);
    await expect(sign(key, { ...statement, kid: "A".repeat(22) })).rejects.toThrow(/kid/);
  });

  test("a fresh key round-trips and its kid is derived", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const key = await importAttestationSigningKey(pkcs8);
    const s = { ...statement, kid: key.kid };
    const signed = await sign(key, s);
    expect(await verify(signed, key.publicKey)).toMatchObject({ ok: true, statement: s });
    // The vector key's history does not know this kid.
    expect(await verify(signed, keys)).toEqual({ ok: false, error: "unknown_kid" });
    // A bare key that is not the signer's: the signature fails before the kid is compared.
    expect(await verify(signed, v.publicKey)).toEqual({ ok: false, error: "bad_signature" });
  });

  test("single-key verification refuses a statement naming another kid", async () => {
    const key = await importAttestationSigningKey(v.privateKeyPkcs8);
    const bytes = new TextEncoder().encode(v.canonical.replace(v.kid, "A".repeat(22)));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, bytes));
    const signed: SignedAttestation = { payload: toB64url(bytes), signature: toB64url(sig) };
    expect(await verify(signed, v.publicKey)).toEqual({ ok: false, error: "kid_mismatch" });
  });

  test.each<[string, SignedAttestation]>([
    ["empty", { payload: "", signature: "" }],
    ["not base64url", { payload: "***", signature: v.signed.signature }],
    ["not JSON", { payload: toB64url(new TextEncoder().encode("nope")), signature: v.signed.signature }],
    ["JSON null", { payload: toB64url(new TextEncoder().encode("null")), signature: v.signed.signature }],
    ["invalid UTF-8", { payload: toB64url(Uint8Array.of(0xff, 0xfe)), signature: v.signed.signature }],
  ])("malformed envelope: %s", async (_name, signed) => {
    expect(await verify(signed, keys)).toEqual({ ok: false, error: "malformed" });
    expect((await verify(signed, v.publicKey)).ok).toBe(false);
  });

  test("a malformed public key is malformed, not a crash", async () => {
    expect(await verify(v.signed, "short")).toEqual({ ok: false, error: "malformed" });
  });
});

describe("hash helpers", () => {
  test("stableJson sorts keys at every depth and refuses non-JSON values", () => {
    expect(stableJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}',
    );
    expect(stableJson({ a: undefined, b: true })).toBe('{"b":true}');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1, new Date(0), undefined])
      expect(() => stableJson(bad)).toThrow(/^stableJson: /);
  });

  test("reasonsCommitment binds the salt and every reason", async () => {
    const base = await reasonsCommitment(v.reasons.salt, v.reasons.breakdown);
    expect(await reasonsCommitment(v.reasons.salt, { ...v.reasons.breakdown, fetch_pattern: 1_201 })).not.toBe(base);
    expect(await reasonsCommitment(newReasonsSalt(), v.reasons.breakdown)).not.toBe(base);
    const reordered = Object.fromEntries(Object.entries(v.reasons.breakdown).reverse());
    expect(await reasonsCommitment(v.reasons.salt, reordered)).toBe(base);
    await expect(reasonsCommitment(v.reasons.salt, { a: 1.5 })).rejects.toThrow(/not a non-negative integer/);
    await expect(reasonsCommitment(v.reasons.salt, { a: -1 })).rejects.toThrow(/not a non-negative integer/);
    await expect(reasonsCommitment(toB64url(new Uint8Array(8)), {})).rejects.toThrow(/16 bytes/);
    expect(fromB64url(newReasonsSalt())).toHaveLength(32);
  });

  test("thresholdsHash changes with the ruleset version and any threshold", async () => {
    const t = v.thresholds;
    expect(await thresholdsHash(t.rulesetVersion + 1, t.thresholds)).not.toBe(t.hash);
    expect(await thresholdsHash(t.rulesetVersion, { ...t.thresholds, minWatchSeconds: 61 })).not.toBe(t.hash);
  });

  test("base64url helpers round-trip and are strict", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(toB64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
      expect(fromB64url(toB64url(bytes))).toEqual(bytes);
    }
    expect(() => fromB64url("AA==")).toThrow(/invalid base64url/);
    expect(() => fromB64url("AB")).toThrow(/non-canonical/);
    expect(() => fromB64url("A")).toThrow(/invalid base64url/);
    expect(() => fromB64url("a+b/")).toThrow(/invalid base64url/);
  });
});

describe("self-contained (ADR 0035, batch 6 decision (q))", () => {
  const source = readFileSync(path.join(import.meta.dirname, "../src/attestation.ts"), "utf8");

  test("dual-licensed header", () => {
    const tag = ["SPDX", "License", "Identifier"].join("-");
    expect(source.split("\n").slice(0, 3).join("\n")).toContain(`${tag}: AGPL-3.0-or-later OR Apache-2.0`);
  });

  test("imports zod only, and no Node or Bun API", () => {
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["zod"]);
    expect(source).not.toMatch(/\bBuffer\b|\bBun\.|node:|process\./);
  });
});
