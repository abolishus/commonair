// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vite-plus/test";
import { ChatControlMessage } from "@commonair/contracts/chat";
import { RAID_RULES } from "@commonair/contracts/enums";
import { EVENTS } from "@commonair/contracts/events";
import {
  RAID_REFUSALS,
  cooldownSecondsLeft,
  raidCooldownEndsAt,
  raidEventPayload,
  raidExecuteCancelReason,
  raidFrame,
  raidPolicyAllows,
  raidStartRefusal,
  raidViewerCount,
  raidViewersQuery,
  toRaidView,
  type RaidPolicy,
  type RaidSide,
} from "../src/raids.ts";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const LIVE: RaidSide = { liveBroadcastId: "0190f0aa-0000-7000-8000-0000000000b1", suspendedAt: null };
const OFF: RaidSide = { liveBroadcastId: null, suspendedAt: null };
const SUSPENDED: RaidSide = { ...LIVE, suspendedAt: new Date("2026-10-29T11:00:00.000Z") };
const target = (policy: RaidPolicy = "anyone", side: RaidSide = LIVE) => ({ ...side, raidPolicy: policy });

describe("raidPolicyAllows", () => {
  test.each([
    ["anyone", false, true],
    ["anyone", true, true],
    ["followed", false, false],
    ["followed", true, true],
    ["off", false, false],
    ["off", true, false],
  ] as const)("%s, target owner follows source %s → %s", (policy, follows, ok) => {
    expect(raidPolicyAllows(policy, follows)).toBe(ok);
  });
});

describe("raidCooldownEndsAt", () => {
  const ms = RAID_RULES.cooldownSeconds * 1000;
  test("no previous raid: no cooldown", () => expect(raidCooldownEndsAt(null, NOW)).toBeNull());
  test("one second inside the cooldown", () => {
    const last = new Date(NOW.getTime() - ms + 1000);
    expect(raidCooldownEndsAt(last, NOW)?.toISOString()).toBe(new Date(last.getTime() + ms).toISOString());
  });
  test("exactly at the boundary the cooldown is over", () => {
    expect(raidCooldownEndsAt(new Date(NOW.getTime() - ms), NOW)).toBeNull();
  });
  test("one millisecond before the boundary it still runs", () => {
    expect(raidCooldownEndsAt(new Date(NOW.getTime() - ms + 1), NOW)).not.toBeNull();
  });
  test("seconds left round up and never show 0", () => {
    expect(cooldownSecondsLeft(new Date(NOW.getTime() + 1), NOW)).toBe(1);
    expect(cooldownSecondsLeft(new Date(NOW.getTime() + 1500), NOW)).toBe(2);
    expect(cooldownSecondsLeft(new Date(NOW.getTime() + 600_000), NOW)).toBe(600);
  });
});

describe("raidStartRefusal", () => {
  const base = { source: LIVE, target: target(), targetOwnerFollowsSource: false, lastEndedAt: null, now: NOW };
  test("both live, anyone, no cooldown → allowed", () => expect(raidStartRefusal(base)).toBeNull());
  test("source offline", () =>
    expect(raidStartRefusal({ ...base, source: OFF })?.code).toBe(RAID_REFUSALS.sourceOffline));
  test("target offline", () =>
    expect(raidStartRefusal({ ...base, target: target("anyone", OFF) })?.code).toBe(RAID_REFUSALS.targetOffline));
  test("offline wins over suspended (order of the contract)", () =>
    expect(raidStartRefusal({ ...base, source: { ...SUSPENDED, liveBroadcastId: null } })?.code).toBe(
      RAID_REFUSALS.sourceOffline,
    ));
  test("either side suspended", () => {
    expect(raidStartRefusal({ ...base, source: SUSPENDED })?.code).toBe(RAID_REFUSALS.suspended);
    expect(raidStartRefusal({ ...base, target: target("anyone", SUSPENDED) })?.code).toBe(RAID_REFUSALS.suspended);
  });
  test("policy off and followed-without-follow refuse; followed with the follow passes", () => {
    expect(raidStartRefusal({ ...base, target: target("off") })?.code).toBe(RAID_REFUSALS.refused);
    expect(raidStartRefusal({ ...base, target: target("followed") })?.code).toBe(RAID_REFUSALS.refused);
    expect(raidStartRefusal({ ...base, target: target("followed"), targetOwnerFollowsSource: true })).toBeNull();
  });
  test("cooldown carries its end", () => {
    const last = new Date(NOW.getTime() - 60_000);
    const r = raidStartRefusal({ ...base, lastEndedAt: last });
    expect(r?.code).toBe(RAID_REFUSALS.cooldown);
    expect(r?.cooldownEndsAt?.getTime()).toBe(last.getTime() + RAID_RULES.cooldownSeconds * 1000);
  });
  test("the policy is checked before the cooldown", () =>
    expect(
      raidStartRefusal({ ...base, target: target("off"), lastEndedAt: new Date(NOW.getTime() - 1000) })?.code,
    ).toBe(RAID_REFUSALS.refused));
});

