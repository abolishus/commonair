// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.push.{status,subscribe,unsubscribe}` (ADR 0028 decisions 1 and 6). */
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { schema } from "@commonair/db";
import { b64url, decryptSecret, hmacHex, randomSecret, sha256Hex } from "@commonair/tokens";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
let vapidPublicKey: string;
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  vapidPublicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  api = await startApi({ env: { WEB_PUSH_ENABLED: "true", VAPID_PUBLIC_KEY: vapidPublicKey } });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
type Member = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Status {
  enabled: boolean;
  vapidPublicKey: string | null;
  subscriptions: number;
}

/** Flip one env flag for the length of `fn` (the handlers read `deps.env` per request). */
async function withEnv<T>(
  over: { WEB_PUSH_ENABLED?: boolean; WEB_PUSH_ALLOW_INSECURE_ENDPOINTS?: boolean },
  fn: () => Promise<T>,
) {
  const env = api.deps.env as { WEB_PUSH_ENABLED: boolean; WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: boolean };
  const before = { ...env };
  Object.assign(env, over);
  try {
    return await fn();
  } finally {
    env.WEB_PUSH_ENABLED = before.WEB_PUSH_ENABLED;
    env.WEB_PUSH_ALLOW_INSECURE_ENDPOINTS = before.WEB_PUSH_ALLOW_INSECURE_ENDPOINTS;
  }
}

async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

const endpointFor = (tag: string) => `https://push.example.test/wpush/v2/${tag}-${crypto.randomUUID()}`;
const subscribe = async (m: Member, endpoint: string, keys?: { p256dh: string; auth: string }) =>
  m.client.call("POST", "/api/notifications/push/subscriptions", { endpoint, keys: keys ?? (await browserKeys()) });
const unsubscribe = (m: Member, endpoint: string) =>
  m.client.call("POST", "/api/notifications/push/unsubscribe", { endpoint });
const status = async (m: Member) => (await m.client.call<Status>("GET", "/api/notifications/push")).body;
const rowsOf = (userId: string) =>
  db()
    .select()
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.userId, userId))
    .orderBy(asc(schema.pushSubscriptions.createdAt));
const hashOf = (endpoint: string) => hmacHex(api.deps.env.AUTH_SECRET, `push-endpoint:${endpoint}`);

