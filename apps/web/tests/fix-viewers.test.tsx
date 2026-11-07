// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul decision 2 (F6): the health card says "Watching now" (the public live count) beside
 * "Peak so far", with the "final numbers settle after the stream" hint; analytics shows the live
 * broadcast as a provisional "Live now" entry and each listed broadcast's length in the picker.
 */
import type { AnalyticsRange, BroadcastAnalytics } from "@commonair/contracts/dto";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AnalyticsView } from "../src/components/analytics/analytics-page.tsx";
import type { AnalyticsClient } from "../src/components/analytics/client.ts";
import { LiveNowEntry } from "../src/components/analytics/live-now.tsx";
import { StreamHealthCard } from "../src/components/stream-health-card.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { StreamHealthDto } from "../src/lib/stream-health.ts";

vi.mock("../src/components/analytics/group-appeal.tsx", () => ({ GroupAppealAction: () => null }));
vi.mock("../src/components/attestations/panel.tsx", () => ({ AttestationsPanel: () => null }));

afterEach(cleanup);

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const wrap = (node: React.ReactNode) =>
  render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );

const metric = (id: string) => document.querySelector(`[data-testid="stream-health-number"][data-metric="${id}"]`);

const health = (over: Partial<StreamHealthDto> = {}): StreamHealthDto => ({
  live: true,
  broadcastId: "01900000-0000-7000-8000-0000000000b1",
  ingestProtocol: "rtmp",
  transcodeActive: true,
  renditions: [],
  samples: [],
  simulcast: [],
  viewers: { verified: 8, pending: 1, excluded: 2, catchingUp: 0 },
  peakSoFar: 11,
  ...over,
});

describe("health card viewer numbers", () => {
  it("shows Watching now and Peak so far with the settle hint", async () => {
    wrap(<StreamHealthCard channel="aurora" load={async () => health()} />);
    await waitFor(() => expect(screen.getByTestId("stream-health-numbers")).toBeTruthy());
    expect(metric("viewers")?.getAttribute("data-value")).toBe("8");
    expect(metric("viewers")?.textContent).toContain(t("fixViewers.health.watchingNow"));
    expect(metric("peak")?.getAttribute("data-value")).toBe("11");
    expect(metric("peak")?.textContent).toContain(t("fixViewers.health.peakSoFar"));
    expect(metric("catchingUp")).toBeNull(); // none catching up: left out
    expect(screen.getByTestId("stream-health-viewers-hint").textContent).toBe(t("fixViewers.health.hint"));
    expect(t("fixViewers.health.hint")).toContain("Final numbers settle after the stream");
  });

  it("never shows a peak below the count, and shows DVR viewers catching up", async () => {
    wrap(
      <StreamHealthCard
        channel="aurora"
        load={async () => health({ viewers: { verified: 12, pending: 0, excluded: 0, catchingUp: 3 }, peakSoFar: 10 })}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("stream-health-numbers")).toBeTruthy());
    expect(metric("peak")?.getAttribute("data-value")).toBe("12");
    expect(metric("catchingUp")?.getAttribute("data-value")).toBe("3");
    expect(metric("catchingUp")?.textContent).toContain(t("fixViewers.health.catchingUp"));
  });

  it("leaves the peak out when the API does not send one", async () => {
    const { peakSoFar: _, ...older } = health();
    wrap(<StreamHealthCard channel="aurora" load={async () => older} />);
    await waitFor(() => expect(screen.getByTestId("stream-health-numbers")).toBeTruthy());
    expect(metric("peak")).toBeNull();
  });
});

