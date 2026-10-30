// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import type { Executor } from "@commonair/db";
import { generateSigningKey, signPlaybackToken, verifyPlaybackToken } from "@commonair/tokens";
import { TokenRefresher } from "../src/refresh.ts";

const { key } = await generateSigningKey();
const NOW = 1_800_000_000;
const claims = (exp: number): PlaybackClaims => ({
  v: 1,
  sid: "0190a0a0-0000-7000-8000-000000000001",
  cid: "0190a0a0-0000-7000-8000-000000000002",
  path: "live/alice",
  src: "origin",
  iat: exp - 120,
  exp,
});

/** Fake `select … from playback_sessions where id = ? limit 1` answering `rows`. */
function fakeDb(rows: { endedAt: Date | null }[]) {
  let queries = 0;
  const chain = { from: () => chain, where: () => chain, limit: async () => (queries++, rows) };
  return { db: { select: () => chain } as unknown as Executor, queries: () => queries };
}

describe("TokenRefresher", () => {
  test("tokens with a minute or more left are echoed unchanged", async () => {
    const f = fakeDb([{ endedAt: null }]);
    const r = new TokenRefresher({ key, db: f.db, now: () => NOW });
    const c = claims(NOW + 60);
    const t = await signPlaybackToken(key, c);
    expect(await r.tokenFor(c, t)).toBe(t);
    expect(f.queries()).toBe(0);
  });

  test("near expiry, an active session gets a fresh token with the same claims", async () => {
    const f = fakeDb([{ endedAt: null }]);
    const r = new TokenRefresher({ key, db: f.db, now: () => NOW });
    const c = claims(NOW + 59);
    const t = await signPlaybackToken(key, c);
    const fresh = await r.tokenFor(c, t);
    expect(fresh).not.toBe(t);
    const v = await verifyPlaybackToken(key.publicKey, fresh, NOW);
    expect(v).toEqual({ ok: true, value: { ...c, iat: NOW, exp: NOW + 120 } });
    // Reused for the rest of the session's requests, no second signature or lookup.
    expect(await r.tokenFor(c, t)).toBe(fresh);
    expect(f.queries()).toBe(1);
  });

  test("a token is never reused across a dm change (ADR 0018)", async () => {
    const f = fakeDb([{ endedAt: null }]);
    const r = new TokenRefresher({ key, db: f.db, now: () => NOW });
    const before = claims(NOW + 30);
    const first = await r.tokenFor(before, await signPlaybackToken(key, before));
    expect((await verifyPlaybackToken(key.publicKey, first, NOW)).ok).toBe(true);

    // The API re-minted with a ceiling; the new token is near expiry too.
    const on = { ...claims(NOW + 30), dm: 96_618 };
    const second = await r.tokenFor(on, await signPlaybackToken(key, on));
    expect(second).not.toBe(first);
    const v = await verifyPlaybackToken(key.publicKey, second, NOW);
    expect(v.ok && v.value.dm).toBe(96_618);

    // A different ceiling, and back to off: each gets its own token, never the other's.
    const raised = { ...claims(NOW + 30), dm: 1_545_894 };
    const third = await r.tokenFor(raised, await signPlaybackToken(key, raised));
    const v3 = await verifyPlaybackToken(key.publicKey, third, NOW);
    expect(v3.ok && v3.value.dm).toBe(1_545_894);
    const off = claims(NOW + 30);
    const fourth = await r.tokenFor(off, await signPlaybackToken(key, off));
    const v4 = await verifyPlaybackToken(key.publicKey, fourth, NOW);
    expect(v4.ok && v4.value.dm).toBeUndefined();
    // Same (sid, dm) is still reused.
    expect(await r.tokenFor(on, await signPlaybackToken(key, on))).toBe(second);
  });

  test("ended or unknown sessions are not extended", async () => {
    for (const rows of [[{ endedAt: new Date() }], []]) {
      const r = new TokenRefresher({ key, db: fakeDb(rows).db, now: () => NOW });
      const c = claims(NOW + 10);
      const t = await signPlaybackToken(key, c);
      expect(await r.tokenFor(c, t)).toBe(t);
    }
  });
});
