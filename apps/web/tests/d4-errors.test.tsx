// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D4 (F13): every not-found and error state explains itself and offers a way forward ("Browse live
 * channels", `empty-state-action`); errors never show their message or stack. Rendered through a
 * router the way the app's root and its `_app`, `_studio` and `_admin` layouts render them, plus a
 * source check that every `<EmptyState>` on an error or not-found path under `routes/**` has an
 * `action` (the files another unit owns wait in PENDING_ACTION).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterContextProvider,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { BROWSE_LIVE_ROUTE } from "../src/lib/browse-route.ts";

/** `<EmptyState …>` opening tags: their attributes run to the first `>` outside braces. */
function emptyStateTags(code: string): { attrs: string; index: number }[] {
  const out: { attrs: string; index: number }[] = [];
  const start = /<EmptyState\b/g;
  for (let m = start.exec(code); m; m = start.exec(code)) {
    let depth = 0;
    let i = start.lastIndex;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    out.push({ attrs: code.slice(start.lastIndex, i), index: m.index });
  }
  return out;
}

// The site chrome needs the bootstrap; these tests are about the states inside it.
vi.mock("../src/components/site-chrome.tsx", () => ({
  AppHeader: () => <header data-testid="app-header" />,
  AppFooter: () => <footer />,
  AppRail: () => null,
}));

const { ChannelNotFoundState, ErrorState, NotFoundState } = await import("../src/components/not-found.tsx");
const { Route: AppRoot } = await import("../src/routes/__root.tsx");
const { Route: AppLayout } = await import("../src/routes/_app.tsx");
const { Route: StudioLayout } = await import("../src/routes/_studio.tsx");
const { Route: AdminLayout } = await import("../src/routes/_admin.tsx");

afterEach(cleanup);

const SECRET = "relation users_private does not exist at line 42";
const opt = (route: { options: object }, name: "notFoundComponent" | "errorComponent") =>
  (route.options as Record<string, unknown>)[name] as never;

function providers(node: React.ReactNode) {
  return (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>
  );
}

/**
 * A root with the app root's not-found page and one layout (`_app`, `_studio` or `_admin`, by id,
 * with that layout's own not-found and error pages) holding a broken page and a missing one.
 */
