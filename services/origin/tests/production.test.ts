// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { noopMetrics, type OriginMetrics } from "../src/metrics.ts";
import { ISSUANCE_KEYS, ProductionStore, objectClass, parseProduction } from "../src/production.ts";

describe("objectClass", () => {
  test("init sections, parts and full segments", () => {
    expect(objectClass("54dd_video1_init.mp4", "segment")).toBe("init");
    expect(objectClass("54dd_video1_part3.mp4", "part")).toBe("part");
    expect(objectClass("54dd_video1_seg3.mp4", "segment")).toBe("segment");
  });
});

describe("parseProduction", () => {
  test("groups directory metrics by channel and ignores junk fields", () => {
    const m = parseProduction({
      "live/a|segments": "2",
      "live/a|segmentBytes": "2000",
      "live/a/720p|parts": "5",
      "live/a/720p|partBytes": "500",
      "live/b|inits": "1",
      "live/b|nope": "9",
      "live/b|initBytes": "x",
      garbage: "1",
    });
    expect([...m.keys()].sort()).toEqual(["live/a", "live/b"]);
    expect(m.get("live/a")?.get("live/a")).toMatchObject({ segments: 2, segmentBytes: 2000, parts: 0 });
    expect(m.get("live/a")?.get("live/a/720p")).toMatchObject({ parts: 5, partBytes: 500 });
    expect(m.get("live/b")?.get("live/b")).toMatchObject({ inits: 1, initBytes: 0 });
  });
});

describe("ProductionStore", () => {
  test("records through one atomic script per object, into the minute's hash", async () => {
    const calls: unknown[][] = [];
    const store = new ProductionStore({
      valkey: {
        eval: (async (...args: unknown[]) => (calls.push(args), 1)) as never,
        hgetall: (async () => ({})) as never,
      },
    });
    store.record("live/a/720p", "x_video1_part9.mp4", "part", 321, 125_000);
    await store.flush();
    expect(calls[0]?.slice(1)).toEqual([
      2,
      ISSUANCE_KEYS.seen("live/a/720p/x_video1_part9.mp4"),
      ISSUANCE_KEYS.production(2),
      120,
      1200,
      "live/a/720p|parts",
      "live/a/720p|partBytes",
      321,
    ]);
  });

  test("Valkey failures are counted, never thrown at callers", async () => {
    let dropped = 0;
    const metrics: OriginMetrics = { ...noopMetrics, accountingDropped: (_w, n) => void (dropped += n) };
    const store = new ProductionStore({
      valkey: { eval: (() => Promise.reject(new Error("down"))) as never, hgetall: (async () => ({})) as never },
      metrics,
    });
    store.record("live/a", "s1.mp4", "segment", 1, 0);
    await store.flush();
    expect(dropped).toBe(1);
  });

  test("bounded number of in-flight writes", () => {
    let dropped = 0;
    const metrics: OriginMetrics = { ...noopMetrics, accountingDropped: (_w, n) => void (dropped += n) };
    const store = new ProductionStore({
      valkey: { eval: (() => new Promise(() => {})) as never, hgetall: (async () => ({})) as never },
      metrics,
      maxPending: 2,
    });
    for (let i = 0; i < 5; i++) store.record("live/a", `s${i}.mp4`, "segment", 1, 0);
    expect(dropped).toBe(3);
  });
});