describe("raidExecuteCancelReason", () => {
  const base = { source: LIVE, target: target(), targetOwnerFollowsSource: false };
  test("all still fine → execute", () => expect(raidExecuteCancelReason(base)).toBeNull());
  test("suspended first, whichever side", () => {
    expect(raidExecuteCancelReason({ ...base, source: { ...SUSPENDED, liveBroadcastId: null } })).toBe("suspended");
    expect(raidExecuteCancelReason({ ...base, target: target("off", SUSPENDED) })).toBe("suspended");
  });
  test("source offline before target offline", () => {
    expect(raidExecuteCancelReason({ ...base, source: OFF, target: target("anyone", OFF) })).toBe("source_offline");
    expect(raidExecuteCancelReason({ ...base, target: target("anyone", OFF) })).toBe("target_offline");
  });
  test("the target changed its policy during the countdown", () => {
    expect(raidExecuteCancelReason({ ...base, target: target("off") })).toBe("target_refused");
    expect(raidExecuteCancelReason({ ...base, target: target("followed") })).toBe("target_refused");
    expect(raidExecuteCancelReason({ ...base, target: target("followed"), targetOwnerFollowsSource: true })).toBeNull();
  });
});

describe("raidViewersQuery (verified count)", () => {
  const q = new PgDialect().sqlToQuery(raidViewersQuery("0190f0aa-0000-7000-8000-000000000001", NOW));
  const text = q.sql.replace(/\s+/g, " ");
  test("counts open sessions of the channel with a heartbeat in the last 60 s", () => {
    expect(text).toContain("from playback_sessions ps");
    expect(text).toContain("ps.channel_id = $1");
    expect(text).toContain("ps.ended_at is null");
    expect(text).toContain("ps.last_heartbeat_at > $2::timestamptz");
    expect(q.params).toEqual(["0190f0aa-0000-7000-8000-000000000001", "2026-10-29T11:59:00.000Z"]);
  });
  test("verified is distinct viewers (account, else device) filtered by GATE_ELIGIBLE", () => {
    expect(text).toContain("count(distinct coalesce(ps.user_id::text, 'device:' || ps.device_hash))");
    expect(text).toContain("filter (where (ps.verdict = 'verified' and ps.scored_at is not null");
    expect(text).toContain("fetch_unjudged");
  });
  test("raidViewerCount never exceeds the verified count", () => {
    expect(raidViewerCount(5, 1)).toBe(1);
    expect(raidViewerCount(0, 0)).toBe(0);
    expect(raidViewerCount(3, 3)).toBe(3);
    // A device counted once across two sessions can never lift the count above the sessions.
    expect(raidViewerCount(1, 2)).toBe(1);
  });
});

describe("builders", () => {
  const from = {
    id: "0190f0aa-0000-7000-8000-000000000001",
    ownerId: "0190f0aa-0000-7000-8000-0000000000a1",
    slug: "src",
    displayName: "Source",
  };
  const to = {
    id: "0190f0aa-0000-7000-8000-000000000002",
    ownerId: "0190f0aa-0000-7000-8000-0000000000a2",
    slug: "dst",
    displayName: "Target",
  };
  const raid = {
    id: "0190f0aa-0000-7000-8000-0000000000c1",
    viewerCount: 0,
    status: "pending" as const,
    cancelReason: null,
    createdAt: NOW,
    executeAt: new Date(NOW.getTime() + 30_000),
  };
  test("channel.raid payload matches the catalog", () => {
    const p = raidEventPayload(from, to, 7);
    expect(EVENTS["channel.raid"].payload.parse(p)).toEqual(p);
    expect(p).toMatchObject({ from_broadcaster_user_login: "src", to_broadcaster_user_id: to.ownerId, viewers: 7 });
  });
  test("the raid frame is a valid control message on the source's room", () => {
    for (const status of ["pending", "completed", "canceled"] as const) {
      const f = raidFrame({ ...raid, status }, from, to);
      expect(ChatControlMessage.parse(f)).toEqual(f);
      expect(f).toMatchObject({ op: "raid", channel: "src", to: "dst", toDisplayName: "Target", status });
    }
  });
  test("RaidView", () => {
    expect(toRaidView(raid, from, to)).toEqual({
      id: raid.id,
      from: "src",
      to: "dst",
      toDisplayName: "Target",
      viewerCount: 0,
      status: "pending",
      cancelReason: null,
      createdAt: NOW.toISOString(),
      executeAt: "2026-10-29T12:00:30.000Z",
    });
  });
});
