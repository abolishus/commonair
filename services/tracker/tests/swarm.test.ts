// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { p2pSwarmId } from "@commonair/contracts/internal";
import { PendingExchanges } from "../src/exchanges.ts";
import { binaryToHex, LIMITS, parseFrame, type Frame } from "../src/protocol.ts";
import { SwarmRegistry, type Conn } from "../src/swarm.ts";
import { answerSdp, binaryId, id, offerSdp } from "./helpers.ts";

const CH = "0190f1c2-0000-7000-8000-00000000c0de";
const CH2 = "0190f1c2-0000-7000-8000-00000000beef";
const HASH = binaryId(1);
const SWARM = p2pSwarmId(CH, binaryToHex(HASH));

interface FakeConn extends Conn {
  sent: Record<string, unknown>[];
}
const conn = (channelId = CH): FakeConn => {
  const sent: Record<string, unknown>[] = [];
  return {
    sid: crypto.randomUUID(),
    channelId,
    pending: new PendingExchanges(),
    swarms: new Map(),
    sent,
    send: (m) => sent.push(m as Record<string, unknown>),
  };
};
const frame = (o: Record<string, unknown>): Frame => {
  const r = parseFrame(JSON.stringify({ action: "announce", info_hash: HASH, ...o }));
  if (!r.ok) throw new Error(r.reason);
  return r.frame;
};
const offers = (n: number) => Array.from({ length: n }, (_, i) => ({ offer: offerSdp(i), offer_id: id(100 + i) }));
const registry = (maxNumwant = 20) => {
  const deltas: number[] = [];
  const r = new SwarmRegistry({ maxNumwant, onSwarmCount: (d) => deltas.push(d) });
  return { r, deltas };
};

describe("announce", () => {
  test("joins, responds with interval and counts, keyed by channel + hex hash", () => {
    const { r, deltas } = registry();
    const a = conn();
    const out = r.handle(a, frame({ peer_id: id(1), left: 100 }));
    expect(out).toEqual({ kind: "announce", swarm: SWARM, offersRelayed: 0, answerRelayed: false, exchange: null });
    expect(a.sent).toEqual([
      { action: "announce", interval: LIMITS.announceInterval, info_hash: HASH, complete: 0, incomplete: 1 },
    ]);
    expect(a.swarms.get(SWARM)).toBe(id(1));
    expect(r.size).toBe(1);
    expect(deltas).toEqual([1]);
  });

  test("left 0 counts as a seeder; completed counts downloaded once", () => {
    const { r } = registry();
    const a = conn();
    const b = conn();
    r.handle(a, frame({ peer_id: id(1), left: 0 }));
    r.handle(b, frame({ peer_id: id(2), left: 5 }));
    expect(r.counts(SWARM)).toEqual({ complete: 1, incomplete: 1, downloaded: 0 });
    r.handle(b, frame({ peer_id: id(2), event: "completed" }));
    r.handle(b, frame({ peer_id: id(2), event: "completed" }));
    expect(r.counts(SWARM)).toEqual({ complete: 2, incomplete: 0, downloaded: 1 });
    r.handle(b, frame({ peer_id: id(2), left: 7 }));
    expect(r.counts(SWARM)).toEqual({ complete: 1, incomplete: 1, downloaded: 1 });
  });

  test("the running seeder count follows leaves and repeated announces", () => {
    const { r } = registry();
    const a = conn();
    const b = conn();
    r.handle(a, frame({ peer_id: id(1), left: 0 }));
    r.handle(a, frame({ peer_id: id(1), left: 0 }));
    r.handle(b, frame({ peer_id: id(2), event: "completed" }));
    expect(r.counts(SWARM)).toMatchObject({ complete: 2, incomplete: 0 });
    // A seeder that restarts with a new peer id is replaced, not double counted.
    r.handle(a, frame({ peer_id: id(3), left: 9 }));
    expect(r.counts(SWARM)).toMatchObject({ complete: 1, incomplete: 1 });
    r.handle(b, frame({ peer_id: id(2), event: "stopped" }));
    expect(r.counts(SWARM)).toMatchObject({ complete: 0, incomplete: 1 });
    // The emptied swarm is dropped, so a new one starts from zero.
    r.leaveAll(a);
    r.handle(b, frame({ peer_id: id(2), left: 0 }));
    expect(r.counts(SWARM)).toEqual({ complete: 1, incomplete: 0, downloaded: 0 });
  });

  test("a peer id claimed by another socket is refused", () => {
    const { r } = registry();
    const a = conn();
    const b = conn();
    r.handle(a, frame({ peer_id: id(1) }));
    const out = r.handle(b, frame({ peer_id: id(1) }));
    expect(out).toEqual({ kind: "refused", reason: "peer_id in use" });
    expect(b.sent.at(-1)).toMatchObject({ "failure reason": "peer_id in use", info_hash: HASH });
    expect(b.swarms.size).toBe(0);
    expect(r.counts(SWARM).incomplete).toBe(1);
  });

  test("a socket that changes its peer id in a swarm replaces itself", () => {
    const { r } = registry();
    const a = conn();
    r.handle(a, frame({ peer_id: id(1) }));
    r.handle(a, frame({ peer_id: id(2) }));
    expect(a.swarms.get(SWARM)).toBe(id(2));
    expect(r.counts(SWARM).incomplete).toBe(1);
  });

  test("swarms per socket are bounded", () => {
    const { r } = registry();
    const a = conn();
    for (let i = 0; i < LIMITS.maxSwarmsPerSocket; i++)
      expect(r.handle(a, { ...frame({ peer_id: id(1) }), infoHash: binaryId(50 + i) } as Frame).kind).toBe("announce");
    const out = r.handle(a, { ...frame({ peer_id: id(1) }), infoHash: binaryId(99) } as Frame);
    expect(out).toEqual({ kind: "refused", reason: "too many swarms" });
    expect(a.swarms.size).toBe(LIMITS.maxSwarmsPerSocket);
  });

  test("the same info hash in two channels is two swarms", () => {
    const { r } = registry();
    const a = conn(CH);
    const b = conn(CH2);
    r.handle(a, frame({ peer_id: id(1) }));
    r.handle(b, frame({ peer_id: id(1), offers: offers(1) }));
    expect(r.size).toBe(2);
    expect(a.sent).toHaveLength(1);
  });
});

