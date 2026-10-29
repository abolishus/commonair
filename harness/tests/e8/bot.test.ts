// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `channel-bot` steps' pure helpers (the steps themselves run against the stack). */
import { describe, expect, test } from "vite-plus/test";
import type { ServerFrame } from "@commonair/contracts";
import { BotConfig } from "@commonair/contracts/shapes";
import {
  harnessBotConfig,
  isBotMessage,
  REPLY_TIMEOUT_MS,
  SILENCE_MS,
  songUrl,
  stepCommands,
  stepPointsCost,
  stepSongRequests,
  stepTimer,
  TIMER_TICK_MS,
} from "../../src/e8/bot.ts";

const BOT = "00000000-0000-7000-8000-0000000000b0";
const message = (userId: string, body: string): ServerFrame => ({
  op: "message",
  channel: "streamer",
  message: {
    id: "00000000-0000-7000-8000-000000000001",
    channelId: "00000000-0000-7000-8000-0000000000c1",
    user: { id: userId, username: "u", displayName: "U", color: "chat-1", badges: [], accountType: "bot" },
    body,
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: "2026-10-29T12:00:00.000Z",
  },
});

describe("harnessBotConfig", () => {
  test("is a valid BotConfig with every filter off and points and song requests on", () => {
    const c = harnessBotConfig();
    expect(BotConfig.parse(c)).toEqual(c);
    expect(c.filters.spam.enabled || c.filters.links.enabled || c.filters.caps.enabled).toBe(false);
    expect(c.filters.timeoutSeconds).toBe(0);
    expect(c.loyalty.enabled).toBe(true);
    expect(c.songRequests.enabled).toBe(true);
  });

  test("overrides replace whole sections", () => {
    const c = harnessBotConfig({ songRequests: { enabled: false, maxQueue: 1 } });
    expect(c.songRequests).toEqual({ enabled: false, maxQueue: 1 });
    expect(BotConfig.safeParse(c).success).toBe(true);
  });
});

describe("isBotMessage", () => {
  test("only messages from the bot account, optionally matching a body test", () => {
    expect(isBotMessage(message(BOT, "Hi Ann!"), BOT)).toBe(true);
    expect(isBotMessage(message(BOT, "Hi Ann!"), BOT, (b) => b.startsWith("Hi "))).toBe(true);
    expect(isBotMessage(message(BOT, "other"), BOT, (b) => b.startsWith("Hi "))).toBe(false);
    expect(isBotMessage(message("00000000-0000-7000-8000-000000000099", "Hi Ann!"), BOT)).toBe(false);
    expect(isBotMessage({ op: "pong" }, BOT)).toBe(false);
  });
});

describe("songUrl", () => {
  test("a run-unique https link the bot accepts", () => {
    const url = songUrl("run 1/2");
    expect(url).toBe("https://example.org/song/run%201%2F2");
    expect(new URL(url).protocol).toBe("https:");
    expect(url.length).toBeLessThanOrEqual(500);
    expect(songUrl("a")).not.toBe(songUrl("b"));
  });
});

describe("timing", () => {
  test("waits cover the engine's timer tick and the API round trip", () => {
    expect(TIMER_TICK_MS).toBe(15_000);
    expect(REPLY_TIMEOUT_MS).toBeGreaterThan(SILENCE_MS);
  });

  test("every step the scenario dispatches is a function", () => {
    for (const step of [stepCommands, stepPointsCost, stepTimer, stepSongRequests])
      expect(typeof step).toBe("function");
  });
});
