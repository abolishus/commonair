// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { uuidv7 } from "@commonair/db";
import { assignSource, eligibleRelays, type AssignInput } from "../src/playback/delivery.ts";

const relay = (id: string, capacityMbps: number, over: Partial<AssignInput["relays"][number]> = {}) => ({
  id,
  url: `https://${id}.example.invalid`,
  capacityMbps,
  status: "active",
  load: 0,
  ...over,
});
const noCdn = { enabled: false, threshold: 5000 };

function distribution(relays: AssignInput["relays"], sessions = 20_000, cdn = noCdn, viewers = 0) {
  const counts = new Map<string, number>();
  for (let i = 0; i < sessions; i++) {
    const a = assignSource({ sessionId: uuidv7(), relays, cdn, channelVerifiedViewers: viewers });
    const k = a.source === "relay" ? a.relayId : a.source;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (k: string) => (counts.get(k) ?? 0) / sessions;
}

test("no relays → origin", () => {
  expect(assignSource({ sessionId: uuidv7(), relays: [], cdn: noCdn, channelVerifiedViewers: 10 })).toEqual({
    source: "origin",
  });
});

test("one relay: origin keeps about half (≥ 1/(N+1))", () => {
  const share = distribution([relay("r1", 100)]);
  expect(share("origin")).toBeGreaterThan(0.47);
  expect(share("origin")).toBeLessThan(0.53);
  expect(share("r1")).toBeGreaterThan(0.47);
});

test("relays share by declared capacity; origin keeps ≥ 1/(N+1)", () => {
  const share = distribution([relay("a", 100), relay("b", 300)]);
  // total 400, origin weight 200: origin 1/3, a 1/6, b 1/2
  expect(share("origin")).toBeGreaterThan(1 / 3 - 0.02);
  expect(share("a")).toBeCloseTo(1 / 6, 1);
  expect(share("b")).toBeCloseTo(1 / 2, 1);
  expect(share("b") / share("a")).toBeGreaterThan(2.6);
  expect(share("b") / share("a")).toBeLessThan(3.4);
});

test("deterministic per session id", () => {
  const relays = [relay("a", 100), relay("b", 50)];
  const sid = uuidv7();
  const first = assignSource({ sessionId: sid, relays, cdn: noCdn, channelVerifiedViewers: 0 });
  for (let i = 0; i < 5; i++)
    expect(
      assignSource({ sessionId: sid, relays: [...relays].reverse(), cdn: noCdn, channelVerifiedViewers: 0 }),
    ).toEqual(first);
});

test("relays that are not active or lack headroom get nothing", () => {
  const relays = [
    relay("full", 100, { load: 95 }),
    relay("pending", 100, { status: "pending" }),
    relay("zero", 0),
    relay("ok", 100, { load: 50 }),
  ];
  expect(eligibleRelays(relays).map((r) => r.id)).toEqual(["ok"]);
  const share = distribution(relays, 4000);
  expect(share("full") + share("pending") + share("zero")).toBe(0);
});

test("CDN takes the origin share only above the burst threshold", () => {
  const cdn = { enabled: true, threshold: 100 };
  expect(distribution([], 500, cdn, 100)("cdn")).toBe(0);
  expect(distribution([], 500, cdn, 101)("cdn")).toBe(1);
  expect(distribution([], 500, { ...cdn, enabled: false }, 10_000)("origin")).toBe(1);
  const mixed = distribution([relay("r", 100)], 4000, cdn, 1000);
  expect(mixed("origin")).toBe(0);
  expect(mixed("cdn")).toBeGreaterThan(0.4);
  expect(mixed("r")).toBeGreaterThan(0.4);
});