describe("offer fan-out and answers", () => {
  test("offers go to distinct other peers, at most min(numwant, max, offers)", () => {
    const { r } = registry(3);
    const peers = Array.from({ length: 6 }, () => conn());
    peers.forEach((p, i) => r.handle(p, frame({ peer_id: id(10 + i) })));
    const a = conn();
    for (const p of peers) p.sent.length = 0;

    // numwant 2 < offers 5 < max 3: two relayed.
    let out = r.handle(a, frame({ peer_id: id(1), numwant: 2, offers: offers(5) }));
    expect(out).toMatchObject({ kind: "announce", offersRelayed: 2 });
    // Without numwant: min(offers 5, max 3) = 3.
    out = r.handle(a, frame({ peer_id: id(1), offers: offers(5) }));
    expect(out).toMatchObject({ offersRelayed: 3 });
    // Fewer offers than peers and numwant: one per offer.
    out = r.handle(a, frame({ peer_id: id(1), numwant: 10, offers: offers(1) }));
    expect(out).toMatchObject({ offersRelayed: 1 });
    expect(a.sent.filter((m) => "offer" in m)).toHaveLength(0);

    const received = peers.flatMap((p) => p.sent.filter((m) => "offer" in m));
    expect(received).toHaveLength(6);
    expect(received[0]).toEqual({
      action: "announce",
      offer: expect.objectContaining({ type: "offer" }),
      offer_id: expect.any(String),
      peer_id: id(1),
      info_hash: HASH,
    });
    // Within one announce no peer gets two offers.
    for (const p of peers) p.sent.length = 0;
    r.handle(a, frame({ peer_id: id(1), numwant: 3, offers: offers(3) }));
    for (const p of peers) expect(p.sent.filter((m) => "offer" in m).length).toBeLessThanOrEqual(1);
    expect(peers.filter((p) => p.sent.length > 0)).toHaveLength(3);
  });

  test("numwant 0 or an empty swarm relays nothing", () => {
    const { r } = registry();
    const a = conn();
    expect(r.handle(a, frame({ peer_id: id(1), offers: offers(3) }))).toMatchObject({ offersRelayed: 0 });
    const b = conn();
    expect(r.handle(b, frame({ peer_id: id(2), numwant: 0, offers: offers(3) }))).toMatchObject({ offersRelayed: 0 });
    expect(a.sent.filter((m) => "offer" in m)).toHaveLength(0);
  });

  test("large swarm sampling still picks distinct peers, never self", () => {
    let seed = 1;
    const r = new SwarmRegistry({
      maxNumwant: 5,
      random: () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646,
    });
    const peers = Array.from({ length: 200 }, () => conn());
    peers.forEach((p, i) => r.handle(p, frame({ peer_id: binaryId(1000 + i) })));
    const self = peers[0] as FakeConn;
    const out = r.handle(self, frame({ peer_id: binaryId(1000), offers: offers(5) }));
    expect(out).toMatchObject({ offersRelayed: 5 });
    expect(self.sent.filter((m) => "offer" in m)).toHaveLength(0);
    expect(peers.filter((p) => p.sent.some((m) => "offer" in m))).toHaveLength(5);
  });

  test("an answer is routed to to_peer_id only, without an announce response", () => {
    const { r } = registry();
    const a = conn();
    const b = conn();
    const c = conn();
    r.handle(a, frame({ peer_id: id(1) }));
    r.handle(b, frame({ peer_id: id(2) }));
    r.handle(c, frame({ peer_id: id(3) }));
    for (const x of [a, b, c]) x.sent.length = 0;
    const out = r.handle(b, frame({ peer_id: id(2), answer: answerSdp, to_peer_id: id(1), offer_id: id(77) }));
    // The tracker never relayed offer 77 from a to b: relayed, but no exchange.
    expect(out).toMatchObject({ kind: "announce", answerRelayed: true, exchange: null });
    expect(a.sent).toEqual([
      { action: "announce", answer: answerSdp, offer_id: id(77), peer_id: id(2), info_hash: HASH },
    ]);
    expect(b.sent).toEqual([]);
    expect(c.sent).toEqual([]);
  });

  test("an answer to an unknown peer or to oneself goes nowhere", () => {
    const { r } = registry();
    const a = conn();
    r.handle(a, frame({ peer_id: id(1) }));
    a.sent.length = 0;
    expect(r.handle(a, frame({ peer_id: id(1), answer: answerSdp, to_peer_id: id(9), offer_id: id(7) }))).toMatchObject(
      {
        answerRelayed: false,
      },
    );
    expect(r.handle(a, frame({ peer_id: id(1), answer: answerSdp, to_peer_id: id(1), offer_id: id(7) }))).toMatchObject(
      {
        answerRelayed: false,
      },
    );
    expect(a.sent).toEqual([]);
  });
});

