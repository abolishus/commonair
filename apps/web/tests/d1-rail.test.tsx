// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D1-web (F7): the left rail. Signed out it lists the channels live now; signed in, the followed
 * channels, live first. It is expanded from `lg` and collapsed below, keeps the viewer's toggle for
 * the tab, and still works when storage throws.
 */
import { AppShell } from "@commonair/ui/layouts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ART, MEMBER, boot, home, live, offline, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({
  boot: null as unknown,
  home: null as unknown as () => Promise<unknown>,
}));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => fake.home() } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));

const { SideRail, SheetDiscovery } = await import("../src/components/discovery/rail.tsx");
const { primeHomeFeed, resetHomeFeed } = await import("../src/components/discovery/feed.ts");
const { RAIL_KEY } = await import("../src/components/discovery/tab-storage.ts");

/** `matchMedia` with `lg` (min-width: 1024px) on or off; never the shadcn phone breakpoint. */
function screenWidth(wide: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width: 1024px") ? wide : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function shell() {
  return (
    <AppShell header={<header />} sidebar={<SideRail />} sidebarPlacement="below" skipLabel="Skip">
      <p>page</p>
    </AppShell>
  );
}

const rows = () =>
  [...document.querySelectorAll('[data-testid="side-rail-item"]')].map((el) => [
    el.getAttribute("data-channel"),
    el.getAttribute("data-live"),
  ]);
const rail = () => screen.getByTestId("side-rail");

beforeEach(() => {
  fake.boot = boot();
  fake.home = () => new Promise(() => {});
  resetHomeFeed();
  sessionStorage.clear();
  screenWidth(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("what the rail lists", () => {
  it("shows placeholders while the feed loads, then says when it failed", async () => {
    let fail: (err: Error) => void = () => {};
    fake.home = () => new Promise((_, reject) => (fail = reject));
    await renderInRouter(shell());
    expect(rail().querySelector('[data-slot="skeleton"]')).not.toBeNull();
    await act(async () => fail(new Error("down")));
    expect(await screen.findByText("The channel list could not be loaded.")).toBeTruthy();
  });

  it("signed out: Live now, busiest first, with the live badge and verified viewers", async () => {
    fake.home = async () =>
      home({ live: [live("quiet", { viewers: 2 }), live("busy", { viewers: 90, category: ART })] });
    await renderInRouter(shell());
    await waitFor(() =>
      expect(rows()).toEqual([
        ["busy", "true"],
        ["quiet", "true"],
      ]),
    );
    expect(rail().textContent).toContain("Live now");
    expect(rail().textContent).not.toContain("Followed channels");
    const busy = rail().querySelector('[data-channel="busy"]') as HTMLElement;
    expect(busy.querySelector("a")?.getAttribute("href")).toBe("/busy");
    expect(busy.textContent).toContain("Art");
    expect(busy.querySelector('[data-slot="live-badge"]')).not.toBeNull();
  });

  it("signed in: Followed, live first, then offline with when they were last live", async () => {
    fake.boot = boot({ me: MEMBER });
    primeHomeFeed(
      home({
        following: [live("small", { viewers: 1 }), live("big", { viewers: 50 })],
        followingOffline: [offline("napping", "2026-11-04T10:00:00.000Z")],
        live: [live("stranger", { viewers: 999 })],
      }),
    );
    await renderInRouter(shell());
    expect(rows()).toEqual([
      ["big", "true"],
      ["small", "true"],
      ["napping", "false"],
    ]);
    expect(rail().textContent).toContain("Followed channels");
    const napping = rail().querySelector('[data-channel="napping"]') as HTMLElement;
    expect(napping.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-04T10:00:00.000Z");
    expect(napping.querySelector('[data-slot="live-badge"]')).toBeNull();
  });

  it("shows @handle when two rows share a name", async () => {
    primeHomeFeed(home({ live: [live("twin_a", { name: "Twin" }), live("twin_b", { name: "Twin" })] }));
    await renderInRouter(shell());
    expect(rail().textContent).toContain("Twin (@twin_a)");
    expect(rail().textContent).toContain("Twin (@twin_b)");
  });

  it("the mobile sheet carries Following, Live now and Categories", async () => {
    fake.boot = boot({ me: MEMBER });
    primeHomeFeed(home({ following: [live("pal")], live: [live("pal"), live("other", { category: ART })] }));
    await renderInRouter(<SheetDiscovery />);
    const sheet = screen.getByTestId("sheet-discovery");
    const groups = [...sheet.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"));
    expect(groups).toEqual(["Followed channels", "Live now", "Categories"]);
    // A followed channel is not repeated under Live now.
    expect(
      [...sheet.querySelectorAll('[data-testid="sheet-rail-item"]')].map((el) => el.getAttribute("data-channel")),
    ).toEqual(["pal", "other"]);
    expect(sheet.querySelector('a[href="/directory/art"]')).not.toBeNull();
  });
});

describe("collapsing", () => {
  beforeEach(() => primeHomeFeed(home({ live: [live("a")] })));

  it("is expanded from lg and collapsed below it, until the viewer chooses", async () => {
    await renderInRouter(shell());
    expect(rail().getAttribute("data-state")).toBe("expanded");
    cleanup();
    screenWidth(false);
    await renderInRouter(shell());
    await waitFor(() => expect(rail().getAttribute("data-state")).toBe("collapsed"));
    expect(screen.getByRole("button", { name: "Expand the channel list" })).toBeTruthy();
  });

  it("keeps the viewer's choice for the tab", async () => {
    await renderInRouter(shell());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse the channel list" }));
    });
    expect(rail().getAttribute("data-state")).toBe("collapsed");
    expect(sessionStorage.getItem(RAIL_KEY)).toBe("collapsed");
    cleanup();
    // Wide again, but the tab remembers.
    await renderInRouter(shell());
    await waitFor(() => expect(rail().getAttribute("data-state")).toBe("collapsed"));
  });

  it("still renders and toggles when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    await renderInRouter(shell());
    expect(rows()).toEqual([["a", "true"]]);
    expect(rail().getAttribute("data-state")).toBe("expanded");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse the channel list" }));
    });
    expect(rail().getAttribute("data-state")).toBe("collapsed");
  });
});
