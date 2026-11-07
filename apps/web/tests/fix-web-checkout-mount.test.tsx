// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * F12 on the channel route: coming back from checkout to `/$channel?checkout=…` shows the notice
 * above the player and strips the return params from the URL at once.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const fake = vi.hoisted(() => ({
  // Not confirmed yet: the notice stays pending.
  payment: vi.fn<(input: { paymentId: string }) => Promise<never>>(() => new Promise(() => {})),
}));
vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: null, config: { publicUrl: "https://air.example.test" }, now: Date.now() }),
}));
vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api.ts")>();
  // Every other call stays in flight; the page only needs the payment lookup here.
  const pending = new Proxy({}, { get: () => () => new Promise(() => {}) });
  return {
    ...real,
    api: () =>
      new Proxy({}, { get: (_, ns) => (ns === "money" ? { ...pending, paymentBreakdown: fake.payment } : pending) }),
  };
});
vi.mock("../src/lib/use-channel.ts", () => ({ useChannel: (_slug: string, initial: unknown) => initial }));
vi.mock("../src/player/player.tsx", () => ({ Player: () => <div data-testid="player" /> }));
vi.mock("../src/chat/chat-panel.tsx", () => ({ ChatPanel: () => <div data-testid="chat" /> }));
vi.mock("../src/components/support/support-dialog.tsx", () => ({
  SupportButton: () => <span data-testid="support-stub">Support</span>,
}));

const { Route } = await import("../src/routes/_app/$channel.tsx");
type ChannelPage = import("../src/components/channel/panels-loader.ts").ChannelPage;

beforeAll(async () => {
  const c = Route.options.component as { preload?: () => Promise<void> } | undefined;
  await c?.preload?.();
});

afterEach(() => {
  cleanup();
  fake.payment.mockClear();
  window.history.replaceState(null, "", "/");
});

const PAYMENT = "0192f000-0000-7000-8000-0000000000aa";

function page(): ChannelPage {
  return {
    summary: {
      id: "0192f000-0000-7000-8000-000000000001",
      slug: "fern",
      displayName: "Fern",
      title: "Pottery",
      avatarUrl: null,
      accent: null,
      mature: false,
      live: null,
      category: null,
      tags: [],
      lastLiveAt: null,
      followerCount: 1,
      following: null,
      portabilityGrant: null,
      movedTo: null,
    },
    extras: { bannerUrl: null, panels: [], suspended: false },
    about: { bio: "", socials: [] },
    vods: { items: [], nextCursor: null },
    clips: { items: [], nextCursor: null },
  };
}

/** The channel route at `href`, in the browser's URL too (the notice reads `window.location`). */
function renderAt(href: string) {
  window.history.replaceState(null, "", href);
  const root = createRootRoute({ component: () => <Outlet /> });
  const app = createRoute({ getParentRoute: () => root, id: "_app", component: () => <Outlet /> });
  const data = page();
  const channel = createRoute({
    getParentRoute: () => app,
    path: "$channel",
    loader: () => data,
    component: Route.options.component as never,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([channel])]),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

describe("the channel page after checkout (F12)", () => {
  it("success: says the payment arrived, before the player, polls it, and strips the params", async () => {
    renderAt(`/fern?checkout=success&payment=${PAYMENT}&ref=x`);
    const notice = await screen.findByTestId("checkout-return");
    expect(notice.getAttribute("data-state")).toBe("pending");
    expect(notice.textContent).toContain(t("fixWeb.checkout.pending", { channel: "Fern" }));
    await waitFor(() => expect(fake.payment).toHaveBeenCalledWith({ paymentId: PAYMENT }));
    const params = new URLSearchParams(window.location.search);
    expect(params.has("checkout")).toBe(false);
    expect(params.has("payment")).toBe(false);
    expect(params.get("ref")).toBe("x");
    // Announced first: it heads the page's left column, before the stage and the header.
    const header = screen.getByTestId("channel-page").querySelector("section");
    expect(header).toBeTruthy();
    expect(notice.compareDocumentPosition(header as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("canceled: says nothing was charged", async () => {
    renderAt("/fern?checkout=canceled");
    const notice = await screen.findByTestId("checkout-return");
    expect(notice.getAttribute("data-state")).toBe("canceled");
    expect(notice.textContent).toBe(t("fixWeb.checkout.canceled"));
    expect(window.location.search).toBe("");
    expect(fake.payment).not.toHaveBeenCalled();
  });

  it("no return params: no notice", async () => {
    renderAt("/fern");
    await screen.findByTestId("channel-page");
    expect(screen.queryByTestId("checkout-return")).toBeNull();
  });
});