describe("completed exchanges", () => {
  let t = 1_000_000;
  const timed = () => {
    const r = new SwarmRegistry({ maxNumwant: 20, now: () => t });
    const a = conn();
    const b = conn();
    const c = conn();
    r.handle(b, frame({ peer_id: id(2) }));
    r.handle(c, frame({ peer_id: id(3) }));
    // One offer from a: relayed to exactly one of b, c.
    r.handle(a, frame({ peer_id: id(1), offers: offers(1) }));
    const receiver = b.sent.some((m) => "offer" in m) ? b : c;
    const bystander = receiver === b ? c : b;
    const receiverPeer = receiver === b ? id(2) : id(3);
    const bystanderPeer = receiver === b ? id(3) : id(2);
    const answer = (from: FakeConn, peerId: string, offerId = id(100)) =>
      r.handle(from, frame({ peer_id: peerId, answer: answerSdp, to_peer_id: id(1), offer_id: offerId }));
    return { r, a, receiver, bystander, receiverPeer, bystanderPeer, answer };
  };

  test("the receiver's answer with the relayed offer_id completes it once, naming the offerer", () => {
    const { a, receiver, receiverPeer, answer } = timed();
    expect(a.pending.size).toBe(1);
    expect(answer(receiver, receiverPeer)).toMatchObject({ answerRelayed: true, exchange: a });
    expect(a.pending.size).toBe(0);
    // Replaying the same answer relays it but completes nothing.
    expect(answer(receiver, receiverPeer)).toMatchObject({ answerRelayed: true, exchange: null });
  });

  test("another session, a wrong offer_id, or a late answer completes nothing", () => {
    const { a, receiver, bystander, receiverPeer, bystanderPeer, answer } = timed();
    expect(answer(bystander, bystanderPeer)).toMatchObject({ answerRelayed: true, exchange: null });
    expect(answer(receiver, receiverPeer, id(101))).toMatchObject({ exchange: null });
    // The right answerer can still complete it after those.
    expect(a.pending.size).toBe(1);
    t += 60_001;
    expect(answer(receiver, receiverPeer)).toMatchObject({ answerRelayed: true, exchange: null });
    expect(a.pending.size).toBe(0);
  });
});

