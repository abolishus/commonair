// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The OBS overlay pages as the browser source sees them: a transparent root on `/overlay/*`
 * only, the merged head (no-referrer, the root's color-scheme replaced), the goals and chat
 * overlays (refused without a token), and the overlay's API client and `EventSource` carrying no cookies.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  HeadContent,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { browserOverlayDeps } from "../src/components/overlay-alerts-page.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { overlayApi } from "../src/lib/api.ts";
import { rootChrome } from "../src/lib/overlay-page.ts";
import { Route as AppRoot } from "../src/routes/__root.tsx";
import { Route as ChatRoute } from "../src/routes/overlay.chat.tsx";
import { Route as GoalsRoute } from "../src/routes/overlay.goals.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const meta of document.head.querySelectorAll("meta, title")) meta.remove();
});

describe("root chrome", () => {
  it.each(["/overlay/alerts", "/overlay/goals", "/overlay/chat"])("%s: transparent, data-overlay", (path) => {
    for (const theme of ["dark", "light"]) {
      const chrome = rootChrome(path, theme);
      expect(chrome.dataOverlay).toBe("true");
      expect(chrome.htmlClass).toBe("bg-transparent");
      expect(chrome.bodyClass.split(" ")).toContain("bg-transparent");
      expect(chrome.bodyClass).not.toMatch(/\bbg-background\b|\btext-foreground\b/);
    }
  });

  it.each(["/dashboard", "/overlays", "/overlay", "/"])("%s: the themed background, no data-overlay", (path) => {
    const dark = rootChrome(path, "dark");
    expect(dark.dataOverlay).toBeUndefined();
    expect(dark.htmlClass).toBeUndefined();
    expect(dark.bodyClass.split(" ")).toEqual(expect.arrayContaining(["bg-background", "text-foreground"]));
    expect(dark.bodyClass).not.toContain("bg-transparent");
    expect(rootChrome(path, "light").htmlClass).toBe("light");
  });
});

type HeadFn = () => { meta?: React.JSX.IntrinsicElements["meta"][] };
const headOf = (route: { options: { head?: unknown } }) => route.options.head as HeadFn;
const componentOf = (route: { options: { component?: unknown } }) => route.options.component as () => React.JSX.Element;

/** The app root's head over the real overlay routes, merged by the router as in the app. */
function renderOverlay(path: string) {
  const root = createRootRoute({
    head: headOf(AppRoot),
    // The goals overlay reads the instance currency from the root's bootstrap.
    loader: () => ({ config: { currency: "usd" } }),
    component: () => (
      <>
        <HeadContent />
        <Outlet />
      </>
    ),
  });
  const child = (route: typeof GoalsRoute | typeof ChatRoute, at: string) =>
    createRoute({ getParentRoute: () => root, path: at, head: headOf(route), component: componentOf(route) });
  const router = createRouter({
    routeTree: root.addChildren([child(GoalsRoute, "/overlay/goals"), child(ChatRoute, "/overlay/chat")]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

const metas = (name: string) =>
  [...document.querySelectorAll(`meta[name="${name}"]`)].map((meta) => meta.getAttribute("content"));

describe("goals and chat overlays and head", () => {
  it.each([
    ["/overlay/goals", "overlay-goals"],
    ["/overlay/chat", "overlay-chat"],
  ])("%s renders %s (refused without a token) with the overlay head", async (path, id) => {
    renderOverlay(path);
    const overlay = await screen.findByTestId(id);
    await waitFor(() => expect(overlay.getAttribute("data-state")).toBe("refused"));
    expect(document.querySelector('[data-testid="overlay-placeholder"]')).toBeNull();
    await waitFor(() => expect(metas("referrer")).toEqual(["no-referrer"]));
    // The overlay's color-scheme replaces the root's `dark light`, which would paint a canvas.
    expect(metas("color-scheme")).toEqual(["normal"]);
    expect(metas("robots")).toEqual(["noindex, nofollow"]);
    // The root's own tags survive the merge.
    expect(metas("viewport")).toEqual(["width=device-width, initial-scale=1"]);
  });
});

describe("overlay API client", () => {
  it("sends the token as a bearer with no cookies and no referrer", async () => {
    const calls: { request: Request; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request, init?: RequestInit) => {
        calls.push({ request, init });
        return new Response(JSON.stringify({ json: { eventsUrl: "https://api.example/e" } }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await overlayApi("tok")
      .interact.overlays.state()
      .catch(() => undefined);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect(call.request.headers.get("authorization")).toBe("Bearer tok");
    expect(new URL(call.request.url).pathname.startsWith("/rpc")).toBe(true);
    expect(call.init?.credentials).toBe("omit");
    expect(call.init?.referrerPolicy).toBe("no-referrer");
    // What the browser would actually send: the init overrides whatever the Request carried.
    const effective = new Request(call.request, call.init);
    expect(effective.credentials).toBe("omit");
    expect(effective.referrerPolicy).toBe("no-referrer");
  });

  it("opens the overlay stream without credentials", () => {
    const opened: { url: string; init: unknown }[] = [];
    class FakeEventSource {
      constructor(url: string, init?: unknown) {
        opened.push({ url, init });
      }
      addEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    browserOverlayDeps("tok").openEvents("https://api.example/overlay/events?token=tok");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.url).toBe("https://api.example/overlay/events?token=tok");
    const init = opened[0]?.init as { withCredentials?: boolean } | undefined;
    expect(init?.withCredentials ?? false).toBe(false);
  });
});
