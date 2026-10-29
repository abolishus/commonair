// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { DEFAULT_RATE_LIMITS, decide, memoryRateLimitStore, rateLimitKey } from "../src/lib/ratelimit.ts";

const rule = { max: 3, windowMs: 10_000 };

test("allows up to max in the window, then refuses with retry-after", async () => {
  const s = memoryRateLimitStore();
  for (let i = 0; i < 3; i++) expect((await s.hit("k", rule, 1000 + i, `m${i}`)).allowed).toBe(true);
  const r = await s.hit("k", rule, 1500, "m3");
  expect(r.allowed).toBe(false);
  // Oldest hit at t=1000 leaves the window at 11000: 9.5 s → 10 s rounded up.
  expect(r.retryAfterSeconds).toBe(10);
});

test("the window slides: old hits expire individually", async () => {
  const s = memoryRateLimitStore();
  await s.hit("k", rule, 0, "a");
  await s.hit("k", rule, 5000, "b");
  await s.hit("k", rule, 6000, "c");
  expect((await s.hit("k", rule, 9999, "d")).allowed).toBe(false);
  // At 10 001 the first hit has left; exactly one slot opens.
  expect((await s.hit("k", rule, 10_001, "e")).allowed).toBe(true);
  expect((await s.hit("k", rule, 10_002, "f")).allowed).toBe(false);
});

test("refused hits are not recorded (no penalty spiral)", async () => {
  const s = memoryRateLimitStore();
  for (let i = 0; i < 3; i++) await s.hit("k", rule, i, `x${i}`);
  for (let i = 0; i < 50; i++) await s.hit("k", rule, 100 + i, `y${i}`);
  expect((await s.hit("k", rule, 10_003, "z")).allowed).toBe(true);
});

test("keys are independent per subject and bucket", async () => {
  const s = memoryRateLimitStore();
  for (let i = 0; i < 3; i++) await s.hit(rateLimitKey("write", "u:a"), rule, i, `${i}`);
  expect((await s.hit(rateLimitKey("write", "u:b"), rule, 5, "b")).allowed).toBe(true);
  expect((await s.hit(rateLimitKey("default", "u:a"), rule, 5, "c")).allowed).toBe(true);
  expect(rateLimitKey("write", "u:a")).toBe("rl:write:u:a");
});

test("decide: boundary at exactly max and retry-after is at least 1 s", () => {
  expect(decide([1, 2], rule, 3)).toMatchObject({ allowed: true, count: 3 });
  const r = decide([1, 2, 3], { max: 3, windowMs: 10 }, 10);
  expect(r.allowed).toBe(false);
  expect(r.retryAfterSeconds).toBe(1);
});

test("default buckets match the documented limits", () => {
  expect(DEFAULT_RATE_LIMITS).toEqual({
    default: { max: 120, windowMs: 60_000 },
    write: { max: 30, windowMs: 60_000 },
    auth: { max: 10, windowMs: 60_000 },
    chat: { max: 20, windowMs: 30_000 },
    expensive: { max: 5, windowMs: 3_600_000 },
    mail: { max: 10, windowMs: 3_600_000 },
    playback: { max: 3000, windowMs: 60_000 },
    app: { max: 6000, windowMs: 60_000 },
    eventsub: { max: 60, windowMs: 60_000 },
  });
});
