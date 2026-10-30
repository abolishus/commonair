// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** P2P stream swarm ids, info hash vectors and the P1 contract shapes (ADR 0005 amendment 1). */
import { describe, expect, test } from "vite-plus/test";
import { Heartbeat, IceServers, InstanceInfo, PlaybackStart } from "../src/api/entities.ts";
import { contract } from "../src/api/router.ts";
import { KEYS, P2P_GRANT_TTL_SECONDS, p2pAllowedStreamSwarmIds as fromInternal } from "../src/internal.ts";
import {
  P2P_INFOHASH_VECTORS,
  P2P_STREAM_RENDITIONS,
  P2P_STREAM_TYPES,
  p2pAllowedStreamSwarmIds,
  p2pStreamSwarmId,
} from "../src/p2p.ts";

/** The recipe the tracker reimplements: Base64 of the first 15 SHA-1 bytes. */
async function infoHash(id: string): Promise<string> {
  const sha1 = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(id)));
  return btoa(String.fromCharCode(...sha1.subarray(0, 15)));
}

describe("stream swarm ids", () => {
  test("recipe", () => {
    expect(p2pStreamSwarmId("b1", "main", "720p")).toBe("ca1:b1:main:720p");
    expect(p2pStreamSwarmId("b1", "secondary", "audio")).toBe("ca1:b1:secondary:audio");
  });

  test("names are the renditions plus audio, without duplicates", () => {
    expect(P2P_STREAM_RENDITIONS).toEqual(["source", "1080p", "720p", "480p", "audio"]);
    expect(new Set(P2P_STREAM_RENDITIONS).size).toBe(P2P_STREAM_RENDITIONS.length);
  });

  test("the allowed set is both types × every name, and differs per swarm", () => {
    const ids = p2pAllowedStreamSwarmIds("b1");
    expect(ids).toHaveLength(P2P_STREAM_TYPES.length * P2P_STREAM_RENDITIONS.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("ca1:b1:main:source");
    expect(ids).toContain("ca1:b1:secondary:audio");
    expect(p2pAllowedStreamSwarmIds("b2").some((id) => ids.includes(id))).toBe(false);
  });

  test("internal re-exports the browser-safe entry", () => {
    expect(fromInternal).toBe(p2pAllowedStreamSwarmIds);
  });
});

describe("info hash vectors", () => {
  test("cover two swarms, all types and names", () => {
    const swarms = ["0192f3a4-5b6c-7d8e-9f01-23456789abcd", "019a0000-0000-7000-8000-000000000001"];
    expect(P2P_INFOHASH_VECTORS.map((v) => v.streamSwarmId)).toEqual(swarms.flatMap(p2pAllowedStreamSwarmIds));
  });

  test("each is 20 ASCII characters and matches the recipe", async () => {
    for (const v of P2P_INFOHASH_VECTORS) {
      expect(v.infoHash).toMatch(/^[A-Za-z0-9+/]{20}$/);
      expect(await infoHash(v.streamSwarmId)).toBe(v.infoHash);
    }
  });
});

describe("grant", () => {
  test("key and TTL", () => {
    expect(KEYS.p2pGrant("s1")).toBe("p2p:grant:s1");
    expect(P2P_GRANT_TTL_SECONDS).toBe(43_200);
  });
});

describe("contract shapes", () => {
  const start = {
    sessionId: "019a0000-0000-7000-8000-000000000001",
    token: "t",
    playlistUrl: "http://o/hls/live/x/index.m3u8",
    source: "origin",
    heartbeatIntervalMs: 15_000,
    expiresAt: "2026-10-27T00:00:00.000Z",
    renditions: ["source"],
    captions: [],
    dataMode: null,
  };

  test("PlaybackStart.p2p requires available and digestUrl", () => {
    const p2p = { enabled: false, trackerUrls: [], swarmId: "b" };
    expect(PlaybackStart.safeParse({ ...start, p2p }).success).toBe(false);
    expect(
      PlaybackStart.safeParse({ ...start, p2p: { ...p2p, available: true, digestUrl: "http://o/p2p-digest" } }).success,
    ).toBe(true);
  });

  test("heartbeat P2P diagnostics are optional and bounded", () => {
    const beat = {
      sessionId: start.sessionId,
      token: "t",
      playedSeconds: 10,
      bufferSeconds: 1,
      stalls: 0,
      bytesHttp: 1,
      bytesP2p: 0,
      rendition: "source",
      latencySeconds: null,
      ttffMs: null,
      visible: true,
      muted: false,
    };
    expect(Heartbeat.safeParse(beat).success).toBe(true);
    expect(Heartbeat.safeParse({ ...beat, bytesP2pUp: 5, p2pPeers: 64, p2pRejected: 0 }).success).toBe(true);
    expect(Heartbeat.safeParse({ ...beat, p2pPeers: 65 }).success).toBe(false);
    expect(Heartbeat.safeParse({ ...beat, bytesP2pUp: -1 }).success).toBe(false);
  });

  test("IceServers: STUN only expires never; entries need a URL", () => {
    expect(IceServers.safeParse({ iceServers: [{ urls: ["stun:x:3478"] }], expiresAt: null }).success).toBe(true);
    expect(IceServers.safeParse({ iceServers: [{ urls: [] }], expiresAt: null }).success).toBe(false);
  });

  test("instance features carry the operator default", () => {
    const shape = InstanceInfo.shape.features.shape;
    expect(shape.p2pDefault.options).toEqual(["off", "on"]);
  });

  test("p2pCapable defaults to false", () => {
    const input = contract.playback.start["~orpc"].inputSchema;
    const parsed = input?.["~standard"].validate({ channel: "abc", deviceId: "d".repeat(16) });
    expect(parsed && "value" in parsed ? parsed.value : undefined).toMatchObject({ p2pCapable: false });
  });

  test("p2p.iceServers is public, playback-limited and routed", () => {
    const def = contract.p2p.iceServers["~orpc"];
    expect(def.route).toMatchObject({ method: "POST", path: "/playback/ice-servers" });
    expect(def.meta).toMatchObject({ access: "public", rateLimit: "playback" });
  });
});
