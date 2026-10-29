// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E8-studio pure logic: form bounds and payloads, payouts, raid refusal codes, roles, bot forms. */
import { describe, expect, it } from "vite-plus/test";
import type { BotConfig } from "@commonair/contracts/shapes";
import { en } from "../src/i18n/en.ts";
import { t } from "../src/i18n/index.ts";
import {
  adjustError,
  adjustInput,
  botAbilities,
  botSettingsDraft,
  botSettingsInput,
  commandDraft,
  commandInput,
  commandName,
  commandSaveError,
  createdBotAccount,
  emptyCommandDraft,
  orderedSongRequests,
  parseAliases,
  songLink,
  timerInput,
  timerSaveError,
  variableInput,
  variableSaveError,
  type BotCommandDto,
  type BotSettingsDto,
  type SongRequestDto,
} from "../src/lib/bot-studio.ts";
import {
  RAID_ERROR_CODES,
  canArchivePoll,
  canStartPoll,
  canStartPrediction,
  channelSearch,
  goalInput,
  goalPercent,
  interactAbilities,
  orderedGoals,
  parseBoundedInt,
  percentOf,
  pollInput,
  predictionInput,
  predictionPayouts,
  raidCooldownUntil,
  raidErrorCode,
  raidErrorMessage,
  raidTarget,
  studioRole,
  type GoalDto,
  type PollDto,
  type PredictionDto,
} from "../src/lib/interact-studio.ts";

const CH = "streamer";
const err = (code: string, data?: Record<string, unknown>) => Object.assign(new Error(code), { code, data });

