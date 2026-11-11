// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Overhaul wave 5 contract step: the schedule, the last broadcast, audit-log dates and new fields. */
import type { z } from "zod";
import { describe, expect, test } from "vite-plus/test";
import { contract } from "../src/api/router.ts";
import {
  AdminQueueCount,
  Channel,
  ChannelScheduleInput,
  LastBroadcast,
  LocalTime,
  LoyaltyBalance,
  ShareView,
} from "../src/api/entities.ts";
import { SCHEDULE_RULES, UI_METRIC_STEPS, UI_METRIC_SURFACES } from "../src/enums.ts";
import { NOTIFY_JOBS } from "../src/internal.ts";

const input = (s: unknown) => s as z.ZodType;
const slot = { weekday: 5, startLocal: "19:30", durationMinutes: 120, title: "Friday build", categoryId: null };

describe("channel schedule", () => {
  test("local times are 24 h HH:MM", () => {
    for (const ok of ["00:00", "09:05", "23:59"]) expect(LocalTime.safeParse(ok).success).toBe(true);
    for (const bad of ["24:00", "9:05", "12:60", "12:00:00", ""]) expect(LocalTime.safeParse(bad).success).toBe(false);
  });

  test("set takes the whole schedule within SCHEDULE_RULES", () => {
    const set = input(contract.channels.schedule.set["~orpc"].inputSchema);
    expect(set.safeParse({ channel: "w5channel", timezone: "Europe/Paris", slots: [slot], oneOffs: [] }).success).toBe(
      true,
    );
    const many = Array.from({ length: SCHEDULE_RULES.maxSlots + 1 }, () => slot);
    expect(ChannelScheduleInput.safeParse({ timezone: "UTC", slots: many, oneOffs: [] }).success).toBe(false);
    const short = { ...slot, durationMinutes: SCHEDULE_RULES.minDurationMinutes - 1 };
    expect(ChannelScheduleInput.safeParse({ timezone: "UTC", slots: [short], oneOffs: [] }).success).toBe(false);
    const long = { ...slot, title: "x".repeat(SCHEDULE_RULES.titleMax + 1) };
    expect(ChannelScheduleInput.safeParse({ timezone: "UTC", slots: [long], oneOffs: [] }).success).toBe(false);
    const skip = {
      startsAt: "2030-01-04T19:30:00.000Z",
      durationMinutes: 120,
      title: null,
      categoryId: null,
      cancelsSlot: 0,
    };
    expect(ChannelScheduleInput.safeParse({ timezone: "UTC", slots: [slot], oneOffs: [skip] }).success).toBe(true);
  });

  test("the channel carries its next stream", () => {
    expect(Channel.shape).toHaveProperty("nextStreamAt");
    expect(Channel.shape.viewer.unwrap().unwrap().shape).toHaveProperty("subscribed");
  });
});

describe("other wave 5 fields and inputs", () => {
  test("lastBroadcast is nullable and counts are whole", () => {
    const out = contract.stream.lastBroadcast["~orpc"].outputSchema as unknown as z.ZodType;
    expect(out.safeParse(null).success).toBe(true);
    expect(LastBroadcast.shape.newFollowers.safeParse(-1).success).toBe(false);
  });

  test("the audit log takes a date range", () => {
    const schema = input(contract.safety.auditLog["~orpc"].inputSchema);
    expect(schema.safeParse({ from: "2026-11-01T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" }).success).toBe(true);
    expect(schema.safeParse({ from: "yesterday" }).success).toBe(false);
  });

  test("new nullable fields", () => {
    expect(LoyaltyBalance.shape.earnedToday.safeParse(null).success).toBe(true);
    expect(LoyaltyBalance.shape.earnedToday.safeParse(-1).success).toBe(false);
    expect(AdminQueueCount.shape.nextDueAt.safeParse(null).success).toBe(true);
    expect(ShareView.shape.deletionScheduledFor.safeParse(null).success).toBe(true);
    expect(input(contract.coop.shares.askRefundDetails["~orpc"].inputSchema).safeParse({ shareId: "x" }).success).toBe(
      false,
    );
  });

  test("metric names and job names", () => {
    expect(UI_METRIC_SURFACES).toEqual(
      expect.arrayContaining(["channel.schedule", "studio.schedule", "studio.sharePrompt"]),
    );
    expect(UI_METRIC_STEPS).toEqual(expect.arrayContaining(["ics", "feed", "copy", "share"]));
    expect(new Set(Object.values(NOTIFY_JOBS)).size).toBe(Object.values(NOTIFY_JOBS).length);
    expect(NOTIFY_JOBS).toMatchObject({ weeklyDigest: "notify-weekly-digest", vodEmail: "notify-vod-email" });
  });
});
