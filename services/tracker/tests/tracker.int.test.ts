// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The tracker in-process on an ephemeral port against the real Valkey: authenticated sockets,
 * offer/answer relay between two sessions on two networks, evidence in Valkey, and refusals.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS, p2pSwarmId } from "@commonair/contracts/internal";
import { createLogger } from "@commonair/observability";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { generateSigningKey, randomSecret, signPlaybackToken, type SigningKey } from "@commonair/tokens";
import { Evidence } from "../src/evidence.ts";
import { binaryToHex, LIMITS } from "../src/protocol.ts";
import { startTracker, type Tracker } from "../src/tracker.ts";
import { Peer, upgradeStatus } from "./client.ts";
import { answerSdp, binaryId, offerSdp } from "./helpers.ts";

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const SECRET = randomSecret("", 32);
const MAX_AGE = 3600;
const CHANNEL = crypto.randomUUID();
const HASH = binaryId(42);
const SWARM = p2pSwarmId(CHANNEL, binaryToHex(HASH));
const NET_A = "198.51.100.10";
const NET_B = "203.0.113.20";

let valkey: ValkeyClient;
let key: SigningKey;
let tracker: Tracker;
let wsBase: string;
const peers: Peer[] = [];
const sessions: string[] = [];

const nowS = () => Math.floor(Date.now() / 1000);
const token = (sid: string, opts: { iat?: number; signer?: SigningKey } = {}) => {
  const iat = opts.iat ?? nowS();
  return signPlaybackToken(opts.signer ?? key, {
    v: 1,
    sid,
    cid: CHANNEL,
    path: `live/${CHANNEL}`,
    src: "origin",
    iat,
    exp: iat + 120,
  });
};
/** A session with a fresh heartbeat. */
const session = async (heartbeatAgeMs = 0) => {
  const sid = crypto.randomUUID();
  sessions.push(sid);
  await valkey.zadd(KEYS.viewers(CHANNEL), Date.now() - heartbeatAgeMs, sid);
  return sid;
};
const connect = async (sid: string, ip: string) => {
  const p = await Peer.open(`${wsBase}/announce?t=${await token(sid)}`, { "x-forwarded-for": ip });
  peers.push(p);
  return p;
};
const eventually = async (check: () => Promise<void>, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await Bun.sleep(25);
    }
  }
};

beforeAll(async () => {
  valkey = createValkey(VALKEY_URL, { keyPrefix: `test:${crypto.randomUUID()}:`, name: "tracker-int" });
  key = (await generateSigningKey()).key;
  tracker = startTracker({
    port: 0,
    hostname: "127.0.0.1",
    logger: createLogger({ service: "tracker-int", level: "fatal" }),
    valkey,
    publicKey: key.publicKey,
    internalSecret: SECRET,
    // The test client connects from loopback: treat it as the reverse proxy.
    trustedProxies: ["127.0.0.0/8", "::1/128"],
    limits: { maxConnections: 100, maxConnectionsPerIp: 10, maxNumwant: 20, tokenMaxAgeSeconds: MAX_AGE },
    // Re-check the heartbeat on every announce so a lapse is observable at once.
    heartbeatRecheckMs: 0,
  });
  wsBase = `ws://127.0.0.1:${tracker.url.port}`;
});

afterAll(async () => {
  for (const p of peers) p.close();
  await tracker.stop();
  await valkey.del(KEYS.viewers(CHANNEL), KEYS.p2pSwarm(SWARM), ...sessions.map((s) => KEYS.p2pPeer(s)));
  valkey.disconnect();
});

