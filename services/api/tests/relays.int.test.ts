// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { KEYS, mediaPath } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { generateSigningKey, signReceipt } from "@commonair/tokens";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
let healthy = true;
const healthCalls: string[] = [];
let member: Awaited<ReturnType<typeof signUpAndSignIn>>;

beforeAll(async () => {
  api = await startApi({
    pinnedGet: async (url) => {
      healthCalls.push(url.toString());
      return healthy ? 200 : 503;
    },
  });
  member = await signUpAndSignIn(api);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

test("relay lifecycle: create → register (health-checked) → heartbeat → receipt → assignment", async () => {
  const created = await member.client.call<{ relayId: string; registrationToken: string }>("POST", "/api/relays", {
    name: "home",
  });
  expect(created.status).toBe(200);
  expect(created.body.registrationToken.startsWith("relay_")).toBe(true);
  const relay = client(api, { bearer: created.body.registrationToken });
  const { key } = await generateSigningKey();

  // Heartbeats before registration are refused; unknown tokens are unauthorized.
  expect(
    (await relay.call("POST", "/api/relay/heartbeat", { activeViewers: 0, egressMbps: 0, cacheBytes: 0 })).status,
  ).toBe(412);
  expect(
    (
      await client(api, { bearer: "relay_nope" }).call("POST", "/api/relay/heartbeat", {
        activeViewers: 0,
        egressMbps: 0,
        cacheBytes: 0,
      })
    ).status,
  ).toBe(401);

  healthy = false;
  const pending = await relay.call<{ status: string; originPublicKey: string }>("POST", "/api/relay/register", {
    publicUrl: "http://relay-test.invalid:8080",
    declaredCapacityMbps: 100,
    publicKey: key.publicKeyB64,
    version: "test",
  });
  expect(pending.status).toBe(200);
  expect(pending.body.status).toBe("pending");
  expect(pending.body.originPublicKey).toBe(api.deps.signingKey.publicKeyB64);
  expect(healthCalls.at(-1)).toBe("http://relay-test.invalid:8080/healthz");
  expect(await api.deps.valkey.hget(KEYS.relays, created.body.relayId)).toBeNull();

  healthy = true;
  const active = await relay.call<{ status: string }>("POST", "/api/relay/register", {
    publicUrl: "http://relay-test.invalid:8080",
    declaredCapacityMbps: 100,
    publicKey: key.publicKeyB64,
    version: "test",
  });
  expect(active.body.status).toBe("active");
  const hb = await relay.call<{ status: string }>("POST", "/api/relay/heartbeat", {
    activeViewers: 2,
    egressMbps: 10,
    cacheBytes: 5,
  });
  expect(hb.body.status).toBe("active");
  const entry = JSON.parse((await api.deps.valkey.hget(KEYS.relays, created.body.relayId)) ?? "{}") as {
    load: number;
    capacityMbps: number;
  };
  expect(entry).toMatchObject({ load: 10, capacityMbps: 100 });

  const now = Date.now();
  const payload = {
    v: 1 as const,
    relayId: created.body.relayId,
    nonce: crypto.randomUUID(),
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now).toISOString(),
    entries: [{ sessionId: uuidv7(), segments: 10, bytes: 1_000_000 }],
  };
  const signed = await signReceipt(key, payload);
  const receipt = await relay.call<{ status: string }>("POST", "/api/relay/receipts", signed);
  expect(receipt.status).toBe(200);
  expect(receipt.body.status).toBe("pending");
  expect((await relay.call("POST", "/api/relay/receipts", signed)).status).toBe(409); // nonce replay
  const forged = await signReceipt((await generateSigningKey()).key, { ...payload, nonce: crypto.randomUUID() });
  expect((await relay.call("POST", "/api/relay/receipts", forged)).status).toBe(400);

  // New playback sessions are now shared with the relay.
  await member.client.call("POST", `/api/channels/${member.username}/stream-keys`);
  await fetch(`${api.url}/internal/media/ready`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": api.internalSecret },
    body: JSON.stringify({ path: mediaPath(member.username), sourceType: "rtmpConn" }),
  });
  const sources = new Set<string>();
  const urls: [string, string][] = [];
  for (let i = 0; i < 30; i++) {
    const r = await client(api).call<{ source: string; playlistUrl: string }>(
      "POST",
      `/api/channels/${member.username}/playback`,
      {
        deviceId: `device-${crypto.randomUUID()}`,
      },
    );
    sources.add(r.body.source);
    urls.push([r.body.source, r.body.playlistUrl]);
  }
  expect(sources).toEqual(new Set(["origin", "relay"]));
  const relayUrls = urls.filter(([src]) => src === "relay").map(([, u]) => u);
  expect(relayUrls.every((u) => u.startsWith("http://relay-test.invalid:8080/hls/"))).toBe(true);

  const mine = await member.client.call<{ id: string; status: string }[]>("GET", "/api/relays");
  expect(mine.body).toEqual([
    expect.objectContaining({
      id: created.body.relayId,
      status: "active",
      bytesVerified30d: 0,
      lastReceiptAt: expect.any(String),
      receipts30d: { pending: 1, verified: 0, rejected: 0 },
    }),
  ]);

  // Retiring the relay kills its token and removes it from assignment.
  expect((await member.client.call("DELETE", `/api/relays/${created.body.relayId}`)).status).toBe(200);
  expect(await api.deps.valkey.hget(KEYS.relays, created.body.relayId)).toBeNull();
  expect(
    (await relay.call("POST", "/api/relay/heartbeat", { activeViewers: 0, egressMbps: 0, cacheBytes: 0 })).status,
  ).toBe(401);
});

