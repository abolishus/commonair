// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer-platform` step 7 (E9-console): its pure helpers and its step shape. */
import { describe, expect, test } from "vite-plus/test";
import {
  SECRET_SELECTORS,
  consoleAppName,
  consoleBotUsername,
  lastAttempt,
  looksLikeAccessToken,
  looksLikeClientSecret,
  needsToggle,
  newNotifications,
  redeliveryTarget,
  step,
} from "../../src/e9/console.ts";

const d = (
  id: string,
  over: Partial<{ messageId: string; messageType: string; attempt: number; createdAt: string }> = {},
) => ({
  id,
  messageId: `m-${id}`,
  messageType: "notification",
  attempt: 1,
  createdAt: "2026-10-29T10:00:00.000Z",
  ...over,
});

describe("step 7 helpers", () => {
  test("names fit the forms' bounds", () => {
    expect(consoleAppName("mhabc123")).toBe("Console mhabc123");
    expect(consoleAppName("x".repeat(80))).toHaveLength(50);
    expect(consoleBotUsername("MhAbc-123")).toBe("cb_mhabc123");
    const long = consoleBotUsername("m".repeat(40));
    expect(long).toHaveLength(25);
    expect(long).toMatch(/^[a-z0-9_]{3,25}$/);
  });

  test("secret and token shapes", () => {
    expect(looksLikeClientSecret("cas_abcdefghijklmnopqrstuv")).toBe(true);
    expect(looksLikeClientSecret("ca_abcdefghijklmnopqrstuv")).toBe(false);
    expect(looksLikeClientSecret("cas_short")).toBe(false);
    expect(looksLikeAccessToken("ca_abcdefghijklmnopqrstuv")).toBe(true);
    expect(looksLikeAccessToken("car_abcdefghijklmnopqrstuv")).toBe(false);
    expect(looksLikeAccessToken("")).toBe(false);
  });

  test("the redelivery target is the oldest notification", () => {
    const list = [
      d("c", { createdAt: "2026-10-29T10:00:03.000Z" }),
      d("v", { messageType: "webhook_callback_verification", createdAt: "2026-10-29T09:59:00.000Z" }),
      d("a", { createdAt: "2026-10-29T10:00:01.000Z" }),
      d("b", { createdAt: "2026-10-29T10:00:01.000Z" }),
    ];
    expect(redeliveryTarget(list)?.id).toBe("a");
    expect(redeliveryTarget([d("v", { messageType: "revocation" })])).toBeNull();
    expect(redeliveryTarget([])).toBeNull();
  });

  test("attempts per message id", () => {
    const list = [
      d("1", { messageId: "m", attempt: 1 }),
      d("2", { messageId: "m", attempt: 3 }),
      d("3", { messageId: "n", attempt: 7 }),
    ];
    expect(lastAttempt(list, "m")).toBe(3);
    expect(lastAttempt(list, "x")).toBe(0);
  });

  test("new notifications by delivery id", () => {
    const before = [d("1"), d("2")];
    const after = [d("3"), d("4", { messageType: "revocation" }), ...before];
    expect(newNotifications(before, after).map((x) => x.id)).toEqual(["3"]);
    expect(newNotifications(after, after)).toEqual([]);
  });

  test("switch toggling", () => {
    expect(needsToggle("true", true)).toBe(false);
    expect(needsToggle("false", true)).toBe(true);
    expect(needsToggle(null, true)).toBe(true);
    expect(needsToggle(null, false)).toBe(false);
  });

  test("failure screenshots blank the secret and the token", () => {
    expect(SECRET_SELECTORS).toEqual(['[data-testid="devapp-secret-value"]', '[data-testid="devbot-token-value"]']);
  });

  test("the step is ready, web only, and needs step 4", () => {
    expect(step.owner).toBe("E9-console");
    expect(step.ready).toBe(true);
    expect(step.webOnly).toBe(true);
    expect(step.needs).toEqual([4]);
  });
});
