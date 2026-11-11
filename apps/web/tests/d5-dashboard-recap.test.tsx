// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d5-dashboard: the stream recap (overhaul wave 3, D5.3). The rules (when it shows, which broadcast
 * and video, the counts over the stream), viewer numbers only once the analytics settle them, the
 * video's states with Share and Make a clip, dismissing, and the one-time member-owner notice.
 */
import type { AnalyticsRange } from "@commonair/contracts/dto";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  END_MATCH_MS,
  MAX_STREAM_MS,
  RECAP_DISMISSED_KEY,
  RECAP_MAX_AGE_MS,
  averageViewers,
  clipsDuring,
  followsDuring,
  memberNoticeKey,
  readFlag,
  recapVideo,
  recapVisible,
  recapWindow,
  settledBroadcast,
  writeFlag,
} from "../src/components/recap/model.ts";
import { type RecapClient, StreamRecap } from "../src/components/recap/stream-recap.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

// First-party counters: recorded here instead of sent.
const track = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => {
    track.calls.push(`${surface}|${action}|${step}`);
  },
}));

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const wrap = (node: React.ReactNode) =>
  render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ENDED = "2026-11-10T19:50:00.000Z";
const START = "2026-11-10T18:02:00.000Z";
const NOW = Date.parse("2026-11-11T21:00:00.000Z");
const totals = (over: Partial<AnalyticsRange["totals"]> = {}) => ({
  verifiedViewerSeconds: 3 * 6480,
  unverifiedViewerSeconds: 0,
  excludedViewerSeconds: 0,
  peakVerifiedConcurrent: 5,
  sessions: 9,
  ...over,
});
const BROADCAST = {
  broadcastId: "b1",
  title: "Watercolour harbours",
  startedAt: START,
  durationSeconds: 6480,
  totals: totals(),
};
const range = (broadcasts: AnalyticsRange["broadcasts"]): AnalyticsRange => ({
  from: "2026-11-07T00:00:00.000Z",
  to: "2026-11-11T21:00:00.000Z",
  totals: totals(),
  broadcasts,
  delivery: [],
  cost: null,
  live: null,
});

describe("the recap's rules", () => {
  it("shows offline, after a recent stream, until dismissed for that stream", () => {
    const end = Date.parse(ENDED);
    expect(recapVisible({ live: false, lastLiveAt: ENDED, dismissedFor: null }, end + 1000)).toBe(true);
    expect(recapVisible({ live: true, lastLiveAt: ENDED, dismissedFor: null }, end + 1000)).toBe(false);
    expect(recapVisible({ live: false, lastLiveAt: null, dismissedFor: null }, end)).toBe(false);
    expect(recapVisible({ live: false, lastLiveAt: ENDED, dismissedFor: ENDED }, end + 1000)).toBe(false);
    // Dismissing an older stream does not hide the next one's recap.
    expect(recapVisible({ live: false, lastLiveAt: ENDED, dismissedFor: START }, end + 1000)).toBe(true);
    expect(recapVisible({ live: false, lastLiveAt: ENDED, dismissedFor: null }, end + RECAP_MAX_AGE_MS + 1)).toBe(
      false,
    );
    expect(recapVisible({ live: false, lastLiveAt: "nonsense", dismissedFor: null }, end)).toBe(false);
  });

  it("finds the settled broadcast that ended at lastLiveAt, the closest within five minutes", () => {
    const off = { ...BROADCAST, broadcastId: "b0", durationSeconds: 6480 - (END_MATCH_MS / 1000 + 1) };
    const near = { ...BROADCAST, broadcastId: "b2", durationSeconds: 6480 - 60 };
    expect(settledBroadcast([off], ENDED)).toBeNull();
    expect(settledBroadcast([near, BROADCAST], ENDED)?.broadcastId).toBe("b1");
    expect(settledBroadcast([], ENDED)).toBeNull();
  });

  it("averages verified viewer-seconds over the stream, whole", () => {
    expect(averageViewers(BROADCAST)).toBe(3);
    expect(averageViewers({ ...BROADCAST, totals: totals({ verifiedViewerSeconds: 100 }), durationSeconds: 60 })).toBe(
      2,
    );
    expect(averageViewers({ ...BROADCAST, durationSeconds: 0 })).toBe(0);
  });

  it("windows the stream exactly once settled, else as long as a stream can be", () => {
    expect(recapWindow(ENDED, BROADCAST)).toEqual({ start: Date.parse(START), end: Date.parse(ENDED) });
    expect(recapWindow(ENDED, null)).toEqual({ start: Date.parse(ENDED) - MAX_STREAM_MS, end: Date.parse(ENDED) });
  });

  it("picks the newest video made during the stream, and counts follows and clips in it", () => {
    const w = recapWindow(ENDED, BROADCAST);
    const vods = [
      { id: "old", createdAt: "2026-11-09T10:00:00.000Z" },
      { id: "this", createdAt: "2026-11-10T18:02:30.000Z" },
      { id: "next", createdAt: "2026-11-11T10:00:00.000Z" },
    ];
    expect(recapVideo(vods, w)?.id).toBe("this");
    expect(recapVideo([], w)).toBeNull();
    const follows = [
      { followedAt: "2026-11-10T18:30:00.000Z", excluded: false },
      { followedAt: "2026-11-10T18:31:00.000Z", excluded: true },
      { followedAt: "2026-11-10T20:30:00.000Z", excluded: false },
      { followedAt: "2026-11-10T19:49:00.000Z", excluded: false },
    ];
    expect(followsDuring(follows, w)).toBe(2);
    expect(clipsDuring([{ createdAt: "2026-11-10T19:00:00.000Z" }, { createdAt: "2026-11-09T19:00:00.000Z" }], w)).toBe(
      1,
    );
  });

  it("remembers flags in storage and survives storage that throws", () => {
    writeFlag("k", "v");
    expect(readFlag("k")).toBe("v");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readFlag("k", broken)).toBeNull();
    expect(() => writeFlag("k", "v", broken)).not.toThrow();
    expect(readFlag("k", null)).toBeNull();
    expect(memberNoticeKey("aurora")).toContain("aurora");
  });
});

