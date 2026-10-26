// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  DeliveryCounter,
  exactlyOnce,
  perSenderOrderKept,
  summarizeDeliveries,
  withinOneBatch,
} from "../src/multi/exactly-once.ts";

describe("DeliveryCounter", () => {
  test("each expected key once is exactly once", () => {
    const c = new DeliveryCounter();
    for (const k of ["a", "b", "c"]) c.record(k);
    const s = c.summary(["a", "b", "c"]);
    expect(s).toEqual({ expected: 3, delivered: 3, missing: [], duplicated: [], extra: 0, unexpected: 0 });
    expect(exactlyOnce(s)).toBe(true);
  });

  test("missing, repeated and unexpected keys are told apart", () => {
    const c = new DeliveryCounter();
    for (const k of ["a", "a", "a", "b", "zzz"]) c.record(k);
    const s = c.summary(["a", "b", "c"]);
    expect(s.missing).toEqual(["c"]);
    expect(s.duplicated).toEqual([{ key: "a", count: 3 }]);
    expect(s.extra).toBe(2);
    expect(s.unexpected).toBe(1);
    expect(s.delivered).toBe(2);
    expect(exactlyOnce(s)).toBe(false);
  });

  test("an empty expectation is trivially exactly once; nothing delivered is all missing", () => {
    expect(exactlyOnce(new DeliveryCounter().summary([]))).toBe(true);
    const s = new DeliveryCounter().summary(["x", "y"]);
    expect(s.missing).toEqual(["x", "y"]);
    expect(exactlyOnce(s)).toBe(false);
  });

  test("duplicate expected keys count once", () => {
    const c = new DeliveryCounter();
    c.record("a");
    expect(c.summary(["a", "a"]).expected).toBe(1);
  });

  test("seenAt and count follow the deliveries", () => {
    const c = new DeliveryCounter();
    c.record("a", 10);
    c.record("a", 20);
    expect(c.seenAt("a")).toBe(10);
    expect(c.seenAt("b")).toBeNull();
    expect(c.count("a")).toBe(2);
  });

  test("a tracked group counts distinct first deliveries as they arrive", () => {
    const c = new DeliveryCounter();
    c.record("a");
    c.track("g", ["a", "b", "c", "c"]);
    // Keys seen before tracking count at once.
    expect(c.seenCount("g")).toBe(1);
    c.record("b");
    c.record("b");
    c.record("zzz");
    expect(c.seenCount("g")).toBe(2);
    c.record("c");
    expect(c.seenCount("g")).toBe(3);
  });

  test("a key may belong to several groups; untracked or re-tracked groups throw", () => {
    const c = new DeliveryCounter();
    c.track("one", ["a", "b"]);
    c.track("two", ["b", "c"]);
    c.record("b");
    expect([c.seenCount("one"), c.seenCount("two")]).toEqual([1, 1]);
    expect(() => c.seenCount("nope")).toThrow(/not tracked/);
    expect(() => c.track("one", [])).toThrow(/already tracked/);
  });

  test("the running count matches a rescan over a large group", () => {
    const c = new DeliveryCounter();
    const keys = Array.from({ length: 20_000 }, (_, i) => `k${i}`);
    c.track("big", keys);
    for (let i = 0; i < 20_000; i += 3) c.record(`k${i}`);
    for (let i = 0; i < 20_000; i += 6) c.record(`k${i}`);
    const rescan = keys.filter((k) => c.count(k) > 0).length;
    expect(c.seenCount("big")).toBe(rescan);
    expect(c.summary(keys).delivered).toBe(rescan);
  });

  test("samples are capped, totals are not", () => {
    const counts = new Map<string, number>();
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
    for (const k of keys) counts.set(k, 2);
    const s = summarizeDeliveries(counts, [...keys, "gone1", "gone2"], 5);
    expect(s.duplicated).toHaveLength(5);
    expect(s.extra).toBe(50);
    expect(s.missing).toEqual(["gone1", "gone2"]);
  });
});

describe("withinOneBatch (outbox at-least-once after a kill)", () => {
  const summary = (extra: number, missing: string[] = []) => ({
    expected: 1000,
    delivered: 1000 - missing.length,
    missing,
    duplicated: [],
    extra,
    unexpected: 0,
  });
  test("up to one batch per killed worker may repeat; nothing may be lost", () => {
    expect(withinOneBatch(summary(0), 200)).toBe(true);
    expect(withinOneBatch(summary(200), 200)).toBe(true);
    expect(withinOneBatch(summary(201), 200)).toBe(false);
    expect(withinOneBatch(summary(400), 200, 2)).toBe(true);
    expect(withinOneBatch(summary(0, ["lost"]), 200)).toBe(false);
  });
});

describe("perSenderOrderKept", () => {
  const sent = new Map([
    ["alice", ["a0", "a1", "a2"]],
    ["bob", ["b0", "b1"]],
  ]);
  test("interleaving between senders is fine; each sender's order must hold", () => {
    const ok = [
      { sender: "bob", key: "b0" },
      { sender: "alice", key: "a0" },
      { sender: "alice", key: "a1" },
      { sender: "bob", key: "b1" },
      { sender: "alice", key: "a2" },
    ];
    expect(perSenderOrderKept(ok, sent)).toBe(true);
    const swapped = [
      { sender: "alice", key: "a1" },
      { sender: "alice", key: "a0" },
    ];
    expect(perSenderOrderKept(swapped, sent)).toBe(false);
  });

  test("a gap is not a reordering; unrelated keys are ignored", () => {
    expect(
      perSenderOrderKept(
        [
          { sender: "alice", key: "a0" },
          { sender: "alice", key: "other" },
          { sender: "alice", key: "a2" },
        ],
        sent,
      ),
    ).toBe(true);
  });

  test("a repeated delivery breaks the order", () => {
    expect(
      perSenderOrderKept(
        [
          { sender: "bob", key: "b0" },
          { sender: "bob", key: "b1" },
          { sender: "bob", key: "b0" },
        ],
        sent,
      ),
    ).toBe(false);
  });
});
