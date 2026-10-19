// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { P2P_EVIDENCE } from "@commonair/contracts/internal";
import type { ValkeyClient } from "@commonair/service";
import {
  isP2pCandidate,
  linkedNetworks,
  NOT_EVIDENCED,
  P2P_RULE,
  p2pEvidenceFor,
  parseLinks,
  parseP2pPeer,
  readP2pEvidence,
  type P2pLink,
  type P2pPeer,
  type P2pSessionRef,
} from "../src/p2p.ts";

const T = 1_800_000_000_000;
const W = P2P_EVIDENCE.windowMs;
const CH = "0190a6f4-0000-7000-8000-000000000001";
const OTHER = "0190a6f4-0000-7000-8000-000000000002";
const SWARM = `${CH}:${"a".repeat(40)}`;
const peer = (o: Partial<P2pPeer> = {}): P2pPeer => ({
  swarm: SWARM,
  net: "net-a",
  first: T - 600_000,
  last: T - 1_000,
  announces: 7,
  ...o,
});
const S: P2pSessionRef = { id: "self", channelId: CH, at: T };
const link = (net: string, at = T - 1_000): P2pLink => ({ net, at });
const MAX = P2P_EVIDENCE.maxSessionsPerNetwork;
/** Channel announcer counts per network; every network within the cap unless given. */
const counts = (o: Record<string, number> = {}) => new Map(Object.entries({ "net-a": 1, "net-b": 1, ...o }));
const ev = (links: readonly P2pLink[], netCounts = counts(), p: P2pPeer | null = peer(), s: P2pSessionRef = S) =>
  p2pEvidenceFor(s, p, links, netCounts);

describe("parseP2pPeer", () => {
  test("parses the tracker's hash and rejects incomplete ones", () => {
    expect(parseP2pPeer({ swarm: SWARM, net: "n", first: "10", last: "20", announces: "3" })).toEqual({
      swarm: SWARM,
      net: "n",
      first: 10,
      last: 20,
      announces: 3,
    });
    expect(parseP2pPeer({ swarm: SWARM, net: "n", last: "20" })).toEqual({
      swarm: SWARM,
      net: "n",
      first: 20,
      last: 20,
      announces: 0,
    });
    expect(parseP2pPeer({})).toBeNull();
    expect(parseP2pPeer(null)).toBeNull();
    expect(parseP2pPeer({ swarm: SWARM, net: "", last: "20" })).toBeNull();
    expect(parseP2pPeer({ swarm: SWARM, net: "n", last: "soon" })).toBeNull();
    expect(parseP2pPeer({ net: "n", last: "20" })).toBeNull();
  });
});

