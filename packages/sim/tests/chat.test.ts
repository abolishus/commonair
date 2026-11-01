// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  BURST_BODY,
  chatScript,
  DEFAULT_BURST,
  DEFAULT_RATE,
  dueMessages,
  EARLY_VIEWERS,
  presentAt,
  REPEATED_BODY,
  sampleableWords,
  seededRandom,
  viewers,
  type SimMessage,
} from "../src/index.ts";

const script = (seed = "b-1", words: string[] = ["badword", "spoiler"]) =>
  chatScript({ seed, rate: DEFAULT_RATE, burst: DEFAULT_BURST, filterWords: words, durationSeconds: 600 });
const steady = (s: SimMessage[]) => s.filter((m) => !m.burst);

describe("chatScript", () => {
  test("the steady rate stays within ±10% over every 60 s window", () => {
    for (const seed of ["a", "b", "c", "0197f0aa-0000-7000-8000-000000000001"]) {
      const msgs = steady(script(seed));
      for (let w = 0; w + 60_000 <= 600_000; w += 60_000) {
        const n = msgs.filter((m) => m.atMs >= w && m.atMs < w + 60_000).length;
        expect(n).toBeGreaterThanOrEqual(DEFAULT_RATE * 60 * 0.9);
        expect(n).toBeLessThanOrEqual(DEFAULT_RATE * 60 * 1.1);
      }
    }
  });

  test("one burst of 50 messages inside 5 s, mixing duplicates, links and filtered words", () => {
    const burst = script().filter((m) => m.burst);
    expect(burst).toHaveLength(50);
    const first = burst[0]!.atMs;
    const last = burst.at(-1)!.atMs;
    expect(first).toBe(DEFAULT_BURST.atSeconds * 1000);
    expect(last - first).toBeLessThan(5000);
    const kinds = new Set(burst.map((m) => m.kind));
    expect(kinds).toEqual(new Set(["repeat", "link", "filtered"]));
    // The duplicate spammer repeats one body.
    const dups = burst.filter((m) => m.kind === "repeat");
    expect(new Set(dups.map((m) => m.body))).toEqual(new Set([BURST_BODY]));
    expect(new Set(dups.map((m) => m.senderKey)).size).toBe(1);
    expect(burst.filter((m) => m.kind === "filtered").every((m) => /badword|spoiler/.test(m.body))).toBe(true);
    expect(burst.filter((m) => m.kind === "link").every((m) => /https?:\/\//.test(m.body))).toBe(true);
  });

  test("without filter words the burst falls back to duplicates and the steady chat has no filtered kind", () => {
    const s = script("x", []);
    expect(s.some((m) => m.kind === "filtered")).toBe(false);
    expect(s.filter((m) => m.burst)).toHaveLength(50);
  });

  test("no burst when asked for none, and none past the end", () => {
    expect(chatScript({ seed: "a", rate: 3, burst: null, durationSeconds: 60 }).some((m) => m.burst)).toBe(false);
    const late = chatScript({
      seed: "a",
      rate: 3,
      burst: { atSeconds: 58, count: 50, seconds: 5 },
      durationSeconds: 60,
    });
    expect(late.filter((m) => m.burst).every((m) => m.atMs < 60_000)).toBe(true);
  });

  test("the same seed gives the same script; another seed another", () => {
    expect(script("seed-1")).toEqual(script("seed-1"));
    expect(script("seed-1")).not.toEqual(script("seed-2"));
  });

  test("ordered by offset with seq equal to the position", () => {
    const s = script();
    expect(s.map((m) => m.seq)).toEqual(s.map((_, i) => i));
    expect(s.every((m, i) => i === 0 || m.atMs >= s[i - 1]!.atMs)).toBe(true);
  });

  test("varied bodies: emotes, the repeated body from several senders, links and filter words", () => {
    const s = steady(script());
    const kinds = new Set(s.map((m) => m.kind));
    expect(kinds).toEqual(new Set(["chat", "emote", "repeat", "link", "filtered"]));
    expect(new Set(s.map((m) => m.body)).size).toBeGreaterThan(50);
    const repeats = s.filter((m) => m.kind === "repeat");
    expect(new Set(repeats.map((m) => m.body))).toEqual(new Set([REPEATED_BODY]));
    expect(new Set(repeats.map((m) => m.senderKey)).size).toBeGreaterThan(3);
  });

  test("no personal data: synthetic senders, fixed vocabulary, no addresses or handles", () => {
    for (const m of script("pii", ["word"])) {
      expect(m.senderKey).toMatch(/^(v\d{3}|spam\d)$/);
      expect(m.body).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/); // e-mail
      expect(m.body).not.toMatch(/@\w/); // mentions
      expect(m.body).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/); // IPv4
      expect(m.body).not.toMatch(/\+?\d[\d\s-]{7,}\d/); // phone-like
      expect(m.body.length).toBeLessThanOrEqual(500);
    }
  });

  test("one sender never sends twice within a second in the steady chat", () => {
    const last = new Map<string, number>();
    const gaps: number[] = [];
    for (const m of steady(script())) {
      const prev = last.get(m.senderKey);
      if (prev !== undefined) gaps.push(m.atMs - prev);
      last.set(m.senderKey, m.atMs);
    }
    expect(gaps.length).toBeGreaterThan(100);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000);
  });

  test("a non-positive rate is refused", () => {
    expect(() => chatScript({ seed: "a", rate: 0, burst: null })).toThrow("rate must be positive");
  });

  test("sampleableWords trims and drops empty and oversized entries", () => {
    expect(sampleableWords([" a ", "", "x".repeat(101), "b c"])).toEqual(["a", "b c"]);
    expect(sampleableWords(undefined)).toEqual([]);
  });
});

describe("dueMessages", () => {
  test("returns unsent messages due before the time, resuming by seq", () => {
    const s = script();
    const first = dueMessages(s, 0, 10_000);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((m) => m.atMs < 10_000)).toBe(true);
    const next = first.at(-1)!.seq + 1;
    expect(dueMessages(s, next, 10_000)).toEqual([]);
    const later = dueMessages(s, next, 20_000);
    expect(later[0]?.seq).toBe(next);
    expect(dueMessages(s, s.length, 10_000_000)).toEqual([]);
  });
});

describe("viewers", () => {
  test("synthetic keys, an early handful present from the start, deterministic", () => {
    const v = viewers({ count: 40, seed: "s" });
    expect(v).toHaveLength(40);
    expect(new Set(v.map((x) => x.key)).size).toBe(40);
    expect(presentAt(v, 0)).toHaveLength(EARLY_VIEWERS);
    expect(viewers({ count: 40, seed: "s" })).toEqual(v);
    expect(v.every((x) => x.leaveAtMs === null || x.leaveAtMs > x.joinAtMs)).toBe(true);
    expect(v.some((x) => x.leaveAtMs !== null)).toBe(true);
  });

  test("presence only: no session, heartbeat or account fields", () => {
    for (const x of viewers({ count: 5, seed: "s" }))
      expect(Object.keys(x).sort()).toEqual(["joinAtMs", "key", "leaveAtMs"]);
  });

  test("zero and fractional counts", () => {
    expect(viewers({ count: 0, seed: "s" })).toEqual([]);
    expect(viewers({ count: 2.7, seed: "s" })).toHaveLength(2);
  });
});

describe("seededRandom", () => {
  test("uniform in [0, 1) and repeatable", () => {
    const a = seededRandom("k");
    const b = seededRandom("k");
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
