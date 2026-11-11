// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The new-sign-in mail's device summary and its rule (auth/device.ts, D7.2). */
import { describe, expect, test } from "vite-plus/test";
import { deviceLabel, deviceSummary, earnsNewSignInMail, isSignInPath, sameDevice } from "../src/auth/device.ts";

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36",
  opera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0",
  chromebook:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
};

describe("deviceSummary", () => {
  test.each([
    [UA.chromeWindows, "Chrome", "Windows"],
    [UA.edgeWindows, "Edge", "Windows"],
    [UA.firefoxLinux, "Firefox", "Linux"],
    [UA.safariMac, "Safari", "macOS"],
    [UA.safariIphone, "Safari", "iPhone"],
    [UA.chromeIos, "Chrome", "iPhone"],
    [UA.chromeAndroid, "Chrome", "Android"],
    [UA.samsung, "Samsung Internet", "Android"],
    [UA.opera, "Opera", "Windows"],
    [UA.chromebook, "Chrome", "ChromeOS"],
    [UA.ipad, "Safari", "iPad"],
  ])("%s", (ua, browser, os) => {
    expect(deviceSummary(ua)).toEqual({ browser, os });
  });

  test("unknown, empty and missing agents are unknown", () => {
    expect(deviceSummary("curl/8.0")).toEqual({ browser: null, os: null });
    expect(deviceSummary("")).toEqual({ browser: null, os: null });
    expect(deviceSummary(null)).toEqual({ browser: null, os: null });
    expect(deviceSummary(undefined)).toEqual({ browser: null, os: null });
  });

  test("a huge agent is read only in part", () => {
    expect(deviceSummary(`${"x".repeat(600)} Firefox/1`)).toEqual({ browser: null, os: null });
  });
});

describe("deviceLabel", () => {
  test("joins what is known", () => {
    expect(deviceLabel({ browser: "Firefox", os: "Linux" })).toBe("Firefox · Linux");
    expect(deviceLabel({ browser: null, os: "Linux" })).toBe("Linux");
    expect(deviceLabel({ browser: "Firefox", os: null })).toBe("Firefox");
    expect(deviceLabel({ browser: null, os: null })).toBeNull();
  });
});

test("sameDevice compares both parts", () => {
  expect(sameDevice(deviceSummary(UA.chromeWindows), deviceSummary(UA.chromeWindows))).toBe(true);
  expect(sameDevice(deviceSummary(UA.chromeWindows), deviceSummary(UA.edgeWindows))).toBe(false);
  expect(sameDevice(deviceSummary(UA.chromeAndroid), deviceSummary(UA.chromeWindows))).toBe(false);
});

describe("isSignInPath", () => {
  test.each([
    ["/sign-in/email", true],
    ["/sign-in/username", true],
    ["/two-factor/verify-totp", true],
    ["/two-factor/verify-backup-code", true],
    ["/passkey/verify-authentication", true],
    ["/magic-link/verify", true],
    ["/callback/github", true],
    ["/verify-email", false],
    ["/sign-up/email", false],
    ["/two-factor/enable", false],
    ["/two-factor/disable", false],
    ["/change-password", false],
    [undefined, false],
  ])("%s → %s", (path, expected) => {
    expect(isSignInPath(path)).toBe(expected);
  });
});

describe("earnsNewSignInMail", () => {
  const base = { path: "/sign-in/email", twoFactorEnabled: false, current: UA.firefoxLinux };

  test("a sign-in from a device no other session has", () => {
    expect(earnsNewSignInMail({ ...base, others: [UA.chromeWindows] })).toBe(true);
  });

  test("not from a device another session has", () => {
    expect(earnsNewSignInMail({ ...base, others: [UA.chromeWindows, UA.firefoxLinux] })).toBe(false);
  });

  test("not with no other session to compare against", () => {
    expect(earnsNewSignInMail({ ...base, others: [] })).toBe(false);
  });

  test("not for a session that is not a sign-in", () => {
    expect(earnsNewSignInMail({ ...base, path: "/verify-email", others: [UA.chromeWindows] })).toBe(false);
    expect(earnsNewSignInMail({ ...base, path: undefined, others: [UA.chromeWindows] })).toBe(false);
  });

  test("two-step sign-in: the code step mails, the password step does not", () => {
    const tfa = { ...base, twoFactorEnabled: true, others: [UA.chromeWindows] };
    expect(earnsNewSignInMail(tfa)).toBe(false);
    expect(earnsNewSignInMail({ ...tfa, path: "/two-factor/verify-totp" })).toBe(true);
    expect(earnsNewSignInMail({ ...tfa, path: "/two-factor/verify-backup-code" })).toBe(true);
  });

  test("two unknown agents count as the same device", () => {
    expect(earnsNewSignInMail({ ...base, current: "curl/8", others: [null] })).toBe(false);
  });
});
