// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The harness-only `/internal/moderation/*` test hooks: absent by default, secret-gated when on. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS } from "@commonair/contracts/internal";
import { uuidv7 } from "@commonair/db";
import { startModeration } from "../src/moderation/index.ts";
import { recordingQueue } from "../src/moderation/queue.ts";
import { startApi, type TestApi } from "./harness.ts";

let off: TestApi;
let on: TestApi;
const clock = recordingQueue({ escalated24: 1, escalated36: 2, autoHidden: 3 });
/** Set to make the worker's clock run fail (as on a BullMQ timeout). */
let clockFails = false;
const realClock = clock.nciiClock.bind(clock);
clock.nciiClock = async (asOf) => {
  if (clockFails) throw new Error("timed out");
  return realClock(asOf);
};

beforeAll(async () => {
  [off, on] = await Promise.all([
    startApi(),
    startApi({ env: { MODERATION_TEST_HOOKS: "true", MODERATION_CLASSIFIER: "scripted" } }),
  ]);
  // The runtime is cached per deps, so the hook's tick reaches this recording queue. This must
  // run before anything else touches `on`'s runtime: later overrides are ignored.
  await startModeration(on.deps, { queue: clock });
}, 120_000);
afterAll(async () => {
  await Promise.all([off?.stop(), on?.stop()]);
});

const call = (api: TestApi, method: string, route: string, body: unknown, secret = api.internalSecret) =>
  fetch(`${api.url}${route}`, {
    method,
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
  });

describe("moderation test hooks", () => {
  test("off by default: both routes are 404, even with the secret", async () => {
    const channelId = uuidv7();
    expect((await call(off, "PUT", INTERNAL_ROUTES.moderationScript, { channelId, scores: {} })).status).toBe(404);
    expect((await call(off, "POST", INTERNAL_ROUTES.nciiTick, { asOf: new Date().toISOString() })).status).toBe(404);
    expect(await off.deps.valkey.get(KEYS.moderationScript(channelId))).toBeNull();
  });

  test("on: a wrong or missing secret is refused", async () => {
    const r = await call(on, "PUT", INTERNAL_ROUTES.moderationScript, { channelId: uuidv7(), scores: {} }, "wrong");
    expect(r.status).toBe(401);
    const bare = await fetch(`${on.url}${INTERNAL_ROUTES.nciiTick}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asOf: new Date().toISOString() }),
    });
    expect(bare.status).toBe(401);
  });

  test("on: the script is stored under the classifier's key, and {} clears the scores", async () => {
    const channelId = uuidv7();
    const put = await call(on, "PUT", INTERNAL_ROUTES.moderationScript, { channelId, scores: { sexual: 0.85 } });
    expect(put.status).toBe(204);
    expect(JSON.parse((await on.deps.valkey.get(KEYS.moderationScript(channelId))) ?? "null")).toEqual({
      sexual: 0.85,
    });
    expect((await call(on, "PUT", INTERNAL_ROUTES.moderationScript, { channelId, scores: {} })).status).toBe(204);
    expect(await on.deps.valkey.get(KEYS.moderationScript(channelId))).toBe("{}");
  });

  test("on: malformed bodies and wrong methods are rejected", async () => {
    expect((await call(on, "PUT", INTERNAL_ROUTES.moderationScript, { channelId: "x", scores: {} })).status).toBe(400);
    expect((await call(on, "POST", INTERNAL_ROUTES.nciiTick, { asOf: "yesterday" })).status).toBe(400);
    expect((await call(on, "GET", INTERNAL_ROUTES.nciiTick, undefined)).status).toBe(405);
  });

  test("on: ncii-tick runs the clock as of the given time and returns its result", async () => {
    const asOf = "2026-10-23T12:01:00.000Z";
    const r = await call(on, "POST", INTERNAL_ROUTES.nciiTick, { asOf });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ escalated24: 1, escalated36: 2, autoHidden: 3 });
    expect(clock.clockCalls).toContain(asOf);
  });

  test("on: a clock run that fails or times out answers 504", async () => {
    clockFails = true;
    try {
      const r = await call(on, "POST", INTERNAL_ROUTES.nciiTick, { asOf: new Date().toISOString() });
      expect(r.status).toBe(504);
    } finally {
      clockFails = false;
    }
  });
});
