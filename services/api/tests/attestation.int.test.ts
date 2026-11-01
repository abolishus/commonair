// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity.attestations.*`, the public verifier and `/.well-known/commonair-attestation` over
 * HTTP, against chain rows written here (the worker's job has its own tests; this file signs with
 * a test key only to have rows, the API itself never signs): owner and editor views, the 24 h
 * publication delay and its bypass, share links (expiring, revocable, checked against the
 * commitment), the contiguous public bundle, the verifier's answers, the key history, and the
 * audited key compromise.
 */
import { generateKeyPairSync } from "node:crypto";
import type { AttestationBundle, AttestationEntry, AttestationShareLink } from "@commonair/contracts/dto";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import {
  type AttestationSigningKey,
  type AttestationStatement,
  canonicalize,
  entryHash,
  importAttestationSigningKey,
  newReasonsSalt,
  reasonsCommitment,
  sign,
  toB64url,
} from "@commonair/tokens/attestation";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { loadApiEnv } from "../src/env.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

/** The running API's env as strings, so `loadApiEnv` sees a complete source. */
const envOf = (a: TestApi): Record<string, string> =>
  Object.fromEntries(
    Object.entries(a.deps.env as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(([k, v]) => [k, String(v)]),
  );

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
const HOUR = 3_600_000;

let api: TestApi;
let owner: Person;
let editor: Person;
let other: Person;
let admin: Person;
let channelId: string;
let key: AttestationSigningKey;
let origin: string;
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi({
    rateLimits: { expensive: { max: 1000, windowMs: 3_600_000 } },
    env: { OPS_TEST_HOOKS: "true", WORKER_BULL_PREFIX: `test-attest-${crypto.randomUUID()}` },
  });
  owner = await signUpAndSignIn(api);
  editor = await signUpAndSignIn(api);
  other = await signUpAndSignIn(api);
  admin = await signUpAndSignIn(api);
  await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
  channelId = c!.id;
  await db().insert(schema.channelRoles).values({ channelId, userId: editor.userId, role: "editor" });
  key = await importAttestationSigningKey(
    generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  );
  origin = new URL(api.deps.site.publicUrl).origin;
  await db().insert(schema.integritySigningKeys).values({ kid: key.kid, publicKey: key.publicKey });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

async function broadcastEnded(hoursAgo: number) {
  const endedAt = new Date(Date.now() - hoursAgo * HOUR);
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      id: uuidv7(),
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${owner.username}`,
      startedAt: new Date(endedAt.getTime() - HOUR),
      endedAt,
    })
    .returning();
  return b!;
}

/** Append a signed entry at the head of the owner's chain, as the worker would. */
async function append(
  b: { id: string; startedAt: Date; endedAt: Date | null },
  verified: number,
  o: { kind?: "reissue"; signer?: AttestationSigningKey } = {},
) {
  const signer = o.signer ?? key;
  const [head] = await db()
    .select()
    .from(schema.integrityAttestations)
    .where(eq(schema.integrityAttestations.channelId, channelId))
    .orderBy(desc(schema.integrityAttestations.seq))
    .limit(1);
  const [latest] = await db()
    .select()
    .from(schema.integrityAttestations)
    .where(eq(schema.integrityAttestations.broadcastId, b.id))
    .orderBy(desc(schema.integrityAttestations.seq))
    .limit(1);
  const salt = newReasonsSalt();
  const breakdown = { datacenter: 600 };
  const statement: AttestationStatement = {
    v: 1,
    kind: o.kind ?? (latest ? "supersede" : "broadcast"),
    origin,
    kid: signer.kid,
    channelId,
    broadcastId: b.id,
    seq: (head?.seq ?? 0) + 1,
    prevHash: head?.entryHash ?? null,
    supersedes: latest?.entryHash ?? null,
    periodStart: b.startedAt.toISOString(),
    periodEnd: b.endedAt!.toISOString(),
    signedAt: new Date().toISOString(),
    rulesetVersion: 1,
    thresholdsHash: "a".repeat(64),
    peakVerifiedConcurrent: 2,
    verifiedViewerSeconds: verified,
    durationSeconds: 3600,
    unverifiedViewerSeconds: 0,
    excludedViewerSeconds: 600,
    reasonsCommitment: await reasonsCommitment(salt, breakdown),
    deliveryBytes: { origin: 1, relay: 0, cdn: 0 },
  };
  const signed = await sign(signer, statement);
  const [row] = await db()
    .insert(schema.integrityAttestations)
    .values({
      id: uuidv7(),
      channelId,
      broadcastId: b.id,
      seq: statement.seq,
      kind: statement.kind,
      kid: signer.kid,
      payload: signed.payload,
      signature: signed.signature,
      entryHash: await entryHash(signed),
      prevHash: statement.prevHash,
      supersedes: statement.supersedes,
      signedAt: new Date(),
      breakdown,
      salt,
    })
    .returning();
  return row!;
}

const bypass = (enabled: boolean) =>
  fetch(`${api.url}${INTERNAL_ROUTES.analyticsDisplayBypass}`, {
    method: "PUT",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify({ channelId, enabled }),
  });
const path = (rest = "") => `/api/channels/${owner.username}/attestations${rest}`;
const anon = () => client(api);
const verifyCall = (body: unknown) =>
  anon().call<{
    valid: boolean;
    problem: string | null;
    origin: string | null;
    statement: Record<string, unknown> | null;
  }>("POST", "/api/attestations/verify", body);

let old: Awaited<ReturnType<typeof broadcastEnded>>;
let recent: Awaited<ReturnType<typeof broadcastEnded>>;
let e1: Awaited<ReturnType<typeof append>>;
let e2: Awaited<ReturnType<typeof append>>;
let e3: Awaited<ReturnType<typeof append>>;

describe("the chain as served", () => {
  beforeAll(async () => {
    old = await broadcastEnded(30);
    recent = await broadcastEnded(3);
    e1 = await append(old, 3600); // seq 1
    e2 = await append(recent, 1800); // seq 2: inside the 24 h delay
    e3 = await append(old, 3660); // seq 3: supersedes e1
  });

  test("the owner sees published entries with breakdown and salt; an editor the public statement", async () => {
    const r = await owner.client.call<{ items: AttestationEntry[] }>("GET", path());
    expect(r.status).toBe(200);
    expect(r.body.items.map((e) => [e.seq, e.kind, e.superseded])).toEqual([
      [3, "supersede", false],
      [1, "broadcast", true],
    ]);
    expect(r.body.items[0]).toMatchObject({ breakdown: { datacenter: 600 }, salt: e3.salt, entryHash: e3.entryHash });
    const ed = await editor.client.call<{ items: AttestationEntry[] }>("GET", path());
    expect(ed.status).toBe(200);
    expect(ed.body.items.every((e) => e.breakdown === null && e.salt === null)).toBe(true);
    expect((await other.client.call("GET", path())).status).toBe(403);
    expect((await anon().call("GET", path())).status).toBe(401);
  });

  test("paging: newest first by seq, a cursor continues", async () => {
    const p1 = await owner.client.call<{ items: AttestationEntry[]; nextCursor: string | null }>(
      "GET",
      path("?limit=1"),
    );
    expect(p1.body.items.map((e) => e.seq)).toEqual([3]);
    const p2 = await owner.client.call<{ items: AttestationEntry[]; nextCursor: string | null }>(
      "GET",
      path(`?limit=1&cursor=${p1.body.nextCursor}`),
    );
    expect(p2.body.items.map((e) => e.seq)).toEqual([1]);
    expect(p2.body.nextCursor).toBeNull();
  });

  test("get: an unpublished entry is NOT_FOUND until the bypass; then visible", async () => {
    expect((await owner.client.call("GET", path(`/${e2.id}`))).status).toBe(404);
    expect((await bypass(true)).status).toBe(200);
    try {
      const r = await owner.client.call<AttestationEntry>("GET", path(`/${e2.id}`));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ seq: 2, superseded: false, breakdown: { datacenter: 600 } });
      const list = await owner.client.call<{ items: AttestationEntry[] }>("GET", path());
      expect(list.body.items.map((e) => e.seq)).toEqual([3, 2, 1]);
    } finally {
      await bypass(false);
    }
  });

  test("the public bundle is contiguous: it stops before the first unpublished entry", async () => {
    const r = await anon().call<AttestationBundle>("GET", path("/bundle"));
    expect(r.status).toBe(200);
    expect(r.body.entries.map((e) => e.seq)).toEqual([1]);
    expect(r.body.entries[0]).toMatchObject({ breakdown: null, salt: null, superseded: false });
    expect(r.body.keys.origin).toBe(origin);
    expect(r.body.keys.keys.map((k) => k.kid)).toContain(key.kid);
    await bypass(true);
    try {
      const all = await anon().call<AttestationBundle>("GET", path("/bundle?fromSeq=1"));
      expect(all.body.entries.map((e) => [e.seq, e.superseded])).toEqual([
        [1, true],
        [2, false],
        [3, false],
      ]);
      const window = await anon().call<AttestationBundle>("GET", path("/bundle?fromSeq=2&limit=1"));
      expect(window.body.entries.map((e) => e.seq)).toEqual([2]);
    } finally {
      await bypass(false);
    }
    expect((await anon().call("GET", `/api/channels/nobody${Date.now()}/attestations/bundle`)).status).toBe(404);
  });
});

describe("share links", () => {
  test("owner only; the link reveals the breakdown until it is revoked; the URL is shown once", async () => {
    expect((await editor.client.call("POST", path(`/${e3.id}/share`), { expiresInDays: 1 })).status).toBe(403);
    expect((await owner.client.call("POST", path(`/${e2.id}/share`), { expiresInDays: 1 })).status).toBe(404);
    const created = await owner.client.call<AttestationShareLink>("POST", path(`/${e3.id}/share`), {
      expiresInDays: 1,
    });
    expect(created.status).toBe(200);
    expect(created.body.attestationId).toBe(e3.id);
    const token = new URL(created.body.url!).pathname.split("/").at(-1)!;
    const [stored] = await db()
      .select()
      .from(schema.attestationShareLinks)
      .where(eq(schema.attestationShareLinks.id, created.body.id));
    expect(stored!.tokenHash).not.toContain(token);

    const shared = await anon().call<AttestationEntry>("GET", `/api/attestations/shared/${token}`);
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ id: e3.id, breakdown: { datacenter: 600 }, salt: e3.salt });

    const list = await owner.client.call<{ items: AttestationShareLink[] }>("GET", path("/share-links"));
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ id: created.body.id, url: null, revokedAt: null });
    expect((await editor.client.call("GET", path("/share-links"))).status).toBe(403);

    expect((await other.client.call("DELETE", path(`/share-links/${created.body.id}`))).status).toBe(403);
    expect((await owner.client.call("DELETE", path(`/share-links/${created.body.id}`))).status).toBe(200);
    expect((await owner.client.call("DELETE", path(`/share-links/${created.body.id}`))).status).toBe(200);
    expect((await anon().call("GET", `/api/attestations/shared/${token}`)).status).toBe(404);
  });

  test("an expired link is NOT_FOUND like an unknown one", async () => {
    const created = await owner.client.call<AttestationShareLink>("POST", path(`/${e1.id}/share`), {
      expiresInDays: 1,
    });
    const token = new URL(created.body.url!).pathname.split("/").at(-1)!;
    await db()
      .update(schema.attestationShareLinks)
      .set({ createdAt: new Date(Date.now() - 3 * 86_400_000), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.attestationShareLinks.id, created.body.id));
    expect((await anon().call("GET", `/api/attestations/shared/${token}`)).status).toBe(404);
    expect((await anon().call("GET", `/api/attestations/shared/${"c".repeat(48)}`)).status).toBe(404);
  });
});

describe("the public verifier", () => {
  test("the current statement verifies and names this instance; the replaced one is superseded", async () => {
    const ok = await verifyCall({ envelope: { payload: e3.payload, signature: e3.signature } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ valid: true, problem: null, origin });
    expect(ok.body.statement).toMatchObject({ seq: 3, verifiedViewerSeconds: 3660 });
    expect((await verifyCall({ envelope: { payload: e1.payload, signature: e1.signature } })).body).toMatchObject({
      valid: false,
      problem: "superseded",
    });
  });

  test("a bundle verifies; a gap, a tampered payload and a padded payload do not", async () => {
    const env = (e: typeof e1) => ({ payload: e.payload, signature: e.signature });
    expect((await verifyCall({ bundle: [env(e1), env(e2), env(e3)] })).body).toMatchObject({ valid: true });
    expect((await verifyCall({ bundle: [env(e1), env(e3)] })).body).toMatchObject({
      valid: false,
      problem: "chain_break",
    });
    const s = JSON.parse(Buffer.from(e3.payload, "base64url").toString()) as AttestationStatement;
    const forged = toB64url(canonicalize({ ...s, verifiedViewerSeconds: 99999 }));
    expect((await verifyCall({ envelope: { payload: forged, signature: e3.signature } })).body).toMatchObject({
      valid: false,
      problem: "bad_signature",
      statement: null,
    });
    expect((await verifyCall({ envelope: { payload: `${e3.payload}=`, signature: e3.signature } })).body).toMatchObject(
      {
        valid: false,
        problem: "malformed",
      },
    );
    expect((await verifyCall({})).status).toBe(400);
    expect((await verifyCall({ envelope: env(e1), bundle: [env(e1)] })).status).toBe(400);
  });

  test("a statement signed for another origin is wrong_origin; an unknown key is unknown_kid", async () => {
    const s = JSON.parse(Buffer.from(e3.payload, "base64url").toString()) as AttestationStatement;
    const foreign = await sign(key, { ...s, origin: "https://elsewhere.example" });
    expect((await verifyCall({ envelope: foreign })).body).toMatchObject({ valid: false, problem: "wrong_origin" });
    const stranger = await importAttestationSigningKey(
      generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    );
    const unknown = await sign(stranger, { ...s, kid: stranger.kid });
    expect((await verifyCall({ envelope: unknown })).body).toMatchObject({ valid: false, problem: "unknown_kid" });
  });

  test("a validly signed statement that was never stored is not in the chain", async () => {
    const s = JSON.parse(Buffer.from(e3.payload, "base64url").toString()) as AttestationStatement;
    const orphan = await sign(key, { ...s, seq: 4, prevHash: e3.entryHash, verifiedViewerSeconds: 1 });
    expect((await verifyCall({ envelope: orphan })).body).toMatchObject({ valid: false, problem: "chain_break" });
  });
});

describe("keys", () => {
  test("/.well-known/commonair-attestation: the origin and the full key history", async () => {
    const res = await fetch(`${api.url}/api/.well-known/commonair-attestation`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { origin: string; keys: Record<string, unknown>[] };
    expect(body.origin).toBe(origin);
    expect(body.keys).toContainEqual(
      expect.objectContaining({ kid: key.kid, algorithm: "Ed25519", publicKey: key.publicKey, retiredAt: null }),
    );
    expect(Object.keys(body.keys[0]!).sort()).toEqual(
      ["algorithm", "compromisedAt", "firstUsedAt", "kid", "publicKey", "retiredAt"].sort(),
    );
  });

  test("compromise: admin only, audited, verifiers then refuse the kid", async () => {
    const url = `/api/admin/integrity/keys/${key.kid}/compromise`;
    expect((await owner.client.call("POST", url, { reason: "leaked" })).status).toBe(403);
    const r = await admin.client.call<{ kid: string; compromisedAt: string | null }>("POST", url, {
      reason: "Key file found in a public backup",
    });
    expect(r.status).toBe(200);
    expect(r.body.compromisedAt).not.toBeNull();
    expect((await admin.client.call("POST", url, { reason: "again" })).status).toBe(409);
    const [row] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "integrity.key.compromise"), eq(schema.auditLog.subjectId, key.kid)));
    expect(row).toMatchObject({ actorId: admin.userId, actorType: "admin" });
    expect(row!.details).toMatchObject({ kid: key.kid, broadcasts: 2 });
    expect((await verifyCall({ envelope: { payload: e3.payload, signature: e3.signature } })).body).toMatchObject({
      valid: false,
      problem: "compromised_kid",
    });

    // Re-issued under a new key at the head: a window through the compromised era then verifies,
    // and fails while one broadcast's latest entry is still the compromised key's.
    await db()
      .update(schema.integritySigningKeys)
      .set({ retiredAt: new Date() })
      .where(eq(schema.integritySigningKeys.kid, key.kid));
    const next = await importAttestationSigningKey(
      generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    );
    await db().insert(schema.integritySigningKeys).values({ kid: next.kid, publicKey: next.publicKey });
    await append(old, 3660, { kind: "reissue", signer: next });
    const chain = async () =>
      (
        await db()
          .select()
          .from(schema.integrityAttestations)
          .where(eq(schema.integrityAttestations.channelId, channelId))
          .orderBy(schema.integrityAttestations.seq)
      ).map((e) => ({ payload: e.payload, signature: e.signature }));
    expect((await verifyCall({ bundle: await chain() })).body).toMatchObject({
      valid: false,
      problem: "compromised_kid",
      statement: null,
    });
    await append(recent, 1800, { kind: "reissue", signer: next });
    expect((await verifyCall({ bundle: await chain() })).body).toMatchObject({ valid: true, problem: null, origin });
  });
});

describe("the API holds no signing key", () => {
  test("its env schema drops INTEGRITY_SIGNING_KEY, even when the process env has one", () => {
    const pkcs8 = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const env = loadApiEnv({ ...process.env, ...envOf(api), INTEGRITY_SIGNING_KEY: pkcs8 });
    expect(Object.keys(env)).not.toContain("INTEGRITY_SIGNING_KEY");
    expect(Object.keys(api.deps.env)).not.toContain("INTEGRITY_SIGNING_KEY");
  });
});