describe("parseBoundedInt", () => {
  it("accepts whole numbers inside the bounds only", () => {
    expect(parseBoundedInt("15", 15, 1800)).toBe(15);
    expect(parseBoundedInt(" 1800 ", 15, 1800)).toBe(1800);
    expect(parseBoundedInt("14", 15, 1800)).toBeNull();
    expect(parseBoundedInt("1801", 15, 1800)).toBeNull();
    expect(parseBoundedInt("2.5", 0, 10)).toBeNull();
    expect(parseBoundedInt("", 0, 10)).toBeNull();
    expect(parseBoundedInt("1e3", 0, 10_000)).toBeNull();
    expect(parseBoundedInt("-5", -10, 10)).toBe(-5);
    expect(parseBoundedInt("99999999999999999999", 0, Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe("poll form", () => {
  const draft = { title: "Best map?", choices: ["Dust", "Mirage", "", "Inferno"], duration: "20", extraCost: "0" };

  it("sends trimmed choices without the empty ones", () => {
    expect(pollInput(CH, draft)).toEqual({
      ok: true,
      input: {
        channel: CH,
        title: "Best map?",
        choices: ["Dust", "Mirage", "Inferno"],
        durationSeconds: 20,
        pointsPerExtraVote: 0,
      },
    });
  });

  it("checks the title (1-60), 2-5 choices of up to 25, 15-1800 s and the extra cost", () => {
    const bad = pollInput(CH, { title: "x".repeat(61), choices: ["Only"], duration: "14", extraCost: "-1" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(Object.keys(bad.errors).sort()).toEqual(["choices", "duration", "extraCost", "title"]);
    expect(pollInput(CH, { ...draft, title: "x".repeat(60) }).ok).toBe(true);
    expect(pollInput(CH, { ...draft, title: "   " }).ok).toBe(false);
    expect(pollInput(CH, { ...draft, choices: ["a", "b", "c", "d", "e", "f"] }).ok).toBe(false);
    expect(pollInput(CH, { ...draft, choices: ["a", "b", "c", "d", "e"] }).ok).toBe(true);
    expect(pollInput(CH, { ...draft, choices: ["a", "b".repeat(26)] }).ok).toBe(false);
    expect(pollInput(CH, { ...draft, duration: "15" }).ok).toBe(true);
    expect(pollInput(CH, { ...draft, duration: "1800" }).ok).toBe(true);
    expect(pollInput(CH, { ...draft, duration: "1801" }).ok).toBe(false);
    expect(pollInput(CH, { ...draft, extraCost: "25" })).toMatchObject({ ok: true, input: { pointsPerExtraVote: 25 } });
  });

  const poll = (status: PollDto["status"]): PollDto => ({
    id: "p1",
    title: "Q",
    choices: [],
    status,
    startedAt: "2026-10-29T10:00:00.000Z",
    endsAt: "2026-10-29T10:01:00.000Z",
    endedAt: null,
    pointsPerExtraVote: 0,
    myVote: null,
    myVotes: 0,
  });

  it("starts only while no poll runs and archives only ended polls", () => {
    expect(canStartPoll(null)).toBe(true);
    expect(canStartPoll(poll("active"))).toBe(false);
    expect(canStartPoll(poll("completed"))).toBe(true);
    expect(canArchivePoll(poll("active"))).toBe(false);
    expect(canArchivePoll(poll("completed"))).toBe(true);
    expect(canArchivePoll(poll("terminated"))).toBe(true);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(0, 0)).toBe(0);
  });
});

describe("prediction form and payouts", () => {
  it("checks the title (1-45), 2-10 outcomes and a 30-1800 s window", () => {
    const ok = predictionInput(CH, { title: "Who wins?", outcomes: ["A", " B ", ""], window: "30" });
    expect(ok).toEqual({
      ok: true,
      input: { channel: CH, title: "Who wins?", outcomes: ["A", "B"], windowSeconds: 30 },
    });
    expect(predictionInput(CH, { title: "x".repeat(46), outcomes: ["A", "B"], window: "30" }).ok).toBe(false);
    expect(predictionInput(CH, { title: "Q", outcomes: ["A"], window: "30" }).ok).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => `o${i}`);
    expect(predictionInput(CH, { title: "Q", outcomes: eleven, window: "30" }).ok).toBe(false);
    expect(predictionInput(CH, { title: "Q", outcomes: eleven.slice(0, 10), window: "30" }).ok).toBe(true);
    expect(predictionInput(CH, { title: "Q", outcomes: ["A", "B"], window: "29" }).ok).toBe(false);
    expect(predictionInput(CH, { title: "Q", outcomes: ["A", "B"], window: "1801" }).ok).toBe(false);
  });

  const base: PredictionDto = {
    id: "pr1",
    title: "Q",
    outcomes: [
      { id: "a", title: "A", points: 400, users: 2 },
      { id: "b", title: "B", points: 200, users: 1 },
      { id: "c", title: "C", points: 0, users: 0 },
    ],
    status: "active",
    startedAt: "2026-10-29T10:00:00.000Z",
    locksAt: "2026-10-29T10:01:00.000Z",
    lockedAt: null,
    endedAt: null,
    winningOutcomeId: null,
    myBet: null,
  };

  it("pays the whole pool to the winners", () => {
    expect(predictionPayouts(base)).toBeNull();
    expect(predictionPayouts({ ...base, status: "locked" })).toBeNull();
    expect(predictionPayouts({ ...base, status: "resolved", winningOutcomeId: "a" })).toEqual([
      { id: "a", result: "won", paid: 600 },
      { id: "b", result: "lost", paid: 0 },
      { id: "c", result: "lost", paid: 0 },
    ]);
  });

  it("refunds every bet on a cancel or a winner nobody bet on", () => {
    const refunds = [
      { id: "a", result: "refunded", paid: 400 },
      { id: "b", result: "refunded", paid: 200 },
      { id: "c", result: "refunded", paid: 0 },
    ];
    expect(predictionPayouts({ ...base, status: "canceled" })).toEqual(refunds);
    expect(predictionPayouts({ ...base, status: "resolved", winningOutcomeId: "c" })).toEqual(refunds);
    expect(canStartPrediction({ ...base, status: "locked" })).toBe(false);
    expect(canStartPrediction({ ...base, status: "resolved" })).toBe(true);
  });
});

describe("raids", () => {
  it("maps every precondition code, the pending CONFLICT and the rest to a data-code", () => {
    for (const requirement of [
      "raid_source_offline",
      "raid_target_offline",
      "raid_suspended",
      "raid_refused",
      "raid_cooldown",
    ])
      expect(raidErrorCode(err("PRECONDITION_FAILED", { requirement }))).toBe(requirement);
    expect(raidErrorCode(err("CONFLICT"))).toBe("raid_pending");
    expect(raidErrorCode(err("NOT_FOUND"))).toBe("raid_not_found");
    expect(raidErrorCode(err("BAD_REQUEST"))).toBe("raid_invalid");
    expect(raidErrorCode(err("PRECONDITION_FAILED", { requirement: "something_new" }))).toBe("raid_failed");
    expect(raidErrorCode(new Error("network"))).toBe("raid_failed");
  });

  it("has a translated message per code", () => {
    const messages = RAID_ERROR_CODES.map(raidErrorMessage);
    expect(new Set(messages).size).toBe(RAID_ERROR_CODES.length);
    expect(raidErrorMessage("raid_refused")).toBe(en["interact.raid.error.refused"]);
  });

  it("reads the target as a slug", () => {
    expect(raidTarget(" @Other_Chan ")).toBe("other_chan");
    expect(raidTarget("ab")).toBeNull();
    expect(raidTarget("has space")).toBeNull();
  });

  it("shows the cooldown only while it runs", () => {
    const state = { raid: null, policy: "anyone" as const, cooldownEndsAt: "2026-10-29T10:10:00.000Z" };
    expect(raidCooldownUntil(state, Date.parse("2026-10-29T10:05:00.000Z"))).toBe(state.cooldownEndsAt);
    expect(raidCooldownUntil(state, Date.parse("2026-10-29T10:10:00.000Z"))).toBeNull();
    expect(raidCooldownUntil({ ...state, cooldownEndsAt: null }, 0)).toBeNull();
  });
});

describe("goals", () => {
  it("sends a tips target in minor units of the instance currency", () => {
    expect(goalInput(CH, { type: "tips", title: " Mic ", target: "12.50" }, "usd", "en-US")).toEqual({
      ok: true,
      input: { channel: CH, type: "tips", title: "Mic", target: 1250 },
    });
    expect(goalInput(CH, { type: "tips", title: "Mic", target: "1.234,5" }, "eur", "de-DE")).toMatchObject({
      input: { target: 123450 },
    });
    expect(goalInput(CH, { type: "tips", title: "Mic", target: "500" }, "jpy", "ja-JP")).toMatchObject({
      input: { target: 500 },
    });
    expect(goalInput(CH, { type: "tips", title: "Mic", target: "1.005" }, "usd", "en-US").ok).toBe(false);
    expect(goalInput(CH, { type: "tips", title: "Mic", target: "0" }, "usd", "en-US").ok).toBe(false);
  });

  it("sends follower and subscription targets as counts, and checks the title", () => {
    expect(goalInput(CH, { type: "followers", title: "Two", target: "2" }, "usd", "en-US")).toMatchObject({
      input: { type: "followers", target: 2 },
    });
    expect(goalInput(CH, { type: "subscriptions", title: "S", target: "2.5" }, "usd", "en-US").ok).toBe(false);
    expect(goalInput(CH, { type: "followers", title: "x".repeat(61), target: "2" }, "usd", "en-US").ok).toBe(false);
    expect(goalInput(CH, { type: "followers", title: "x".repeat(60), target: "2" }, "usd", "en-US").ok).toBe(true);
  });

  it("caps progress at 100 % and lists open goals first", () => {
    const g = (
      id: string,
      current: number,
      endedAt: string | null,
      startedAt = "2026-10-29T10:00:00.000Z",
    ): GoalDto => ({
      id,
      type: "followers",
      title: id,
      target: 4,
      current,
      startedAt,
      endedAt,
    });
    expect(goalPercent(g("a", 1, null))).toBe(25);
    expect(goalPercent(g("a", 9, null))).toBe(100);
    const ordered = orderedGoals([
      g("ended", 4, "2026-10-29T11:00:00.000Z"),
      g("old", 0, null, "2026-10-29T09:00:00.000Z"),
      g("new", 0, null, "2026-10-29T12:00:00.000Z"),
    ]);
    expect(ordered.map((x) => x.id)).toEqual(["new", "old", "ended"]);
  });
});

describe("roles", () => {
  const me = { id: "u1", username: "ann", channelSlug: "ann" };

  it("owner on one's own channel, editor counts as owner, moderator as moderator", () => {
    expect(studioRole(me, "ann", null)).toBe("owner");
    expect(studioRole(me, "bob", [{ user: { id: "u1" }, role: "editor" }])).toBe("owner");
    expect(studioRole(me, "bob", [{ user: { id: "u1" }, role: "moderator" }])).toBe("moderator");
    expect(studioRole(me, "bob", [{ user: { id: "u1" }, role: "vip" }])).toBeNull();
    expect(studioRole(me, "bob", [{ user: { id: "u2" }, role: "editor" }])).toBeNull();
  });

  it("keeps raids, goal changes and bot settings for owners and editors", () => {
    expect(interactAbilities("owner")).toEqual({ raids: true, manageGoals: true });
    expect(interactAbilities("moderator")).toEqual({ raids: false, manageGoals: false });
    expect(botAbilities("owner").settings).toBe(true);
    expect(botAbilities("moderator").settings).toBe(false);
  });

  it("reads ?channel= as a slug only", () => {
    expect(channelSearch({ channel: "Bob_1" })).toEqual({ channel: "bob_1" });
    expect(channelSearch({ channel: "x" })).toEqual({});
    expect(channelSearch({ channel: 5 })).toEqual({});
    expect(channelSearch({})).toEqual({});
  });
});

// ── /bot ──────────────────────────────────────────────────────────────────────────────────────

const config: BotConfig = {
  displayName: "ChannelBot",
  filters: {
    spam: { enabled: true, maxRepeatedChars: 9 },
    links: { enabled: false, allowSubscribers: true, allowlist: ["example.org"] },
    caps: { enabled: false, minLength: 20, maxRatio: 0.5 },
    timeoutSeconds: 10,
  },
  loyalty: { enabled: true, pointsName: "points" },
  songRequests: { enabled: false, maxQueue: 25 },
};
const settings: BotSettingsDto = { enabled: false, config, botUser: null };

describe("bot settings", () => {
  it("round-trips the draft and keeps the knobs the page does not show", () => {
    const draft = { ...botSettingsDraft(settings), enabled: true, links: true, srEnabled: true, srMax: "50" };
    const checked = botSettingsInput(CH, draft, config);
    expect(checked).toEqual({
      ok: true,
      input: {
        channel: CH,
        enabled: true,
        config: {
          ...config,
          filters: { ...config.filters, links: { ...config.filters.links, enabled: true } },
          songRequests: { enabled: true, maxQueue: 50 },
        },
      },
    });
  });

  it("checks the display name, points name, timeout and queue size", () => {
    const draft = botSettingsDraft(settings);
    const bad = botSettingsInput(
      CH,
      { ...draft, displayName: "", pointsName: "x".repeat(21), timeout: "-1", srMax: "201" },
      config,
    );
    expect(bad.ok ? [] : Object.keys(bad.errors).sort()).toEqual(["displayName", "pointsName", "srMax", "timeout"]);
    expect(botSettingsInput(CH, { ...draft, displayName: "x".repeat(25), srMax: "1" }, config).ok).toBe(true);
    expect(botSettingsInput(CH, { ...draft, srMax: "0" }, config).ok).toBe(false);
  });

  it("names the account the first enable created, once", () => {
    const after = { ...settings, enabled: true, botUser: { id: "b1", username: "annbot" } };
    expect(createdBotAccount(settings, after)).toBe("annbot");
    expect(createdBotAccount(after, after)).toBeNull();
  });
});

describe("commands", () => {
  const draft = {
    ...emptyCommandDraft(),
    name: "!Hello",
    aliases: "hi, !HEY, hi, ",
    response: " Hi ${user}! ",
    cooldown: "30",
  };

  it("sends the name and aliases without ! in lower case, de-duplicated", () => {
    expect(commandInput(CH, draft)).toEqual({
      ok: true,
      input: {
        channel: CH,
        name: "hello",
        aliases: ["hi", "hey"],
        response: "Hi ${user}!",
        userLevel: "everyone",
        cooldownSeconds: 30,
        costPoints: 0,
        enabled: true,
      },
    });
    expect(commandName("  !!sr ")).toBe("sr");
    expect(parseAliases("a,,b , a")).toEqual(["a", "b"]);
  });

  it("refuses built-ins, bad names, too many aliases and out-of-range numbers", () => {
    const fails = (over: Partial<typeof draft>) => {
      const r = commandInput(CH, { ...draft, ...over });
      return r.ok ? [] : Object.keys(r.errors);
    };
    expect(fails({ name: "points" })).toEqual(["name"]);
    expect(fails({ name: "with space" })).toEqual(["name"]);
    expect(fails({ name: "x".repeat(26) })).toEqual(["name"]);
    expect(fails({ aliases: "sr" })).toEqual(["aliases"]);
    expect(fails({ aliases: "a,b,c,d,e,f" })).toEqual(["aliases"]);
    expect(fails({ aliases: "a,b,c,d,e" })).toEqual([]);
    expect(fails({ aliases: "bad-alias" })).toEqual(["aliases"]);
    expect(fails({ response: "x".repeat(501) })).toEqual(["response"]);
    expect(fails({ response: "x".repeat(500) })).toEqual([]);
    expect(fails({ cooldown: "3601" })).toEqual(["cooldown"]);
    expect(fails({ cost: "-1" })).toEqual(["cost"]);
    expect(fails({ cost: "1000000" })).toEqual([]);
  });

  it("edits from an existing command", () => {
    const c: BotCommandDto = {
      id: "c1",
      name: "hug",
      aliases: ["cuddle"],
      response: "${user} hugs ${touser}",
      userLevel: "follower",
      cooldownSeconds: 0,
      costPoints: 50,
      enabled: false,
      useCount: 3,
    };
    expect(commandInput(CH, commandDraft(c))).toMatchObject({
      input: { name: "hug", aliases: ["cuddle"], userLevel: "follower", costPoints: 50, enabled: false },
    });
  });

  it("pluralizes point counts in the studio strings", () => {
    expect(t("bot.points.adjusted", { username: "ann", points: 1 })).toBe("ann now has 1 point.");
    expect(t("bot.points.adjusted", { username: "ann", points: 1200 })).toBe("ann now has 1,200 points.");
    expect(t("interact.prediction.payout.refunded", { points: 1 })).toBe("Refunded 1 point");
  });

  it("refuses a new command whose name is already taken, so a save never overwrites it", () => {
    const r = commandInput(CH, { ...draft, name: "!Hello" }, ["hello", "bye"]);
    expect(r).toEqual({ ok: false, errors: { name: en["bot.command.error.exists"].replace("{name}", "hello") } });
    expect(commandInput(CH, draft, ["bye"]).ok).toBe(true);
    // Editing passes no taken names: saving the same name updates it.
    expect(commandInput(CH, draft).ok).toBe(true);
  });

  it("maps refused saves to messages", () => {
    expect(commandSaveError(err("CONFLICT"))).toBe(en["bot.command.error.conflict"]);
    expect(commandSaveError(err("PRECONDITION_FAILED", { requirement: "bot_command_limit" }))).toBe(
      en["bot.command.error.limit"],
    );
    expect(commandSaveError(err("BAD_REQUEST"))).toBe(en["bot.command.error.invalid"]);
    expect(commandSaveError(err("FORBIDDEN"))).toBe(en["bot.error.forbidden"]);
    expect(commandSaveError(new Error("x"))).toBe(en["bot.command.error.failed"]);
  });
});

describe("timers and variables", () => {
  it("checks a timer's bounds; minChatLines is at least 1", () => {
    const d = { name: "Follow", message: "Follow!", interval: "1", minLines: "3", enabled: true };
    expect(timerInput(CH, d)).toEqual({
      ok: true,
      input: { channel: CH, name: "Follow", message: "Follow!", intervalMinutes: 1, minChatLines: 3, enabled: true },
    });
    expect(timerInput(CH, { ...d, id: "t1" })).toMatchObject({ input: { id: "t1" } });
    const fails = (over: Partial<typeof d>) => {
      const r = timerInput(CH, { ...d, ...over });
      return r.ok ? [] : Object.keys(r.errors);
    };
    expect(fails({ minLines: "0" })).toEqual(["minLines"]);
    expect(fails({ minLines: "1000" })).toEqual([]);
    expect(fails({ interval: "0" })).toEqual(["interval"]);
    expect(fails({ interval: "1441" })).toEqual(["interval"]);
    expect(fails({ name: "x".repeat(51) })).toEqual(["name"]);
    expect(fails({ message: "" })).toEqual(["message"]);
    expect(timerSaveError(err("PRECONDITION_FAILED", { requirement: "bot_timer_limit" }))).toBe(
      en["bot.timer.error.limit"],
    );
  });

  it("checks a variable's name and value", () => {
    expect(variableInput(CH, { name: " Schedule ", value: "Mon 8pm" })).toEqual({
      ok: true,
      input: { channel: CH, name: "schedule", value: "Mon 8pm" },
    });
    expect(variableInput(CH, { name: "x".repeat(31), value: "" }).ok).toBe(false);
    expect(variableInput(CH, { name: "ok", value: "x".repeat(501) }).ok).toBe(false);
    expect(variableSaveError(err("PRECONDITION_FAILED", { requirement: "bot_variable_limit" }))).toBe(
      en["bot.variable.error.limit"],
    );
  });
});

describe("song requests", () => {
  it("links only http(s) URLs and never anything else", () => {
    expect(songLink("https://example.org/song")).toBe("https://example.org/song");
    expect(songLink("http://example.org/a b")).toBe("http://example.org/a%20b");
    expect(songLink("javascript:alert(1)")).toBeNull();
    expect(songLink("not-a-link")).toBeNull();
    expect(songLink("data:text/html,x")).toBeNull();
  });

  it("puts the queue first, oldest first", () => {
    const r = (id: string, status: SongRequestDto["status"], createdAt: string): SongRequestDto => ({
      id,
      url: "https://example.org",
      requester: "ann",
      status,
      createdAt,
    });
    const ordered = orderedSongRequests([
      r("played-old", "played", "2026-10-29T09:00:00.000Z"),
      r("q2", "queued", "2026-10-29T11:00:00.000Z"),
      r("q1", "queued", "2026-10-29T10:00:00.000Z"),
      r("skipped-new", "skipped", "2026-10-29T12:00:00.000Z"),
    ]);
    expect(ordered.map((x) => x.id)).toEqual(["q1", "q2", "skipped-new", "played-old"]);
  });
});

describe("points adjust", () => {
  it("sends a signed whole delta and a reason code", () => {
    expect(adjustInput(CH, { username: "@Ann", delta: "-50", reason: "penalty" })).toEqual({
      ok: true,
      input: { channel: CH, username: "ann", delta: -50, reason: "penalty" },
    });
    const fails = (over: Partial<{ username: string; delta: string }>) => {
      const r = adjustInput(CH, { username: "ann", delta: "10", reason: "reward", ...over });
      return r.ok ? [] : Object.keys(r.errors);
    };
    expect(fails({ delta: "0" })).toEqual(["delta"]);
    expect(fails({ delta: "1000001" })).toEqual(["delta"]);
    expect(fails({ delta: "-1000000" })).toEqual([]);
    expect(fails({ delta: "1.5" })).toEqual(["delta"]);
    expect(fails({ username: "a" })).toEqual(["username"]);
  });

  it("shows insufficient_points and the other refusals inline", () => {
    expect(adjustError(err("PRECONDITION_FAILED", { requirement: "insufficient_points" }))).toBe(
      en["bot.points.error.insufficient"],
    );
    expect(adjustError(err("NOT_FOUND"))).toBe(en["bot.points.error.notFound"]);
    expect(adjustError(err("BAD_REQUEST"))).toBe(en["bot.points.error.invalid"]);
    expect(adjustError(new Error("x"))).toBe(en["bot.points.error.failed"]);
  });
});
