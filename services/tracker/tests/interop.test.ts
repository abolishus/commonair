// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pinned P2P client's frames (`tests/fixtures.ts`, p2p-media-loader-core 4.0.0) against the
 * parser and the registry, and the registry's replies through the client's reading rules.
 */
import { describe, expect, test } from "vite-plus/test";
import { P2P_INFOHASH_VECTORS, p2pSwarmId } from "@commonair/contracts/internal";
import { PendingExchanges } from "../src/exchanges.ts";
import { binaryToHex, LIMITS, parseFrame, type Frame } from "../src/protocol.ts";
import { SwarmRegistry, type Conn } from "../src/swarm.ts";
import {
  ANSWER_SDP,
  answer,
  clientReads,
  INFO_HASH,
  OFFER_ID,
  OFFER_SDP,
  OTHER_PEER_ID,
  PEER_ID,
  periodicNoOffers,
  periodicWithTrackerId,
  startedWithOffers,
  stopped,
} from "./fixtures.ts";

const CH = "0190f1c2-0000-7000-8000-00000000c0de";

const parse = (o: unknown): Frame => {
  const r = parseFrame(JSON.stringify(o));
  if (!r.ok) throw new Error(r.reason);
  return r.frame;
};
interface FakeConn extends Conn {
  sent: Record<string, unknown>[];
}
const conn = (): FakeConn => {
  const sent: Record<string, unknown>[] = [];
  return {
    sid: crypto.randomUUID(),
    channelId: CH,
    pending: new PendingExchanges(),
    swarms: new Map(),
    sent,
    send: (m) => sent.push(m as Record<string, unknown>),
  };
};

describe("frames the client sends parse", () => {
  test("started announce with offers", () => {
    expect(parse(startedWithOffers())).toEqual({
      action: "announce",
      infoHash: INFO_HASH,
      peerId: PEER_ID,
      numwant: 1,
      event: "started",
      offers: [{ offer: OFFER_SDP, offerId: OFFER_ID }],
    });
  });

  test("periodic announce without offers (numwant 0)", () => {
    expect(parse(periodicNoOffers())).toEqual({
      action: "announce",
      infoHash: INFO_HASH,
      peerId: PEER_ID,
      numwant: 0,
      offers: [],
    });
  });

  test("an echoed trackerid is ignored", () => {
    expect(parse(periodicWithTrackerId())).toEqual(parse(periodicNoOffers()));
  });

  test("stopped", () => {
    expect(parse(stopped())).toMatchObject({ event: "stopped", numwant: 0, offers: [] });
  });

  test("answer", () => {
    expect(parse(answer())).toEqual({
      action: "announce",
      infoHash: INFO_HASH,
      peerId: PEER_ID,
      offers: [],
      answer: { sdp: ANSWER_SDP, toPeerId: OTHER_PEER_ID, offerId: OFFER_ID },
    });
  });

  test("every vector info hash is accepted as an info_hash", () => {
    for (const v of P2P_INFOHASH_VECTORS) expect(parse(periodicNoOffers(v.infoHash)).action).toBe("announce");
  });
});

describe("shapes outside the subset stay refused", () => {
  const fail = (o: unknown) => {
    const r = parseFrame(JSON.stringify(o));
    return r.ok ? null : r.reason;
  };
  test.each([
    ["a 19-character info hash", { ...periodicNoOffers(), info_hash: INFO_HASH.slice(1) }, "invalid info_hash"],
    ["a 21-character peer id", { ...periodicNoOffers(), peer_id: `${PEER_ID}x` }, "invalid peer_id"],
    [
      "an offer typed answer",
      { ...startedWithOffers(), offers: [{ offer: ANSWER_SDP, offer_id: OFFER_ID }] },
      "invalid offer",
    ],
    ["a pranswer answer", { ...answer(), answer: { type: "pranswer", sdp: "x" } }, "invalid answer"],
    [
      "a short offer id",
      { ...startedWithOffers(), offers: [{ offer: OFFER_SDP, offer_id: "abc" }] },
      "invalid offer_id",
    ],
    ["an unknown event", { ...periodicNoOffers(), event: "paused" }, "invalid event"],
    ["a negative numwant", { ...periodicNoOffers(), numwant: -1 }, "invalid numwant"],
    ["an answer with offers", { ...answer(), offers: startedWithOffers().offers }, "answer with offers"],
    [
      "too many offers",
      {
        ...startedWithOffers(),
        offers: Array(LIMITS.maxOffersPerAnnounce + 1).fill({ offer: OFFER_SDP, offer_id: OFFER_ID }),
      },
      "too many offers",
    ],
  ])("%s", (_, frame, reason) => {
    expect(fail(frame)).toBe(reason);
  });
});

