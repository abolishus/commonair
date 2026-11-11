// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d4-follow, pure parts: which answers the first-follow prompt offers per browser (iOS before
 * install: no Push), the arm/fire hand-off of `firstFollow`, and the bounded notify lookup.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  alertOptions,
  armFirstFollow,
  browserAlertEnv,
  fireFirstFollow,
} from "../src/components/follow/alert-options.ts";
import { findFollowNotify, type FollowsPage, type FollowsPageLoader } from "../src/components/follow/notify.ts";

const media = (standalone: boolean) => (query: string) => ({
  matches: standalone && query === "(display-mode: standalone)",
});

describe("alertOptions", () => {
  it("offers Push wherever the browser can push", () => {
    expect(alertOptions({ pushSupported: true, appleStandaloneApi: false, standalone: false })).toEqual({
      push: true,
      installHint: false,
    });
    // iOS from the Home Screen exposes PushManager: Push, no hint.
    expect(alertOptions({ pushSupported: true, appleStandaloneApi: true, standalone: true })).toEqual({
      push: true,
      installHint: false,
    });
  });

  it("on iOS before install: never Push, an Add to Home Screen hint instead", () => {
    expect(alertOptions({ pushSupported: false, appleStandaloneApi: true, standalone: false })).toEqual({
      push: false,
      installHint: true,
    });
  });

  it("another browser without push: Email only, no hint that would not help", () => {
    expect(alertOptions({ pushSupported: false, appleStandaloneApi: false, standalone: false })).toEqual({
      push: false,
      installHint: false,
    });
    expect(alertOptions({ pushSupported: false, appleStandaloneApi: true, standalone: true })).toEqual({
      push: false,
      installHint: false,
    });
  });
});

describe("browserAlertEnv (feature detection, no user agent)", () => {
  it("Safari on an iPhone, in the browser: no PushManager, navigator.standalone false", () => {
    const env = browserAlertEnv(
      { Notification: {}, matchMedia: media(false) },
      { serviceWorker: {}, standalone: false },
    );
    expect(env).toEqual({ pushSupported: false, appleStandaloneApi: true, standalone: false });
    expect(alertOptions(env)).toEqual({ push: false, installHint: true });
  });

  it("the same iPhone from the Home Screen: PushManager and standalone", () => {
    const env = browserAlertEnv(
      { PushManager: {}, Notification: {}, matchMedia: media(true) },
      { serviceWorker: {}, standalone: true },
    );
    expect(env).toEqual({ pushSupported: true, appleStandaloneApi: true, standalone: true });
    expect(alertOptions(env).push).toBe(true);
  });

  it("a desktop browser: push, and no Apple standalone API", () => {
    const env = browserAlertEnv({ PushManager: {}, Notification: {}, matchMedia: media(false) }, { serviceWorker: {} });
    expect(env).toEqual({ pushSupported: true, appleStandaloneApi: false, standalone: false });
  });

  it("an installed desktop app counts as standalone; a throwing matchMedia does not break it", () => {
    expect(
      browserAlertEnv({ PushManager: {}, Notification: {}, matchMedia: media(true) }, { serviceWorker: {} }).standalone,
    ).toBe(true);
    const env = browserAlertEnv(
      {
        Notification: {},
        matchMedia: () => {
          throw new Error("no");
        },
      },
      { standalone: false },
    );
    expect(env).toEqual({ pushSupported: false, appleStandaloneApi: true, standalone: false });
  });

  it("on the server: nothing", () => {
    expect(browserAlertEnv(undefined, undefined)).toEqual({
      pushSupported: false,
      appleStandaloneApi: false,
      standalone: false,
    });
  });
});

describe("armFirstFollow / fireFirstFollow", () => {
  it("delivers to the last armed control, once", () => {
    const a = vi.fn<() => void>();
    const b = vi.fn<() => void>();
    armFirstFollow(a);
    armFirstFollow(b);
    expect(fireFirstFollow()).toBe(true);
    expect(fireFirstFollow()).toBe(false);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a disarmed control gets nothing; disarming another's arm is a no-op", () => {
    const a = vi.fn<() => void>();
    const b = vi.fn<() => void>();
    const disarmA = armFirstFollow(a);
    disarmA();
    expect(fireFirstFollow()).toBe(false);
    const disarmStale = armFirstFollow(a);
    armFirstFollow(b);
    disarmStale();
    expect(fireFirstFollow()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });
});

describe("findFollowNotify", () => {
  const page = (slugs: [string, boolean][], nextCursor: string | null): FollowsPage => ({
    items: slugs.map(([slug, notify]) => ({ channel: { slug }, notify })),
    nextCursor,
  });

  it("finds the follow on a later page, passing the cursor", async () => {
    const load = vi.fn<FollowsPageLoader>(async (cursor) =>
      cursor === undefined ? page([["a", true]], "c1") : page([["rivertide", false]], null),
    );
    expect(await findFollowNotify("rivertide", load)).toBe(false);
    expect(load.mock.calls.map(([c]) => c)).toEqual([undefined, "c1"]);
  });

  it("null when the list ends, or after the page budget", async () => {
    expect(await findFollowNotify("x", async () => page([["a", true]], null))).toBeNull();
    const load = vi.fn<FollowsPageLoader>(async () => page([], "more"));
    expect(await findFollowNotify("x", load, 2)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed page rejects (the caller falls back to the default)", async () => {
    await expect(
      findFollowNotify("x", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });
});