const NOW = Date.parse("2026-11-06T23:57:00.000Z");
const totals = {
  verifiedViewerSeconds: 600,
  unverifiedViewerSeconds: 0,
  excludedViewerSeconds: 0,
  peakVerifiedConcurrent: 4,
  sessions: 12,
};
const B_LONG = "01900000-0000-7000-8000-0000000000a1";
const B_SHORT = "01900000-0000-7000-8000-0000000000a2";
const LIVE = "01900000-0000-7000-8000-0000000000a3";
const range = (over: Partial<AnalyticsRange> = {}): AnalyticsRange => ({
  from: "2026-10-07T23:57:00.000Z",
  to: "2026-11-06T23:57:00.000Z",
  totals,
  broadcasts: [
    { broadcastId: B_LONG, title: "Pixel art", startedAt: "2026-11-06T22:02:07.000Z", durationSeconds: 1773, totals },
    { broadcastId: B_SHORT, title: "Pixel art", startedAt: "2026-11-06T21:51:42.000Z", durationSeconds: 59, totals },
  ],
  delivery: [],
  cost: null,
  live: { broadcastId: LIVE, title: "Pixel art", startedAt: "2026-11-06T22:31:44.000Z", peakSoFar: 16 },
  ...over,
});
const analytics: BroadcastAnalytics = {
  broadcastId: B_LONG,
  title: "Pixel art",
  startedAt: "2026-11-06T22:02:07.000Z",
  endedAt: "2026-11-06T22:31:40.000Z",
  durationSeconds: 1773,
  totals,
  minutes: [],
  minutesRetained: true,
  exclusions: [],
  hiddenGroups: 0,
  delivery: [],
  cost: null,
};
const client = (r: AnalyticsRange): AnalyticsClient => ({
  range: vi.fn<AnalyticsClient["range"]>(async () => r),
  broadcast: vi.fn<AnalyticsClient["broadcast"]>(async () => analytics),
  shareLinks: vi.fn<AnalyticsClient["shareLinks"]>(async () => ({ items: [], nextCursor: null })),
  createShareLink: vi.fn<AnalyticsClient["createShareLink"]>(),
  revokeShareLink: vi.fn<AnalyticsClient["revokeShareLink"]>(),
});

describe("analytics live entry and picker", () => {
  it("shows the live broadcast with its peak so far, apart from the settled list", async () => {
    wrap(<AnalyticsView channel="me" now={NOW} client={client(range())} />);
    await waitFor(() => expect(screen.getByTestId("analytics-live-now")).toBeTruthy());
    const entry = screen.getByTestId("analytics-live-now");
    expect(entry.getAttribute("data-broadcast")).toBe(LIVE);
    expect(screen.getByTestId("analytics-live-peak").getAttribute("data-value")).toBe("16");
    expect(entry.textContent).toContain(t("fixViewers.analytics.live.peak"));
    expect(entry.textContent).toContain(t("fixViewers.analytics.live.body"));
    expect(entry.querySelector("h2")?.textContent).toMatch(/^Live now · started /);
    // The live broadcast is not one of the settled picker's choices.
    expect(screen.getByTestId("analytics-broadcast-select").getAttribute("data-value")).toBe(B_LONG);
  });

  it("shows the live entry even when no broadcast has settled yet", async () => {
    wrap(<AnalyticsView channel="me" now={NOW} client={client(range({ broadcasts: [] }))} />);
    await waitFor(() => expect(screen.getByTestId("analytics-empty")).toBeTruthy());
    expect(screen.getByTestId("analytics-live-now")).toBeTruthy();
  });

  it("has no live entry while offline", async () => {
    wrap(<AnalyticsView channel="me" now={NOW} client={client(range({ live: null }))} />);
    await waitFor(() => expect(screen.getByTestId("analytics-broadcast-select")).toBeTruthy());
    expect(screen.queryByTestId("analytics-live-now")).toBeNull();
    cleanup();
    const { live: _, ...older } = range();
    wrap(<AnalyticsView channel="me" now={NOW} client={client(older)} />);
    await waitFor(() => expect(screen.getByTestId("analytics-broadcast-select")).toBeTruthy());
    expect(screen.queryByTestId("analytics-live-now")).toBeNull();
  });

  it("tells same-titled broadcasts apart by their length", async () => {
    wrap(<AnalyticsView channel="me" now={NOW} client={client(range())} />);
    await waitFor(() => expect(screen.getByTestId("analytics-broadcast-select")).toBeTruthy());
    fireEvent.click(screen.getByTestId("analytics-broadcast-select"));
    await waitFor(() => expect(document.querySelector(`[data-value="${B_SHORT}"][role="option"]`)).toBeTruthy());
    const option = (id: string) => document.querySelector(`[data-value="${id}"][role="option"]`)?.textContent ?? "";
    expect(option(B_LONG)).toMatch(/^Pixel art · .+ · 29:33$/);
    expect(option(B_SHORT)).toMatch(/^Pixel art · .+ · 0:59$/);
  });

  it("names an untitled live broadcast", () => {
    wrap(
      <LiveNowEntry live={{ broadcastId: LIVE, title: "  ", startedAt: "2026-11-06T22:31:44.000Z", peakSoFar: 0 }} />,
    );
    expect(screen.getByTestId("analytics-live-now").textContent).toContain(t("analytics.broadcast.untitled"));
  });
});
