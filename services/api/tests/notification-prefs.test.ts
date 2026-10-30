// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure preference resolver (ADR 0028 decision 4; N1-inbox). */
import { describe, expect, it } from "vite-plus/test";
import { NOTIFY_DEFAULTS } from "@commonair/contracts/notify";
import {
  enabledFor,
  type FollowedChannel,
  type PreferenceRow,
  resolvePreferences,
} from "../src/notifications/preferences/resolve.ts";

const A: FollowedChannel = { id: "00000000-0000-7000-8000-00000000000a", slug: "alpha", displayName: "Alpha" };
const B: FollowedChannel = { id: "00000000-0000-7000-8000-00000000000b", slug: "bravo", displayName: "Bravo" };
const GONE = "00000000-0000-7000-8000-00000000000c";
const followed = new Map([
  [B.id, B],
  [A.id, A],
]);

const resolve = (rows: PreferenceRow[], emailVerified = true) =>
  resolvePreferences({ type: "go_live", rows, followed, emailVerified });

describe("resolvePreferences", () => {
  it("no rows: the built-in defaults, every medium built in", () => {
    expect(resolve([])).toEqual({
      type: "go_live",
      defaults: { in_app: true, email: false, push: false },
      builtIn: { in_app: true, email: true, push: true },
      channels: [],
      emailVerified: true,
    });
  });

  it("does not mutate NOTIFY_DEFAULTS", () => {
    resolve([{ channelId: null, medium: "email", enabled: true }]);
    expect(NOTIFY_DEFAULTS.go_live).toEqual({ in_app: true, email: false, push: false });
  });

  it("a default row wins over the built-in and is marked chosen, even when equal to it", () => {
    const r = resolve([
      { channelId: null, medium: "email", enabled: true },
      { channelId: null, medium: "in_app", enabled: true },
    ]);
    expect(r.defaults).toEqual({ in_app: true, email: true, push: false });
    expect(r.builtIn).toEqual({ in_app: false, email: false, push: true });
  });

  it("groups overrides per channel, media in NOTIFY_MEDIA order, channels by slug", () => {
    const r = resolve([
      { channelId: B.id, medium: "push", enabled: true },
      { channelId: A.id, medium: "push", enabled: false },
      { channelId: A.id, medium: "email", enabled: true },
    ]);
    expect(r.channels).toEqual([
      { channel: A, media: { email: true, push: false } },
      { channel: B, media: { push: true } },
    ]);
    expect(Object.keys(r.channels[0]?.media ?? {})).toEqual(["email", "push"]);
    // Overrides do not touch the defaults.
    expect(r.builtIn).toEqual({ in_app: true, email: true, push: true });
  });

  it("leaves out overrides of channels the member no longer follows", () => {
    const r = resolve([
      { channelId: GONE, medium: "email", enabled: true },
      { channelId: A.id, medium: "email", enabled: false },
    ]);
    expect(r.channels.map((c) => c.channel.slug)).toEqual(["alpha"]);
  });

  it("passes emailVerified through", () => {
    expect(resolve([], false).emailVerified).toBe(false);
  });
});

describe("enabledFor", () => {
  const prefs = resolve([
    { channelId: null, medium: "email", enabled: true },
    { channelId: A.id, medium: "email", enabled: false },
    { channelId: B.id, medium: "push", enabled: true },
  ]);

  it("an override wins over the default", () => {
    expect(enabledFor(prefs, A.id, "email")).toBe(false);
    expect(enabledFor(prefs, B.id, "push")).toBe(true);
  });

  it("no override: the default", () => {
    expect(enabledFor(prefs, B.id, "email")).toBe(true);
    expect(enabledFor(prefs, A.id, "push")).toBe(false);
    expect(enabledFor(prefs, GONE, "in_app")).toBe(true);
  });
});
