// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test, vi } from "vite-plus/test";
import { createDb, reconnectBackoff } from "../src/client.ts";

vi.setConfig({ testTimeout: 20_000 });

test("reconnect backoff grows, then caps at 2 s with jitter in [50 %, 100 %]", () => {
  expect(reconnectBackoff(0, () => 1)).toBeCloseTo(0.05);
  expect(reconnectBackoff(3, () => 1)).toBeCloseTo(0.4);
  expect(reconnectBackoff(6, () => 1)).toBe(2);
  expect(reconnectBackoff(50, () => 1)).toBe(2);
  expect(reconnectBackoff(50, () => 0)).toBe(1);
  for (let r = 0; r < 30; r++) expect(reconnectBackoff(r)).toBeLessThanOrEqual(2);
});

test("after a run of failed connects, the next attempt is not held back for long", async () => {
  // Nothing listens on port 1: every connect is refused at once, and each refusal raises the
  // pool's failure count (the driver's own backoff would be 7–20 s by the 7th attempt).
  const db = createDb({ url: "postgres://nobody@127.0.0.1:1/none", max: 1 });
  try {
    for (let i = 0; i < 6; i++) await db.sql`select 1`.catch(() => undefined);
    const started = performance.now();
    const err = await db.sql`select 1`.then(
      () => null,
      (e: { code?: string }) => e.code,
    );
    expect(err).toBe("ECONNREFUSED");
    expect(performance.now() - started).toBeLessThan(2_500);
  } finally {
    await db.close();
  }
});
