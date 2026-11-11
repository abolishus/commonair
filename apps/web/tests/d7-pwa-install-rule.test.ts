// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** When "Install CommonAir" is offered: the install mode and the second-visit, 3-minute rule. */
import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_ENGAGEMENT,
  type Engagement,
  MAX_WATCH_FLUSH_MS,
  VISIT_GAP_MS,
  WATCH_THRESHOLD_MS,
  addWatched,
  createWatchClock,
  dismissOffer,
  installMode,
  offerDue,
  parseEngagement,
  recordVisit,
  serializeEngagement,
} from "../src/components/pwa/install-rule.ts";

const T0 = Date.UTC(2026, 10, 11, 12);
const MIN = 60_000;

describe("installMode (feature detection only)", () => {
  const env = { standalone: false, promptReady: false, promptSupported: false, appleStandaloneApi: false };

  it("offers nothing once the app runs installed, whatever else is true", () => {
    expect(installMode({ standalone: true, promptReady: true, promptSupported: true, appleStandaloneApi: true })).toBe(
      "none",
    );
  });

  it("uses the browser's dialog when a beforeinstallprompt is held", () => {
    expect(installMode({ ...env, promptReady: true, promptSupported: true })).toBe("prompt");
  });

  it("waits for the event in a browser that has it but has not fired it", () => {
    expect(installMode({ ...env, promptSupported: true })).toBe("none");
    expect(installMode({ ...env, promptSupported: true, appleStandaloneApi: true })).toBe("none");
  });

  it("shows Apple's Add to Home Screen steps where navigator.standalone exists and no event can come", () => {
    expect(installMode({ ...env, appleStandaloneApi: true })).toBe("ios");
  });

  it("offers nothing in a browser that can do neither", () => {
    expect(installMode(env)).toBe("none");
  });
});

describe("visits", () => {
  it("counts the first page load as the first visit", () => {
    expect(recordVisit(EMPTY_ENGAGEMENT, T0)).toEqual({ ...EMPTY_ENGAGEMENT, visits: 1, lastSeenAt: T0 });
  });

  it("counts a page load after 30 minutes away as a new visit, and one sooner as the same visit", () => {
    const first = recordVisit(EMPTY_ENGAGEMENT, T0);
    expect(recordVisit(first, T0 + VISIT_GAP_MS - 1).visits).toBe(1);
    expect(recordVisit(first, T0 + VISIT_GAP_MS).visits).toBe(2);
  });

  it("keeps a visit open while the viewer keeps loading pages", () => {
    let state = recordVisit(EMPTY_ENGAGEMENT, T0);
    for (let i = 1; i <= 10; i++) state = recordVisit(state, T0 + i * 20 * MIN);
    expect(state.visits).toBe(1);
  });

  it("treats a clock that went backwards as a new visit rather than freezing", () => {
    const first = recordVisit(EMPTY_ENGAGEMENT, T0);
    expect(recordVisit(first, T0 - 5 * MIN)).toMatchObject({ visits: 2, lastSeenAt: T0 - 5 * MIN });
  });
});

describe("watched time", () => {
  it("adds watched time and counts it as activity", () => {
    const state = addWatched(recordVisit(EMPTY_ENGAGEMENT, T0), 90_000, T0 + 2 * MIN);
    expect(state).toMatchObject({ watchedMs: 90_000, lastSeenAt: T0 + 2 * MIN });
  });

  it("clamps one flush to 0..5 minutes and ignores nonsense", () => {
    expect(addWatched(EMPTY_ENGAGEMENT, 60 * MIN, T0).watchedMs).toBe(MAX_WATCH_FLUSH_MS);
    expect(addWatched(EMPTY_ENGAGEMENT, -5, T0).watchedMs).toBe(0);
    expect(addWatched(EMPTY_ENGAGEMENT, Number.NaN, T0).watchedMs).toBe(0);
    expect(addWatched(EMPTY_ENGAGEMENT, 1234.9, T0).watchedMs).toBe(1234);
  });

  it("never moves the last-seen time backwards", () => {
    const state = recordVisit(EMPTY_ENGAGEMENT, T0);
    expect(addWatched(state, 1000, T0 - MIN).lastSeenAt).toBe(T0);
  });
});