test("admin endpoints: relays list, reinstate, categories, roles", async () => {
  const adminUser = await signUpAndSignIn(api);
  await api.db.db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, adminUser.userId));
  expect((await member.client.call("GET", "/api/admin/relays")).status).toBe(403);
  const list = await adminUser.client.call<{ items: { owner: { username: string } }[] }>("GET", "/api/admin/relays");
  expect(list.status).toBe(200);
  expect(list.body.items[0]?.owner.username).toBe(member.username);

  const cat = await adminUser.client.call<{ slug: string; mature: boolean; liveChannels: number }>(
    "PUT",
    "/api/admin/categories/just-chatting",
    {
      name: "Just Chatting",
    },
  );
  expect(cat.body).toMatchObject({ slug: "just-chatting", mature: false });
  expect(
    (await client(api).call<{ items: { slug: string }[] }>("GET", "/api/categories")).body.items.map((c) => c.slug),
  ).toContain("just-chatting");
  expect((await client(api).call("GET", "/api/categories/just-chatting")).status).toBe(200);

  expect(
    (await adminUser.client.call("PUT", `/api/admin/users/${member.username}/role`, { role: "moderator" })).status,
  ).toBe(200);
  expect(
    (await adminUser.client.call("PUT", `/api/admin/users/${adminUser.username}/role`, { role: "user" })).status,
  ).toBe(400);
  const audits = await api.db.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "user.set_role"));
  expect(audits).toHaveLength(1);
});

test("relay stats: 30-day receipt counts and verified bytes per relay, older periods excluded", async () => {
  const mk = async (name: string) => {
    const r = await member.client.call<{ relayId: string }>("POST", "/api/relays", { name });
    expect(r.status).toBe(200);
    return r.body.relayId;
  };
  const a = await mk("stats-a");
  const b = await mk("stats-b");
  const now = Date.now();
  const receipt = (
    relayId: string,
    status: "pending" | "verified" | "rejected",
    bytesVerified: number,
    ageMs: number,
  ) => ({
    relayId,
    nonce: crypto.randomUUID(),
    periodStart: new Date(now - ageMs - 60_000),
    periodEnd: new Date(now - ageMs),
    bytesReported: bytesVerified,
    segmentsReported: 1,
    tokensReported: 1,
    payload: { v: 1, relayId, nonce: "n", periodStart: "", periodEnd: "", entries: [] } as never,
    signature: "x".repeat(86),
    status,
    bytesVerified,
    createdAt: new Date(now - ageMs),
  });
  await api.db.db.insert(schema.relayReceipts).values([
    receipt(a, "verified", 1000, 60_000),
    receipt(a, "verified", 500, 120_000),
    receipt(a, "rejected", 0, 180_000),
    receipt(a, "pending", 0, 30_000),
    receipt(a, "verified", 99_999, 31 * 86_400_000), // outside the 30-day window
    receipt(b, "rejected", 0, 60_000),
  ]);
  const mine = await member.client.call<
    {
      id: string;
      bytesVerified30d: number;
      lastReceiptAt: string | null;
      receipts30d: { pending: number; verified: number; rejected: number };
    }[]
  >("GET", "/api/relays");
  const byId = new Map(mine.body.map((r) => [r.id, r]));
  expect(byId.get(a)).toMatchObject({
    bytesVerified30d: 1500,
    receipts30d: { pending: 1, verified: 2, rejected: 1 },
  });
  expect(new Date(byId.get(a)?.lastReceiptAt ?? 0).getTime()).toBe(now - 30_000);
  expect(byId.get(b)).toMatchObject({ bytesVerified30d: 0, receipts30d: { pending: 0, verified: 0, rejected: 1 } });
});
