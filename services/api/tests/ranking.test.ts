// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_GOVERNANCE_SETTINGS } from "@commonair/db";
import {
  matureFilter,
  newAndLive,
  pickRandom,
  rankLive,
  scoreParts,
  spotlight,
  spotlightWindow,
  type LiveEntry,
} from "../src/discovery/ranking.ts";
import { DiscoveryRanking } from "../src/lib/settings.ts";

const cfg = DiscoveryRanking.parse(DEFAULT_GOVERNANCE_SETTINGS.find((s) => s.key === "discovery.ranking")?.value);
const now = new Date("2026-10-18T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

let n = 0;
const entry = (over: Partial<LiveEntry> = {}): LiveEntry => ({
  channelId: `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  channelCreatedAt: daysAgo(400),
  broadcastStartedAt: hoursAgo(1),
  viewers: 0,
  follows24h: 0,
  mature: false,
  ...over,
});
const ids = (es: LiveEntry[]) => es.map((e) => e.channelId);

describe("blended score", () => {
  test("components are bounded and log-scaled", () => {
    const e = entry({ viewers: 100, follows24h: 10, broadcastStartedAt: now });
    const p = scoreParts(e, { maxViewers: 100, maxFollows24h: 10, now }, cfg);
    expect(p.viewers).toBeCloseTo(1);
    expect(p.followMomentum).toBeCloseTo(1);
    expect(p.freshness).toBeCloseTo(1);
    expect(p.smallChannelBoost).toBeCloseTo(11 / 101);
    const small = scoreParts(entry({ viewers: 10 }), { maxViewers: 1000, maxFollows24h: 0, now }, cfg);
    // log scaling: 10 of 1000 viewers scores a third of the viewer component, not 1%.
    expect(small.viewers).toBeCloseTo(Math.log1p(10) / Math.log1p(1000));
    expect(small.smallChannelBoost).toBe(1);
    expect(small.followMomentum).toBe(0);
  });

  test("a small, fresh, growing channel can outrank a big stale one", () => {
    const big = entry({ viewers: 5000, broadcastStartedAt: hoursAgo(10) });
    const small = entry({ viewers: 8, follows24h: 40, broadcastStartedAt: hoursAgo(0.1) });
    expect(ids(rankLive([big, small], cfg, now))[0]).toBe(small.channelId);
  });

  test("viewers dominate when nothing else differs", () => {
    const a = entry({ viewers: 50 });
    const b = entry({ viewers: 500 });
    expect(ids(rankLive([a, b], cfg, now))).toEqual([b.channelId, a.channelId]);
  });

  test("empty input and ties are deterministic", () => {
    expect(rankLive([], cfg, now)).toEqual([]);
    const es = [entry(), entry(), entry()];
    expect(ids(rankLive(es, cfg, now))).toEqual(ids(rankLive([...es].reverse(), cfg, now)));
  });
});

describe("spotlight", () => {
  const minutes = cfg.spotlightRotationMinutes;
  const at = (w: number) => new Date(w * minutes * 60_000 + 1000);

  test("only channels at or under spotlightMaxViewers are eligible", () => {
    const big = entry({ viewers: cfg.spotlightMaxViewers + 1 });
    const edge = entry({ viewers: cfg.spotlightMaxViewers });
    expect(ids(spotlight([big, edge], cfg, now))).toEqual([edge.channelId]);
  });

  test("deterministic within a window and across input order", () => {
    const es = Array.from({ length: 12 }, () => entry({ viewers: 2 }));
    const w = at(100);
    const later = new Date(w.getTime() + (minutes * 60_000) / 2);
    expect(ids(spotlight(es, cfg, w))).toEqual(ids(spotlight([...es].reverse(), cfg, later)));
    expect(spotlightWindow(w, minutes)).toBe(spotlightWindow(later, minutes));
  });

  test("never repeats a channel in consecutive windows with ≥ 2 × slots candidates", () => {
    const es = Array.from({ length: cfg.spotlightSlots * 2 + 1 }, () => entry({ viewers: 1 }));
    for (let w = 0; w < 50; w++) {
      const a = new Set(ids(spotlight(es, cfg, at(w))));
      const b = ids(spotlight(es, cfg, at(w + 1)));
      expect(a.size).toBe(cfg.spotlightSlots);
      for (const id of b) expect(a.has(id)).toBe(false);
    }
  });

  test("every small channel gets spotlight time over a full cycle", () => {
    const es = Array.from({ length: 10 }, () => entry({ viewers: 3 }));
    const seen = new Set<string>();
    for (let w = 0; w < 10; w++) for (const id of ids(spotlight(es, cfg, at(w)))) seen.add(id);
    expect(seen.size).toBe(10);
  });

  test("fewer candidates than slots shows all of them; zero slots shows none", () => {
    const es = [entry(), entry()];
    expect(spotlight(es, cfg, now)).toHaveLength(2);
    expect(spotlight(es, { ...cfg, spotlightSlots: 0 }, now)).toEqual([]);
    expect(spotlight([], cfg, now)).toEqual([]);
  });
});

test("new and live: within newChannelMaxAgeDays, newest first", () => {
  const old = entry({ channelCreatedAt: daysAgo(cfg.newChannelMaxAgeDays + 1) });
  const newer = entry({ channelCreatedAt: daysAgo(1) });
  const newest = entry({ channelCreatedAt: hoursAgo(1) });
  expect(ids(newAndLive([old, newer, newest], cfg, now))).toEqual([newest.channelId, newer.channelId]);
});

test("mature streams need includeMature AND a confirmed adult", () => {
  const m = { mature: true };
  expect(matureFilter(false, false)(m)).toBe(false);
  expect(matureFilter(true, false)(m)).toBe(false);
  expect(matureFilter(false, true)(m)).toBe(false);
  expect(matureFilter(true, true)(m)).toBe(true);
  expect(matureFilter(false, false)({ mature: false })).toBe(true);
});

test("random pick is uniform over items and handles empty input", () => {
  expect(pickRandom([])).toBeNull();
  const items = ["a", "b", "c", "d"];
  expect(pickRandom(items, () => 0)).toBe("a");
  expect(pickRandom(items, () => 0.999999)).toBe("d");
  expect(pickRandom(items, () => 0.5)).toBe("c");
});