describe("p2p evidence predicate", () => {
  test("a link to another network within the cap evidences the session", () => {
    expect(P2P_EVIDENCE.minLinkedNetworks).toBe(1);
    expect(ev([link("net-b")])).toEqual({
      evidenced: true,
      linkedNetworks: 1,
      linkedWithinCap: 1,
      sameNetworkPeers: 1,
      announces: 7,
    });
    expect(ev([link("net-b"), link("net-c")], counts({ "net-c": 3 }))).toMatchObject({
      evidenced: true,
      linkedNetworks: 2,
      linkedWithinCap: 2,
    });
  });

  test("no links, however diverse the swarm, is not evidenced", () => {
    // Regression: announcing into a popular multi-network swarm used to be enough.
    expect(ev([], counts({ "net-b": 1, "net-c": 1, "net-d": 1 }))).toMatchObject({
      evidenced: false,
      linkedNetworks: 0,
    });
  });

  test("a link only to its own network does not count", () => {
    expect(ev([link("net-a"), link("net-a", T - 5)])).toMatchObject({ evidenced: false, linkedNetworks: 0 });
    expect(linkedNetworks(peer(), [link("net-a"), link("net-b"), link("net-b", T - 9)], S)).toEqual(["net-b"]);
  });

  test("window edges: the session's last announce and each link", () => {
    expect(isP2pCandidate(peer({ last: T - W }), S)).toBe(true);
    expect(isP2pCandidate(peer({ last: T - W - 1 }), S)).toBe(false);
    expect(ev([link("net-b")], counts(), peer({ last: T - W - 1 }))).toBe(NOT_EVIDENCED);
    // A link at the window start counts; one before it does not.
    expect(ev([link("net-b", T - W)]).evidenced).toBe(true);
    expect(ev([link("net-b", T - W - 1)]).evidenced).toBe(false);
  });

  test("own network: exactly maxSessionsPerNetwork announcers evidences, one more does not", () => {
    expect(MAX).toBe(16);
    expect(ev([link("net-b")], counts({ "net-a": MAX }))).toMatchObject({ evidenced: true, sameNetworkPeers: MAX });
    expect(ev([link("net-b")], counts({ "net-a": MAX + 1 }))).toMatchObject({
      evidenced: false,
      sameNetworkPeers: MAX + 1,
    });
  });

  test("a linked network over the cap cannot vouch", () => {
    // Two farm networks over the cap linking each other.
    expect(ev([link("net-b")], counts({ "net-b": MAX + 1 }))).toMatchObject({
      evidenced: false,
      linkedNetworks: 1,
      linkedWithinCap: 0,
    });
    expect(ev([link("net-b")], counts({ "net-b": MAX })).evidenced).toBe(true);
    // One honest linked network is enough.
    expect(ev([link("net-b"), link("net-c")], counts({ "net-b": MAX + 1, "net-c": 2 }))).toMatchObject({
      evidenced: true,
      linkedWithinCap: 1,
    });
  });

  test("an unknown count (failed read) is treated as over the cap", () => {
    expect(ev([link("net-b")], new Map([["net-b", 1]])).evidenced).toBe(false);
    expect(ev([link("net-b")], new Map([["net-a", 1]])).evidenced).toBe(false);
  });

  test("another channel's swarm is ignored", () => {
    const foreign = `${OTHER}:${"b".repeat(40)}`;
    expect(isP2pCandidate(peer({ swarm: foreign }), S)).toBe(false);
    expect(ev([link("net-b")], counts(), peer({ swarm: foreign }))).toBe(NOT_EVIDENCED);
    // A channel id that is only a prefix of the swarm's channel does not match.
    expect(isP2pCandidate(peer({ swarm: `${CH}0:${"a".repeat(40)}` }), S)).toBe(false);
    // Any swarm of its own channel (a rendition switch, a client-chosen hash) is fine.
    expect(ev([link("net-b")], counts(), peer({ swarm: `${CH}:${"c".repeat(40)}` })).evidenced).toBe(true);
  });

  test("an ended session is judged at its end", () => {
    const ended: P2pSessionRef = { ...S, at: T - 600_000 };
    expect(
      ev([link("net-b", T - 600_000 - 5_000)], counts(), peer({ last: T - 600_000 - 1_000 }), ended).evidenced,
    ).toBe(true);
    // Its last announce long before its end: not a candidate.
    expect(ev([link("net-b")], counts(), peer({ last: T - 600_000 - W - 1 }), ended)).toBe(NOT_EVIDENCED);
  });

  test("no peer hash: not evidenced", () => {
    expect(ev([link("net-b")], counts(), null)).toBe(NOT_EVIDENCED);
  });

  test("the default rule mirrors the contract", () => {
    expect(P2P_RULE).toEqual({
      windowMs: P2P_EVIDENCE.windowMs,
      minLinkedNetworks: P2P_EVIDENCE.minLinkedNetworks,
      maxSessionsPerNetwork: P2P_EVIDENCE.maxSessionsPerNetwork,
    });
  });
});

describe("parseLinks", () => {
  test("parses WITHSCORES replies and skips bad scores", () => {
    expect(parseLinks(["net-b", "10", "net-c", "x", "net-d", "20", "dangling"])).toEqual([
      { net: "net-b", at: 10 },
      { net: "net-d", at: 20 },
    ]);
    expect(parseLinks(null)).toEqual([]);
  });
});

describe("readP2pEvidence", () => {
  test("a failed round trip never throws: nothing is evidenced and the error is counted", async () => {
    const down = {
      pipeline: () => ({
        hgetall() {},
        exec: () => Promise.reject(new Error("connection lost")),
      }),
    } as unknown as ValkeyClient;
    const r = await readP2pEvidence(down, [
      { id: "s1", channelId: CH, at: T },
      { id: "s2", channelId: CH, at: T },
    ]);
    expect(r.evidence.size).toBe(0);
    expect(r.errors).toBe(2);
  });

  test("no sessions: no round trip", async () => {
    const never = {
      pipeline: () => {
        throw new Error("unexpected");
      },
    } as unknown as ValkeyClient;
    expect(await readP2pEvidence(never, [])).toEqual({ evidence: new Map(), errors: 0 });
  });
});
