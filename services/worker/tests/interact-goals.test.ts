// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The relay's goal hook stays out of the database for batches with nothing that counts. */
import { describe, expect, test } from "vite-plus/test";
import type { BusEvent } from "@commonair/contracts/events";
import type { Executor } from "@commonair/db";
import { applyGoalProgress } from "../src/interact/goals/outbox-hook.ts";

const CH = "0190f0aa-0000-7000-8000-000000000001";
let seq = 0;
const ev = (type: string, channelId: string | null = CH, payload: Record<string, unknown> = {}): BusEvent =>
  ({
    id: `0190f0aa-0000-7000-8000-${String(++seq).padStart(12, "0")}`,
    type,
    version: "1",
    channelId,
    payload,
    occurredAt: new Date().toISOString(),
  }) as BusEvent;

/** A transaction that fails the test on any use. */
const untouchable = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the hook touched the database (${String(prop)})`);
    },
  },
) as Executor;
const ctx = { now: () => new Date() };

describe("applyGoalProgress without a query", () => {
  test("an empty batch", async () => {
    expect(await applyGoalProgress(untouchable, [], ctx)).toBe(0);
  });
  test("unrelated events, the gift summary, platform events and malformed tips", async () => {
    const batch = [
      ev("stream.online"),
      ev("channel.raid"),
      ev("channel.subscription.gift", CH, { total: 3 }),
      ev("channel.subscription.end"),
      ev("channel.goal.progress"),
      ev("channel.follow", null),
      ev("channel.tip", CH, { amount: { value: 0 } }),
    ];
    expect(await applyGoalProgress(untouchable, batch, ctx)).toBe(0);
  });
});
