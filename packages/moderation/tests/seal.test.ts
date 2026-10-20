// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  SEAL_HEADER_BYTES,
  SEAL_OVERHEAD_BYTES,
  SealError,
  evidenceKeyId,
  importOpeningKey,
  importSealingKey,
  openJson,
  plaintextSha256,
  sealJson,
} from "../src/seal.ts";

async function keypair() {
  const k = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
  };
  return {
    pub: Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64"),
    priv: Buffer.from(await crypto.subtle.exportKey("pkcs8", k.privateKey)).toString("base64"),
  };
}

describe("evidence seal", () => {
  test("round-trips, with a fresh ephemeral key and nonce every time", async () => {
    const { pub, priv } = await keypair();
    const sealer = await importSealingKey(pub);
    const opener = await importOpeningKey(priv);
    expect(sealer.keyId).toMatch(/^[0-9a-f]{32}$/);
    expect(opener.keyId).toBe(sealer.keyId);
    expect(await evidenceKeyId(pub)).toBe(sealer.keyId);
    const plain = crypto.getRandomValues(new Uint8Array(4096));
    const a = await sealer.seal(plain);
    const b = await sealer.seal(plain);
    expect(a.length).toBe(plain.length + SEAL_OVERHEAD_BYTES);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a.subarray(0, 4)).toString()).toBe("CAEV");
    expect(a[4]).toBe(1);
    expect(Buffer.from(await opener.open(a)).equals(Buffer.from(plain))).toBe(true);
    expect(Buffer.from(await opener.open(b)).equals(Buffer.from(plain))).toBe(true);
  });

  test("empty and 1 MiB plaintexts fit the evidence_objects limit", async () => {
    const { pub, priv } = await keypair();
    const sealer = await importSealingKey(pub);
    const opener = await importOpeningKey(priv);
    expect((await opener.open(await sealer.seal(new Uint8Array(0)))).length).toBe(0);
    const big = await sealer.seal(new Uint8Array(1_048_576));
    expect(big.length).toBeLessThanOrEqual(1_049_600);
  });

  test("any changed byte, a truncated object or another key fails", async () => {
    const { pub, priv } = await keypair();
    const other = await keypair();
    const sealer = await importSealingKey(pub);
    const opener = await importOpeningKey(priv);
    const sealed = await sealer.seal(new TextEncoder().encode("synthetic"));
    for (const i of [0, 4, 5, 21, 53, SEAL_HEADER_BYTES, sealed.length - 1]) {
      const t = sealed.slice();
      t[i] = (t[i] ?? 0) ^ 1;
      await expect(opener.open(t)).rejects.toBeInstanceOf(SealError);
    }
    await expect(opener.open(sealed.subarray(0, SEAL_OVERHEAD_BYTES - 1))).rejects.toBeInstanceOf(SealError);
    await expect((await importOpeningKey(other.priv)).open(sealed)).rejects.toThrow(/different evidence key/);
  });

  test("the public key alone cannot open, and a wrong-length key is refused", async () => {
    await expect(importSealingKey(Buffer.alloc(31).toString("base64"))).rejects.toBeInstanceOf(SealError);
    const { pub } = await keypair();
    await expect(importOpeningKey(pub)).rejects.toThrow(/./);
  });

  test("JSON snapshots and the plaintext digest", async () => {
    const { pub, priv } = await keypair();
    const value = { v: 1, account: { id: "u1" } };
    const sealed = await sealJson(await importSealingKey(pub), value);
    expect(await openJson(await importOpeningKey(priv), sealed)).toEqual(value);
    expect(await plaintextSha256(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
