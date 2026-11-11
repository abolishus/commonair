// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Rail v2 (wave 2, D3.5): steady loading rows of the real height; signed out, Live now, then
 * Recently live, then a sign-up nudge (counted as `rail.followNudge`); signed in, no nudge.
 */
import { AppShell } from "@commonair/ui/layouts";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MEMBER, boot, home, live, offline, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({
  boot: null as unknown,
  home: null as unknown as () => Promise<unknown>,
  tracked: [] as string[],
}));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => fake.home() } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => fake.tracked.push(`${surface}|${action}|${step}`),
}));

const { SideRail, RAIL_SKELETON_ROWS } = await import("../src/components/discovery/rail.tsx");
const { primeHomeFeed, resetHomeFeed } = await import("../src/components/discovery/feed.ts");
const { t } = await import("../src/i18n/index.ts");

function wide(): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width: 1024px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const shell = () => (
  <AppShell header={<header />} sidebar={<SideRail />} sidebarPlacement="below" skipLabel="Skip">
    <p>page</p>
  </AppShell>
);

const groups = () =>
  [...document.querySelectorAll('[data-testid="side-rail"] [data-section]')].map((el) =>
    el.getAttribute("data-section"),
  );

beforeEach(() => {
  fake.boot = boot();
  fake.home = () => new Promise(() => {});
  fake.tracked = [];
  resetHomeFeed();
  sessionStorage.clear();
  wide();
});
afterEach(() => {
  cleanup();
});

describe("rail v2", () => {
  it("draws steady loading rows of the real row height, and no nudge yet", async () => {
    await renderInRouter(shell());
    const loading = screen.getByTestId("side-rail-loading");
    const rows = loading.querySelectorAll('[data-testid="side-rail-skeleton-row"]');
    expect(rows).toHaveLength(RAIL_SKELETON_ROWS);
    // `h-12`: the height of a `SidebarMenuButton size="lg"` row, so the list replaces it in place.
    for (const row of rows) expect(row.className).toContain("h-12");
    expect(loading.textContent).toContain(t("d3Home.rail.loading"));
    expect(screen.queryByTestId("side-rail-nudge")).toBeNull();
  });

  it("signed out: Live now, Recently live (never a live channel twice), then the counted nudge", async () => {
    primeHomeFeed(
      home({ live: [live("a", { viewers: 3 })], recentlyLive: [offline("a"), offline("dune")] }),
      "anonymous",
    );
    await renderInRouter(shell());
    expect(groups()).toEqual(["live", "recent"]);
    const items = [...document.querySelectorAll('[data-testid="side-rail-item"]')].map((el) => [
      el.getAttribute("data-channel"),
      el.getAttribute("data-live"),
    ]);
    expect(items).toEqual([
      ["a", "true"],
      ["dune", "false"],
    ]);
    const nudge = screen.getByTestId("side-rail-nudge");
    expect(nudge.textContent).toContain(t("d3Home.rail.nudge.title"));
    // The nudge opens the sign-up prompt (intent=follow), not a bare /signup link.
    const cta = screen.getByTestId("side-rail-nudge-signup");
    expect(cta.tagName).toBe("BUTTON");
    expect(cta.getAttribute("href")).toBeNull();
    expect(cta.getAttribute("data-auth-gate")).toBe("follow");
    expect(fake.tracked).toContain("rail.followNudge|view|none");
    fireEvent.click(cta);
    expect(fake.tracked).toContain("rail.followNudge|click|follow");
    const gate = await screen.findByTestId("auth-gate");
    expect(gate.getAttribute("data-intent")).toBe("follow");
    expect(gate.textContent).toContain(t("d2Gate.follow.titleNoChannel"));
    const create = new URL(screen.getByTestId("auth-gate-create").getAttribute("href") ?? "", "https://x.invalid");
    expect(create.pathname).toBe("/signup");
    expect(create.searchParams.get("intent")).toBe("follow");
  });

  it("signed out with nobody live still lists who was live lately", async () => {
    primeHomeFeed(home({ recentlyLive: [offline("dune")] }), "anonymous");
    await renderInRouter(shell());
    expect(groups()).toEqual(["recent"]);
    expect(screen.getByText(t("d3Home.rail.recent"))).toBeTruthy();
  });

  it("signed in: followed channels and no nudge", async () => {
    fake.boot = boot({ me: MEMBER });
    primeHomeFeed(home({ following: [live("pal")], recentlyLive: [offline("dune")] }), MEMBER.id);
    await renderInRouter(shell());
    expect(groups()).toEqual(["followed"]);
    expect(screen.queryByTestId("side-rail-nudge")).toBeNull();
  });

  it("collapsed: no nudge", async () => {
    primeHomeFeed(home({ live: [live("a")] }), "anonymous");
    await renderInRouter(shell());
    expect(screen.getByTestId("side-rail-nudge")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId("side-rail-toggle")));
    expect(screen.getByTestId("side-rail").getAttribute("data-state")).toBe("collapsed");
    expect(screen.queryByTestId("side-rail-nudge")).toBeNull();
  });
});