describe("notifications.push", () => {
  test("status: on with the VAPID key and the caller's count; off with no key", async () => {
    const m = await signUpAndSignIn(api);
    expect(await status(m)).toEqual({ enabled: true, vapidPublicKey, subscriptions: 0 });
    await withEnv({ WEB_PUSH_ENABLED: false }, async () => {
      expect(await status(m)).toEqual({ enabled: false, vapidPublicKey: null, subscriptions: 0 });
    });
    expect((await client(api).call("GET", "/api/notifications/push")).status).toBe(401);
  });

  test("subscribe while push is off → PRECONDITION_FAILED web_push_disabled; nothing stored", async () => {
    const m = await signUpAndSignIn(api);
    await withEnv({ WEB_PUSH_ENABLED: false }, async () => {
      const res = await subscribe(m, endpointFor("off"));
      expect(res.status).toBe(412);
      expect(res.body).toMatchObject({ code: "PRECONDITION_FAILED", data: { requirement: "web_push_disabled" } });
    });
    expect(await rowsOf(m.userId)).toHaveLength(0);
  });

  test("subscribe stores ciphertext (no endpoint or key substring) under the endpoint's HMAC", async () => {
    const m = await signUpAndSignIn(api);
    const endpoint = endpointFor("store");
    const keys = await browserKeys();
    // Padded keys are accepted and stored unpadded.
    const res = await subscribe(m, endpoint, { p256dh: `${keys.p256dh}=`, auth: `${keys.auth}==` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const [row] = await rowsOf(m.userId);
    expect(row?.endpointHash).toBe(await hashOf(endpoint));
    expect(row?.subscription).not.toContain("push.example.test");
    expect(row?.subscription).not.toContain(keys.p256dh);
    expect(row?.subscription).not.toContain(keys.auth);
    expect(JSON.parse(await decryptSecret(api.deps.env.AUTH_SECRET, "push-subscription", row!.subscription))).toEqual({
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    });
    expect((await status(m)).subscriptions).toBe(1);
    // Subscribing the same browser again keeps one row.
    expect((await subscribe(m, endpoint, keys)).status).toBe(200);
    expect(await rowsOf(m.userId)).toHaveLength(1);
  });

  test("bad keys are refused", async () => {
    const m = await signUpAndSignIn(api);
    const good = await browserKeys();
    const compressed = Buffer.from(good.p256dh, "base64url");
    compressed[0] = 0x02;
    for (const keys of [
      { p256dh: b64url(compressed), auth: good.auth },
      { p256dh: good.p256dh, auth: "short" },
      { p256dh: "x".repeat(87), auth: good.auth },
    ])
      expect((await subscribe(m, endpointFor("bad"), keys)).status).toBe(400);
    expect(await rowsOf(m.userId)).toHaveLength(0);
  });

  test("http: endpoints are refused unless WEB_PUSH_ALLOW_INSECURE_ENDPOINTS is on; credentials always", async () => {
    const m = await signUpAndSignIn(api);
    const http = `http://host.containers.internal:4100/push/${crypto.randomUUID()}`;
    expect((await subscribe(m, http)).status).toBe(400);
    expect((await subscribe(m, "https://u:p@push.example.test/a")).status).toBe(400);
    await withEnv({ WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: true }, async () => {
      expect((await subscribe(m, http)).status).toBe(200);
      expect((await subscribe(m, "http://u:p@push.example.test/a")).status).toBe(400);
    });
    expect(await rowsOf(m.userId)).toHaveLength(1);
  });

  test("a second member subscribing the same browser takes it over", async () => {
    const a = await signUpAndSignIn(api);
    const b = await signUpAndSignIn(api);
    const endpoint = endpointFor("shared");
    expect((await subscribe(a, endpoint)).status).toBe(200);
    const hash = await hashOf(endpoint);
    await db()
      .update(schema.pushSubscriptions)
      .set({ failures: 3 })
      .where(eq(schema.pushSubscriptions.endpointHash, hash));
    expect((await subscribe(b, endpoint)).status).toBe(200);
    expect(await rowsOf(a.userId)).toHaveLength(0);
    const [row] = await rowsOf(b.userId);
    expect(row).toMatchObject({ endpointHash: hash, failures: 0 });
    expect((await status(a)).subscriptions).toBe(0);
    expect((await status(b)).subscriptions).toBe(1);
  });

  test(`the ${NOTIFY_RULES.maxPushSubscriptionsPerUser + 1}th browser drops the oldest`, async () => {
    const m = await signUpAndSignIn(api);
    const endpoints: string[] = [];
    for (let i = 0; i <= NOTIFY_RULES.maxPushSubscriptionsPerUser; i++) {
      const e = endpointFor(`cap${i}`);
      endpoints.push(e);
      expect((await subscribe(m, e)).status).toBe(200);
      // Distinct creation times, so "oldest" is well defined.
      await Bun.sleep(5);
    }
    const rows = await rowsOf(m.userId);
    expect(rows).toHaveLength(NOTIFY_RULES.maxPushSubscriptionsPerUser);
    const hashes = new Set(rows.map((r) => r.endpointHash));
    expect(hashes.has(await hashOf(endpoints[0]!))).toBe(false);
    for (const e of endpoints.slice(1)) expect(hashes.has(await hashOf(e))).toBe(true);
    expect((await status(m)).subscriptions).toBe(NOTIFY_RULES.maxPushSubscriptionsPerUser);
  });

  test("unsubscribe is scoped to the caller and answers ok when nothing matched", async () => {
    const a = await signUpAndSignIn(api);
    const b = await signUpAndSignIn(api);
    const endpoint = endpointFor("mine");
    expect((await subscribe(a, endpoint)).status).toBe(200);
    // Another member cannot remove it.
    const other = await unsubscribe(b, endpoint);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ ok: true });
    expect(await rowsOf(a.userId)).toHaveLength(1);
    // The owner can, also while push is off.
    await withEnv({ WEB_PUSH_ENABLED: false }, async () => {
      expect((await unsubscribe(a, endpoint)).status).toBe(200);
    });
    expect(await rowsOf(a.userId)).toHaveLength(0);
    expect((await unsubscribe(a, endpoint)).status).toBe(200);
  });

  test("session callers only: an access token is refused", async () => {
    const m = await signUpAndSignIn(api);
    const raw = randomSecret("ca_", 24);
    await db()
      .insert(schema.oauthTokens)
      .values({
        appId: null,
        userId: m.userId,
        kind: "personal",
        scopes: ["user:read:email"],
        accessTokenHash: await sha256Hex(raw),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const t = client(api, { bearer: raw });
    expect((await t.call("GET", "/api/notifications/push")).status).toBe(403);
    expect(
      (
        await t.call("POST", "/api/notifications/push/subscriptions", {
          endpoint: endpointFor("token"),
          keys: await browserKeys(),
        })
      ).status,
    ).toBe(403);
  });
});
