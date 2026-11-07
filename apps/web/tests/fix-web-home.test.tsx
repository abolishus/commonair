// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * F7 on the home page itself: the signed-in streamer's own channel is in no shelf (nor the hero),
 * and while it is live one "You're live" row leads to the stream manager.
 */
import { cleanup, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MEMBER, boot, home, live, offline, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown, loader: null as unknown }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => new Promise(() => {}) } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
// The page reads its loader data through its own route; hand it the fixture instead.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: object) => ({ options, useLoaderData: () => fake.loader }),
  };
});

const { Route } = await import("../src/routes/_app/index.tsx");
const { resetHomeFeed } = await import("../src/components/discovery/feed.ts");
const { t } = await import("../src/i18n/index.ts");
const options = (
  Route as unknown as { options: { component: React.ComponentType & { preload?: () => Promise<void> } } }
).options;
// Route components are lazy in the build: load the module before rendering it.
await options.component.preload?.();
const Home = options.component;

afterEach(() => {
  cleanup();
  resetHomeFeed();
});

const STREAMER = { ...MEMBER, id: "u2", username: "aurora", channelSlug: "aurora" };
const cards = () =>
  [...document.querySelectorAll('[data-testid="stream-card"], [data-testid="channel-card"]')].map((el) =>
    el.querySelector("a")?.getAttribute("href"),
  );

describe("home for a streamer", () => {
  it("leaves their live channel out of every shelf and shows the You're live row", async () => {
    fake.boot = boot({ me: STREAMER });
    fake.loader = {
      home: home({
        spotlight: [live("aurora", { viewers: 500 }), live("birch", { viewers: 3 })],
        live: [live("aurora", { viewers: 500 }), live("birch", { viewers: 3 })],
      }),
      categories: [],
    };
    await renderInRouter(<Home />);
    const row = await screen.findByTestId("home-own-live");
    expect(row.textContent).toContain(t("fixWeb.home.ownLive.title"));
    expect(screen.getByTestId("home-own-live-manager").getAttribute("href")).toBe("/dashboard");
    expect(screen.getByTestId("home-hero").querySelector("a")?.getAttribute("href")).toBe("/birch");
    expect(cards()).toContain("/birch");
    expect(cards()).not.toContain("/aurora");
  });

  it("offline: no You're live row and no card of their own", async () => {
    fake.boot = boot({ me: STREAMER });
    fake.loader = {
      home: home({ live: [live("birch")], recentlyLive: [offline("aurora"), offline("dune")] }),
      categories: [],
    };
    await renderInRouter(<Home />);
    await screen.findByTestId("directory");
    expect(screen.queryByTestId("home-own-live")).toBeNull();
    const page = screen.getByTestId("directory").textContent ?? "";
    expect(page).toContain("dune");
    expect(page).not.toContain("aurora");
  });

  it("a viewer sees every channel and no status row", async () => {
    fake.boot = boot({ me: MEMBER });
    fake.loader = { home: home({ spotlight: [live("aurora")], live: [live("aurora")] }), categories: [] };
    await renderInRouter(<Home />);
    await screen.findByTestId("directory");
    expect(screen.queryByTestId("home-own-live")).toBeNull();
    expect(screen.getByTestId("home-hero").querySelector("a")?.getAttribute("href")).toBe("/aurora");
  });
});
