// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createValkey, type ValkeyClient } from "@commonair/service";
import {
  EVIDENCE_TTL_SECONDS,
  HEARTBEAT_HISTORY_LENGTH,
  INTEGRITY_KEYS,
  readEvidence,
  recordFetch,
  recordFetches,
  recordHeartbeat,
} from "../src/store.ts";

let valkey: ValkeyClient;
beforeAll(() => {
  valkey = createValkey(process.env.VALKEY_URL ?? "redis://localhost:6379", {
    keyPrefix: `test:${crypto.randomUUID()}:`,
  });
});
afterAll(async () => {
  await valkey?.quit();
});

const beat = (at: number) => ({
  at,
  playedSeconds: 10,
  bufferSeconds: 2,
  visible: true,
  muted: false,
  stalls: 0,
  bytesHttp: 0,
  bytesP2p: 0,
});

describe("integrity evidence store", () => {
  test("keeps the most recent heartbeats, with a TTL", async () => {
    const sid = crypto.randomUUID();
    for (let i = 0; i < HEARTBEAT_HISTORY_LENGTH + 5; i++) await recordHeartbeat(valkey, sid, beat(i));
    const ev = (await readEvidence(valkey, [sid])).get(sid)!;
    expect(ev.heartbeats).toHaveLength(HEARTBEAT_HISTORY_LENGTH);
    expect(ev.heartbeats[0]!.at).toBe(5);
    const ttl = await valkey.ttl(INTEGRITY_KEYS.heartbeats(sid));
    expect(ttl).toBeGreaterThan(EVIDENCE_TTL_SECONDS - 10);
  });

  test("rejects invalid samples on write and drops corrupt entries on read", async () => {
    const sid = crypto.randomUUID();
    await expect(recordHeartbeat(valkey, sid, { ...beat(1), playedSeconds: -1 })).rejects.toThrow(
      /playedSeconds|too_small/,
    );
    await recordHeartbeat(valkey, sid, beat(1));
    await valkey.rpush(INTEGRITY_KEYS.heartbeats(sid), "{not json", JSON.stringify({ at: "x" }));
    expect((await readEvidence(valkey, [sid])).get(sid)!.heartbeats).toHaveLength(1);
  });

  test("counts fetches by kind; sessions without counters report null", async () => {
    const sid = crypto.randomUUID();
    const other = crypto.randomUUID();
    await recordFetch(valkey, { sid, kind: "playlist" });
    await recordFetch(valkey, { sid, kind: "playlist" });
    await recordFetch(valkey, { sid, kind: "part" });
    const ev = await readEvidence(valkey, [sid, other]);
    expect(ev.get(sid)!.fetches).toEqual({ playlists: 2, segments: 0, parts: 1 });
    expect(ev.get(other)).toEqual({ heartbeats: [], fetches: null });
    expect((await readEvidence(valkey, [])).size).toBe(0);
  });

  test("batch counting matches one-by-one counting, with a TTL", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await recordFetches(valkey, [
      { sid: a, kind: "segment" },
      { sid: a, kind: "part" },
      { sid: a, kind: "part" },
      { sid: b, kind: "playlist" },
    ]);
    await recordFetches(valkey, [{ sid: a, kind: "segment" }]);
    await recordFetches(valkey, []);
    const ev = await readEvidence(valkey, [a, b]);
    expect(ev.get(a)!.fetches).toEqual({ playlists: 0, segments: 2, parts: 2 });
    expect(ev.get(b)!.fetches).toEqual({ playlists: 1, segments: 0, parts: 0 });
    expect(await valkey.ttl(INTEGRITY_KEYS.fetches(a))).toBeGreaterThan(EVIDENCE_TTL_SECONDS - 10);
  });
});