describe("signalling and evidence", () => {
  test("offer reaches the other peer, the answer comes back, evidence is written", async () => {
    const sidA = await session();
    const sidB = await session();
    const a = await connect(sidA, NET_A);
    const b = await connect(sidB, NET_B);
    const peerA = binaryId(1);
    const peerB = binaryId(2);

    a.send({
      action: "announce",
      info_hash: HASH,
      peer_id: peerA,
      numwant: 5,
      left: 100,
      event: "started",
      offers: [],
    });
    expect(await a.next((m) => m.interval !== undefined)).toEqual({
      action: "announce",
      interval: LIMITS.announceInterval,
      info_hash: HASH,
      complete: 0,
      incomplete: 1,
    });

    const offerId = binaryId(3);
    b.send({
      action: "announce",
      info_hash: HASH,
      peer_id: peerB,
      numwant: 5,
      left: 0,
      event: "started",
      offers: [{ offer: offerSdp(1), offer_id: offerId }],
    });
    expect(await b.next((m) => m.interval !== undefined)).toMatchObject({ complete: 1, incomplete: 1 });
    expect(await a.next((m) => m.offer !== undefined)).toEqual({
      action: "announce",
      offer: offerSdp(1),
      offer_id: offerId,
      peer_id: peerB,
      info_hash: HASH,
    });

    a.send({
      action: "announce",
      info_hash: HASH,
      peer_id: peerA,
      to_peer_id: peerB,
      answer: answerSdp,
      offer_id: offerId,
    });
    expect(await b.next((m) => m.answer !== undefined)).toEqual({
      action: "announce",
      answer: answerSdp,
      offer_id: offerId,
      peer_id: peerA,
      info_hash: HASH,
    });

    a.send({ action: "scrape", info_hash: HASH });
    expect(await a.next((m) => m.action === "scrape")).toEqual({
      action: "scrape",
      files: { [HASH]: { complete: 1, incomplete: 1, downloaded: 0 } },
    });

    const evidence = new Evidence(valkey, SECRET);
    await eventually(async () => {
      const ha = await valkey.hgetall(KEYS.p2pPeer(sidA));
      const hb = await valkey.hgetall(KEYS.p2pPeer(sidB));
      expect(ha.swarm).toBe(SWARM);
      expect(hb.swarm).toBe(SWARM);
      // A announced and answered: both count.
      expect(ha.announces).toBe("2");
      expect(hb.announces).toBe("1");
      expect(ha.net).toBe(await evidence.networkHash(NET_A));
      expect(hb.net).toBe(await evidence.networkHash(NET_B));
      expect(ha.net).not.toBe(hb.net);
      expect(ha.net).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(ha.first)).toBeLessThanOrEqual(Number(ha.last));
      expect(Number(ha.last)).toBeGreaterThan(Date.now() - 10_000);
      const ttl = await valkey.ttl(KEYS.p2pPeer(sidA));
      expect(ttl).toBeGreaterThan(500);
      const members = await valkey.zrange(KEYS.p2pSwarm(SWARM), 0, -1);
      expect(members.sort()).toEqual([sidA, sidB].sort());
      expect(await valkey.ttl(KEYS.p2pSwarm(SWARM))).toBeGreaterThan(500);
    });
    // The network is stored only as an HMAC.
    expect(JSON.stringify(await valkey.hgetall(KEYS.p2pPeer(sidA)))).not.toContain("198.51.100");
    const first = (await valkey.hget(KEYS.p2pPeer(sidA), "first")) ?? "";

    // `first` is set once; stopped removes the session from the swarm ZSET.
    a.send({ action: "announce", info_hash: HASH, peer_id: peerA, left: 50 });
    await a.next((m) => m.interval !== undefined);
    await eventually(async () => expect(await valkey.hget(KEYS.p2pPeer(sidA), "announces")).toBe("3"));
    expect(await valkey.hget(KEYS.p2pPeer(sidA), "first")).toBe(first);
    a.send({ action: "announce", info_hash: HASH, peer_id: peerA, event: "stopped" });
    await a.next((m) => m.interval !== undefined);
    await eventually(async () => expect(await valkey.zrange(KEYS.p2pSwarm(SWARM), 0, -1)).toEqual([sidB]));

    // Socket close removes it too.
    b.close();
    await eventually(async () => expect(await valkey.zcard(KEYS.p2pSwarm(SWARM))).toBe(0));
    expect(tracker.stats().swarms).toBe(0);
  });

  test("an invalid frame gets a failure reason, not a close", async () => {
    const p = await connect(await session(), NET_A);
    p.send({ action: "announce", info_hash: "short", peer_id: binaryId(1) });
    expect(await p.next((m) => "failure reason" in m)).toEqual({ "failure reason": "invalid info_hash" });
    p.send("{not json");
    expect(await p.next((m) => "failure reason" in m)).toEqual({ "failure reason": "invalid json" });
    expect(p.closed).toBeNull();
  });

  test("a peer id taken by another session in the swarm is refused", async () => {
    const a = await connect(await session(), NET_A);
    const b = await connect(await session(), NET_B);
    const hash = binaryId(77);
    a.send({ action: "announce", info_hash: hash, peer_id: binaryId(9) });
    await a.next((m) => m.interval !== undefined);
    b.send({ action: "announce", info_hash: hash, peer_id: binaryId(9) });
    expect(await b.next((m) => "failure reason" in m)).toMatchObject({ "failure reason": "peer_id in use" });
  });
});

