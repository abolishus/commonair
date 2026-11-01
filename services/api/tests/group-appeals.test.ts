// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The group-appeal rate limit and visibility rules (`analytics/appeals.ts`), pure. */
import { describe, expect, it } from "vite-plus/test";
import { GROUP_APPEAL_WINDOW_MS, groupAppealLimit, groupShown } from "../src/analytics/appeals.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 86_400_000;

describe("groupAppealLimit", () => {
  it("allows the first appeal", () => {
    expect(groupAppealLimit({ broadcastAppeals: 0, channelWindow: [], now: NOW })).toEqual({ ok: true });
  });

  it("one per broadcast, any status: refused with the whole window", () => {
    expect(groupAppealLimit({ broadcastAppeals: 1, channelWindow: [ago(DAY)], now: NOW })).toEqual({
      ok: false,
      limit: "broadcast",
      retryAfterSeconds: GROUP_APPEAL_WINDOW_MS / 1000,
    });
  });

  it("three per channel in 7 days: the fourth waits for the oldest to leave the window", () => {
    const r = groupAppealLimit({ broadcastAppeals: 0, channelWindow: [ago(6 * DAY), ago(DAY), ago(1000)], now: NOW });
    expect(r).toEqual({ ok: false, limit: "channel", retryAfterSeconds: DAY / 1000 });
    expect(groupAppealLimit({ broadcastAppeals: 0, channelWindow: [ago(DAY), ago(1000)], now: NOW })).toEqual({
      ok: true,
    });
  });

  it("the 7-day edge: one exactly 7 days old has left the window", () => {
    expect(
      groupAppealLimit({ broadcastAppeals: 0, channelWindow: [ago(7 * DAY), ago(DAY), ago(1000)], now: NOW }),
    ).toEqual({ ok: true });
    const r = groupAppealLimit({
      broadcastAppeals: 0,
      channelWindow: [ago(7 * DAY - 1), ago(DAY), ago(1000)],
      now: NOW,
    });
    // Rounded up, never 0.
    expect(r).toEqual({ ok: false, limit: "channel", retryAfterSeconds: 1 });
  });

  it("order does not matter, and appeals older than the window are ignored", () => {
    const r = groupAppealLimit({
      broadcastAppeals: 0,
      channelWindow: [ago(1000), ago(30 * DAY), ago(2 * DAY), ago(5 * DAY)],
      now: NOW,
    });
    expect(r).toEqual({ ok: false, limit: "channel", retryAfterSeconds: (2 * DAY) / 1000 });
  });
});

describe("groupShown", () => {
  it("shows groups of 5 or more, like the analytics suppression", () => {
    expect(groupShown(undefined)).toBe(false);
    expect(groupShown(0)).toBe(false);
    expect(groupShown(4)).toBe(false);
    expect(groupShown(5)).toBe(true);
    expect(groupShown(120)).toBe(true);
  });
});
