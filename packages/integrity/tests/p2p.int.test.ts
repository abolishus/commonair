// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `readP2pEvidence` against real Valkey, with keys written the way `services/tracker` writes them. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS, P2P_EVIDENCE, p2pSwarmId } from "@commonair/contracts/internal";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { readP2pEvidence } from "../src/p2p.ts";

let valkey: ValkeyClient;
beforeAll(() => {
  valkey = createValkey(process.env.VALKEY_URL ?? "redis://localhost:6379", {
    keyPrefix: `test:${crypto.randomUUID()}:`,
    name: "integrity-p2p-test",
  });
});
afterAll(async () => {
  await valkey?.quit();
});

const T = Date.now();
const W = P2P_EVIDENCE.windowMs;
const MAX = P2P_EVIDENCE.maxSessionsPerNetwork;
const TTL = P2P_EVIDENCE.peerTtlSeconds;
const hash = () => crypto.randomUUID().replaceAll("-", "").padEnd(40, "0");

/** One accepted announce, as the tracker records it. */
async function announce(
  sid: string,
  channelId: string,
  net: string,
  at = T - 1_000,
  swarm = p2pSwarmId(channelId, hash()),
) {
  const cutoff = `(${at - TTL * 1000}`;
  await valkey
    .pipeline()
    .hset(KEYS.p2pPeer(sid), { swarm, net, last: String(at) })
    .hsetnx(KEYS.p2pPeer(sid), "first", String(at))
    .hincrby(KEYS.p2pPeer(sid), "announces", 1)
    .expire(KEYS.p2pPeer(sid), TTL)
    .zadd(KEYS.p2pSwarm(swarm), at, sid)
    .zremrangebyscore(KEYS.p2pSwarm(swarm), "-inf", cutoff)
    .expire(KEYS.p2pSwarm(swarm), TTL)
    .zadd(KEYS.p2pChannelNet(channelId, net), at, sid)
    .zremrangebyscore(KEYS.p2pChannelNet(channelId, net), "-inf", cutoff)
    .expire(KEYS.p2pChannelNet(channelId, net), TTL)
    .exec();
  return swarm;
}
/** A completed offer/answer exchange: both sides get the other's network. */
async function exchange(a: { sid: string; net: string }, b: { sid: string; net: string }, at = T - 1_000) {
  const p = valkey.pipeline();
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const key = KEYS.p2pLinks(self.sid);
    p.zadd(key, at, other.net)
      .zremrangebyscore(key, "-inf", `(${at - TTL * 1000}`)
      .expire(key, TTL);
  }
  await p.exec();
}
const ref = (id: string, channelId: string, at = T) => ({ id, channelId, at });
const sid = () => crypto.randomUUID();
const net = () => `net-${crypto.randomUUID()}`;

