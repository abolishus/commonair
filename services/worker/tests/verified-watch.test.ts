// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Verified-watch values (ADR 0015 decisions 3, 4, 5): the jitter and the per-address cap. Pure. */
import { describe, expect, test } from "vite-plus/test";
import { unlocks, verifiedWatchJitter, type WatchRow } from "../src/chat-gate/unlocks.ts";

const SECRET = "test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const CH = "00000000-0000-7000-8000-0000000000c1";
const B = "00000000-0000-7000-8000-0000000000b1";
const B2 = "00000000-0000-7000-8000-0000000000b2";
const uid = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const T0 = Date.parse("2026-10-30T12:00:00Z");

const row = (n: number, over: Partial<WatchRow> = {}): WatchRow => ({
  channelId: CH,
  broadcastId: B,
  userId: uid(n),
  ipHash: "ip-a",
  privacyRelay: false,
  seconds: 600,
  firstAt: new Date(T0 + n * 1_000),
  ...over,
});

describe("verifiedWatchJitter", () => {
  test("deterministic per user and broadcast, within 0–30", () => {
    for (let n = 1; n <= 200; n++) {
      const j = verifiedWatchJitter(SECRET, B, uid(n));
      expect(j).toBe(verifiedWatchJitter(SECRET, B, uid(n)));
      expect(Number.isInteger(j)).toBe(true);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(30);
    }
  });

  test("differs across broadcasts and users (not a constant)", () => {
    const users = Array.from({ length: 50 }, (_, i) => uid(i + 1));
    const a = users.map((u) => verifiedWatchJitter(SECRET, B, u));
    const b = users.map((u) => verifiedWatchJitter(SECRET, B2, u));
    expect(a).not.toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(10);
    // A different secret gives different values (an attacker without it cannot predict them).
    expect(users.map((u) => verifiedWatchJitter(`${SECRET}x`, B, u))).not.toEqual(a);
  });

  test("the digest is read as one integer mod 31 (known vector)", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`vw-jitter-v1:${B}:${uid(7)}`)),
    );
    const big = mac.reduce((acc, byte) => acc * 256n + BigInt(byte), 0n);
    expect(verifiedWatchJitter(SECRET, B, uid(7))).toBe(Number(big % 31n));
  });
});

describe("unlocks: seconds and jitter", () => {
  test("seconds summed over a user's sessions, minus the jitter, never negative", () => {
    const [u] = unlocks([row(1, { seconds: 100 }), row(1, { ipHash: "ip-b", seconds: 50 })], 5, SECRET);
    const j = verifiedWatchJitter(SECRET, B, uid(1));
    expect(u?.value).toEqual({ b: B, s: 150 - j, f: 0 });
    const [z] = unlocks([row(2, { seconds: 0 })], 5, SECRET);
    expect(z?.value.s).toBe(0);
  });

  test("no rows, no keys", () => {
    expect(unlocks([], 5, SECRET)).toEqual([]);
  });
});

describe("unlocks: the per-address cap", () => {
  test("six users on one address: the first five by first session are counted", () => {
    // Inserted out of order: ranking is by first session, not by row order.
    const rows = [6, 3, 1, 5, 2, 4].map((n) => row(n));
    const got = unlocks(rows, 5, SECRET)
      .map((u) => u.userId)
      .sort();
    expect(got).toEqual([1, 2, 3, 4, 5].map(uid).sort());
  });

  test("a farm that arrives later cannot push out earlier honest viewers", () => {
    const honest = [1, 2, 3].map((n) => row(n));
    const farm = Array.from({ length: 10 }, (_, i) => row(100 + i, { seconds: 3600 }));
    const got = new Set(unlocks([...farm, ...honest], 5, SECRET).map((u) => u.userId));
    for (const n of [1, 2, 3]) expect(got.has(uid(n))).toBe(true);
    expect(got.size).toBe(5);
  });

  test("addresses are capped separately; one ordinary address within the cap is enough", () => {
    const rows = [
      ...[1, 2, 3, 4, 5].map((n) => row(n)),
      // 6 is sixth on ip-a but first on ip-b.
      row(6, { firstAt: new Date(T0 + 60_000) }),
      row(6, { ipHash: "ip-b", firstAt: new Date(T0 + 61_000) }),
    ];
    expect(unlocks(rows, 5, SECRET)).toHaveLength(6);
  });

  test("equal first-session times rank by user id (stable across passes)", () => {
    const at = new Date(T0);
    const rows = [3, 1, 2].map((n) => row(n, { firstAt: at }));
    expect(
      unlocks(rows, 2, SECRET)
        .map((u) => u.userId)
        .sort(),
    ).toEqual([uid(1), uid(2)]);
  });

  test("privacy-relay addresses are not capped and mark f: 1", () => {
    const relay = Array.from({ length: 8 }, (_, i) => row(i + 1, { ipHash: "relay-1", privacyRelay: true }));
    const got = unlocks(relay, 5, SECRET);
    expect(got).toHaveLength(8);
    expect(got.every((u) => u.value.f === 1)).toBe(true);
  });

  test("relay viewers do not take places in an ordinary address's cap", () => {
    const rows = [
      row(1, { ipHash: "relay-1", privacyRelay: true, firstAt: new Date(T0 - 60_000) }),
      ...[2, 3, 4, 5, 6].map((n) => row(n)),
    ];
    const got = unlocks(rows, 5, SECRET);
    expect(got).toHaveLength(6);
  });

  test("a user counted on an ordinary address gets f: 0 even with relay sessions too", () => {
    const [u] = unlocks([row(1), row(1, { ipHash: "relay", privacyRelay: true })], 5, SECRET);
    expect(u?.value.f).toBe(0);
  });

  test("a user capped on their ordinary address but also on a relay falls back (f: 1)", () => {
    const rows = [...[1, 2].map((n) => row(n)), row(3), row(3, { ipHash: "relay", privacyRelay: true })];
    const capped = unlocks(rows, 2, SECRET).find((u) => u.userId === uid(3));
    expect(capped?.value.f).toBe(1);
  });

  test("the fallback counts the relay seconds only, not those from the address that capped them", () => {
    const rows = [
      ...[1, 2].map((n) => row(n)),
      row(3, { seconds: 600 }),
      row(3, { ipHash: "relay", privacyRelay: true, seconds: 90 }),
    ];
    const capped = unlocks(rows, 2, SECRET).find((u) => u.userId === uid(3));
    expect(capped?.value).toEqual({ b: B, s: Math.max(0, 90 - verifiedWatchJitter(SECRET, B, uid(3))), f: 1 });
    // Counted on an ordinary address: every address's seconds add up.
    const [counted] = unlocks(
      [row(1, { seconds: 600 }), row(1, { ipHash: "relay", privacyRelay: true, seconds: 90 })],
      5,
      SECRET,
    );
    expect(counted?.value.s).toBe(690 - verifiedWatchJitter(SECRET, B, uid(1)));
  });

  test("exempt roles are left out by the query, so they take no place (five others still fit)", () => {
    // The writer's SQL drops the broadcaster, moderators, VIPs and verified bots before ranking.
    const rows = [1, 2, 3, 4, 5].map((n) => row(n));
    expect(unlocks(rows, 5, SECRET)).toHaveLength(5);
  });
});
