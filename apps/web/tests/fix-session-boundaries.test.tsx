// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * F1/F2 on the error boundaries: a guard's `SessionUnavailableError` or a loader's 429/503 is a
 * busy API, not a broken page, so each layout's boundary shows `PageLoadError` (it retries by
 * itself) in place of the generic error page. Anything else still gets the generic page.
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
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { resetPageAttemptsForTests } from "../src/lib/page-load-error.tsx";
import { SessionUnavailableError } from "../src/lib/session.ts";

vi.mock("../src/components/site-chrome.tsx", () => ({
  AppHeader: () => <header data-testid="app-header" />,
  AppFooter: () => <footer />,
  AppRail: () => null,
}));

const { Route: AppLayout } = await import("../src/routes/_app.tsx");
const { Route: StudioLayout } = await import("../src/routes/_studio.tsx");
const { Route: AdminLayout } = await import("../src/routes/_admin.tsx");

beforeEach(resetPageAttemptsForTests);
afterEach(cleanup);

const errorComponent = (route: { options: object }) =>
  (route.options as Record<string, unknown>).errorComponent as never;

/** A layout (by id, with that layout's own error boundary) whose one page's loader throws `error`. */
function renderFailing(id: "_app" | "_studio" | "_admin", layout: { options: object }, error: () => unknown) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const shell = createRoute({
    getParentRoute: () => root,
    id,
    component: () => <Outlet />,
    errorComponent: errorComponent(layout),
  });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "/page",
    loader: () => {
      throw error();
    },
    component: () => <p>never</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([shell.addChildren([page])]),
    history: createMemoryHistory({ initialEntries: ["/page"] }),
  });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

const LAYOUTS = [
  ["_studio", StudioLayout],
  ["_app", AppLayout],
  ["_admin", AdminLayout],
] as const;

describe("a layout's error boundary for a busy API", () => {
  it.each(LAYOUTS)("%s: a SessionUnavailableError is the page-load error, never polish.error.*", async (id, layout) => {
    renderFailing(id, layout, () => new SessionUnavailableError(5));
    const page = await screen.findByTestId("page-load-error");
    expect(page.querySelector("h1")?.textContent).toBe(en["fixSession.load.pageTitle"]);
    expect(page.getAttribute("data-busy")).toBe("true");
    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(document.body.textContent).not.toContain(en["polish.error.description"]);
  });

  it("_studio: a loader's 429 is the page-load error too", async () => {
    renderFailing("_studio", StudioLayout, () =>
      Object.assign(new Error("busy"), { code: "RATE_LIMITED", status: 429, data: { retryAfterSeconds: 4 } }),
    );
    expect(await screen.findByTestId("page-load-error")).toBeTruthy();
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("_studio: a bug is still the generic error page", async () => {
    renderFailing("_studio", StudioLayout, () => new Error("bug"));
    expect(await screen.findByTestId("error-state")).toBeTruthy();
    expect(screen.queryByTestId("page-load-error")).toBeNull();
  });
});
