// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The root's theme setter respects Preferences consent, a tab-only theme applies after
 * hydration, and the consent banner is mounted in the page flow before the page.
 */
import { RouterProvider, createMemoryHistory, createRoute, createRouter } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Bootstrap } from "../src/lib/bootstrap-types.ts";
import type { StoredConsent } from "../src/lib/consent.ts";

const fake = vi.hoisted(() => ({
  boot: null as unknown,
  consent: vi.fn<(input: unknown) => Promise<{ ok: true }>>(),
}));

vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => fake.boot,
  getSessionUser: async () => null,
  useBootstrap: () => fake.boot,
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    legal: {
      get: async () => ({
        id: "doc-cookies",
        kind: "cookies",
        version: "v2",
        title: "Cookie policy",
        body: "Text",
        isDraft: true,
        requiresAcceptance: false,
        publishedAt: "2026-10-29T00:00:00.000Z",
      }),
      consent: (input: unknown) => fake.consent(input),
    },
  };
  return { ...actual, api: () => client };
});

const { Route: AppRoot } = await import("../src/routes/__root.tsx");
const { ThemeContext } = await import("../src/lib/theme-context.ts");
const { CONSENT_COOKIE, resetConsentForTests, serializeConsent } = await import("../src/lib/consent.ts");
const { THEME_COOKIE, THEME_SESSION_KEY } = await import("../src/lib/theme.ts");

function boot(over: Partial<Bootstrap> = {}): Bootstrap {
  return {
    config: {} as Bootstrap["config"],
    instance: { name: "Test Air", sourceUrl: null, p2pDefault: "off" },
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

function ThemePage(): React.JSX.Element {
  const { theme, setTheme } = React.useContext(ThemeContext);
  return (
    <main data-testid="page" data-theme-now={theme}>
      <button type="button" onClick={() => setTheme("light")}>
        light
      </button>
    </main>
  );
}

const page = createRoute({ getParentRoute: () => AppRoot, path: "/", component: ThemePage });
const routeTree = AppRoot.addChildren([page]);

async function renderRoot() {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return screen.findByTestId("page");
}

function cookies(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

beforeEach(() => {
  resetConsentForTests();
  fake.consent.mockReset().mockResolvedValue({ ok: true });
  for (const name of Object.keys(cookies()))
    document.cookie = `${name}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  cleanup();
});

describe("the root and consent", () => {
  it("setTheme without consent writes no cookie, only the tab's choice", async () => {
    fake.boot = boot();
    await renderRoot();
    act(() => screen.getByRole("button", { name: "light" }).click());
    await waitFor(() => expect(screen.getByTestId("page").getAttribute("data-theme-now")).toBe("light"));
    expect(cookies()[THEME_COOKIE]).toBeUndefined();
    expect(sessionStorage.getItem(THEME_SESSION_KEY)).toBe("light");
  });

  it("setTheme with consent writes the cookie", async () => {
    const consent: StoredConsent = { version: "v2", preferences: true, recorded: "user" };
    document.cookie = `${CONSENT_COOKIE}=${serializeConsent(consent)}; path=/`;
    fake.boot = boot({ consent });
    await renderRoot();
    act(() => screen.getByRole("button", { name: "light" }).click());
    await waitFor(() => expect(cookies()[THEME_COOKIE]).toBe("light"));
  });

  it("applies a tab-only theme after hydration", async () => {
    sessionStorage.setItem(THEME_SESSION_KEY, "light");
    fake.boot = boot({ theme: "dark" });
    await renderRoot();
    await waitFor(() => expect(screen.getByTestId("page").getAttribute("data-theme-now")).toBe("light"));
    expect(cookies()[THEME_COOKIE]).toBeUndefined();
  });

  it("granting consent keeps the tab's theme and moves it into the cookie", async () => {
    sessionStorage.setItem(THEME_SESSION_KEY, "light");
    fake.boot = boot({ theme: "dark" });
    await renderRoot();
    await waitFor(() => expect(screen.getByTestId("page").getAttribute("data-theme-now")).toBe("light"));
    act(() => screen.getByTestId("consent-accept-all").click());
    await waitFor(() => expect(fake.consent).toHaveBeenCalledTimes(1));
    expect(cookies()[THEME_COOKIE]).toBe("light");
    expect(sessionStorage.getItem(THEME_SESSION_KEY)).toBeNull();
    expect(screen.getByTestId("page").getAttribute("data-theme-now")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("mounts the banner before the page", async () => {
    fake.boot = boot();
    const main = await renderRoot();
    const banner = screen.getByTestId("consent-banner");
    expect(banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