describe("what the client reads back", () => {
  test("an announce response: interval at least the client's 20 s floor, its own info hash", () => {
    const r = new SwarmRegistry({ maxNumwant: 20 });
    const a = conn();
    r.handle(a, parse(periodicNoOffers()));
    const read = clientReads(a.sent[0] ?? {}, { infoHash: INFO_HASH, peerId: PEER_ID });
    expect(read).toEqual({ kind: "interval", seconds: LIMITS.announceInterval });
    expect(LIMITS.announceInterval).toBeGreaterThanOrEqual(20);
  });

  test("a relayed offer, then the relayed answer", () => {
    const r = new SwarmRegistry({ maxNumwant: 20 });
    const a = conn();
    const b = conn();
    r.handle(a, parse(periodicNoOffers(INFO_HASH, PEER_ID)));
    r.handle(b, parse(startedWithOffers(INFO_HASH, OTHER_PEER_ID)));
    const offer = a.sent.find((m) => m.offer !== undefined) ?? {};
    expect(clientReads(offer, { infoHash: INFO_HASH, peerId: PEER_ID })).toEqual({
      kind: "offer",
      peerId: OTHER_PEER_ID,
      offerId: OFFER_ID,
    });

    const out = r.handle(a, parse(answer(INFO_HASH, PEER_ID, OTHER_PEER_ID, OFFER_ID)));
    expect(out).toMatchObject({ kind: "announce", answerRelayed: true });
    expect(out.kind === "announce" && out.exchange).toBe(b);
    const ans = b.sent.find((m) => m.answer !== undefined) ?? {};
    expect(clientReads(ans, { infoHash: INFO_HASH, peerId: OTHER_PEER_ID })).toEqual({
      kind: "answer",
      peerId: PEER_ID,
      offerId: OFFER_ID,
    });
    // No announce response to the answer itself.
    expect(a.sent.filter((m) => m.interval !== undefined)).toHaveLength(1);
  });

  test("a message for another swarm on the shared socket is ignored by the other torrents", () => {
    const other = (P2P_INFOHASH_VECTORS[1] as { infoHash: string }).infoHash;
    const msg = { action: "announce", interval: 120, info_hash: other, complete: 0, incomplete: 1 };
    expect(clientReads(msg, { infoHash: INFO_HASH, peerId: PEER_ID })).toEqual({ kind: "ignored" });
  });

  test("a refusal with info_hash reaches only that swarm's torrent", () => {
    const msg = { "failure reason": "info_hash not allowed", info_hash: INFO_HASH };
    expect(clientReads(msg, { infoHash: INFO_HASH, peerId: PEER_ID })).toEqual({
      kind: "failure",
      reason: "info_hash not allowed",
    });
    const other = (P2P_INFOHASH_VECTORS[1] as { infoHash: string }).infoHash;
    expect(clientReads(msg, { infoHash: other, peerId: PEER_ID })).toEqual({ kind: "ignored" });
  });

  test("a level switch: stopped leaves the old rendition's swarm, the new one joins", () => {
    const r = new SwarmRegistry({ maxNumwant: 20 });
    const a = conn();
    const [h0, h1] = P2P_INFOHASH_VECTORS.map((v) => v.infoHash);
    r.handle(a, parse(periodicNoOffers(h0)));
    r.handle(a, parse(periodicNoOffers(h1)));
    expect(a.swarms.size).toBe(2);
    expect(r.handle(a, parse(stopped(h0)))).toEqual({ kind: "stopped", swarm: p2pSwarmId(CH, binaryToHex(h0 ?? "")) });
    expect([...a.swarms.keys()]).toEqual([p2pSwarmId(CH, binaryToHex(h1 ?? ""))]);
  });

  test("one peer id in every swarm of a grant: all ten derived swarms fit on one socket", () => {
    const r = new SwarmRegistry({ maxNumwant: 20 });
    const a = conn();
    const hashes = P2P_INFOHASH_VECTORS.slice(0, LIMITS.maxSwarmsPerSocket).map((v) => v.infoHash);
    for (const h of hashes) expect(r.handle(a, parse(periodicNoOffers(h))).kind).toBe("announce");
    expect(a.swarms.size).toBe(10);
    expect(new Set(a.swarms.values())).toEqual(new Set([PEER_ID]));
  });
});
