// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D4 (F15, WCAG 2.4.2): every page has its own document title, "<page> · <site>", in the visitor's
 * language, and it follows a language switch (the root invalidates the router, which re-runs
 * `head()`). The source-policy test checks that every route sets one.
 */
import { SITE } from "@commonair/config/site";
import {
  HeadContent,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { loadLocale, setClientTranslator } from "../src/i18n/index.ts";
import { TITLE_SEPARATOR, pageTitle, titleHead } from "../src/lib/page-title.ts";

// Route modules import the bootstrap (a server function) and the API client; heads need neither.
vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: null, instance: { name: "Test Air" } }),
}));

const { Route: AppRoot } = await import("../src/routes/__root.tsx");
const { Route: Home } = await import("../src/routes/_app/index.tsx");
const { Route: Coop } = await import("../src/routes/_app/coop.index.tsx");
const { Route: Transparency } = await import("../src/routes/_app/transparency.tsx");
const { Route: SignUp } = await import("../src/routes/_app/signup.tsx");
const { Route: Dashboard } = await import("../src/routes/_studio/dashboard.tsx");
const { Route: Treasury } = await import("../src/routes/_admin/treasury.tsx");
const { Route: Preferences } = await import("../src/routes/_app/settings.preferences.tsx");
const { Route: MoveLanding } = await import("../src/routes/_app/m.$channel.$nonce.tsx");
const { Route: Embed } = await import("../src/routes/embed.$channel.tsx");

afterEach(async () => {
  cleanup();
  setClientTranslator(await loadLocale("en"));
  for (const el of document.head.querySelectorAll("meta, title, style")) el.remove();
});

type Head = (ctx: unknown) => { meta?: { title?: string }[] };
const titleOf = (route: { options: object }, ctx: unknown = {}): string | undefined =>
  ((route.options as { head?: Head }).head?.(ctx).meta ?? []).find((m) => m.title !== undefined)?.title;

const T = (page: string) => `${page}${TITLE_SEPARATOR}${SITE.name}`;

describe("pageTitle", () => {
  it("is the page, a middle dot, and the site name", () => {
    expect(pageTitle("Co-op")).toBe(`Co-op · ${SITE.name}`);
    expect(TITLE_SEPARATOR).toBe(" · ");
  });

  it("trims the page, and an empty page is the site name alone", () => {
    expect(pageTitle("  Transparency ")).toBe(T("Transparency"));
    expect(pageTitle("")).toBe(SITE.name);
    expect(pageTitle("   ")).toBe(SITE.name);
  });

  it("keeps long and non-Latin names whole", () => {
    const long = "Solicitar la retirada de imágenes íntimas";
    expect(pageTitle(long)).toBe(T(long));
    expect(pageTitle("ストリーム")).toBe(T("ストリーム"));
  });

  it("titleHead is the head() of a page with only a title", () => {
    expect(titleHead("Co-op")).toEqual({ meta: [{ title: T("Co-op") }] });
  });
});

describe("route titles", () => {
  const sample = [
    [Home, "Live channels", "Canales en directo"],
    [Coop, "Co-op", "Cooperativa"],
    [Transparency, "Transparency", "Transparencia"],
    [SignUp, "Sign up", "Registrarse"],
    [Dashboard, "Stream manager", "Gestor de transmisión"],
    [Treasury, "Treasury", "Tesorería"],
    [Preferences, "Preferences", "Preferencias"],
  ] as const;

  it.each(sample)("%#: in English", (route, en) => {
    expect(titleOf(route)).toBe(T(en));
  });

  it.each(sample)("%#: in Spanish", async (route, _en, es) => {
    setClientTranslator(await loadLocale("es"));
    expect(titleOf(route)).toBe(T(es));
  });

  it("every sampled page has a different title", () => {
    const titles = sample.map(([route]) => titleOf(route));
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("titles from params and loader data", async () => {
    expect(titleOf(MoveLanding, { params: { channel: "aurora", nonce: "n" } })).toBe(T("aurora has moved"));
    expect(titleOf(Embed, { params: { channel: "aurora" }, loaderData: { displayName: "Aurora Pixel" } })).toBe(
      T("Aurora Pixel"),
    );
    // Before the loader has data (a pending match), the slug.
    expect(titleOf(Embed, { params: { channel: "aurora" } })).toBe(T("aurora"));
    setClientTranslator(await loadLocale("es"));
    expect(titleOf(MoveLanding, { params: { channel: "aurora", nonce: "n" } })).toBe(T("aurora se ha mudado"));
  });

  it("the root keeps the tagline as the fallback", () => {
    expect(titleOf(AppRoot)).toBe("Live streaming, owned by the people who make it");
  });
});

describe("document.title in the router", () => {
  function renderAt(path: string) {
    type Opts = { head?: Head; options: object };
    const headOf = (route: Opts) => (route.options as { head?: Head }).head as never;
    const root = createRootRoute({
      head: headOf(AppRoot as unknown as Opts),
      component: () => (
        <>
          <HeadContent />
          <Outlet />
        </>
      ),
    });
    const child = (route: Opts, at: string) =>
      createRoute({ getParentRoute: () => root, path: at, head: headOf(route), component: () => <p>{at}</p> });
    const router = createRouter({
      routeTree: root.addChildren([
        child(Coop as unknown as Opts, "/coop"),
        child(Transparency as unknown as Opts, "/transparency"),
      ]),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    render(<RouterProvider router={router} />);
    return router;
  }

  it("the deepest route's title wins over the root's", async () => {
    renderAt("/coop");
    await waitFor(() => expect(document.title).toBe(T("Co-op")));
  });

  it("follows navigation", async () => {
    const router = renderAt("/coop");
    await waitFor(() => expect(document.title).toBe(T("Co-op")));
    await act(() => router.navigate({ to: "/transparency" as never }));
    await waitFor(() => expect(document.title).toBe(T("Transparency")));
  });

  it("follows a language switch once the router is invalidated (as the root does)", async () => {
    const router = renderAt("/coop");
    await waitFor(() => expect(document.title).toBe(T("Co-op")));
    setClientTranslator(await loadLocale("es"));
    await act(() => router.invalidate());
    await waitFor(() => expect(document.title).toBe(T("Cooperativa")));
  });
});
