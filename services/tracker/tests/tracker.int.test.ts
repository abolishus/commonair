// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The tracker in-process on an ephemeral port against the real Valkey: authenticated sockets,
 * offer/answer relay between two sessions on two networks, evidence in Valkey, and refusals.
 */
import { connect as tcpConnect, type Socket } from "node:net";
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
const connect = async (sid: string, ip: string, iat?: number) => {
  const p = await Peer.open(`${wsBase}/announce?t=${await token(sid, { iat })}`, { "x-forwarded-for": ip });
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
  await valkey.del(
    KEYS.viewers(CHANNEL),
    KEYS.p2pSwarm(SWARM),
    ...sessions.flatMap((s) => [KEYS.p2pPeer(s), KEYS.p2pLinks(s)]),
  );
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
      // The completed exchange: each side holds the other's network.
      expect(await valkey.zrange(KEYS.p2pLinks(sidA), 0, -1)).toEqual([hb.net]);
      expect(await valkey.zrange(KEYS.p2pLinks(sidB), 0, -1)).toEqual([ha.net]);
      expect(Number(await valkey.zscore(KEYS.p2pLinks(sidA), hb.net ?? ""))).toBeGreaterThan(Date.now() - 10_000);
      expect(await valkey.ttl(KEYS.p2pLinks(sidB))).toBeGreaterThan(500);
    });
    expect(tracker.stats().exchanges).toBeGreaterThanOrEqual(1);
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

    // The per-channel network ZSETs keep both sessions after `stopped` and close: leaving never
    // dodges the per-network cap. Each network holds only its own session.
    const chA = KEYS.p2pChannelNet(CHANNEL, await evidence.networkHash(NET_A));
    const chB = KEYS.p2pChannelNet(CHANNEL, await evidence.networkHash(NET_B));
    expect(await valkey.zrange(chA, 0, -1)).toContain(sidA);
    expect(await valkey.zrange(chA, 0, -1)).not.toContain(sidB);
    expect(await valkey.zrange(chB, 0, -1)).toContain(sidB);
    expect(Number(await valkey.zscore(chA, sidA))).toBeGreaterThan(Date.now() - 10_000);
    expect(await valkey.ttl(chB)).toBeGreaterThan(500);
  });

  test("an invalid frame gets a failure reason, not a close", async () => {
    const p = await connect(await session(), NET_A);
    p.send({ action: "announce", info_hash: "short", peer_id: binaryId(1) });
    expect(await p.next((m) => "failure reason" in m)).toEqual({ "failure reason": "invalid info_hash" });
    p.send("{not json");
    expect(await p.next((m) => "failure reason" in m)).toEqual({ "failure reason": "invalid json" });
    expect(p.closed).toBeNull();
  });

  test("p2pChannelNet counts one network across all of the channel's swarms", async () => {
    const net = "192.0.2.";
    const sids = [await session(), await session(), await session()];
    const ps = await Promise.all(sids.map((sid, i) => connect(sid, `${net}${10 + i}`)));
    // Three private swarms (client-chosen hashes), one network.
    for (const [i, p] of ps.entries()) {
      p.send({ action: "announce", info_hash: binaryId(200 + i), peer_id: binaryId(210 + i) });
      await p.next((m) => m.interval !== undefined);
    }
    const key = KEYS.p2pChannelNet(CHANNEL, await new Evidence(valkey, SECRET).networkHash(`${net}1`));
    await eventually(async () => expect((await valkey.zrange(key, 0, -1)).sort()).toEqual([...sids].sort()));
    for (const p of ps) p.close();
    await Bun.sleep(100);
    expect(await valkey.zcard(key)).toBe(3);
    await valkey.del(key);
  });

  test("an answer to an offer the tracker never relayed writes no links", async () => {
    const sidA = await session();
    const sidB = await session();
    const a = await connect(sidA, NET_A);
    const b = await connect(sidB, NET_B);
    const hash = binaryId(88);
    a.send({ action: "announce", info_hash: hash, peer_id: binaryId(4) });
    await a.next((m) => m.interval !== undefined);
    b.send({ action: "announce", info_hash: hash, peer_id: binaryId(5) });
    await b.next((m) => m.interval !== undefined);
    b.send({
      action: "announce",
      info_hash: hash,
      peer_id: binaryId(5),
      to_peer_id: binaryId(4),
      answer: answerSdp,
      offer_id: binaryId(6),
    });
    // Still relayed (it is signalling), but not an exchange.
    await a.next((m) => m.answer !== undefined);
    await eventually(async () => expect(await valkey.hget(KEYS.p2pPeer(sidB), "announces")).toBe("2"));
    expect(await valkey.exists(KEYS.p2pLinks(sidA), KEYS.p2pLinks(sidB))).toBe(0);
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

  test("a second socket for one session with the same or an older iat", async () => {
    const sid = await session();
    const iat = nowS() - 60;
    await connect(sid, NET_A, iat);
    expect(await upgradeStatus(tracker.url, `/?t=${await token(sid, { iat })}`)).toBe(409);
    expect(await upgradeStatus(tracker.url, `/?t=${await token(sid, { iat: iat - 1 })}`)).toBe(409);
  });

  test("a newer iat replaces the session's socket and reclaims its peer id", async () => {
    const sid = await session();
    const hash = binaryId(90);
    const peerId = binaryId(91);
    const old = await connect(sid, NET_A, nowS() - 60);
    old.send({ action: "announce", info_hash: hash, peer_id: peerId });
    await old.next((m) => m.interval !== undefined);
    const replaced = tracker.stats().replaced;

    const fresh = await connect(sid, NET_A, nowS());
    expect((await old.waitClosed()).code).toBe(1008);
    expect(tracker.stats().replaced).toBe(replaced + 1);
    fresh.send({ action: "announce", info_hash: hash, peer_id: peerId });
    expect(await fresh.next((m) => m.interval !== undefined)).toMatchObject({ incomplete: 1 });
    const swarm = p2pSwarmId(CHANNEL, binaryToHex(hash));
    await eventually(async () => expect(await valkey.zrange(KEYS.p2pSwarm(swarm), 0, -1)).toEqual([sid]));
    await valkey.del(KEYS.p2pSwarm(swarm));
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

/** A raw WebSocket client that upgrades, sends text frames, and can stop reading. */
function rawSocket(base: URL, path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = tcpConnect(Number(base.port), base.hostname, () => {
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: tracker\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    s.once("data", (d) => (String(d).startsWith("HTTP/1.1 101") ? resolve(s) : reject(new Error(String(d)))));
    s.once("error", reject);
  });
}
/** One masked client text frame (RFC 6455). */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff]);
  const body = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] ?? 0)));
  return Buffer.concat([head, mask, body]);
}

