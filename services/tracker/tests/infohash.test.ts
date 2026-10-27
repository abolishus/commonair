// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  P2P_INFOHASH_VECTORS,
  P2P_STREAM_RENDITIONS,
  p2pAllowedStreamSwarmIds,
  p2pStreamSwarmId,
} from "@commonair/contracts/internal";
import { ALLOWED_PER_GRANT, computeInfoHash, InfoHashAllowlist } from "../src/infohash.ts";
import { isBinaryId, LIMITS } from "../src/protocol.ts";

const A = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const B = "019a0000-0000-7000-8000-000000000001";

describe("computeInfoHash", () => {
  test.each(P2P_INFOHASH_VECTORS.map((v) => [v.streamSwarmId, v.infoHash]))("%s", (id, hash) => {
    expect(computeInfoHash(id)).toBe(hash);
  });

  test("20 ASCII characters that pass isBinaryId", () => {
    for (const v of P2P_INFOHASH_VECTORS) {
      const h = computeInfoHash(v.streamSwarmId);
      expect(h).toMatch(/^[A-Za-z0-9+/]{20}$/);
      expect(isBinaryId(h)).toBe(true);
    }
  });

  test("UTF-8, like the library's sha1 over TextEncoder bytes", () => {
    // Base64 of the first 15 bytes of SHA-1("é") (c3 a9).
    expect(computeInfoHash("é")).toBe(
      Buffer.from("bf15be717ac1b080b4f1c456692825891ff5073d", "hex").subarray(0, 15).toString("base64"),
    );
  });
});

describe("InfoHashAllowlist", () => {
  test("a grant allows exactly its vectors", () => {
    const list = new InfoHashAllowlist();
    for (const swarmId of [A, B]) {
      const expected = P2P_INFOHASH_VECTORS.filter((v) => v.streamSwarmId.startsWith(`ca1:${swarmId}:`)).map(
        (v) => v.infoHash,
      );
      expect(expected).toHaveLength(ALLOWED_PER_GRANT);
      expect([...list.get(swarmId)].sort()).toEqual([...expected].sort());
    }
  });

  test("ALLOWED_PER_GRANT is both types times every rendition, and the per-socket swarm limit", () => {
    expect(ALLOWED_PER_GRANT).toBe(2 * P2P_STREAM_RENDITIONS.length);
    expect(ALLOWED_PER_GRANT).toBe(p2pAllowedStreamSwarmIds(A).length);
    expect(LIMITS.maxSwarmsPerSocket).toBe(ALLOWED_PER_GRANT);
  });

  test("two swarm ids share no hash", () => {
    const list = new InfoHashAllowlist();
    const a = list.get(A);
    const b = list.get(B);
    expect(a.size).toBe(ALLOWED_PER_GRANT);
    expect(b.size).toBe(ALLOWED_PER_GRANT);
    for (const h of a) expect(b.has(h)).toBe(false);
    expect(list.allows(A, [...b][0] ?? "")).toBe(false);
  });

  test("the cache returns the same set", () => {
    const list = new InfoHashAllowlist();
    expect(list.get(A)).toBe(list.get(A));
    expect(list.size).toBe(1);
  });

  test("the cache is bounded and evicts the least recently used", () => {
    const list = new InfoHashAllowlist(2);
    const a = list.get(A);
    list.get(B);
    list.get(A); // A is now the most recent
    list.get("c");
    expect(list.size).toBe(2);
    expect(list.get(A)).toBe(a);
    // B was evicted: a fresh (equal) set.
    const b1 = list.get(B);
    expect(list.get(B)).toBe(b1);
  });

  test("an unknown type or rendition name is not allowed", () => {
    const list = new InfoHashAllowlist();
    expect(list.allows(A, computeInfoHash(p2pStreamSwarmId(A, "main", "720p")))).toBe(true);
    expect(list.allows(A, computeInfoHash(p2pStreamSwarmId(A, "main", "360p")))).toBe(false);
    expect(list.allows(A, computeInfoHash(`ca1:${A}:tertiary:source`))).toBe(false);
    expect(list.allows(A, computeInfoHash(`ca2:${A}:main:source`))).toBe(false);
    // The library's default derivation (no streamSwarmIdBuilder) never matches.
    expect(list.allows(A, computeInfoHash(`${A}-v-0`))).toBe(false);
  });
});
