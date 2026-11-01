// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The studio analytics page (docs/testing/w2-selectors.md "Analytics"), rendered with a fake
 * client: the pickers, verified and unverified seconds, excluded groups with the appeal mount,
 * "n small groups hidden", delivery shares, cost, the pending and empty states, share links.
 */
import type { AnalyticsRange, AnalyticsShareLink, BroadcastAnalytics } from "@commonair/contracts/dto";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AnalyticsView } from "../src/components/analytics/analytics-page.tsx";
import { type AnalyticsClient, allPages } from "../src/components/analytics/client.ts";
import {
  deliveryShares,
  hoursOf,
  minuteRows,
  parseRangeDays,
  pickBroadcast,
  rangeFor,
} from "../src/components/analytics/data.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

// Both fetch on their own (their own tests cover them); stubbed so this file makes no requests.
vi.mock("../src/components/analytics/group-appeal.tsx", () => ({ GroupAppealAction: () => null }));
vi.mock("../src/components/attestations/panel.tsx", () => ({ AttestationsPanel: () => null }));

afterEach(cleanup);

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const B1 = "01900000-0000-7000-8000-0000000000b1";
const B2 = "01900000-0000-7000-8000-0000000000b2";
const totals = {
  verifiedViewerSeconds: 7200,
  unverifiedViewerSeconds: 300,
  excludedViewerSeconds: 3600,
  peakVerifiedConcurrent: 4,
  sessions: 20,
};

const range: AnalyticsRange = {
  from: "2026-10-01T12:00:00.000Z",
  to: "2026-10-31T12:00:00.000Z",
  totals,
  broadcasts: [
    { broadcastId: B1, title: "Late show", startedAt: "2026-10-29T20:00:00.000Z", durationSeconds: 3600, totals },
    { broadcastId: B2, title: "", startedAt: "2026-10-20T20:00:00.000Z", durationSeconds: 3600, totals },
  ],
  delivery: [],
  cost: { cents: 40, currency: "usd" },
};

const analytics: BroadcastAnalytics = {
  broadcastId: B1,
  title: "Late show",
  startedAt: "2026-10-29T20:00:00.000Z",
  endedAt: "2026-10-29T21:00:00.000Z",
  durationSeconds: 3600,
  totals,
  minutes: [
    { at: "2026-10-29T20:00:00.000Z", verified: 3, unverified: 1, excluded: 6 },
    { at: "2026-10-29T20:01:00.000Z", verified: 4, unverified: 0, excluded: 6 },
  ],
  minutesRetained: true,
  exclusions: [{ category: "datacenter", sessions: 12, viewerSeconds: 3600 }],
  hiddenGroups: 2,
  delivery: [
    { source: "origin", bytes: 6_000_000_000, verifiedViewerSeconds: 3600 },
    { source: "relay", bytes: 4_000_000_000, verifiedViewerSeconds: 3600 },
  ],
  cost: { cents: 12, currency: "usd" },
};

const link: AnalyticsShareLink = {
  id: "01900000-0000-7000-8000-0000000000l1",
  broadcastId: B1,
  url: null,
  expiresAt: "2026-11-30T12:00:00.000Z",
  revokedAt: null,
  createdAt: "2026-10-31T11:00:00.000Z",
};

type C = AnalyticsClient;
function fakeClient(over: Partial<AnalyticsClient> = {}): AnalyticsClient {
  return {
    range: vi.fn<C["range"]>(async () => range),
    broadcast: vi.fn<C["broadcast"]>(async () => analytics),
    shareLinks: vi.fn<C["shareLinks"]>(async () => ({ items: [link], nextCursor: null })),
    createShareLink: vi.fn<C["createShareLink"]>(async () => ({
      ...link,
      id: "01900000-0000-7000-8000-0000000000l2",
      url: "https://x/t",
    })),
    revokeShareLink: vi.fn<C["revokeShareLink"]>(async () => ({ ok: true })),
    ...over,
  };
}

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const byId = (id: string) => document.querySelectorAll(`[data-testid="${id}"]`);

