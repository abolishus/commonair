// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F11: after sign-in, the visitor's target wins; otherwise only an account that has created a
 * stream key lands in the studio and everyone else goes home. A verification link without a
 * target lands home too.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_LANDING } from "../src/lib/auth.ts";
import { STUDIO_LANDING, signInLanding, type LandingProbe } from "../src/lib/auth-return.ts";

const probe = (channel: string | null, keys: number): LandingProbe & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    channelSlug: async () => {
      calls.push("me");
      return channel;
    },
    streamKeyCount: async (slug) => {
      calls.push(`keys:${slug}`);
      return keys;
    },
  };
};

describe("signInLanding", () => {
  it("lands home by default, the studio only by request", () => {
    expect(DEFAULT_LANDING).toBe("/");
    expect(STUDIO_LANDING).toBe("/dashboard");
  });

  it("goes to the visitor's target without asking the API", async () => {
    const p = probe("streamer1", 1);
    expect(await signInLanding("/fern?tab=clips", p)).toBe("/fern?tab=clips");
    expect(await signInLanding("/dashboard?intent=stream", p)).toBe("/dashboard?intent=stream");
    expect(p.calls).toEqual([]);
  });

  it.each(["//evil.example/x", "https://evil.example/x", "/\\evil", "relative"])(
    "ignores an unsafe target (%s) and decides by the account",
    async (bad) => {
      expect(await signInLanding(bad, probe("viewer1", 0))).toBe("/");
      expect(await signInLanding(bad, probe("streamer1", 2))).toBe("/dashboard");
    },
  );

  it("an account with a stream key goes to the studio, checked on its own channel", async () => {
    const p = probe("streamer1", 1);
    expect(await signInLanding(undefined, p)).toBe("/dashboard");
    expect(p.calls).toEqual(["me", "keys:streamer1"]);
  });

  it("a viewer, or an account without a channel, goes home", async () => {
    expect(await signInLanding(undefined, probe("viewer1", 0))).toBe("/");
    const none = probe(null, 5);
    expect(await signInLanding(undefined, none)).toBe("/");
    expect(none.calls).toEqual(["me"]);
  });

  it("goes home when the API fails at either step", async () => {
    const failMe: LandingProbe = {
      channelSlug: () => Promise.reject(new Error("429")),
      streamKeyCount: async () => 1,
    };
    const failKeys: LandingProbe = {
      channelSlug: async () => "streamer1",
      streamKeyCount: () => Promise.reject(new Error("503")),
    };
    expect(await signInLanding(undefined, failMe)).toBe("/");
    expect(await signInLanding(undefined, failKeys)).toBe("/");
  });

  it("goes home rather than wait on a slow answer", async () => {
    vi.useFakeTimers();
    try {
      const slow: LandingProbe = { channelSlug: () => new Promise(() => {}), streamKeyCount: async () => 1 };
      const landing = signInLanding(undefined, slow, 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(await landing).toBe("/");
    } finally {
      vi.useRealTimers();
    }
  });
});