function client(over: Partial<RecapClient> = {}): RecapClient {
  return {
    range: vi.fn<RecapClient["range"]>(async () => range([BROADCAST])),
    vods: vi.fn<RecapClient["vods"]>(async () => [
      { id: "v1", status: "ready", createdAt: "2026-11-10T18:02:30.000Z" },
    ]),
    follows: vi.fn<RecapClient["follows"]>(async () => [
      { followedAt: "2026-11-10T18:30:00.000Z", excluded: false },
      { followedAt: "2026-11-10T19:00:00.000Z", excluded: false },
    ]),
    clips: vi.fn<RecapClient["clips"]>(async () => [{ createdAt: "2026-11-10T19:10:00.000Z" }]),
    revenue: vi.fn<RecapClient["revenue"]>(async () => ({
      net: { cents: 900, currency: "usd" },
      gross: { cents: 1000, currency: "usd" },
    })),
    ...over,
  };
}

const recap = (c: RecapClient, over: Partial<React.ComponentProps<typeof StreamRecap>> = {}) => (
  <StreamRecap
    channel="aurora"
    publicUrl="https://site.test"
    live={false}
    lastLiveAt={ENDED}
    vodEnabled
    member={false}
    client={c}
    now={() => NOW}
    {...over}
  />
);

describe("StreamRecap", () => {
  it("states the settled numbers: length, peak and average verified viewers, follows, earnings, clips", async () => {
    const c = client();
    wrap(recap(c));
    const card = await screen.findByTestId("stream-recap");
    await waitFor(() => expect(card.getAttribute("data-settled")).toBe("true"));
    const stat = (id: string) => document.querySelector(`[data-stat="${id}"]`)?.textContent ?? "";
    expect(stat("duration")).toContain("1:48:00");
    expect(stat("peak")).toContain("5");
    expect(stat("average")).toContain("3");
    expect(stat("followers")).toContain("2");
    expect(stat("support")).toContain("$9.00");
    expect(stat("clips")).toContain("1");
    expect(screen.getByTestId("stream-recap-note").textContent).toContain(t("d5Dashboard.recap.settled"));
    expect(card.textContent).toContain("Watercolour harbours");
    // Revenue over the stream's exact span.
    expect(c.revenue).toHaveBeenCalledWith("aurora", new Date(START).toISOString(), ENDED);
  });

  it("before the numbers settle it says so and states no viewer numbers", async () => {
    const c = client({ range: vi.fn<RecapClient["range"]>(async () => range([])) });
    wrap(recap(c));
    const card = await screen.findByTestId("stream-recap");
    await waitFor(() => expect(card.getAttribute("data-settled")).toBe("false"));
    expect(screen.queryByTestId("stream-recap-stats")).toBeNull();
    expect(screen.getByTestId("stream-recap-note").textContent).toContain(t("d5Dashboard.recap.settling"));
    expect(c.follows).not.toHaveBeenCalled();
    expect(c.revenue).not.toHaveBeenCalled();
    // The video is already known.
    expect(screen.getByTestId("stream-recap-video").getAttribute("data-video")).toBe("ready");
  });

  it("no earnings, no support tile", async () => {
    const c = client({
      revenue: vi.fn<RecapClient["revenue"]>(async () => ({
        net: { cents: 0, currency: "usd" },
        gross: { cents: 0, currency: "usd" },
      })),
    });
    wrap(recap(c));
    await waitFor(() => expect(document.querySelector('[data-stat="duration"]')).toBeTruthy());
    expect(document.querySelector('[data-stat="support"]')).toBeNull();
  });

  it("Share copies the video link; Make a clip opens the video", async () => {
    const writeText = vi.fn<(v: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    wrap(recap(client()));
    fireEvent.click(await screen.findByTestId("stream-recap-share"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://site.test/aurora/vods/v1"));
    expect(screen.getByTestId("stream-recap-clip").getAttribute("href")).toBe("/aurora/vods/v1");
  });

  it.each([
    ["recording", "processing"],
    ["processing", "processing"],
    ["failed", "failed"],
  ] as const)("a %s video reads as %s", async (status, shown) => {
    wrap(
      recap(
        client({
          vods: vi.fn<RecapClient["vods"]>(async () => [{ id: "v1", status, createdAt: "2026-11-10T18:02:30.000Z" }]),
        }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("stream-recap-video").getAttribute("data-video")).toBe(shown));
  });

  it("without a video: offers to turn saving on when it is off", async () => {
    wrap(recap(client({ vods: vi.fn<RecapClient["vods"]>(async () => []) }), { vodEnabled: false }));
    const row = await screen.findByTestId("stream-recap-video");
    expect(row.textContent).toContain(t("d5Dashboard.recap.video.off"));
  });

  it("dismissing hides it and remembers it for that stream", async () => {
    wrap(recap(client()));
    fireEvent.click(await screen.findByTestId("stream-recap-dismiss"));
    expect(screen.queryByTestId("stream-recap")).toBeNull();
    expect(window.localStorage.getItem(RECAP_DISMISSED_KEY)).toBe(ENDED);
    expect(track.calls).toContain("studio.recap|dismiss|none");
  });

  it("shows nothing while live or with no stream yet", () => {
    const view = wrap(recap(client(), { live: true }));
    expect(view.container.querySelector("[data-testid='stream-recap-area']")).toBeNull();
    cleanup();
    const none = wrap(recap(client(), { lastLiveAt: null }));
    expect(none.container.querySelector("[data-testid='stream-recap-area']")).toBeNull();
  });

  it("carries the member-owner notice once", async () => {
    wrap(recap(client(), { member: true }));
    expect(await screen.findByTestId("stream-recap-member")).toBeTruthy();
    expect(screen.getByText(t("d5Dashboard.member.title"))).toBeTruthy();
    fireEvent.click(screen.getByTestId("stream-recap-member-dismiss"));
    expect(screen.queryByTestId("stream-recap-member")).toBeNull();
    expect(window.localStorage.getItem(memberNoticeKey("aurora"))).toBe("1");
    cleanup();
    wrap(recap(client(), { member: true }));
    await screen.findByTestId("stream-recap");
    expect(screen.queryByTestId("stream-recap-member")).toBeNull();
  });

  it("not a member: no notice", async () => {
    wrap(recap(client()));
    await screen.findByTestId("stream-recap");
    expect(screen.queryByTestId("stream-recap-member")).toBeNull();
  });

  it("a failed load shows the section error and Retry", async () => {
    let fail = true;
    const c = client({
      range: vi.fn<RecapClient["range"]>(async () => {
        if (fail) throw Object.assign(new Error("x"), { status: 500 });
        return range([BROADCAST]);
      }),
    });
    wrap(recap(c));
    expect(await screen.findByTestId("stream-recap-error")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByTestId("stream-recap-retry"));
    await waitFor(() => expect(screen.getByTestId("stream-recap").getAttribute("data-settled")).toBe("true"));
  });
});
