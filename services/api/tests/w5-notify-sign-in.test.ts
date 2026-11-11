// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Overhaul wave 5 (w5-notify): which sessions are a new sign-in, and the device in coarse words. */
import { describe, expect, test, vi } from "vite-plus/test";
import type { AuthBackground } from "../src/auth/background.ts";
import {
  COMPLETED_SIGN_IN_PATHS,
  coarseDevice,
  isCompletedSignIn,
  mayBeSignIn,
  newSignInKey,
  onSessionCreated,
  PASSWORD_SIGN_IN_PATHS,
  type NewSignInDeps,
} from "../src/auth/new-sign-in.ts";

const UA = {
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
};

describe("isCompletedSignIn", () => {
  test("a password sign-in counts only without two-step (the code step counts instead)", () => {
    for (const path of PASSWORD_SIGN_IN_PATHS) {
      expect(isCompletedSignIn(path, false)).toBe(true);
      expect(isCompletedSignIn(path, true)).toBe(false);
    }
  });

  test("social, magic link, passkey and the two-step code steps count either way", () => {
    for (const path of COMPLETED_SIGN_IN_PATHS) {
      expect(isCompletedSignIn(path, false)).toBe(true);
      expect(isCompletedSignIn(path, true)).toBe(true);
    }
    expect(COMPLETED_SIGN_IN_PATHS.has("/two-factor/verify-totp")).toBe(true);
    expect(COMPLETED_SIGN_IN_PATHS.has("/passkey/verify-authentication")).toBe(true);
  });

  test("sign-up, email verification, password changes and unknown paths never count", () => {
    for (const path of [
      "/sign-up/email",
      "/verify-email",
      "/change-password",
      "/reset-password",
      "/update-user",
      "/change-email",
      "/admin/impersonate-user",
      "/get-session",
      "",
      undefined,
    ]) {
      expect(isCompletedSignIn(path, false)).toBe(false);
      expect(mayBeSignIn(path)).toBe(false);
    }
  });
});

describe("coarseDevice", () => {
  test("browser and system, never a version or model", () => {
    expect(coarseDevice(UA.firefoxLinux)).toBe("Firefox · Linux");
    expect(coarseDevice(UA.safariIphone)).toBe("Safari · iPhone");
    expect(coarseDevice(UA.edgeWindows)).toBe("Edge · Windows");
    expect(coarseDevice(UA.chromeAndroid)).toBe("Chrome · Android");
    for (const ua of Object.values(UA)) expect(coarseDevice(ua)).not.toMatch(/\d/);
  });

  test("one of the two, or nothing", () => {
    expect(coarseDevice("Firefox/132.0")).toBe("Firefox");
    expect(coarseDevice("curl/8.0 (Linux)")).toBe("Linux");
    expect(coarseDevice("curl/8.0")).toBeUndefined();
    expect(coarseDevice("")).toBeUndefined();
    expect(coarseDevice(null)).toBeUndefined();
    expect(coarseDevice(undefined)).toBeUndefined();
  });

  test("a very long user agent is cut before matching", () => {
    expect(coarseDevice(`${"x".repeat(600)} Firefox/1`)).toBeUndefined();
  });
});

describe("onSessionCreated", () => {
  const deps = {} as NewSignInDeps;
  const session = { id: "s", userId: "u", createdAt: new Date() };
  const req = (path: string | undefined, hasSession = false) => ({
    path,
    hasSession,
    sessionCookie: async () => null,
  });
  const recorder = () => {
    const handler = vi.fn<AuthBackground["handler"]>();
    const bg: AuthBackground = {
      handler,
      mail: vi.fn<AuthBackground["mail"]>(),
      pending: () => 0,
      drain: async () => {},
    };
    return { bg, handler };
  };

  test("hands a possible sign-in to the background and returns at once", () => {
    const { bg, handler } = recorder();
    // The background task fails on the empty deps; the handler only keeps it.
    onSessionCreated(deps, bg, session, req("/sign-in/email"));
    expect(handler).toHaveBeenCalledTimes(1);
    const task = handler.mock.calls[0]?.[0];
    expect(task).toBeInstanceOf(Promise);
    void Promise.resolve(task).catch(() => undefined);
  });

  test("skips without a request, a signed-in request, impersonation or another endpoint", () => {
    const { bg, handler } = recorder();
    onSessionCreated(deps, bg, session, null);
    onSessionCreated(deps, bg, session, req("/sign-in/email", true));
    onSessionCreated(deps, bg, { ...session, impersonatedBy: "admin" }, req("/sign-in/email"));
    onSessionCreated(deps, bg, session, req("/verify-email"));
    onSessionCreated(deps, bg, session, req(undefined));
    expect(handler).not.toHaveBeenCalled();
  });

  test("the rate key is per member", () => {
    expect(newSignInKey("abc")).toBe("auth:new-sign-in:abc");
  });
});
