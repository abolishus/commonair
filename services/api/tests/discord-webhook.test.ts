// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The Discord webhook status and the test dedupe window (ADR 0028 decision 5). */
import { DiscordWebhookStatus } from "@commonair/contracts/dto";
import { describe, expect, test } from "vite-plus/test";
import { testMinute, toStatus } from "../src/notifications/discord/webhook.ts";

describe("toStatus", () => {
  test("no row: not configured, everything null", () => {
    const s = toStatus(undefined);
    expect(s).toEqual({ configured: false, setAt: null, lastPostedAt: null, lastError: null });
    expect(DiscordWebhookStatus.parse(s)).toEqual(s);
  });

  test("a row: ISO times and the last error, nothing else (the URL is not even an input)", () => {
    const s = toStatus({
      setAt: new Date("2026-10-30T10:00:00Z"),
      lastPostedAt: new Date("2026-10-30T11:00:00Z"),
      lastError: "not_found",
    });
    expect(s).toEqual({
      configured: true,
      setAt: "2026-10-30T10:00:00.000Z",
      lastPostedAt: "2026-10-30T11:00:00.000Z",
      lastError: "not_found",
    });
    expect(DiscordWebhookStatus.parse(s)).toEqual(s);
    expect(toStatus({ setAt: new Date(0), lastPostedAt: null, lastError: null })).toMatchObject({
      configured: true,
      lastPostedAt: null,
      lastError: null,
    });
  });
});

test("testMinute: whole minutes since the epoch, the same across one minute", () => {
  expect(testMinute(new Date("2026-10-30T12:00:00.000Z"))).toBe(testMinute(new Date("2026-10-30T12:00:59.999Z")));
  expect(testMinute(new Date("2026-10-30T12:01:00.000Z")) - testMinute(new Date("2026-10-30T12:00:59.999Z"))).toBe(1);
  expect(testMinute(new Date(0))).toBe(0);
});
