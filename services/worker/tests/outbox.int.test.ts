// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { BusEvent } from "@commonair/contracts/events";
import { schema } from "@commonair/db";
import { createValkey } from "@commonair/service";
import { isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { relayOutboxBatch } from "../src/outbox.ts";
import { broadcasterFields, insertEvent, makeUser, setup, VALKEY_URL, waitFor, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
const seen: string[] = [];
const subscriber = createValkey(VALKEY_URL, { name: "worker-test-outbox-sub" });

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
  await subscriber.subscribe(env.worker.ctx.busChannel);
  subscriber.on("message", (_c, m) => seen.push(BusEvent.parse(JSON.parse(m)).id));
});
afterAll(async () => {
  await subscriber.quit();
  await env.close();
});

test("concurrent relays (replicas) claim disjoint rows: every event is published exactly once", async () => {
  const { user, channel } = await makeUser(env.t.db);
  const ids: string[] = [];
  for (let i = 0; i < 120; i++)
    ids.push((await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user))).id);

  // Four "replicas" draining in parallel with small batches.
  const drain = async () => {
    let total = 0;
    for (;;) {
      const n = await relayOutboxBatch(env.worker.ctx, 7);
      if (n === 0) return total;
      total += n;
    }
  };
  const totals = await Promise.all([drain(), drain(), drain(), drain()]);
  expect(totals.reduce((a, b) => a + b, 0)).toBe(120);
  await waitFor(async () => seen.length >= 120, { label: "all published" });
  await Bun.sleep(100);
  expect(seen).toHaveLength(120);
  expect(new Set(seen)).toEqual(new Set(ids));
  expect(await env.t.db.select().from(schema.events).where(isNull(schema.events.publishedAt))).toHaveLength(0);
});

test("events are published in occurrence order within a relay", async () => {
  const { user, channel } = await makeUser(env.t.db);
  seen.length = 0;
  const ids: string[] = [];
  for (let i = 0; i < 10; i++)
    ids.push((await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user))).id);
  expect(await relayOutboxBatch(env.worker.ctx, 100)).toBe(10);
  await waitFor(async () => seen.length === 10);
  expect(seen).toEqual(ids);
});
