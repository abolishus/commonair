// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The go-live fan-out's pure parts: media resolution, the mature title rule, page planning, job ids. */
import { NOTIFY_MEDIA, type NotifyMedium } from "@commonair/contracts/enums";
import { DiscordJob, GoLiveJob, NOTIFY_JOBS, PushJob } from "@commonair/contracts/internal";
import { NOTIFY_DEFAULTS } from "@commonair/contracts/notify";
import { describe, expect, test } from "vite-plus/test";
import {
  anyMedium,
  goLiveTitle,
  MAX_TITLE_LENGTH,
  preferred,
  resolveMedia,
  type FollowerFacts,
  type MediumPreference,
} from "../src/notify/fanout/media.ts";
import { discordJob, discordJobId, goLiveJobId, nextPageJob, pushJobId, pushJobs } from "../src/notify/fanout/plan.ts";

const TRI = [true, false, null] as const;
const BOOL = [true, false] as const;
const unset: MediumPreference = { channel: null, fallback: null };

function facts(
  over: Partial<FollowerFacts> & { email?: MediumPreference; push?: MediumPreference; in_app?: MediumPreference } = {},
): FollowerFacts {
  return {
    prefs: { in_app: over.in_app ?? unset, email: over.email ?? unset, push: over.push ?? unset },
    excluded: over.excluded ?? false,
    emailVerified: over.emailVerified ?? true,
    demo: over.demo ?? false,
    hasPushSubscription: over.hasPushSubscription ?? true,
  };
}

describe("preferred: channel override, else default, else built-in", () => {
  for (const medium of NOTIFY_MEDIA)
    for (const channel of TRI)
      for (const fallback of TRI)
        test(`${medium}: channel ${String(channel)}, default ${String(fallback)}`, () => {
          const expected = channel !== null ? channel : fallback !== null ? fallback : NOTIFY_DEFAULTS.go_live[medium];
          expect(preferred(medium, { channel, fallback })).toBe(expected);
        });

  test("the built-in default is in-app only", () => {
    expect(resolveMedia(facts(), true)).toEqual({ in_app: true, email: false, push: false });
  });
});

describe("resolveMedia: every combination", () => {
  // Each medium's preference is decided by `preferred` (tested above); here the stored choice is
  // the channel override, the default or the built-in, crossed with every gate.
  const sources: { name: string; pref: (on: boolean) => MediumPreference }[] = [
    { name: "override", pref: (on) => ({ channel: on, fallback: !on }) },
    { name: "default", pref: (on) => ({ channel: null, fallback: on }) },
  ];
  for (const source of sources)
    for (const want of BOOL)
      for (const excluded of BOOL)
        for (const emailVerified of BOOL)
          for (const demo of BOOL)
            for (const hasPushSubscription of BOOL)
              for (const pushAvailable of BOOL)
                test(`${source.name} ${want ? "on" : "off"}, excluded ${excluded}, verified ${emailVerified}, demo ${demo}, subscribed ${hasPushSubscription}, push ${pushAvailable}`, () => {
                  const pref = source.pref(want);
                  const m = resolveMedia(
                    facts({
                      in_app: pref,
                      email: pref,
                      push: pref,
                      excluded,
                      emailVerified,
                      demo,
                      hasPushSubscription,
                    }),
                    pushAvailable,
                  );
                  // In-app ignores every gate, exclusion included.
                  expect(m.in_app).toBe(want);
                  expect(m.email).toBe(want && !excluded && emailVerified && !demo);
                  expect(m.push).toBe(want && !excluded && pushAvailable && hasPushSubscription);
                  expect(anyMedium(m)).toBe(m.in_app || m.email || m.push);
                });

  test("the built-in default with every gate open: in-app only", () => {
    for (const excluded of BOOL)
      expect(resolveMedia(facts({ excluded }), true)).toEqual({ in_app: true, email: false, push: false });
  });

  test("each medium is decided on its own row", () => {
    const m = resolveMedia(
      facts({
        in_app: { channel: false, fallback: true },
        email: { channel: null, fallback: true },
        push: { channel: true, fallback: false },
      }),
      true,
    );
    expect(m).toEqual({ in_app: false, email: true, push: true });
  });

  test("no medium left: skipped", () => {
    const off: MediumPreference = { channel: false, fallback: null };
    expect(anyMedium(resolveMedia(facts({ in_app: off }), true))).toBe(false);
    // Email on but unverified and in-app off: nothing.
    expect(
      anyMedium(
        resolveMedia(facts({ in_app: off, email: { channel: true, fallback: null }, emailVerified: false }), true),
      ),
    ).toBe(false);
    // Excluded follow with only email and push on: nothing.
    const on: MediumPreference = { channel: null, fallback: true };
    expect(anyMedium(resolveMedia(facts({ in_app: off, email: on, push: on, excluded: true }), true))).toBe(false);
  });

  test("anyMedium is true for each medium alone", () => {
    for (const k of NOTIFY_MEDIA) {
      const m = { in_app: false, email: false, push: false } as Record<NotifyMedium, boolean>;
      m[k] = true;
      expect(anyMedium(m)).toBe(true);
    }
    expect(anyMedium({ in_app: false, email: false, push: false })).toBe(false);
  });
});