describe("readP2pEvidence", () => {
  test("a completed exchange with another network evidences both sides; announcing alone does not", async () => {
    const ch = crypto.randomUUID();
    const [a, b, lurker] = [sid(), sid(), sid()];
    const [na, nb, nc] = [net(), net(), net()];
    const swarm = await announce(a, ch, na);
    await announce(b, ch, nb, T - 1_000, swarm);
    await announce(lurker, ch, nc, T - 1_000, swarm);
    await exchange({ sid: a, net: na }, { sid: b, net: nb });
    const r = await readP2pEvidence(valkey, [ref(a, ch), ref(b, ch), ref(lurker, ch)]);
    expect(r.errors).toBe(0);
    expect(r.evidence.get(a)).toMatchObject({ evidenced: true, linkedNetworks: 1, sameNetworkPeers: 1 });
    expect(r.evidence.get(b)?.evidenced).toBe(true);
    // In a diverse swarm, but never exchanged: not evidenced.
    expect(r.evidence.get(lurker)).toMatchObject({ evidenced: false, linkedNetworks: 0 });
  });

  test("links at the window edge count; older ones and links to its own network do not", async () => {
    const ch = crypto.randomUUID();
    const [edge, old, self, other] = [sid(), sid(), sid(), sid()];
    const [n1, n2, shared] = [net(), net(), net()];
    await announce(edge, ch, n1);
    await announce(old, ch, n2);
    await announce(self, ch, shared);
    await announce(other, ch, shared);
    await exchange({ sid: edge, net: n1 }, { sid: sid(), net: net() }, T - W);
    await exchange({ sid: old, net: n2 }, { sid: sid(), net: net() }, T - W - 1);
    await exchange({ sid: self, net: shared }, { sid: other, net: shared });
    const r = await readP2pEvidence(valkey, [ref(edge, ch), ref(old, ch), ref(self, ch)]);
    expect(r.evidence.get(edge)?.evidenced).toBe(true);
    expect(r.evidence.get(old)?.evidenced).toBe(false);
    expect(r.evidence.get(self)).toMatchObject({ evidenced: false, linkedNetworks: 0 });
  });

  test("per-channel cap: exactly maxSessionsPerNetwork on one network evidences, one more does not", async () => {
    const ch = crypto.randomUUID();
    const honest = { sid: sid(), net: net() };
    await announce(honest.sid, ch, honest.net);
    const farmNet = net();
    const farm = Array.from({ length: MAX }, () => sid());
    // Every farm session in its own client-chosen swarm: the cap is per channel, not per swarm.
    for (const f of farm) {
      await announce(f, ch, farmNet);
      await exchange({ sid: f, net: farmNet }, honest);
    }
    let r = await readP2pEvidence(
      valkey,
      farm.map((f) => ref(f, ch)),
    );
    expect([...r.evidence.values()].filter((e) => e.evidenced)).toHaveLength(MAX);
    expect(r.evidence.get(farm[0]!)?.sameNetworkPeers).toBe(MAX);

    const extra = sid();
    await announce(extra, ch, farmNet);
    await exchange({ sid: extra, net: farmNet }, honest);
    r = await readP2pEvidence(
      valkey,
      [...farm, extra].map((f) => ref(f, ch)),
    );
    expect([...r.evidence.values()].filter((e) => e.evidenced)).toHaveLength(0);
    expect(r.evidence.get(extra)?.sameNetworkPeers).toBe(MAX + 1);
    // Another channel's count is separate.
    const ch2 = crypto.randomUUID();
    const elsewhere = sid();
    await announce(elsewhere, ch2, farmNet);
    await exchange({ sid: elsewhere, net: farmNet }, { sid: sid(), net: net() });
    expect((await readP2pEvidence(valkey, [ref(elsewhere, ch2)])).evidence.get(elsewhere)?.evidenced).toBe(true);
  });

  test("two networks over the cap cannot vouch for each other", async () => {
    const ch = crypto.randomUUID();
    const [netX, netY] = [net(), net()];
    const xs = Array.from({ length: MAX + 1 }, () => sid());
    const ys = Array.from({ length: MAX + 1 }, () => sid());
    for (const id of xs) await announce(id, ch, netX);
    for (const id of ys) await announce(id, ch, netY);
    // A session on a third, small network linked only to the over-cap network Y.
    const lone = { sid: sid(), net: net() };
    await announce(lone.sid, ch, lone.net);
    await exchange(lone, { sid: ys[0]!, net: netY });
    for (let i = 0; i <= MAX; i++) await exchange({ sid: xs[i]!, net: netX }, { sid: ys[i]!, net: netY });
    const r = await readP2pEvidence(valkey, [ref(xs[0]!, ch), ref(lone.sid, ch)]);
    expect(r.evidence.get(xs[0]!)?.evidenced).toBe(false);
    expect(r.evidence.get(lone.sid)).toMatchObject({ evidenced: false, linkedNetworks: 1, linkedWithinCap: 0 });
  });

  test("leaving the swarm does not dodge the cap, and an ended session counts later announcers", async () => {
    const ch = crypto.randomUUID();
    const farmNet = net();
    const honest = { sid: sid(), net: net() };
    await announce(honest.sid, ch, honest.net);
    const farm = Array.from({ length: MAX + 1 }, () => sid());
    for (const f of farm) {
      const swarm = await announce(f, ch, farmNet);
      // A `stopped` announce removes it from the swarm, never from the channel count.
      await valkey.zrem(KEYS.p2pSwarm(swarm), f);
    }
    await exchange({ sid: farm[0]!, net: farmNet }, honest);
    expect((await readP2pEvidence(valkey, [ref(farm[0]!, ch)])).evidence.get(farm[0]!)?.evidenced).toBe(false);

    // An ended session judged at its end still sees peers that kept announcing after it.
    const ch2 = crypto.randomUUID();
    const end = T - 30_000;
    const ended = sid();
    await announce(ended, ch2, farmNet, end - 1_000);
    await exchange({ sid: ended, net: farmNet }, honest, end - 2_000);
    for (let i = 0; i < MAX; i++) await announce(sid(), ch2, farmNet, T - 1_000);
    expect((await readP2pEvidence(valkey, [ref(ended, ch2, end)])).evidence.get(ended)?.evidenced).toBe(false);
  });

  test("a corrupt key is a counted error, not a throw", async () => {
    const ch = crypto.randomUUID();
    const a = sid();
    const na = net();
    await announce(a, ch, na);
    await exchange({ sid: a, net: na }, { sid: sid(), net: net() });
    await valkey.set(KEYS.p2pChannelNet(ch, na), "not-a-zset");
    const broken = sid();
    await valkey.set(KEYS.p2pPeer(broken), "not-a-hash");
    const r = await readP2pEvidence(valkey, [ref(a, ch), ref(broken, ch)]);
    expect(r.evidence.size).toBe(0);
    expect(r.errors).toBe(2);
  });
});
