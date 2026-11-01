// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, createPublicKey, createVerify } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  AS2_CONTEXT,
  DATE_SKEW_SECONDS,
  digest,
  exportPublicKeyPem,
  FEDERATION_OBJECT_KINDS,
  generateActorKey,
  importPrivateKeyPem,
  importPublicKeyPem,
  parseSignatureHeader,
  pkcs1ToSpki,
  publicKeyPemFromPrivate,
  signRequest,
  verifyDigest,
  verifyRequest,
} from "../src/index.ts";
import { DATE, federationVectors, KEYS, NOW } from "../src/vectors.ts";
import vectors from "../vectors.json" with { type: "json" };

const pub = vectors.publicKeys;

describe("vectors", () => {
  test("the committed file is exactly what the generator produces", async () => {
    expect(await federationVectors()).toEqual(vectors);
  });

  test("the public keys belong to the test private keys", async () => {
    expect(await publicKeyPemFromPrivate(KEYS.actor)).toBe(pub.actor);
    expect(await publicKeyPemFromPrivate(KEYS.other)).toBe(pub.other);
  });

  test.each(vectors.vectors.map((v) => [v.name, v] as const))("%s", async (_, v) => {
    const r = await verifyRequest(v.request, pub[v.verify.key as "actor" | "other"], {
      now: new Date(v.verify.now),
      ...(v.verify.actorId ? { actorId: v.verify.actorId } : {}),
    });
    expect(r.ok ? "ok" : r.error).toBe(v.expect);
  });

  test.each(vectors.vectors.filter((v) => v.signingString).map((v) => [v.name, v] as const))(
    "%s: node:crypto verifies the signing string independently",
    (_, v) => {
      const params = parseSignatureHeader(v.request.headers.signature as string);
      expect(params).not.toBeNull();
      const ok = createVerify("RSA-SHA256")
        .update(v.signingString as string)
        .verify(createPublicKey(pub.actor), Buffer.from(params?.signature ?? "", "base64"));
      expect(ok).toBe(true);
      const body = v.request.body;
      expect(v.request.headers.digest).toBe(
        body === undefined ? undefined : `SHA-256=${createHash("sha256").update(body).digest("base64")}`,
      );
    },
  );

  test("every tamper case named in the contract step is covered", () => {
    const errors = new Set(vectors.vectors.map((v) => v.expect));
    for (const e of ["digest_mismatch", "date_skew", "key_actor_mismatch", "bad_signature", "missing_header"])
      expect(errors.has(e)).toBe(true);
  });
});