describe("goLiveTitle: the one mature rule", () => {
  for (const broadcastMature of BOOL)
    for (const channelMature of BOOL)
      for (const matureConfirmed of BOOL)
        test(`broadcast ${broadcastMature}, channel ${channelMature}, confirmed ${matureConfirmed}`, () => {
          const hidden = (broadcastMature || channelMature) && !matureConfirmed;
          expect(goLiveTitle({ title: "Speedrun", broadcastMature, channelMature, matureConfirmed })).toBe(
            hidden ? "" : "Speedrun",
          );
        });

  test("titles are bounded by the payload schema", () => {
    const long = "x".repeat(MAX_TITLE_LENGTH + 20);
    expect(
      goLiveTitle({ title: long, broadcastMature: false, channelMature: false, matureConfirmed: false }),
    ).toHaveLength(MAX_TITLE_LENGTH);
    expect(goLiveTitle({ title: "", broadcastMature: false, channelMature: false, matureConfirmed: false })).toBe("");
  });
});

describe("job ids and follow-up jobs", () => {
  const eventId = "0190f5a0-0000-7000-8000-000000000001";
  const userId = "0190f5a0-0000-7000-8000-000000000002";
  const channelId = "0190f5a0-0000-7000-8000-000000000003";
  const broadcastId = "0190f5a0-0000-7000-8000-000000000004";
  const ref = { eventId, channelId, broadcastId };

  test("formats (no colon: BullMQ refuses them)", () => {
    expect(goLiveJobId(eventId, null)).toBe(`go-live-${eventId}`);
    expect(goLiveJobId(eventId, userId)).toBe(`go-live-${eventId}-${userId}`);
    expect(pushJobId(eventId, userId)).toBe(`push-${eventId}-${userId}`);
    expect(discordJobId(eventId)).toBe(`discord-${eventId}`);
    for (const id of [
      goLiveJobId(eventId, null),
      goLiveJobId(eventId, userId),
      pushJobId(eventId, userId),
      discordJobId(eventId),
    ])
      expect(id).not.toContain(":");
  });

  test("a full page enqueues the next page after its last follower", () => {
    const ids = ["a", "b", userId];
    const next = nextPageJob(eventId, ids, 3);
    expect(next).toEqual({
      name: NOTIFY_JOBS.goLive,
      data: { eventId, after: userId },
      opts: { jobId: `go-live-${eventId}-${userId}` },
    });
    expect(GoLiveJob.parse(next?.data)).toEqual({ eventId, after: userId });
  });

  test("a short or empty page is the last", () => {
    expect(nextPageJob(eventId, ["a", "b"], 3)).toBeNull();
    expect(nextPageJob(eventId, [], 3)).toBeNull();
    expect(nextPageJob(eventId, [], 0)).toBeNull();
  });

  test("push jobs: one per member, contract payload", () => {
    const jobs = pushJobs(ref, [userId]);
    expect(jobs).toEqual([
      {
        name: NOTIFY_JOBS.push,
        data: { eventId, userId, channelId, broadcastId },
        opts: { jobId: `push-${eventId}-${userId}` },
      },
    ]);
    expect(PushJob.parse(jobs[0]?.data)).toEqual(jobs[0]?.data);
    expect(pushJobs(ref, [])).toEqual([]);
  });

  test("discord job: not a test, by event", () => {
    const d = discordJob(ref);
    expect(d).toEqual({
      name: NOTIFY_JOBS.discord,
      data: { channelId, eventId, broadcastId, test: false },
      opts: { jobId: `discord-${eventId}` },
    });
    expect(DiscordJob.parse(d.data)).toEqual(d.data);
  });
});