describe("refusals", () => {
  test("no token", async () => {
    expect(await upgradeStatus(tracker.url, "/announce")).toBe(401);
    expect(tracker.stats().refused.token_malformed).toBeGreaterThan(0);
  });

  test("bad signature", async () => {
    const other = (await generateSigningKey()).key;
    const sid = await session();
    expect(await upgradeStatus(tracker.url, `/?t=${await token(sid, { signer: other })}`)).toBe(401);
  });

  test("iat older than the max age, and iat in the future", async () => {
    const sid = await session();
    expect(await upgradeStatus(tracker.url, `/?t=${await token(sid, { iat: nowS() - MAX_AGE - 5 })}`)).toBe(401);
    expect(await upgradeStatus(tracker.url, `/?t=${await token(sid, { iat: nowS() + 120 })}`)).toBe(401);
    // An expired (but young enough) token is fine: sockets outlive the 120 s token.
    expect(await upgradeStatus(tracker.url, `/?t=${await token(sid, { iat: nowS() - 600 })}`)).toBe(101);
  });

  test("session not heartbeating", async () => {
    const stale = await session(60_000);
    expect(await upgradeStatus(tracker.url, `/?t=${await token(stale)}`)).toBe(401);
    const unknown = crypto.randomUUID();
    expect(await upgradeStatus(tracker.url, `/?t=${await token(unknown)}`)).toBe(401);
    expect(tracker.stats().refused.not_watching).toBeGreaterThanOrEqual(2);
  });

  test("a second socket for one session", async () => {
    const sid = await session();
    await connect(sid, NET_A);
    expect(await upgradeStatus(tracker.url, `/?t=${await token(sid)}`)).toBe(409);
  });

  test("a plain HTTP request", async () => {
    expect((await fetch(tracker.url)).status).toBe(426);
  });

  test("an oversized frame closes the socket", async () => {
    const p = await connect(await session(), NET_A);
    p.send("x".repeat(LIMITS.maxFrameBytes + 1024));
    const { code } = await p.waitClosed();
    expect([1006, 1009]).toContain(code);
  });

  test("a frame flood closes the socket with 1008", async () => {
    const p = await connect(await session(), NET_A);
    for (let i = 0; i < LIMITS.rateBurst + 5; i++) p.send({ action: "scrape" });
    expect((await p.waitClosed()).code).toBe(1008);
  });

  test("a lapsed heartbeat closes the socket with 1008 on the next announce", async () => {
    const sid = await session();
    const p = await connect(sid, NET_A);
    p.send({ action: "announce", info_hash: binaryId(60), peer_id: binaryId(61) });
    await p.next((m) => m.interval !== undefined);
    await valkey.zadd(KEYS.viewers(CHANNEL), Date.now() - 60_000, sid);
    p.send({ action: "announce", info_hash: binaryId(60), peer_id: binaryId(61) });
    expect((await p.waitClosed()).code).toBe(1008);
  });
});
