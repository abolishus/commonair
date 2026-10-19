// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E3 relay lifecycle: retire, drain, rejoin after a timeout, suspension and reinstatement. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { KEYS, mediaPath } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { generateSigningKey } from "@commonair/tokens";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
let member: Awaited<ReturnType<typeof signUpAndSignIn>>;
let admin: Awaited<ReturnType<typeof signUpAndSignIn>>;
/** Relay hosts whose /healthz fails. */
const unhealthy = new Set<string>();
/** Relay hosts whose /healthz waits until the promise settles. */
const held = new Map<string, Promise<void>>();
/** Added to the API clock (playback heartbeat floor, health re-check window). */
let offset = 0;

beforeAll(async () => {
  api = await startApi({
    pinnedGet: async (url) => {
      await held.get(url.host);
      return unhealthy.has(url.host) ? 503 : 200;
    },
  });
  api.deps.now = () => new Date(Date.now() + offset);
  member = await signUpAndSignIn(api);
  admin = await signUpAndSignIn(api);
  await api.db.db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
  // The member's own channel goes live so playback sessions can start.
  await member.client.call("POST", `/api/channels/${member.username}/stream-keys`);
  const ready = await fetch(`${api.url}/internal/media/ready`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": api.internalSecret },
    body: JSON.stringify({ path: mediaPath(member.username), sourceType: "rtmpConn" }),
  });
  if (ready.status >= 300) throw new Error(`media ready hook answered ${ready.status}`);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const idle = { activeViewers: 0, egressMbps: 0, cacheBytes: 0 };

async function makeRelay(name: string) {
  const created = await member.client.call<{ relayId: string; registrationToken: string }>("POST", "/api/relays", {
    name,
  });
  expect(created.status).toBe(200);
  const id = created.body.relayId;
  const host = `${name}.relay-e3.invalid:8080`;
  const publicUrl = `http://${host}`;
  const http: Client = client(api, { bearer: created.body.registrationToken });
  const { key } = await generateSigningKey();
  const register = () =>
    http.call<{ status: string }>("POST", "/api/relay/register", {
      publicUrl,
      declaredCapacityMbps: 1000,
      publicKey: key.publicKeyB64,
      version: "test",
    });
  const heartbeat = (over: Record<string, unknown> = {}) =>
    http.call<{ status: string }>("POST", "/api/relay/heartbeat", { ...idle, ...over });
  return { id, host, publicUrl, register, heartbeat };
}

const inAssignment = async (id: string) => (await api.deps.valkey.hget(KEYS.relays, id)) !== null;
const row = async (id: string) =>
  (await api.db.db.select().from(schema.relayNodes).where(eq(schema.relayNodes.id, id)))[0];
const mine = async (id: string) =>
  (
    await member.client.call<{ id: string; status: string; suspendedReason: string | null }[]>("GET", "/api/relays")
  ).body.find((r) => r.id === id);

type Start = { sessionId: string; token: string; playlistUrl: string; source: string };
async function startPlayback(): Promise<Start> {
  const r = await client(api).call<Start>("POST", `/api/channels/${member.username}/playback`, {
    deviceId: `device-${crypto.randomUUID()}`,
  });
  expect(r.status).toBe(200);
  return r.body;
}
/** Assignment is deterministic per session id, so open new sessions until one lands on the relay. */
async function startOnRelay(publicUrl: string): Promise<Start> {
  for (let i = 0; i < 200; i++) {
    const s = await startPlayback();
    if (s.source === "relay" && s.playlistUrl.startsWith(`${publicUrl}/hls/`)) return s;
  }
  throw new Error("no session was assigned to the relay");
}
function beat(s: { sessionId: string }, token: string) {
  return client(api).call<{ ok: true; token?: string; switchTo?: string; throttled?: boolean }>(
    "POST",
    "/api/playback/heartbeat",
    {
      sessionId: s.sessionId,
      token,
      playedSeconds: 10,
      bufferSeconds: 3,
      stalls: 0,
      bytesHttp: 1000,
      bytesP2p: 0,
      rendition: "source",
      latencySeconds: 2,
      ttffMs: 800,
      visible: true,
      muted: false,
    },
  );
}
const auditRows = (id: string, action: string) =>
  api.db.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, action)));

/** What the worker does when a relay misses heartbeats for 3 minutes. */
async function workerTimesOut(id: string) {
  await api.db.db
    .update(schema.relayNodes)
    .set({ status: "offline", lastHealthAt: new Date(api.deps.now().getTime() - 240_000) })
    .where(eq(schema.relayNodes.id, id));
  await api.deps.valkey.hdel(KEYS.relays, id);
}
/** What the worker does when a relay's receipts over-report. */
async function workerSuspends(id: string) {
  await api.db.db
    .update(schema.relayNodes)
    .set({ status: "suspended", suspendedAt: api.deps.now(), suspendedReason: "receipt over-report" })
    .where(eq(schema.relayNodes.id, id));
  await api.deps.valkey.hdel(KEYS.relays, id);
}

