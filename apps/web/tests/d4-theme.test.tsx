// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D4 (F14, the no-flash half): the server-rendered `<html>` already carries the theme from the
 * cookie, so the first paint is right; and colour transitions stay off (`data-hydrating`) until the
 * app has hydrated, so nothing fades from the server's state into the client's.
 */
import { RouterProvider, createMemoryHistory, createRoute, createRouter } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Bootstrap } from "../src/lib/bootstrap-types.ts";

const fake = vi.hoisted(() => ({ boot: null as unknown }));

vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => fake.boot,
  getSessionUser: async () => null,
  useBootstrap: () => fake.boot,
}));
// Not under test here, and they would fetch.
vi.mock("../src/components/consent/consent-root.tsx", () => ({ ConsentRoot: () => null }));
vi.mock("../src/components/pwa/pwa-root.tsx", () => ({ PwaRoot: () => null }));

const { Route: AppRoot } = await import("../src/routes/__root.tsx");
const { themeFromCookie, THEME_SESSION_KEY } = await import("../src/lib/theme.ts");
const { HYDRATING_ATTRIBUTE, HYDRATING_CSS, rootHtmlAttributes } = await import("../src/lib/root-html.ts");

function boot(over: Partial<Bootstrap> = {}): Bootstrap {
  return {
    config: {} as Bootstrap["config"],
    instance: { name: "Test Air", sourceUrl: null, p2pDefault: "off", chatSafety: false },
    me: null,
    theme: "dark",
    now: 0,
    locale: "en",
    dir: "ltr",
    localeFromUser: false,
    consent: null,
    ...over,
  };
}

const page = createRoute({
  getParentRoute: () => AppRoot,
  path: "/",
  component: () => <main data-testid="page">Page</main>,
});
const routeTree = AppRoot.addChildren([page]);

/** The root rendered on the server for a request with this `Cookie` header. */
async function serverHtml(cookie: string | undefined): Promise<string> {
  fake.boot = boot({ theme: themeFromCookie(cookie) });
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }), isServer: true });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

/** The opening `<html …>` tag's attributes. */
function htmlTag(html: string): Record<string, string> {
  const tag = /^<html([^>]*)>/.exec(html)?.[1] ?? "";
  return Object.fromEntries([...tag.matchAll(/\s([a-z-]+)(?:="([^"]*)")?/g)].map((m) => [m[1] ?? "", m[2] ?? ""]));
}

beforeEach(() => {
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute(HYDRATING_ATTRIBUTE);
  document.documentElement.className = "";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the server-rendered <html> carries the cookie's theme", () => {
  it.each([
    ["no cookie", undefined, "dark", undefined],
    ["dark", "commonair-theme=dark", "dark", undefined],
    ["light", "commonair-theme=light", "light", "light"],
    ["system", "commonair-theme=system", "system", undefined],
    ["among other cookies", "a=1; commonair-theme=light; b=2", "light", "light"],
    ["an unknown value (the default)", "commonair-theme=sepia", "dark", undefined],
  ])("%s → data-theme=%s", async (_name, cookie, theme, className) => {
    const attrs = htmlTag(await serverHtml(cookie));
    expect(attrs["data-theme"]).toBe(theme);
    expect(attrs.class).toBe(className);
    // Transitions are off from the first paint.
    expect(HYDRATING_ATTRIBUTE in attrs).toBe(true);
    expect(attrs.lang).toBe("en");
  });

  it("the head inlines the rule that turns transitions off while hydrating", async () => {
    const html = await serverHtml(undefined);
    expect(html).toContain(`<style>${HYDRATING_CSS}</style>`);
    expect(HYDRATING_CSS).toMatch(/^html\[data-hydrating\] \*, html\[data-hydrating\] \*::before/);
    expect(HYDRATING_CSS).toContain("transition: none !important");
  });

  it("the server and the hydrating client agree on the attributes", () => {
    for (const theme of ["dark", "light", "system"] as const) {
      const server = rootHtmlAttributes({ locale: "es", theme, pathname: "/coop", hydrating: true });
      expect(server).toEqual({
        lang: "es",
        dir: "ltr",
        "data-theme": theme,
        "data-overlay": undefined,
        "data-hydrating": "",
        className: theme === "light" ? "light" : undefined,
      });
    }
    // OBS overlays stay transparent whatever the theme.
    expect(
      rootHtmlAttributes({ locale: "en", theme: "light", pathname: "/overlay/chat", hydrating: false }),
    ).toMatchObject({ className: "bg-transparent", "data-overlay": "true", "data-hydrating": undefined });
  });
});

describe("transitions stay off until hydration", () => {
  it("data-hydrating is set on the first render and removed once hydration has settled", async () => {
    fake.boot = boot({ theme: "light" });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
    await act(async () => {
      render(<RouterProvider router={router} />);
    });
    await screen.findByTestId("page");
    const html = document.documentElement;
    expect(html.getAttribute("data-theme")).toBe("light");
    expect(html.classList.contains("light")).toBe(true);
    expect(html.dataset.hydrated).toBe("true");
    // Still hydrating after the first frame (the tab-only theme may still be settling)…
    expect(html.hasAttribute(HYDRATING_ATTRIBUTE)).toBe(true);
    await act(async () => {
      frames.shift()?.(0);
    });
    expect(html.hasAttribute(HYDRATING_ATTRIBUTE)).toBe(true);
    // …and gone after the second.
    await act(async () => {
      frames.shift()?.(16);
    });
    await waitFor(() => expect(html.hasAttribute(HYDRATING_ATTRIBUTE)).toBe(false));
    vi.restoreAllMocks();
  });

  it("a tab-only theme applies while transitions are still off", async () => {
    fake.boot = boot({ theme: "dark" });
    sessionStorage.setItem(THEME_SESSION_KEY, "light");
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
    await act(async () => {
      render(<RouterProvider router={router} />);
    });
    await screen.findByTestId("page");
    const html = document.documentElement;
    await waitFor(() => expect(html.getAttribute("data-theme")).toBe("light"));
    expect(html.hasAttribute(HYDRATING_ATTRIBUTE)).toBe(true);
    vi.restoreAllMocks();
  });
});