function renderAt(path: string, layout: { id: "_app" | "_studio" | "_admin"; route: { options: object } }) {
  const root = createRootRoute({ component: () => <Outlet />, notFoundComponent: opt(AppRoot, "notFoundComponent") });
  const shell = createRoute({
    getParentRoute: () => root,
    id: layout.id,
    component: () => (
      <div data-testid="layout">
        <Outlet />
      </div>
    ),
    notFoundComponent: opt(layout.route, "notFoundComponent"),
    errorComponent: opt(layout.route, "errorComponent"),
  });
  const broken = createRoute({
    getParentRoute: () => shell,
    path: "/broken",
    loader: () => {
      throw new Error(SECRET);
    },
    component: () => <p>never</p>,
  });
  const missing = createRoute({
    getParentRoute: () => shell,
    path: "/missing",
    loader: () => {
      throw notFound();
    },
    component: () => <p>never</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([shell.addChildren([broken, missing])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(providers(<RouterProvider router={router} />));
}

async function expectAction() {
  const action = await screen.findByTestId("empty-state-action");
  expect(action.tagName).toBe("A");
  expect(action.getAttribute("href")).toBe(BROWSE_LIVE_ROUTE);
  expect(action.textContent).toBe("Browse live channels");
  return action;
}

const LAYOUTS = [
  { id: "_app", route: AppLayout },
  { id: "_studio", route: StudioLayout },
  { id: "_admin", route: AdminLayout },
] as const;

describe.each(LAYOUTS)("the $id layout", (layout) => {
  it("an error: a calm page with the action and a retry, never the message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderAt("/broken", layout);
    await expectAction();
    expect(screen.getByTestId("error-state").textContent).toContain("This page didn't load");
    expect(screen.getByTestId("error-state-retry").textContent).toBe("Retry");
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toMatch(/at line|stack|Error:/);
    // The boundary replaced the layout: the page brings the site chrome back.
    expect(screen.getByTestId("skip-link")).toBeTruthy();
    expect(screen.getByTestId("app-header")).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("a page that throws notFound: the not-found page with a description and the action", async () => {
    renderAt("/missing", layout);
    await expectAction();
    const state = screen.getByTestId("not-found-state");
    expect(state.textContent).toContain("Page not found");
    expect(state.textContent).toContain("This page does not exist, or it has moved.");
    // Exactly one site chrome, wherever the router put the page.
    await waitFor(() => expect(screen.getAllByTestId("skip-link")).toHaveLength(1));
  });
});

describe("the root", () => {
  it("an unknown URL: the not-found page with the action, in the site chrome", async () => {
    renderAt("/no/such/page/at/all", LAYOUTS[0]);
    await expectAction();
    expect(screen.getAllByTestId("skip-link")).toHaveLength(1);
  });

  it("the root's own error page is a whole document with the action and no message", async () => {
    const failing = createRootRoute({
      loader: () => {
        throw new Error(SECRET);
      },
      component: () => <p>never</p>,
      errorComponent: opt(AppRoot, "errorComponent"),
    });
    const router = createRouter({
      routeTree: failing,
      history: createMemoryHistory({ initialEntries: ["/"] }),
      isServer: true,
    });
    await router.load();
    const html = renderToString(providers(<RouterProvider router={router} />));
    expect(html).toMatch(/^<html[^>]*data-theme="dark"/);
    expect(html).toContain('data-testid="empty-state-action"');
    expect(html).toContain('data-testid="error-state-retry"');
    expect(html).not.toContain(SECRET);
  });
});

describe("the shared states", () => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const wrap = (node: React.ReactNode) =>
    render(<RouterContextProvider router={router}>{providers(node)}</RouterContextProvider>);

  it("ChannelNotFoundState (for D2-channel's `$channel.tsx`) explains and offers the action", async () => {
    wrap(<ChannelNotFoundState />);
    await expectAction();
    const state = screen.getByTestId("channel-not-found");
    expect(state.textContent).toContain("This channel does not exist");
    expect(state.textContent).toContain("No channel has this name.");
  });

  it("NotFoundState takes another primary action (e.g. back to the channel)", () => {
    wrap(
      <NotFoundState
        title="This video is not available"
        action={
          <a data-testid="empty-state-action" href="/aurora">
            Back to Aurora
          </a>
        }
      />,
    );
    expect(screen.getByTestId("empty-state-action").getAttribute("href")).toBe("/aurora");
    expect(screen.getByTestId("not-found-state").textContent).toContain("This page does not exist");
  });

  it("ErrorState retries by reloading the route data, then resetting the boundary", async () => {
    const reset = vi.fn<() => void>();
    const invalidate = vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    wrap(<ErrorState reset={reset} />);
    screen.getByTestId("error-state-retry").click();
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledTimes(1);
    invalidate.mockRestore();
  });

  it("the Spanish states are translated", async () => {
    const { loadLocale, setClientTranslator } = await import("../src/i18n/index.ts");
    setClientTranslator(await loadLocale("es"));
    try {
      wrap(<NotFoundState />);
      expect(screen.getByTestId("empty-state-action").textContent).toBe("Explorar canales en directo");
      expect(screen.getByTestId("not-found-state").textContent).toContain("Página no encontrada");
    } finally {
      setClientTranslator(await loadLocale("en"));
    }
  });
});

/**
 * Route files whose not-found `<EmptyState>` another unit replaces, with that unit. Shrink-only:
 * an entry whose states all have an action fails until it is removed.
 */
const PENDING_ACTION: Readonly<Record<string, string>> = {
  "src/routes/embed.$channel.tsx": "contract request: the embed's not-found links out of the frame",
};

const WEB = join(import.meta.dirname, "..");
/** A not-found or error state: its title says so. */
const DEAD_END = /\bt\("[^"]*(?:notFound|NotFound|error|Error|unavailable|Unavailable)[^"]*"/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name.endsWith(".tsx") ? [full] : [];
  });
}

/** Every `<EmptyState>` on an error or not-found path, as `file:line`, and whether it has an action. */
function deadEnds(): { at: string; file: string; action: boolean }[] {
  return routeFiles(join(WEB, "src/routes")).flatMap((full) => {
    const file = relative(WEB, full);
    const code = readFileSync(full, "utf8");
    return emptyStateTags(code)
      .filter((tag) => DEAD_END.test(tag.attrs))
      .map((tag) => ({
        at: `${file}:${code.slice(0, tag.index).split("\n").length}`,
        file,
        action: /(^|\s)action=/.test(tag.attrs),
      }));
  });
}

describe("every error and not-found EmptyState under routes/** has an action", () => {
  const found = deadEnds();

  it("finds the dead ends it is checking", () => {
    expect(found.map((d) => d.file)).toEqual(expect.arrayContaining(Object.keys(PENDING_ACTION)));
  });

  it("each one passes action (outside PENDING_ACTION)", () => {
    expect(found.filter((d) => !d.action && !(d.file in PENDING_ACTION)).map((d) => d.at)).toEqual([]);
  });

  it.each(Object.entries(PENDING_ACTION))("PENDING_ACTION %s (%s) still lacks one", (file) => {
    expect(existsSync(join(WEB, file))).toBe(true);
    expect(found.some((d) => d.file === file && !d.action)).toBe(true);
  });
});