test("retire kills the token: register and heartbeat answer 401, audited once", async () => {
  const r = await makeRelay("retire");
  expect((await r.register()).body.status).toBe("active");
  const tokenHash = (await row(r.id))?.tokenHash;
  expect(await inAssignment(r.id)).toBe(true);

  expect((await member.client.call("DELETE", `/api/relays/${r.id}`)).status).toBe(200);
  expect(await inAssignment(r.id)).toBe(false);
  expect((await r.register()).status).toBe(401);
  expect((await r.heartbeat()).status).toBe(401);
  expect((await r.heartbeat({ draining: true })).status).toBe(401);
  expect(await mine(r.id)).toBeUndefined(); // relays.mine omits retired relays
  const retired = await row(r.id);
  expect(retired).toMatchObject({ status: "offline" });
  expect(retired?.retiredAt).toBeInstanceOf(Date);
  expect(retired?.tokenHash).not.toBe(tokenHash);

  // Idempotent, one audit row; someone else's relay is not found.
  expect((await member.client.call("DELETE", `/api/relays/${r.id}`)).status).toBe(200);
  const audits = await auditRows(r.id, "relay.retire");
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ actorType: "user", actorId: member.userId, subjectType: "relay" });
  expect((await admin.client.call("DELETE", `/api/relays/${r.id}`)).status).toBe(404);
});

test("an offline (timed-out) relay rejoins by heartbeat or by registering again", async () => {
  const r = await makeRelay("rejoin");
  expect((await r.register()).body.status).toBe("active");

  // Heartbeats again after the worker timed it out: a passing health check brings it back.
  await workerTimesOut(r.id);
  expect((await mine(r.id))?.status).toBe("offline");
  const back = await r.heartbeat({ egressMbps: 5 });
  expect(back.status).toBe(200);
  expect(back.body.status).toBe("active");
  expect(await inAssignment(r.id)).toBe(true);

  // A failing check keeps it offline and out of assignment.
  await workerTimesOut(r.id);
  unhealthy.add(r.host);
  expect((await r.heartbeat()).body.status).toBe("offline");
  expect(await inAssignment(r.id)).toBe(false);

  // Registering again with the same token: pending until the health check passes.
  await workerTimesOut(r.id);
  expect((await r.register()).body.status).toBe("pending");
  expect(await inAssignment(r.id)).toBe(false);
  unhealthy.delete(r.host);
  expect((await r.register()).body.status).toBe("active");
  expect(await inAssignment(r.id)).toBe(true);
  expect((await mine(r.id))?.status).toBe("active");
});

test("draining removes the relay at once; its viewers get switchTo the origin; it rejoins", async () => {
  const r = await makeRelay("drain");
  expect((await r.register()).body.status).toBe("active");
  const s = await startOnRelay(r.publicUrl);
  const [before] = await api.db.db
    .select()
    .from(schema.playbackSessions)
    .where(eq(schema.playbackSessions.id, s.sessionId));
  expect(before).toMatchObject({ assignedSource: "relay", relayId: r.id });

  // While the relay is active, a heartbeat keeps the session where it is.
  offset += 11_000;
  const stay = await beat(s, s.token);
  expect(stay.status).toBe(200);
  expect(stay.body.switchTo).toBeUndefined();

  const auditsBefore = (await api.db.db.select().from(schema.auditLog)).length;
  const drained = await r.heartbeat({ draining: true });
  expect(drained.status).toBe(200);
  expect(drained.body.status).toBe("offline");
  expect(await inAssignment(r.id)).toBe(false);
  expect((await mine(r.id))?.status).toBe("offline");
  expect((await api.db.db.select().from(schema.auditLog)).length).toBe(auditsBefore); // operational

  // Later draining heartbeats stay offline (no rejoin while draining).
  expect((await r.heartbeat({ draining: true })).body.status).toBe("offline");

  offset += 11_000;
  const moved = await beat(s, s.token);
  expect(moved.status).toBe(200);
  const origin = api.deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, "");
  expect(moved.body.switchTo?.startsWith(`${origin}/hls/${mediaPath(member.username)}/index.m3u8?t=`)).toBe(true);
  expect(moved.body.token).toBeTruthy();
  expect(moved.body.switchTo).toContain(encodeURIComponent(moved.body.token ?? ""));
  // Re-recorded as origin-delivered: integrity judges it on origin fetches from now on.
  const [after] = await api.db.db
    .select()
    .from(schema.playbackSessions)
    .where(eq(schema.playbackSessions.id, s.sessionId));
  expect(after).toMatchObject({ assignedSource: "origin", relayId: null });
  // With the origin token there is nothing more to move.
  offset += 11_000;
  expect((await beat(s, moved.body.token ?? "")).body.switchTo).toBeUndefined();

  // New sessions never land on the drained relay.
  for (let i = 0; i < 20; i++) expect((await startPlayback()).playlistUrl.startsWith(r.publicUrl)).toBe(false);

  // Restarted with the same token: back to active.
  expect((await r.register()).body.status).toBe("active");
  expect(await inAssignment(r.id)).toBe(true);
});

