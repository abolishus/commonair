// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 3, d4-chat: the pure parts. Chat-mode commands match what services/chat parses,
 * the chips read the `settings` frame, the composer gate names the first reason the server would
 * give (J3-d), the busy log, the raid alert's source, the points chip's visibility, and the
 * connection's `command` frame.
 */
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { describe, expect, it } from "vite-plus/test";
import { ChatConnection, type SocketLike } from "../src/chat/connection.ts";
import { chatEventView } from "../src/chat/events.ts";
import { GATE_REFUSALS, composerGate, isGateRefusal, needsAccountFacts } from "../src/chat/gate-reason.ts";
import { showPointsChip } from "../src/chat/interact/points-chip.tsx";
import type { LoyaltyBalanceDto } from "../src/chat/interact/state.ts";
import { BUSY_ROWS, BUSY_WINDOW_MS, isBusy } from "../src/chat/live-region.ts";
import { TIMEOUT_SECONDS, timeoutTestId } from "../src/chat/mod-menu.tsx";
import { incomingRaidOf } from "../src/chat/mod-tools/raid-alert.tsx";
import {
  CLEAR_COMMAND,
  DEFAULT_TIMEOUT_SECONDS,
  FOLLOWER_AGE_OPTIONS,
  SLOW_OPTIONS,
  TIMEOUT_OPTIONS,
  activeModes,
  deleteCommand,
  durationLabel,
  emoteOnlyCommand,
  followerAgeLabel,
  followersCommand,
  modeChipHint,
  modeChipLabel,
  slowCommand,
  subscribersCommand,
} from "../src/chat/modes.ts";
import { t } from "../src/i18n/index.ts";

const settings = (over: Partial<ChannelChatSettings> = {}) => ChannelChatSettings.parse(over);
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const DAY = 86_400_000;

describe("chat-mode commands (services/chat parseCommand)", () => {
  it("slow: seconds, and 0 turns it off", () => {
    expect(slowCommand(30)).toEqual({ command: "slow", args: ["30"] });
    expect(slowCommand(0)).toEqual({ command: "slowoff", args: [] });
  });

  it("followers: a follow age in minutes, null turns it off", () => {
    expect(followersCommand(0)).toEqual({ command: "followers", args: ["0m"] });
    expect(followersCommand(10)).toEqual({ command: "followers", args: ["10m"] });
    expect(followersCommand(null)).toEqual({ command: "followersoff", args: [] });
  });

  it("subscribers, emotes, clear and delete", () => {
    expect(subscribersCommand(true)).toEqual({ command: "subscribers", args: [] });
    expect(subscribersCommand(false)).toEqual({ command: "subscribersoff", args: [] });
    expect(emoteOnlyCommand(true)).toEqual({ command: "emoteonly", args: [] });
    expect(emoteOnlyCommand(false)).toEqual({ command: "emoteonlyoff", args: [] });
    expect(CLEAR_COMMAND).toEqual({ command: "clear", args: [] });
    const id = "0192f000-0000-7000-8000-000000000001";
    expect(deleteCommand(id)).toEqual({ command: "delete", args: [id] });
  });

  it("every command name is lower-case letters (the frame's regex)", () => {
    const all = [
      ...SLOW_OPTIONS.map(slowCommand),
      slowCommand(0),
      ...FOLLOWER_AGE_OPTIONS.map(followersCommand),
      followersCommand(null),
      subscribersCommand(true),
      emoteOnlyCommand(false),
      CLEAR_COMMAND,
    ];
    for (const c of all) expect(c.command).toMatch(/^[a-z]+$/);
  });

  it("the menus' lengths are the journey's (J5-b, J5-d) and within the server's bounds", () => {
    expect([...SLOW_OPTIONS]).toEqual([5, 30, 120]);
    expect([...TIMEOUT_OPTIONS]).toEqual([60, 600, 3600, 86_400]);
    for (const s of SLOW_OPTIONS) expect(s).toBeLessThanOrEqual(600);
    for (const m of FOLLOWER_AGE_OPTIONS) expect(m).toBeLessThanOrEqual(129_600);
    expect(TIMEOUT_SECONDS).toBe(DEFAULT_TIMEOUT_SECONDS);
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(600);
  });

  it("timeout test ids: the default keeps chat-mod-timeout, the others carry their seconds", () => {
    expect(timeoutTestId(600)).toBe("chat-mod-timeout");
    expect(TIMEOUT_OPTIONS.map(timeoutTestId)).toEqual([
      "chat-mod-timeout-60",
      "chat-mod-timeout",
      "chat-mod-timeout-3600",
      "chat-mod-timeout-86400",
    ]);
  });
});

