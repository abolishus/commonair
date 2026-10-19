// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { P2P_EVIDENCE } from "@commonair/contracts/internal";
import { MAX_PENDING_EXCHANGES, PendingExchanges } from "../src/exchanges.ts";

const T = 1_000_000;

describe("PendingExchanges", () => {
  test("completes once for the session it was relayed to, in the same swarm", () => {
    const p = new PendingExchanges();
    p.add("o1", "sidB", "sw", T);
    expect(p.complete("o1", "sidC", "sw", T)).toBe(false);
    expect(p.complete("o1", "sidB", "other", T)).toBe(false);
    expect(p.complete("o2", "sidB", "sw", T)).toBe(false);
    expect(p.complete("o1", "sidB", "sw", T + 10)).toBe(true);
    expect(p.complete("o1", "sidB", "sw", T + 10)).toBe(false);
    expect(p.size).toBe(0);
  });

  test("the timeout boundary is inclusive and an expired entry is dropped", () => {
    const p = new PendingExchanges();
    p.add("a", "s", "sw", T);
    p.add("b", "s", "sw", T);
    expect(p.complete("a", "s", "sw", T + P2P_EVIDENCE.exchangeTimeoutMs)).toBe(true);
    expect(p.complete("b", "s", "sw", T + P2P_EVIDENCE.exchangeTimeoutMs + 1)).toBe(false);
    expect(p.size).toBe(0);
  });

  test("a reused offer id is re-targeted and counts as the newest", () => {
    const p = new PendingExchanges(60_000, 2);
    p.add("a", "s1", "sw", T);
    p.add("b", "s1", "sw", T);
    p.add("a", "s2", "sw", T + 1);
    p.add("c", "s1", "sw", T + 2);
    // "b" was the oldest after "a" moved to the back.
    expect(p.complete("b", "s1", "sw", T + 3)).toBe(false);
    expect(p.complete("a", "s1", "sw", T + 3)).toBe(false);
    expect(p.complete("a", "s2", "sw", T + 3)).toBe(true);
    expect(p.complete("c", "s1", "sw", T + 3)).toBe(true);
  });

  test("bounded: the oldest entries are evicted beyond the cap", () => {
    const p = new PendingExchanges();
    for (let i = 0; i < MAX_PENDING_EXCHANGES + 5; i++) p.add(`o${i}`, "s", "sw", T);
    expect(p.size).toBe(MAX_PENDING_EXCHANGES);
    expect(p.complete("o0", "s", "sw", T)).toBe(false);
    expect(p.complete("o4", "s", "sw", T)).toBe(false);
    expect(p.complete("o5", "s", "sw", T)).toBe(true);
  });
});