test("a suspended relay heartbeats and sees suspended, is not assigned, and reinstate needs a health check", async () => {
  const r = await makeRelay("suspend");
  expect((await r.register()).body.status).toBe("active");
  const s = await startOnRelay(r.publicUrl);

  await workerSuspends(r.id);
  const hb = await r.heartbeat({ egressMbps: 1 });
  expect(hb.status).toBe(200);
  expect(hb.body.status).toBe("suspended");
  expect(await inAssignment(r.id)).toBe(false);
  expect(await mine(r.id)).toMatchObject({ status: "suspended", suspendedReason: "receipt over-report" });
  // Neither re-registering nor draining escapes the suspension.
  expect((await r.register()).body.status).toBe("suspended");
  expect((await r.heartbeat({ draining: true })).body.status).toBe("suspended");
  expect((await row(r.id))?.status).toBe("suspended");
  offset += 61_000; // past the health re-check window: still suspended
  expect((await r.heartbeat()).body.status).toBe("suspended");
  expect(await inAssignment(r.id)).toBe(false);

  // Its viewers move to the origin; new sessions never land on it.
  offset += 11_000;
  const moved = await beat(s, s.token);
  expect(moved.body.switchTo?.startsWith(api.deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, ""))).toBe(true);
  for (let i = 0; i < 20; i++) expect((await startPlayback()).playlistUrl.startsWith(r.publicUrl)).toBe(false);

  // Reinstated while unhealthy: pending, still out of assignment; its next heartbeat after the
  // re-check window brings it back once healthy.
  unhealthy.add(r.host);
  const pending = await admin.client.call<{ status: string }>("POST", `/api/admin/relays/${r.id}/reinstate`, {
    reason: "false positive",
  });
  expect(pending.status).toBe(200);
  expect(pending.body.status).toBe("pending");
  expect(await inAssignment(r.id)).toBe(false);
  unhealthy.delete(r.host);
  offset += 61_000;
  expect((await r.heartbeat()).body.status).toBe("active");
  expect(await inAssignment(r.id)).toBe(true);

  // Reinstated while healthy: active and assignable at once.
  await workerSuspends(r.id);
  const active = await admin.client.call<{ status: string }>("POST", `/api/admin/relays/${r.id}/reinstate`, {
    reason: "checked again",
  });
  expect(active.body.status).toBe("active");
  expect(await inAssignment(r.id)).toBe(true);
  expect(await auditRows(r.id, "relay.reinstate")).toHaveLength(2);
});

test("a drain during an offline relay's health check wins over the check", async () => {
  const r = await makeRelay("drainrace");
  expect((await r.register()).body.status).toBe("active");
  await workerTimesOut(r.id);
  let release = () => {};
  held.set(
    r.host,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  // A plain heartbeat starts a rejoin health check and waits on it...
  const rejoin = r.heartbeat();
  await Bun.sleep(50); // let it reach the health check
  // ...while the relay drains.
  expect((await r.heartbeat({ draining: true })).body.status).toBe("offline");
  held.delete(r.host);
  release();
  expect((await rejoin).body.status).toBe("offline");
  expect((await row(r.id))?.status).toBe("offline");
  expect(await inAssignment(r.id)).toBe(false);
});

test("a suspension seen only in Postgres takes the relay out of assignment on its next heartbeat", async () => {
  const r = await makeRelay("race");
  expect((await r.register()).body.status).toBe("active");
  // The worker's Valkey removal not yet visible: the heartbeat must not keep it assignable.
  await api.db.db
    .update(schema.relayNodes)
    .set({ status: "suspended", suspendedReason: "receipt over-report" })
    .where(eq(schema.relayNodes.id, r.id));
  expect((await r.heartbeat()).body.status).toBe("suspended");
  expect(await inAssignment(r.id)).toBe(false);
});

test("retired relays free a slot; drained ones do not", async () => {
  const other = await signUpAndSignIn(api);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const c = await other.client.call<{ relayId: string }>("POST", "/api/relays", { name: `slot${i}` });
    expect(c.status).toBe(200);
    ids.push(c.body.relayId);
  }
  // An offline (drained) relay may rejoin, so it still holds its slot.
  await api.db.db
    .update(schema.relayNodes)
    .set({ status: "offline" })
    .where(eq(schema.relayNodes.id, ids[0] ?? ""));
  expect((await other.client.call("POST", "/api/relays", { name: "slot5" })).status).toBe(412);
  expect((await other.client.call("DELETE", `/api/relays/${ids[0]}`)).status).toBe(200);
  expect((await other.client.call("POST", "/api/relays", { name: "slot5" })).status).toBe(200);
});