describe("leaving", () => {
  test("stopped removes the peer and the emptied swarm", () => {
    const { r, deltas } = registry();
    const a = conn();
    const b = conn();
    r.handle(a, frame({ peer_id: id(1) }));
    r.handle(b, frame({ peer_id: id(2) }));
    expect(r.handle(a, frame({ peer_id: id(1), event: "stopped" }))).toEqual({ kind: "stopped", swarm: SWARM });
    expect(a.sent.at(-1)).toMatchObject({ action: "announce", incomplete: 1 });
    expect(a.swarms.size).toBe(0);
    expect(r.counts(SWARM).incomplete).toBe(1);
    r.handle(b, frame({ peer_id: id(2), event: "stopped" }));
    expect(r.size).toBe(0);
    expect(deltas).toEqual([1, -1]);
  });

  test("leaveAll (socket close) removes the conn from every swarm and keeps others' indices valid", () => {
    const { r } = registry();
    const a = conn();
    const others = [conn(), conn(), conn()];
    others.forEach((o, i) => r.handle(o, frame({ peer_id: id(10 + i) })));
    r.handle(a, frame({ peer_id: id(1) }));
    r.handle(a, { ...frame({ peer_id: id(1) }), infoHash: binaryId(2) } as Frame);
    const left = r.leaveAll(a);
    expect(left.sort()).toEqual([SWARM, p2pSwarmId(CH, binaryToHex(binaryId(2)))].sort());
    expect(r.size).toBe(1);
    // Remove from the middle, then make sure sampling still reaches everyone left.
    r.leaveAll(others[0] as FakeConn);
    const out = r.handle(a, frame({ peer_id: id(1), offers: offers(5) }));
    expect(out).toMatchObject({ offersRelayed: 2 });
  });
});

describe("scrape", () => {
  test("by hash, unknown hash, and no hash (own swarms only)", () => {
    const { r } = registry();
    const a = conn();
    const b = conn();
    const other = conn(CH2);
    r.handle(a, frame({ peer_id: id(1), left: 0 }));
    r.handle(b, frame({ peer_id: id(2), left: 1 }));
    r.handle(other, { ...frame({ peer_id: id(3) }), infoHash: binaryId(5) } as Frame);

    r.handle(a, { action: "scrape", infoHashes: [HASH, binaryId(5)] });
    expect(a.sent.at(-1)).toEqual({
      action: "scrape",
      files: {
        [HASH]: { complete: 1, incomplete: 1, downloaded: 0 },
        // binaryId(5) exists only in another channel: invisible here.
        [binaryId(5)]: { complete: 0, incomplete: 0, downloaded: 0 },
      },
    });
    r.handle(b, { action: "scrape", infoHashes: [] });
    expect(b.sent.at(-1)).toEqual({
      action: "scrape",
      files: { [HASH]: { complete: 1, incomplete: 1, downloaded: 0 } },
    });
    const lonely = conn();
    r.handle(lonely, { action: "scrape", infoHashes: [] });
    expect(lonely.sent.at(-1)).toEqual({ action: "scrape", files: {} });
  });
});
