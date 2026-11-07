// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  RESUME_KEY,
  RESUME_MAX,
  clearResumePoint,
  readResumePoints,
  resumePositionFor,
  saveResumePoint,
  type ResumePoint,
} from "../src/lib/resume.ts";
import { UI_METRICS_PATH, optedOut, resetUiMetricsForTests, trackUi } from "../src/lib/ui-metrics.ts";

function memory(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const point = (vodId: string, positionSeconds = 120, durationSeconds = 600): ResumePoint => ({
  vodId,
  channelSlug: "streamer1",
  title: `Video ${vodId}`,
  thumbnailUrl: null,
  positionSeconds,
  durationSeconds,
  updatedAt: "2026-11-07T12:00:00.000Z",
});

describe("resume points", () => {
  test("empty, missing and corrupt storage read as no points", () => {
    expect(readResumePoints(null)).toEqual([]);
    expect(readResumePoints(memory())).toEqual([]);
    expect(readResumePoints(memory({ [RESUME_KEY]: "{not json" }))).toEqual([]);
    expect(readResumePoints(memory({ [RESUME_KEY]: '{"a":1}' }))).toEqual([]);
    expect(readResumePoints(memory({ [RESUME_KEY]: JSON.stringify([{ vodId: 1 }, point("a")]) }))).toEqual([
      point("a"),
    ]);
  });

  test("saving puts the newest first, replaces the same video and keeps at most 20", () => {
    const s = memory();
    for (let i = 0; i < RESUME_MAX + 5; i++) saveResumePoint(point(`v${i}`), s);
    const all = readResumePoints(s);
    expect(all).toHaveLength(RESUME_MAX);
    expect(all[0]?.vodId).toBe(`v${RESUME_MAX + 4}`);
    saveResumePoint(point("v10", 300), s);
    expect(readResumePoints(s)[0]).toMatchObject({ vodId: "v10", positionSeconds: 300 });
    expect(readResumePoints(s).filter((p) => p.vodId === "v10")).toHaveLength(1);
    expect(resumePositionFor("v10", s)).toBe(300);
    expect(resumePositionFor("nope", s)).toBeNull();
  });

  test("near the start or the end clears the point", () => {
    const s = memory();
    saveResumePoint(point("a"), s);
    saveResumePoint(point("a", 10), s);
    expect(readResumePoints(s)).toEqual([]);
    saveResumePoint(point("b"), s);
    saveResumePoint(point("b", 590, 600), s);
    expect(readResumePoints(s)).toEqual([]);
    // Unknown duration (0) never counts as finished.
    saveResumePoint(point("c", 100, 0), s);
    expect(resumePositionFor("c", s)).toBe(100);
    clearResumePoint("c", s);
    expect(readResumePoints(s)).toEqual([]);
  });

  test("a storage that throws on write is ignored", () => {
    const s = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveResumePoint(point("a"), s)).not.toThrow();
  });
});

describe("ui metrics", () => {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<unknown>>(() => Promise.resolve(null));
  const env = (nav: Record<string, unknown> | undefined = {}) => ({ send: fetchMock, nav });
  beforeEach(() => {
    resetUiMetricsForTests();
    fetchMock.mockClear();
  });

  test("GPC and DNT opt out", () => {
    expect(optedOut({ globalPrivacyControl: true })).toBe(true);
    expect(optedOut({ doNotTrack: "1" })).toBe(true);
    expect(optedOut({ doNotTrack: "0" })).toBe(false);
    expect(optedOut({})).toBe(false);
    expect(optedOut(undefined)).toBe(true);
  });

  test("sends one keepalive POST without credentials, views once per load", () => {
    trackUi("home.hero", "view", "none", env());
    trackUi("home.hero", "view", "none", env());
    trackUi("home.hero", "click", "none", env());
    trackUi("authGate", "view", "follow", env());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(UI_METRICS_PATH);
    expect(init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit" });
    expect(JSON.parse(init?.body as string)).toEqual({ surface: "home.hero", action: "view", step: "none" });
  });

  test("sends nothing when opted out, on the server, or when sending throws", () => {
    trackUi("home.hero", "click", "none", env({ globalPrivacyControl: true }));
    trackUi("home.hero", "click", "none", null);
    trackUi("home.hero", "click");
    expect(fetchMock).not.toHaveBeenCalled();
    const boom = {
      send: (() => {
        throw new Error("x");
      }) as unknown as typeof fetch,
      nav: {},
    };
    expect(() => trackUi("home.hero", "click", "none", boom)).not.toThrow();
  });
});