describe("durations", () => {
  it("seconds, minutes and whole hours", () => {
    expect(durationLabel(5)).toBe("5 seconds");
    expect(durationLabel(1)).toBe("1 second");
    expect(durationLabel(60)).toBe("1 minute");
    expect(durationLabel(120)).toBe("2 minutes");
    expect(durationLabel(5400)).toBe("90 minutes");
    expect(durationLabel(3600)).toBe("1 hour");
    expect(durationLabel(86_400)).toBe("24 hours");
  });

  it("a follow age of 0 is any follower", () => {
    expect(followerAgeLabel(0)).toBe(t("d4Chat.modes.followersAny"));
    expect(followerAgeLabel(10)).toBe("10 minutes");
    expect(followerAgeLabel(1440)).toBe("24 hours");
  });
});

describe("activeModes and chips", () => {
  it("none before the join or with every mode off", () => {
    expect(activeModes(null)).toEqual([]);
    expect(activeModes(settings())).toEqual([]);
  });

  it("every mode that is on, in a fixed order", () => {
    const chips = activeModes(
      settings({ emoteOnly: true, subscribersOnly: true, followersOnlyMinutes: 10, slowModeSeconds: 30 }),
    );
    expect(chips).toEqual([
      { kind: "slow", seconds: 30 },
      { kind: "followers", minutes: 10 },
      { kind: "subs" },
      { kind: "emote" },
    ]);
    expect(chips.map(modeChipLabel)).toEqual([
      "Slow mode · 30 seconds",
      "Followers only · 10 minutes",
      "Subscribers only",
      "Emotes only",
    ]);
  });

  it("followers-only with no age is a plain chip; hints name the channel", () => {
    const [chip] = activeModes(settings({ followersOnlyMinutes: 0 }));
    expect(chip).toEqual({ kind: "followers", minutes: 0 });
    if (!chip) throw new Error("no chip");
    expect(modeChipLabel(chip)).toBe("Followers only");
    expect(modeChipHint(chip, "Indigo")).toBe("Only people who follow Indigo can chat.");
    expect(modeChipHint({ kind: "followers", minutes: 60 }, "Indigo")).toBe(
      "Only people who've followed Indigo for at least 1 hour can chat.",
    );
    expect(modeChipHint({ kind: "slow", seconds: 5 }, "Indigo")).toBe("One message every 5 seconds per person.");
    expect(modeChipHint({ kind: "subs" }, "Indigo")).toBe("Only people who subscribe to Indigo can chat.");
    expect(modeChipHint({ kind: "emote" }, "Indigo")).toBe(t("d4Chat.hint.emote"));
  });
});