describe("signRequest", () => {
  test("is deterministic and keeps a given date", async () => {
    const inbound = vectors.vectors[0]?.request;
    if (!inbound) throw new Error("no vector");
    const headers = await signRequest({
      method: "POST",
      url: inbound.url,
      headers: { "Content-Type": inbound.headers["content-type"] as string, Date: DATE },
      body: inbound.body,
      keyId: "https://mastodon.example/users/alice#main-key",
      privateKey: await importPrivateKeyPem(KEYS.actor),
    });
    expect(headers).toEqual(inbound.headers);
  });

  test("a fresh key round-trips and uses the current date by default", async () => {
    const key = await generateActorKey();
    expect(key.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(key.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(await publicKeyPemFromPrivate(key.privateKeyPem)).toBe(key.publicKeyPem);
    const body = JSON.stringify({ type: "Follow", actor: "https://peer.example/u/a" });
    const headers = await signRequest({
      method: "POST",
      url: "https://instance.example/ap/inbox?x=1",
      body,
      keyId: "https://peer.example/u/a#main-key",
      privateKey: key.privateKeyPem,
    });
    expect(Math.abs(Date.parse(headers.date as string) - Date.now())).toBeLessThan(5_000);
    const req = { method: "POST", url: "https://instance.example/ap/inbox?x=1", headers, body };
    expect(await verifyRequest(req, key.publicKeyPem)).toEqual({
      ok: true,
      keyId: "https://peer.example/u/a#main-key",
      actorId: "https://peer.example/u/a",
      headers: ["(request-target)", "host", "date", "digest"],
    });
    // The query string is part of the request target.
    expect(await verifyRequest({ ...req, url: "https://instance.example/ap/inbox" }, key.publicKeyPem)).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });

  test("Headers objects and Authorization: Signature are accepted", async () => {
    const inbound = vectors.vectors[0]?.request;
    if (!inbound) throw new Error("no vector");
    const h = new Headers(inbound.headers as unknown as Record<string, string>);
    const sig = h.get("signature") as string;
    h.delete("signature");
    h.set("authorization", `Signature ${sig}`);
    const r = await verifyRequest({ ...inbound, headers: h }, pub.actor, { now: new Date(NOW) });
    expect(r.ok).toBe(true);
    // An Authorization header of another scheme is not a signature.
    h.set("authorization", "Bearer abc");
    expect(await verifyRequest({ ...inbound, headers: h }, pub.actor, { now: new Date(NOW) })).toEqual({
      ok: false,
      error: "missing_signature",
    });
  });

  test("refuses quotes in keyId", async () => {
    await expect(
      signRequest({ method: "GET", url: "https://a.example/", keyId: 'x"y', privateKey: KEYS.actor }),
    ).rejects.toThrow(/keyId/);
  });
});

describe("verifyRequest edges", () => {
  const inbound = vectors.vectors[0]?.request as (typeof vectors.vectors)[0]["request"];
  const now = new Date(NOW);

  test("the default skew is 12 hours", () => {
    expect(DATE_SKEW_SECONDS).toBe(43_200);
  });

  test("a custom skew and an explicit actor are honoured", async () => {
    expect(await verifyRequest(inbound, pub.actor, { now, skewSeconds: 30 })).toEqual({
      ok: false,
      error: "date_skew",
    });
    expect(await verifyRequest(inbound, pub.actor, { now, actorId: "https://other.example/users/alice" })).toEqual({
      ok: false,
      error: "key_actor_mismatch",
    });
    expect(await verifyRequest({ ...inbound, body: "not json" }, pub.actor, { now })).toEqual({
      ok: false,
      error: "key_actor_mismatch",
    });
  });

  test("an actor object with an id is read from the body", async () => {
    const body = JSON.stringify({ type: "Delete", actor: { id: "https://mastodon.example/users/alice" } });
    const headers = await signRequest({
      method: "POST",
      url: inbound.url,
      body,
      keyId: "https://mastodon.example/users/alice#main-key",
      privateKey: KEYS.actor,
      now,
    });
    expect((await verifyRequest({ method: "POST", url: inbound.url, headers, body }, pub.actor, { now })).ok).toBe(
      true,
    );
  });

  test("a bad key or signature encoding is refused", async () => {
    expect(await verifyRequest(inbound, "not a pem", { now })).toEqual({ ok: false, error: "bad_key" });
    const bad = {
      ...inbound.headers,
      signature: (inbound.headers.signature as string).replace(/signature="[^"]*"/, 'signature="%%%"'),
    };
    expect(await verifyRequest({ ...inbound, headers: bad }, pub.actor, { now })).toEqual({
      ok: false,
      error: "malformed_signature",
    });
  });
});

describe("parseSignatureHeader", () => {
  test("parses the Mastodon shape", () => {
    expect(
      parseSignatureHeader('keyId="k",algorithm="RSA-SHA256",headers="(request-target) Host date",signature="c2ln"'),
    ).toEqual({
      keyId: "k",
      algorithm: "rsa-sha256",
      headers: ["(request-target)", "host", "date"],
      signature: "c2ln",
    });
    expect(parseSignatureHeader('keyId="k", signature="c2ln"')?.headers).toEqual(["date"]);
  });

  test.each([
    "",
    'keyId="k"',
    'signature="s"',
    'keyId="k",keyId="j",signature="s"',
    'keyId="k",signature="s",headers="date date"',
    'keyId="k",signature="s",headers=""',
    'keyId="k" signature="s"',
    `keyId="${"k".repeat(5000)}",signature="s"`,
  ])("refuses %j", (h) => {
    expect(parseSignatureHeader(h)).toBeNull();
  });
});

describe("digest", () => {
  test("matches node:crypto and accepts strings or bytes", async () => {
    const want = `SHA-256=${createHash("sha256").update("hello").digest("base64")}`;
    expect(await digest("hello")).toBe(want);
    expect(await digest(new TextEncoder().encode("hello"))).toBe(want);
  });

  test("verifyDigest wants a matching SHA-256 entry", async () => {
    const d = await digest("hello");
    expect(await verifyDigest(d, "hello")).toBe(true);
    expect(await verifyDigest(d.replace("SHA-256", "sha-256"), "hello")).toBe(true);
    expect(await verifyDigest(`MD5=abc, ${d}`, "hello")).toBe(true);
    expect(await verifyDigest(d, "hellO")).toBe(false);
    expect(await verifyDigest("SHA-512=abc", "hello")).toBe(false);
    expect(await verifyDigest("", "hello")).toBe(false);
  });
});

describe("keys", () => {
  test("PKCS#1 public keys are wrapped into SPKI", async () => {
    const spki = createPublicKey(pub.actor);
    const pkcs1Pem = spki.export({ type: "pkcs1", format: "pem" }) as string;
    const key = await importPublicKeyPem(pkcs1Pem);
    expect(await exportPublicKeyPem(key)).toBe(pub.actor);
    const der = spki.export({ type: "pkcs1", format: "der" });
    expect(Buffer.from(pkcs1ToSpki(der)).equals(spki.export({ type: "spki", format: "der" }))).toBe(true);
  });

  test("small keys, wrong labels and garbage are refused", async () => {
    const small = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    await expect(importPublicKeyPem(await exportPublicKeyPem(small.publicKey))).rejects.toThrow(/size/);
    await expect(importPublicKeyPem(KEYS.actor)).rejects.toThrow(/unsupported/);
    await expect(importPrivateKeyPem(pub.actor)).rejects.toThrow(/unsupported/);
    await expect(importPublicKeyPem("hello")).rejects.toThrow(/PEM/);
    await expect(importPublicKeyPem(pub.actor.replace("END PUBLIC", "END PRIVATE"))).rejects.toThrow(/PEM/);
  });
});

test("the N4-delivery stubs are exported", () => {
  expect(AS2_CONTEXT).toBe("https://www.w3.org/ns/activitystreams");
  expect(FEDERATION_OBJECT_KINDS).toEqual(["note", "video"]);
});