describe("offerDue: a second visit with 3+ minutes watched, never once dismissed", () => {
  const due = (visits: number, watchedMs: number, dismissed = false): boolean =>
    offerDue({ visits, watchedMs, dismissed, lastSeenAt: T0 });

  it.each([
    [0, 0, false],
    [1, WATCH_THRESHOLD_MS * 10, false],
    [2, WATCH_THRESHOLD_MS - 1, false],
    [2, WATCH_THRESHOLD_MS, true],
    [5, WATCH_THRESHOLD_MS + 1, true],
  ])("visits %i, watched %i ms: %s", (visits, watched, expected) => {
    expect(due(visits, watched)).toBe(expected);
  });

  it("is never due after a dismissal", () => {
    expect(due(9, WATCH_THRESHOLD_MS * 9, true)).toBe(false);
    expect(offerDue(dismissOffer({ visits: 3, watchedMs: WATCH_THRESHOLD_MS, dismissed: false, lastSeenAt: 1 }))).toBe(
      false,
    );
  });

  it("follows a whole journey: watch 2 minutes, leave, come back, watch 1 more", () => {
    let state = recordVisit(EMPTY_ENGAGEMENT, T0);
    state = addWatched(state, 2 * MIN, T0 + 2 * MIN);
    expect(offerDue(state)).toBe(false);
    state = recordVisit(state, T0 + 2 * MIN + VISIT_GAP_MS);
    expect(offerDue(state)).toBe(false);
    state = addWatched(state, MIN, T0 + 3 * MIN + VISIT_GAP_MS);
    expect(offerDue(state)).toBe(true);
  });
});

describe("the stored record", () => {
  it("round-trips", () => {
    const state: Engagement = { visits: 3, lastSeenAt: T0, watchedMs: 200_000, dismissed: true };
    expect(parseEngagement(serializeEngagement(state))).toEqual(state);
  });

  it.each([null, "", "not json", "[]", "null", "42", '"x"'])("reads %j as empty", (raw) => {
    expect(parseEngagement(raw)).toEqual(EMPTY_ENGAGEMENT);
  });

  it("repairs bad fields one by one", () => {
    expect(parseEngagement('{"visits":-1,"lastSeenAt":"x","watchedMs":2.7,"dismissed":"yes"}')).toEqual({
      visits: 0,
      lastSeenAt: 0,
      watchedMs: 2,
      dismissed: false,
    });
  });

  it("holds counts only: nothing that identifies the viewer or what they watched", () => {
    expect(Object.keys(parseEngagement(serializeEngagement(EMPTY_ENGAGEMENT))).sort()).toEqual([
      "dismissed",
      "lastSeenAt",
      "visits",
      "watchedMs",
    ]);
  });
});

describe("createWatchClock", () => {
  it("times a playing stretch", () => {
    const clock = createWatchClock();
    const video = {};
    clock.start(video, 1000);
    expect(clock.playing).toBe(true);
    clock.stop(video, 4000);
    expect(clock.playing).toBe(false);
    expect(clock.take(9000)).toBe(3000);
    expect(clock.take(9000)).toBe(0);
  });

  it("hands over a long stretch in pieces while it plays", () => {
    const clock = createWatchClock();
    const video = {};
    clock.start(video, 0);
    expect(clock.take(30_000)).toBe(30_000);
    expect(clock.take(45_000)).toBe(15_000);
    clock.stop(video, 50_000);
    expect(clock.take(60_000)).toBe(5_000);
  });

  it("counts two videos playing at once only once", () => {
    const clock = createWatchClock();
    const a = {};
    const b = {};
    clock.start(a, 0);
    clock.start(b, 1000);
    clock.stop(a, 2000);
    expect(clock.playing).toBe(true);
    clock.stop(b, 5000);
    expect(clock.take(5000)).toBe(5000);
  });

  it("forgets a swept video without counting its time since the last take", () => {
    const clock = createWatchClock();
    const gone = {};
    const kept = {};
    clock.start(gone, 0);
    expect(clock.take(30_000)).toBe(30_000);
    clock.sweep((video) => video !== gone);
    expect(clock.playing).toBe(false);
    expect(clock.take(60_000)).toBe(0);
    // A sweep that drops one of two keeps timing the other from where it was.
    clock.start(gone, 100_000);
    clock.start(kept, 100_000);
    clock.sweep((video) => video === kept);
    expect(clock.playing).toBe(true);
    expect(clock.take(110_000)).toBe(10_000);
  });

  it("ignores a repeated start, and a stop without a start", () => {
    const clock = createWatchClock();
    const video = {};
    clock.stop(video, 100);
    clock.start(video, 0);
    clock.start(video, 500);
    clock.stop(video, 1000);
    expect(clock.take(2000)).toBe(1000);
  });
});
