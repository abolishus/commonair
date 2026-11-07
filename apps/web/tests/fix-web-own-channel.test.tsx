// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * F7: the signed-in viewer's own channel is never recommended back to them, on home or in the rail
 * and mobile sheet. When it is live, home shows one "You're live" row with the stream manager link.
 */
import { AppShell } from "@commonair/ui/layouts";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MEMBER, boot, home, live, offline, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => new Promise(() => {}) } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));

const { SideRail, SheetDiscovery } = await import("../src/components/discovery/rail.tsx");
const { primeHomeFeed, resetHomeFeed } = await import("../src/components/discovery/feed.ts");
const { ownChannelSlug, withoutOwnChannel } = await import("../src/components/discovery/own-channel.ts");
const { OwnLiveStatus } = await import("../src/components/discovery/own-live-status.tsx");
const { t } = await import("../src/i18n/index.ts");

const STREAMER = { ...MEMBER, id: "u2", username: "aurora", channelSlug: "aurora" };

beforeEach(() => {
  resetHomeFeed();
  sessionStorage.clear();
  fake.boot = boot({ me: STREAMER });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("withoutOwnChannel", () => {
  const feed = home({
    spotlight: [live("aurora", { viewers: 40 }), live("birch")],
    newAndLive: [live("aurora")],
    live: [live("birch"), live("aurora")],
    following: [live("aurora"), live("cedar")],
    recentlyLive: [offline("aurora"), offline("dune")],
    followingOffline: [offline("aurora"), offline("elm")],
  });

  it("removes the channel from every shelf and returns its live card", () => {
    const { home: rest, ownLive } = withoutOwnChannel(feed, "aurora");
    expect(ownLive?.channel.slug).toBe("aurora");
    expect(ownLive?.broadcast.viewerCount).toBe(40);
    const slugs = Object.values(rest).flatMap((cards: { channel: { slug: string } }[]) =>
      cards.map((c) => c.channel.slug),
    );
    expect(slugs).not.toContain("aurora");
    expect(rest.following.map((c) => c.channel.slug)).toEqual(["cedar"]);
    expect(rest.recentlyLive.map((c) => c.channel.slug)).toEqual(["dune"]);
  });

  it("an offline own channel is removed but is not live", () => {
    const offlineOnly = home({ recentlyLive: [offline("aurora")], live: [live("birch")] });
    const { home: rest, ownLive } = withoutOwnChannel(offlineOnly, "aurora");
    expect(ownLive).toBeNull();
    expect(rest.recentlyLive).toEqual([]);
    expect(rest.live.map((c) => c.channel.slug)).toEqual(["birch"]);
  });

  it("keeps the same feed when signed out, without a channel, or when the channel is not in it", () => {
    expect(withoutOwnChannel(feed, null)).toEqual({ home: feed, ownLive: null });
    const other = home({ live: [live("birch")] });
    expect(withoutOwnChannel(other, "aurora").home).toBe(other);
  });

  it("the slug comes from the session's channel, never the username", () => {
    expect(ownChannelSlug(null)).toBeNull();
    expect(ownChannelSlug({ channelSlug: null })).toBeNull();
    expect(ownChannelSlug({ channelSlug: "aurora" })).toBe("aurora");
  });
});

const railRows = () =>
  [...document.querySelectorAll('[data-testid="side-rail-item"]')].map((el) => el.getAttribute("data-channel"));

describe("the rail and the sheet", () => {
  it("a streamer who follows nobody does not see themselves under Live now", async () => {
    primeHomeFeed(home({ live: [live("aurora", { viewers: 99 }), live("birch")] }));
    await renderInRouter(
      <AppShell header={<header />} sidebar={<SideRail />} sidebarPlacement="below" skipLabel="Skip">
        <p>page</p>
      </AppShell>,
    );
    expect(railRows()).toEqual(["birch"]);
  });

  it("nor among the channels they follow, live or offline", async () => {
    primeHomeFeed(
      home({
        following: [live("aurora"), live("cedar")],
        followingOffline: [offline("aurora"), offline("elm")],
        live: [live("aurora")],
      }),
    );
    await renderInRouter(
      <AppShell header={<header />} sidebar={<SideRail />} sidebarPlacement="below" skipLabel="Skip">
        <p>page</p>
      </AppShell>,
    );
    expect(railRows()).toEqual(["cedar", "elm"]);
  });

  it("the mobile sheet leaves it out too", async () => {
    primeHomeFeed(home({ following: [live("aurora"), live("cedar")], live: [live("aurora"), live("birch")] }));
    await renderInRouter(<SheetDiscovery />);
    const items = [...screen.getByTestId("sheet-discovery").querySelectorAll('[data-testid="sheet-rail-item"]')];
    expect(items.map((el) => el.getAttribute("data-channel"))).toEqual(["cedar", "birch"]);
  });

  it("a viewer without a channel sees every channel", async () => {
    fake.boot = boot({ me: MEMBER });
    primeHomeFeed(home({ live: [live("aurora"), live("birch")] }));
    await renderInRouter(
      <AppShell header={<header />} sidebar={<SideRail />} sidebarPlacement="below" skipLabel="Skip">
        <p>page</p>
      </AppShell>,
    );
    expect(railRows()).toEqual(["aurora", "birch"]);
  });
});

describe("OwnLiveStatus", () => {
  it("says you're live, with verified viewers, the uptime and the stream manager link", async () => {
    await renderInRouter(<OwnLiveStatus card={live("aurora", { viewers: 12 })} />);
    const row = screen.getByTestId("home-own-live");
    expect(row.getAttribute("aria-label")).toBe(t("fixWeb.home.ownLive.label"));
    expect(row.textContent).toContain(t("fixWeb.home.ownLive.title"));
    expect(row.textContent).toContain("aurora live");
    expect(row.querySelector('[data-slot="live-badge"]')).not.toBeNull();
    expect(row.querySelector("time")?.getAttribute("datetime")).toMatch(/^P/);
    const manager = screen.getByTestId("home-own-live-manager");
    expect(manager.textContent).toBe(t("fixWeb.home.ownLive.manager"));
    expect(manager.getAttribute("href")).toBe("/dashboard");
  });
});
