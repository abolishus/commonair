// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { P2P_EVIDENCE } from "@commonair/contracts/internal";
import type { ValkeyClient } from "@commonair/service";
import {
  isP2pCandidate,
  NOT_EVIDENCED,
  P2P_RULE,
  P2P_SWARM_MEMBER_CAP,
  p2pEvidenceFor,
  parseP2pPeer,
  readP2pEvidence,
  type P2pMember,
  type P2pPeer,
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
let n = 0;
const member = (net: string | null, o: Partial<P2pMember> = {}): P2pMember => ({
  sessionId: `s${++n}`,
  at: T - 1_000,
  net,
  swarm: SWARM,
  ...o,
});

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
  test("exactly minSwarmNetworks distinct networks (itself included) is evidenced", () => {
    expect(P2P_EVIDENCE.minSwarmNetworks).toBe(2);
    expect(p2pEvidenceFor(peer(), CH, [member("net-b")], T)).toEqual({
      evidenced: true,
      swarmNetworks: 2,
      announces: 7,
    });
    // Itself listed as a member is not a second network.
    expect(p2pEvidenceFor(peer(), CH, [member("net-a")], T)).toMatchObject({ evidenced: false, swarmNetworks: 1 });
    expect(p2pEvidenceFor(peer(), CH, [member("net-b"), member("net-c")], T)).toMatchObject({
      evidenced: true,
      swarmNetworks: 3,
    });
  });

  test("one network with many sessions is not evidenced", () => {
    const farm = Array.from({ length: 50 }, () => member("net-a"));
    expect(p2pEvidenceFor(peer(), CH, farm, T)).toMatchObject({ evidenced: false, swarmNetworks: 1 });
  });

  test("window edges: the session's last announce and each member's", () => {
    // Session announced exactly at the window start: candidate. One ms earlier: not.
    expect(isP2pCandidate(peer({ last: T - W }), CH, T)).toBe(true);
    expect(isP2pCandidate(peer({ last: T - W - 1 }), CH, T)).toBe(false);
    expect(p2pEvidenceFor(peer({ last: T - W - 1 }), CH, [member("net-b")], T)).toBe(NOT_EVIDENCED);
    // A member at the window start counts; one before it does not.
    expect(p2pEvidenceFor(peer(), CH, [member("net-b", { at: T - W })], T).evidenced).toBe(true);
    expect(p2pEvidenceFor(peer(), CH, [member("net-b", { at: T - W - 1 })], T).evidenced).toBe(false);
  });

  test("another channel's swarm is ignored", () => {
    // The session's own swarm belongs to another channel: never a candidate.
    const foreign = `${OTHER}:${"b".repeat(40)}`;
    expect(isP2pCandidate(peer({ swarm: foreign }), CH, T)).toBe(false);
    expect(p2pEvidenceFor(peer({ swarm: foreign }), CH, [member("net-b", { swarm: foreign })], T)).toBe(NOT_EVIDENCED);
    // A channel id that is only a prefix of the swarm's channel does not match.
    expect(isP2pCandidate(peer({ swarm: `${CH}0:${"a".repeat(40)}` }), CH, T)).toBe(false);
    // A member whose peer hash names another channel's swarm does not count.
    expect(p2pEvidenceFor(peer(), CH, [member("net-b", { swarm: foreign })], T).evidenced).toBe(false);
    // Another swarm of the same channel (a rendition switch) still counts.
    expect(p2pEvidenceFor(peer(), CH, [member("net-b", { swarm: `${CH}:${"c".repeat(40)}` })], T).evidenced).toBe(true);
  });

  test("members without a network (expired peer hash) are ignored", () => {
    expect(p2pEvidenceFor(peer(), CH, [member(null), member("net-b", { swarm: null })], T).evidenced).toBe(false);
  });

  test("no peer hash: not evidenced", () => {
    expect(p2pEvidenceFor(null, CH, [member("net-b")], T)).toBe(NOT_EVIDENCED);
  });

  test("member cap: only the first memberCap members (most recent first) are considered", () => {
    expect(P2P_RULE.memberCap).toBe(P2P_SWARM_MEMBER_CAP);
    const rule = { ...P2P_RULE, memberCap: 3 };
    const members = [member("net-a"), member("net-a"), member("net-a"), member("net-b")];
    expect(p2pEvidenceFor(peer(), CH, members, T, rule).evidenced).toBe(false);
    expect(p2pEvidenceFor(peer(), CH, members, T, { ...rule, memberCap: 4 }).evidenced).toBe(true);
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