describe("limits", () => {
  let small: Tracker;
  let base: string;
  beforeAll(() => {
    small = startTracker({
      port: 0,
      hostname: "127.0.0.1",
      logger: createLogger({ service: "tracker-int-limits", level: "fatal" }),
      valkey,
      publicKey: key.publicKey,
      internalSecret: SECRET,
      trustedProxies: ["127.0.0.0/8", "::1/128"],
      limits: { maxConnections: 100, maxConnectionsPerIp: 2, maxNumwant: 20, tokenMaxAgeSeconds: MAX_AGE },
      backpressureBytes: 64 * 1024,
      rate: { burst: 10_000, perSecond: 10_000 },
    });
    base = `ws://127.0.0.1:${small.url.port}`;
  });
  afterAll(async () => {
    await small.stop();
  });

  test("the per-address limit counts an IPv6 /64 as one address", async () => {
    const open = async (ip: string) => {
      const p = await Peer.open(`${base}/?t=${await token(await session())}`, { "x-forwarded-for": ip });
      peers.push(p);
      return p;
    };
    const opened = [await open("2001:db8:1:2::1"), await open("2001:db8:1:2:ffff::2")];
    const status = async (ip: string) =>
      upgradeStatus(small.url, `/?t=${await token(await session())}`, { "x-forwarded-for": ip });
    expect(await status("2001:db8:1:2::3")).toBe(429);
    expect(small.stats().refused.ip_limit).toBeGreaterThanOrEqual(1);
    // Another /64 of the same /48 is a different subscriber.
    expect(await status("2001:db8:1:3::1")).toBe(101);
    for (const p of opened) p.close();
  });

  test("a socket that stops reading is closed at the backpressure limit", async () => {
    const hash = binaryId(150);
    const slow = await rawSocket(small.url, `/?t=${await token(await session())}`);
    slow.write(textFrame(JSON.stringify({ action: "announce", info_hash: hash, peer_id: binaryId(151) })));
    await eventually(async () => expect(small.stats().swarms).toBe(1));
    slow.pause();
    const before = small.stats().connections;

    const sender = await Peer.open(`${base}/?t=${await token(await session())}`, { "x-forwarded-for": NET_B });
    peers.push(sender);
    const sdp = { type: "offer", sdp: `v=0\r\n${"a=x\r\n".repeat(2500)}` };
    for (let i = 0; i < 400; i++)
      sender.send({
        action: "announce",
        info_hash: hash,
        peer_id: binaryId(152),
        offers: [{ offer: sdp, offer_id: binaryId(i) }],
      });
    // The slow socket is dropped; the sender keeps its connection.
    await eventually(async () => expect(small.stats().connections).toBe(before), 10_000);
    expect(sender.closed).toBeNull();
    slow.destroy();
  });
});
