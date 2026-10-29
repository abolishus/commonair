// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E8 contract step (ADR 0026): enums, shapes, the raid control frame, bot control, events, jobs. */
import { describe, expect, test } from "vite-plus/test";
import { BotSettings, PredictionView, RaidState } from "../src/api/entities.ts";
import { contract } from "../src/api/router.ts";
import { BotControlMessage, ChatControlMessage, ServerFrame } from "../src/chat.ts";
import { LOYALTY_REASONS, POINTS_ADJUST_REASONS, RAID_CANCEL_REASONS, RAID_RULES } from "../src/enums.ts";
import { BUS, EVENTS } from "../src/events.ts";
import { INTERACT_JOB_NAMES, INTERACT_JOBS, InteractTickBody, INTERNAL_ROUTES, KEYS, QUEUES } from "../src/internal.ts";
import { BotConfig, PointsAccrualSetting } from "../src/shapes.ts";

const broadcaster = { broadcaster_user_id: "u", broadcaster_user_login: "s", broadcaster_user_name: "S" };
const user = { user_id: "v", user_login: "v", user_name: "V" };

describe("shapes", () => {
  test("loyalty keeps only enabled and pointsName (rates are the instance setting)", () => {
    expect(BotConfig.parse({}).loyalty).toEqual({ enabled: true, pointsName: "points" });
    const parsed = BotConfig.parse({ loyalty: { enabled: false, pointsName: "beans", subscriberMultiplier: 5 } });
    expect(parsed.loyalty).toEqual({ enabled: false, pointsName: "beans" });
  });

  test("PointsAccrualSetting bounds match the 0034 trigger", () => {
    const ok = { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 };
    expect(PointsAccrualSetting.safeParse(ok).success).toBe(true);
    expect(PointsAccrualSetting.safeParse({ ...ok, dailyCapPerChannel: 0 }).success).toBe(true);
    for (const bad of [
      { ...ok, blockMinutes: 0 },
      { ...ok, blockMinutes: 61 },
      { ...ok, pointsPerBlock: 0 },
      { ...ok, pointsPerBlock: 1001 },
      { ...ok, dailyCapPerChannel: 100_001 },
      { ...ok, pointsPerBlock: 1.5 },
    ])
      expect(PointsAccrualSetting.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("entities and router", () => {
  test("bot settings carry the bot account, nullable", () => {
    expect(BotSettings.parse({ enabled: false, config: BotConfig.parse({}), botUser: null }).botUser).toBeNull();
  });

  test("raid state and prediction view take the new fields", () => {
    expect(RaidState.safeParse({ raid: null, cooldownEndsAt: null, policy: "followed" }).success).toBe(true);
    expect(
      PredictionView.safeParse({
        id: "01a1897a-3d1f-709d-892a-7c3947173299",
        title: "t",
        outcomes: [],
        status: "locked",
        startedAt: "2026-10-29T00:00:00.000Z",
        locksAt: "2026-10-29T00:01:00.000Z",
        lockedAt: "2026-10-29T00:01:00.000Z",
        endedAt: null,
        winningOutcomeId: null,
        myBet: { outcomeId: "a", points: 10, payout: null },
      }).success,
    ).toBe(true);
  });

  test("song requests are a namespace with setStatus; raids gain current and setPolicy", () => {
    expect(contract.bot.songRequests.setStatus["~orpc"].route).toMatchObject({
      method: "PUT",
      path: "/channels/{channel}/bot/song-requests/{id}",
    });
    expect(contract.bot.songRequests.list["~orpc"].route.method).toBe("GET");
    expect(contract.interact.raids.current["~orpc"].route.path).toBe("/channels/{channel}/raids");
    expect(contract.interact.raids.setPolicy["~orpc"].meta).toMatchObject({ rateLimit: "write" });
  });

  test("points adjust takes a reason code, never free text", () => {
    const input = contract.bot.points.adjust["~orpc"].inputSchema;
    const base = { channel: "abc", username: "viewer", delta: 5 };
    expect(input?.["~standard"].validate({ ...base, reason: "reward" })).not.toHaveProperty("issues");
    expect(input?.["~standard"].validate({ ...base, reason: "because I said so" })).toHaveProperty("issues");
    expect(POINTS_ADJUST_REASONS).toContain("correction");
  });
});

describe("chat", () => {
  const raid = {
    op: "raid",
    channel: "source",
    raidId: "01a1897a-3d1f-709d-892a-7c3947173299",
    status: "pending",
    to: "target",
    toDisplayName: "Target",
    executeAt: "2026-10-29T00:00:30.000Z",
  };

  test("the raid frame is a server frame and a control frame", () => {
    expect(ServerFrame.safeParse(raid).success).toBe(true);
    expect(ChatControlMessage.safeParse(raid).success).toBe(true);
    expect(ServerFrame.safeParse({ ...raid, status: "exploded" }).success).toBe(false);
  });

  test("bot control messages name a reload scope", () => {
    const channelId = "01a1897a-3d1f-709d-892a-7c3947173299";
    expect(BotControlMessage.safeParse({ channelId, scope: "commands" }).success).toBe(true);
    expect(BotControlMessage.safeParse({ channelId, scope: "everything" }).success).toBe(false);
    expect(BUS.botControl).toBe("bus:bot-control");
  });
});

describe("events", () => {
  test("channel.points.change reasons are the ledger's", () => {
    const p = EVENTS["channel.points.change"].payload;
    const ok = { ...broadcaster, ...user, delta: -50, balance: 50, reason: "command" };
    expect(p.safeParse(ok).success).toBe(true);
    expect(p.safeParse({ ...ok, reason: "gift" }).success).toBe(false);
    expect(LOYALTY_REASONS).toContain("moderator_adjust");
  });

  test("poll payloads carry points voting and bought votes", () => {
    const p = EVENTS["channel.poll.begin"].payload;
    const base = {
      ...broadcaster,
      id: "p",
      title: "t",
      choices: [{ id: "a", title: "A", votes: 3, channel_points_votes: 1 }],
      started_at: "s",
      ends_at: "e",
    };
    expect(p.safeParse({ ...base, channel_points_voting: { is_enabled: true, amount_per_vote: 10 } }).success).toBe(
      true,
    );
    expect(p.safeParse(base).success).toBe(false);
  });

  test("prediction outcomes list at most ten top predictors", () => {
    const p = EVENTS["channel.prediction.lock"].payload;
    const predictor = { ...user, channel_points_used: 10, channel_points_won: null };
    const outcome = (n: number) => ({
      id: "a",
      title: "A",
      users: n,
      channel_points: 10 * n,
      top_predictors: Array.from({ length: n }, () => predictor),
    });
    const base = { ...broadcaster, id: "p", title: "t", started_at: "s", locked_at: "l" };
    expect(p.safeParse({ ...base, outcomes: [outcome(10)] }).success).toBe(true);
    expect(p.safeParse({ ...base, outcomes: [outcome(11)] }).success).toBe(false);
  });
});

describe("internal", () => {
  test("interactivity jobs, queue, hook route and bot keys", () => {
    expect(QUEUES.interact).toBe("interact");
    expect(INTERACT_JOB_NAMES).toEqual([INTERACT_JOBS.tick, INTERACT_JOBS.raidsExecute, INTERACT_JOBS.pointsAccrue]);
    expect(InteractTickBody.safeParse({ job: "points-accrue" }).success).toBe(true);
    expect(InteractTickBody.safeParse({ job: "membership-sync" }).success).toBe(false);
    expect(INTERNAL_ROUTES.interactTick).toBe("/internal/interact/tick");
    expect(KEYS.botCooldown("c", "hello")).toBe("bot:cooldown:c:hello");
    expect(RAID_RULES).toEqual({ countdownSeconds: 30, cooldownSeconds: 600 });
    expect(RAID_CANCEL_REASONS).toContain("target_refused");
  });
});