describe("AnalyticsView", () => {
  it("shows the newest broadcast with its figures, groups, delivery and cost", async () => {
    const client = fakeClient();
    wrap(<AnalyticsView channel="me" now={NOW} client={client} />);
    await waitFor(() => expect(byId("analytics-verified")).toHaveLength(1));
    expect(client.range).toHaveBeenCalledWith({ channel: "me", ...rangeFor(30, NOW) });
    expect(client.broadcast).toHaveBeenCalledWith({ channel: "me", broadcastId: B1 });
    expect(byId("analytics-page")).toHaveLength(1);
    expect(byId("analytics-range")[0]?.getAttribute("data-value")).toBe("30");
    expect(byId("analytics-broadcast-select")[0]?.getAttribute("data-value")).toBe(B1);
    expect(byId("analytics-verified")[0]?.getAttribute("data-seconds")).toBe("7200");
    expect(byId("analytics-unverified")[0]?.getAttribute("data-seconds")).toBe("300");
    expect(byId("analytics-cost")[0]?.getAttribute("data-cents")).toBe("12");

    const groups = byId("analytics-excluded-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.getAttribute("data-category")).toBe("datacenter");
    expect(groups[0]?.getAttribute("data-sessions")).toBe("12");
    expect(groups[0]?.getAttribute("data-seconds")).toBe("3600");
    expect(groups[0]?.textContent).toContain("Data-centre networks");
    expect(byId("analytics-small-groups-hidden")[0]?.getAttribute("data-count")).toBe("2");
    expect(byId("analytics-small-groups-hidden")[0]?.textContent).toContain("2 small groups hidden");

    const sources = [...byId("analytics-delivery-source")];
    expect(sources.map((s) => [s.getAttribute("data-source"), s.getAttribute("data-share-bps")])).toEqual([
      ["origin", "6000"],
      ["relay", "4000"],
    ]);
    expect(sources[1]?.textContent).toContain("Community relays delivered 40%");

    await waitFor(() => expect(byId("analytics-share-link")).toHaveLength(1));
    expect(byId("analytics-share-link")[0]?.getAttribute("data-link-id")).toBe(link.id);
    expect(byId("analytics-share-link")[0]?.getAttribute("data-expires-at")).toBe(link.expiresAt);
    expect(byId("analytics-share-revoke")).toHaveLength(1);
  });

  it("opens the chart's table fallback", async () => {
    wrap(<AnalyticsView channel="me" now={NOW} client={fakeClient()} />);
    await waitFor(() => expect(byId("analytics-verified")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Show as a table" }));
    await waitFor(() => expect(byId("analytics-chart-table")).toHaveLength(1));
    expect(byId("analytics-chart-table")[0]?.textContent).toContain("1:00");
  });

  it("says when a broadcast is not available yet", async () => {
    const pending = Object.assign(new Error("pending"), {
      code: "PRECONDITION_FAILED",
      data: { requirement: "analytics_pending" },
    });
    wrap(
      <AnalyticsView
        channel="me"
        now={NOW}
        client={fakeClient({
          broadcast: vi.fn<C["broadcast"]>(async () => {
            throw pending;
          }),
        })}
      />,
    );
    await waitFor(() => expect(byId("analytics-pending")).toHaveLength(1));
    expect(byId("analytics-verified")).toHaveLength(0);
  });

  it("an empty period explains the 24 h delay; a failed load offers a retry", async () => {
    wrap(
      <AnalyticsView
        channel="me"
        now={NOW}
        client={fakeClient({ range: vi.fn<C["range"]>(async () => ({ ...range, broadcasts: [] })) })}
      />,
    );
    await waitFor(() => expect(screen.getByText("No broadcasts to show yet")).toBeTruthy());
    cleanup();
    const failing = fakeClient({ range: vi.fn<C["range"]>(async () => Promise.reject(new Error("down"))) });
    wrap(<AnalyticsView channel="me" now={NOW} client={failing} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
  });

  it("creates a share link and shows it once; retention leaves only totals", async () => {
    const client = fakeClient({
      broadcast: vi.fn<C["broadcast"]>(async () => ({ ...analytics, minutes: [], minutesRetained: false })),
    });
    wrap(<AnalyticsView channel="me" now={NOW} client={client} />);
    await waitFor(() => expect(byId("analytics-share-create")).toHaveLength(1));
    expect(screen.getByText(/kept for 90 days/)).toBeTruthy();
    fireEvent.click(byId("analytics-share-create")[0] as HTMLElement);
    await waitFor(() => expect(client.createShareLink).toHaveBeenCalledWith({ channel: "me", broadcastId: B1 }));
    await waitFor(() => expect(screen.getByDisplayValue("https://x/t")).toBeTruthy());
  });
});

describe("analytics data helpers", () => {
  it("delivery shares sum to 10,000 basis points", () => {
    const row = (bytes: number) => ({ source: "origin" as const, bytes, verifiedViewerSeconds: 0 });
    expect(deliveryShares([row(1), row(1), row(1)])).toEqual([3334, 3333, 3333]);
    expect(deliveryShares([row(0), row(0)])).toEqual([0, 0]);
    expect(deliveryShares([])).toEqual([]);
  });

  it("hours, minute offsets, the period and the picked broadcast", () => {
    expect(hoursOf(5400, "en")).toBe("1.5");
    expect(hoursOf(5400, "es")).toBe("1,5");
    expect(minuteRows(analytics).map((r) => r.offset)).toEqual(["0:00", "1:00"]);
    expect(parseRangeDays("7")).toBe(7);
    expect(parseRangeDays("13")).toBe(30);
    expect(rangeFor(7, NOW)).toEqual({ from: "2026-10-24T12:00:00.000Z", to: "2026-10-31T12:00:00.000Z" });
    expect(pickBroadcast(range.broadcasts, B2)).toBe(B2);
    expect(pickBroadcast(range.broadcasts, "gone")).toBe(B1);
    expect(pickBroadcast([], null)).toBeNull();
  });
});

describe("allPages", () => {
  const pages: Record<string, { items: number[]; nextCursor: string | null }> = {
    start: { items: [1, 2], nextCursor: "b" },
    b: { items: [3], nextCursor: "c" },
    c: { items: [4], nextCursor: null },
  };
  const fetchPage = vi.fn<(cursor: string | undefined) => Promise<{ items: number[]; nextCursor: string | null }>>(
    async (cursor) => pages[cursor ?? "start"]!,
  );

  it("follows the cursor to the last page", async () => {
    expect(await allPages(fetchPage)).toEqual({ items: [1, 2, 3, 4], nextCursor: null });
  });

  it("stops at the page cap and says where it stopped", async () => {
    expect(await allPages(fetchPage, 2)).toEqual({ items: [1, 2, 3], nextCursor: "c" });
  });
});