describe("composerGate (J3-d)", () => {
  const base = { refused: null, privileged: false, now: NOW };

  it("nothing before the join, and nothing for moderators and the broadcaster", () => {
    expect(composerGate({ ...base, settings: null, facts: {} })).toBeNull();
    expect(
      composerGate({
        ...base,
        privileged: true,
        settings: settings({ followersOnlyMinutes: 0 }),
        facts: { emailVerified: false, following: false },
      }),
    ).toBeNull();
  });

  it("an unverified email first, from the facts or the refusal", () => {
    const s = settings({ requireVerifiedEmail: true, followersOnlyMinutes: 0 });
    expect(composerGate({ ...base, settings: s, facts: { emailVerified: false, following: false } })).toEqual({
      kind: "verifiedEmail",
    });
    expect(composerGate({ ...base, settings: s, facts: {}, refused: "msg_verified_email" })).toEqual({
      kind: "verifiedEmail",
    });
    // The channel does not ask for it: no reason.
    expect(
      composerGate({ ...base, settings: settings({ requireVerifiedEmail: false }), facts: { emailVerified: false } }),
    ).toBeNull();
  });

  it("an account that is too new, with when it opens; unknown age only after a refusal", () => {
    const s = settings({ minAccountAgeDays: 7 });
    const created = new Date(NOW - 2 * DAY).toISOString();
    expect(composerGate({ ...base, settings: s, facts: { emailVerified: true, accountCreatedAt: created } })).toEqual({
      kind: "accountAge",
      days: 7,
      opensAt: new Date(NOW + 5 * DAY).toISOString(),
    });
    const old = new Date(NOW - 30 * DAY).toISOString();
    expect(composerGate({ ...base, settings: s, facts: { accountCreatedAt: old } })).toBeNull();
    expect(composerGate({ ...base, settings: s, facts: {} })).toBeNull();
    expect(composerGate({ ...base, settings: s, facts: {}, refused: "msg_account_too_new" })).toEqual({
      kind: "accountAge",
      days: 7,
      opensAt: null,
    });
    // The boundary: exactly old enough chats.
    const exact = new Date(NOW - 7 * DAY).toISOString();
    expect(composerGate({ ...base, settings: s, facts: { accountCreatedAt: exact } })).toBeNull();
  });

  it("followers-only when the page knows they do not follow, or after the refusal", () => {
    const s = settings({ followersOnlyMinutes: 10 });
    expect(composerGate({ ...base, settings: s, facts: { following: false } })).toEqual({
      kind: "followers",
      minutes: 10,
    });
    expect(composerGate({ ...base, settings: s, facts: { following: null } })).toBeNull();
    expect(composerGate({ ...base, settings: s, facts: { following: true } })).toBeNull();
    // Followed, but not for 10 minutes yet: the refusal stands until the next join.
    expect(composerGate({ ...base, settings: s, facts: { following: true }, refused: "msg_followersonly" })).toEqual({
      kind: "followers",
      minutes: 10,
    });
    // Any follower: following now clears the refusal.
    const any = settings({ followersOnlyMinutes: 0 });
    expect(composerGate({ ...base, settings: any, facts: { following: true }, refused: "msg_followersonly" })).toBe(
      null,
    );
    expect(composerGate({ ...base, settings: settings(), facts: { following: false } })).toBeNull();
  });

  it("subscribers-only only after the refusal (the page cannot know a sub)", () => {
    const s = settings({ subscribersOnly: true });
    expect(composerGate({ ...base, settings: s, facts: {} })).toBeNull();
    expect(composerGate({ ...base, settings: s, facts: {}, refused: "msg_subsonly" })).toEqual({ kind: "subs" });
    expect(composerGate({ ...base, settings: settings(), facts: {}, refused: "msg_subsonly" })).toBeNull();
  });

  it("the server's order: email before age before followers before subs", () => {
    const s = settings({ minAccountAgeDays: 7, followersOnlyMinutes: 0, subscribersOnly: true });
    const young = new Date(NOW - DAY).toISOString();
    expect(
      composerGate({ ...base, settings: s, facts: { emailVerified: false, accountCreatedAt: young, following: false } })
        ?.kind,
    ).toBe("verifiedEmail");
    expect(
      composerGate({ ...base, settings: s, facts: { emailVerified: true, accountCreatedAt: young, following: false } })
        ?.kind,
    ).toBe("accountAge");
    expect(composerGate({ ...base, settings: s, facts: { emailVerified: true, following: false } })?.kind).toBe(
      "followers",
    );
  });

  it("refusal codes, and when the account facts are worth a request", () => {
    expect(GATE_REFUSALS.every(isGateRefusal)).toBe(true);
    expect(isGateRefusal("msg_slowmode")).toBe(false);
    expect(isGateRefusal("msg_verified_watch")).toBe(false);
    expect(needsAccountFacts(null, false)).toBe(false);
    expect(needsAccountFacts(settings({ requireVerifiedEmail: true }), false)).toBe(true);
    expect(needsAccountFacts(settings({ requireVerifiedEmail: true }), true)).toBe(false);
    expect(needsAccountFacts(settings({ requireVerifiedEmail: false, minAccountAgeDays: 0 }), false)).toBe(false);
    expect(needsAccountFacts(settings({ requireVerifiedEmail: false, minAccountAgeDays: 3 }), false)).toBe(true);
  });
});

describe("isBusy (the log stops announcing under load)", () => {
  it("over BUSY_ROWS rows inside the window", () => {
    const times = Array.from({ length: BUSY_ROWS }, (_, i) => NOW - i * 100);
    expect(isBusy(times, NOW)).toBe(false);
    expect(isBusy([...times, NOW], NOW)).toBe(true);
    expect(isBusy([], NOW)).toBe(false);
  });

  it("rows older than the window do not count", () => {
    const old = Array.from({ length: BUSY_ROWS + 5 }, () => NOW - BUSY_WINDOW_MS);
    expect(isBusy(old, NOW)).toBe(false);
  });
});

