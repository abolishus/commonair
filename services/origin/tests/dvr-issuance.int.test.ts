// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The relays' DVR pulls in real Valkey: the record script, the servable range, trim and expiry. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { uuidv7 } from "@commonair/db";
import {
  DVR_PULLS_GRACE_MS,
  DVR_PULLS_SLACK_MS,
  DvrPullStore,
  dvrPullsKey,
  type DvrObject,
} from "../src/dvr-issuance.ts";

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
let valkey: ValkeyClient;

const obj = (file: string, bytes = 100, durationMs = 4000): DvrObject => ({ file, bytes, durationMs });
const T = Date.UTC(2026, 10, 1, 12);

beforeAll(() => {
  valkey = createValkey(VALKEY_URL, { keyPrefix: `test:${crypto.randomUUID()}:` });
});
afterAll(async () => {
  await valkey?.quit();
});

describe("DvrPullStore with Valkey", () => {
  test("servable is the pulls in [start − window − slack, end), across replicas", async () => {
    const vod = uuidv7();
    const a = new DvrPullStore({ valkey, windowSeconds: 60 });
    const b = new DvrPullStore({ valkey, windowSeconds: 60 });
    const start = T;
    const edge = start - a.lookbackMs;
    expect(a.lookbackMs).toBe(60_000 + DVR_PULLS_SLACK_MS);
    a.record(vod, obj("before-edge.m4s"), edge - 1);
    a.record(vod, obj("at-edge.m4s"), edge);
    b.record(vod, obj("inside.m4s"), start + 30_000);
    b.record(vod, obj("at-end.m4s"), start + 60_000);
    await Promise.all([a.flush(), b.flush()]);
    const files = (await a.servable(vod, start, start + 60_000)).map((o) => o.file).sort();
    expect(files).toEqual(["at-edge.m4s", "inside.m4s"]);
    // Another VOD's pulls are its own.
    expect(await a.servable(uuidv7(), start, start + 60_000)).toEqual([]);
  });

  test("a re-pull of the same object is one member, at its latest time", async () => {
    const vod = uuidv7();
    const s = new DvrPullStore({ valkey, windowSeconds: 0 });
    s.record(vod, obj("x.m4s", 7), T);
    s.record(vod, obj("x.m4s", 7), T + 120_000);
    await s.flush();
    expect(await valkey.zcard(dvrPullsKey(vod))).toBe(1);
    // Window 0: only the slack looks back, so the first pull's time alone would be out of range.
    expect(await s.servable(vod, T + 120_000, T + 180_000)).toEqual([obj("x.m4s", 7)]);
  });

  test("each record trims pulls past window + slack + grace and keeps the key alive that long", async () => {
    const vod = uuidv7();
    const s = new DvrPullStore({ valkey, windowSeconds: 30 });
    const keep = 30_000 + DVR_PULLS_SLACK_MS + DVR_PULLS_GRACE_MS;
    s.record(vod, obj("old.m4s"), T - 1);
    s.record(vod, obj("kept.m4s"), T);
    await s.flush();
    s.record(vod, obj("new.m4s"), T + keep);
    await s.flush();
    const members = await valkey.zrange(dvrPullsKey(vod), 0, -1);
    expect(members.sort()).toEqual(["100:4000:kept.m4s", "100:4000:new.m4s"]);
    const ttl = await valkey.pttl(dvrPullsKey(vod));
    expect(ttl).toBeGreaterThan(keep - 5_000);
    expect(ttl).toBeLessThanOrEqual(keep);
  });

  test("a member that does not decode is skipped, the rest are read", async () => {
    const vod = uuidv7();
    const s = new DvrPullStore({ valkey, windowSeconds: 60 });
    await valkey.zadd(dvrPullsKey(vod), T, "garbage", T, "0:0:r1_init.mp4", T, "12:4000:a.m4s");
    expect((await s.servable(vod, T, T + 1)).sort((x, y) => x.file.localeCompare(y.file))).toEqual([
      { file: "a.m4s", bytes: 12, durationMs: 4000 },
      { file: "r1_init.mp4", bytes: 0, durationMs: 0 },
    ]);
  });
});