describe("incomingRaidOf", () => {
  it("a channel.raid event names the raider and the verified viewers", () => {
    const view = chatEventView("channel.raid", {
      from_broadcaster_user_id: "0192f000-0000-7000-8000-000000000010",
      from_broadcaster_user_login: "brass",
      from_broadcaster_user_name: "Brass Comet",
      to_broadcaster_user_id: "0192f000-0000-7000-8000-000000000011",
      to_broadcaster_user_login: "indigo",
      to_broadcaster_user_name: "Indigo",
      viewers: 40,
    });
    if (!view) throw new Error("no view");
    expect(incomingRaidOf("event-1", view)).toEqual({
      id: "event-1",
      login: "brass",
      name: "Brass Comet",
      viewers: 40,
    });
  });

  it("anything else is not a raid", () => {
    const tip = chatEventView("channel.subscribe", {
      user_id: "0192f000-0000-7000-8000-000000000012",
      user_login: "fan",
      user_name: "Fan",
      broadcaster_user_id: "0192f000-0000-7000-8000-000000000011",
      broadcaster_user_login: "indigo",
      broadcaster_user_name: "Indigo",
      tier: "1000",
      is_gift: false,
    });
    if (!tip) throw new Error("no view");
    expect(incomingRaidOf("event-2", tip)).toBeNull();
  });
});

describe("showPointsChip (scope-calls decision 4)", () => {
  const balance = (over: Partial<LoyaltyBalanceDto> = {}): LoyaltyBalanceDto => ({
    channelSlug: "indigo",
    user: { id: "0192f000-0000-7000-8000-000000000050", username: "fan" },
    points: 120,
    pointsName: "points",
    enabled: true,
    accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 },
    ...over,
  });
  const viewer = { own: false, spendable: false };

  it("shown with a balance on someone else's channel", () => {
    expect(showPointsChip(balance(), viewer)).toBe(true);
  });

  it("hidden with no balance, points off, a daily cap of 0, or on your own channel", () => {
    expect(showPointsChip(null, viewer)).toBe(false);
    expect(showPointsChip(balance({ enabled: false }), viewer)).toBe(false);
    expect(
      showPointsChip(balance({ accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 0 } }), viewer),
    ).toBe(false);
    expect(showPointsChip(balance(), { own: true, spendable: true })).toBe(false);
  });

  it("at zero only when there is something to spend them on", () => {
    expect(showPointsChip(balance({ points: 0 }), viewer)).toBe(false);
    expect(showPointsChip(balance({ points: 0 }), { own: false, spendable: true })).toBe(true);
  });
});

describe("ChatConnection.command", () => {
  class Socket implements SocketLike {
    readyState = 1;
    sent: unknown[] = [];
    private fns = new Map<string, ((ev: { data?: unknown }) => void)[]>();
    send(data: string): void {
      this.sent.push(JSON.parse(data));
    }
    close(): void {}
    addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void {
      this.fns.set(type, [...(this.fns.get(type) ?? []), fn]);
    }
    push(frame: unknown): void {
      for (const fn of this.fns.get("message") ?? []) fn({ data: JSON.stringify(frame) });
    }
  }

  it("refuses before the join, then sends a command frame with a nonce", async () => {
    const socket = new Socket();
    const conn = new ChatConnection(
      "indigo",
      {
        getToken: async () => ({ token: "t", url: "ws://chat.test/ws" }),
        createSocket: () => socket,
        setTimer: () => null,
        clearTimer: () => {},
      },
      {
        onStatus: () => {},
        onJoined: () => {},
        onMessage: () => {},
        onDelete: () => {},
        onClear: () => {},
        onNotice: () => {},
      },
    );
    expect(conn.command("slow", ["30"])).toBe(false);
    conn.start();
    await Promise.resolve();
    await Promise.resolve();
    socket.push({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 });
    socket.push({
      op: "joined",
      channel: "indigo",
      channelId: "0192f000-0000-7000-8000-000000000011",
      settings: {},
      me: { badges: [], canModerate: true, canChat: true },
      surge: { state: "off", until: null },
    });
    expect(conn.command("slow", ["30"])).toBe(true);
    expect(conn.command("clear")).toBe(true);
    expect(socket.sent.slice(-2)).toEqual([
      { op: "command", channel: "indigo", command: "slow", args: ["30"], nonce: expect.stringMatching(/^c\d+$/) },
      { op: "command", channel: "indigo", command: "clear", args: [], nonce: expect.stringMatching(/^c\d+$/) },
    ]);
    conn.stop();
    expect(conn.command("clear")).toBe(false);
  });
});
