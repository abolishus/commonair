// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Sign-in and sign-up return to the page that sent the visitor (`?returnTo=`, E9 contract step
 * §7.2): only a relative path is followed; protocol-relative, absolute and backslash values fall
 * back to the dashboard. The verification link of a sign-up lands on the same page.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  isRedirect,
  RouterContextProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { resendVerificationEmail, signUp } from "../src/lib/auth.ts";
import { requireSession, returnToSearch, safeReturnTo } from "../src/lib/guard.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const bodyOf = (init: RequestInit | undefined): unknown => JSON.parse(init?.body as string);

const CONSENT = "/oauth2/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb&state=s";
const REFUSED = [
  "//evil.example/x",
  "https://evil.example/x",
  "http://evil.example",
  "/\\evil.example",
  "javascript:alert(1)",
  "relative/path",
  "/with space",
  "",
  42,
  undefined,
];

describe("safeReturnTo", () => {
  it("keeps a relative path with its query", () => {
    expect(safeReturnTo(CONSENT)).toBe(CONSENT);
    expect(safeReturnTo("/activate?code=BCDF-GHJK")).toBe("/activate?code=BCDF-GHJK");
  });
  it.each(REFUSED)("refuses %j", (value) => {
    expect(safeReturnTo(value)).toBeUndefined();
    expect(returnToSearch({ returnTo: value })).toEqual({});
  });
  it("refuses a value longer than 4096 characters", () => {
    expect(safeReturnTo(`/${"a".repeat(4096)}`)).toBeUndefined();
  });
});

describe("requireSession", () => {
  it("sends a signed-out visitor to /signin with the return path", async () => {
    const err = await requireSession(async () => null, { returnTo: CONSENT }).catch((e: unknown) => e);
    expect(isRedirect(err)).toBe(true);
    expect((err as { options: { to: string; search: unknown } }).options).toMatchObject({
      to: "/signin",
      search: { returnTo: CONSENT },
    });
  });
  it.each(["//evil.example/x", "https://evil.example/x"])("drops an unsafe return path %s", async (returnTo) => {
    const err = await requireSession(async () => null, { returnTo }).catch((e: unknown) => e);
    expect((err as { options: { search: unknown } }).options.search).toEqual({});
  });
});

describe("verification callbacks", () => {
  it("signUp sends the return path as the verification link's landing page", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      email: "a@example.test",
      username: "alice_1",
      password: "correct horse battery",
      birthDate: "2000-01-01",
      altcha: "x",
      acceptedDocumentIds: [],
    };
    await signUp(input, CONSENT);
    await signUp(input);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(AUTH_ROUTES.signUp);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({ callbackURL: CONSENT });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({ callbackURL: "/dashboard" });
  });
  it("a resent link lands on the return path too", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => Response.json({ status: true }));
    vi.stubGlobal("fetch", fetchMock);
    await resendVerificationEmail("a@example.test", CONSENT);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ email: "a@example.test", callbackURL: CONSENT });
  });
});

const { Route: SignInRoute } = await import("../src/routes/_app/signin.tsx");
// Route components are lazy in the build: load the module before rendering it.
await (SignInRoute.options.component as { preload?: () => Promise<void> } | undefined)?.preload?.();
const SignIn = SignInRoute.options.component as React.ComponentType;

describe("route search", () => {
  it("/signin and /signup validate returnTo the same way", async () => {
    const { Route: SignUpRoute } = await import("../src/routes/_app/signup.tsx");
    for (const route of [SignInRoute, SignUpRoute]) {
      const validate = route.options.validateSearch as (s: Record<string, unknown>) => unknown;
      expect(validate({ returnTo: CONSENT })).toEqual({ returnTo: CONSENT });
      for (const bad of REFUSED) expect(validate({ returnTo: bad })).toEqual({});
    }
  });
});

describe("sign-in page", () => {
  async function signInAt(url: string): Promise<string | undefined> {
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: [url] }),
    });
    await router.load();
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => Response.json({})),
    );
    const assign = vi.fn<(url: string | URL) => void>();
    vi.spyOn(window.location, "assign").mockImplementation(assign);
    render(
      <RouterContextProvider router={router}>
        <LocaleProvider locale={locale} messages={uiMessages}>
          <TooltipProvider>
            <React.Suspense fallback={null}>
              <SignIn />
            </React.Suspense>
          </TooltipProvider>
        </LocaleProvider>
      </RouterContextProvider>,
    );
    fireEvent.change(await screen.findByTestId("signin-email"), { target: { value: "a@example.test" } });
    fireEvent.change(screen.getByTestId("signin-password"), { target: { value: "correct horse battery" } });
    fireEvent.submit(screen.getByTestId("signin-submit").closest("form") as HTMLFormElement);
    await waitFor(() => expect(assign).toHaveBeenCalled());
    return assign.mock.calls[0]?.[0]?.toString();
  }

  it("returns to a relative returnTo", async () => {
    expect(await signInAt(`/signin?returnTo=${encodeURIComponent(CONSENT)}`)).toBe(CONSENT);
  });
  it.each(["//evil.example/x", "https://evil.example/x"])("falls back to /dashboard for %s", async (bad) => {
    expect(await signInAt(`/signin?returnTo=${encodeURIComponent(bad)}`)).toBe("/dashboard");
  });
  it("goes to /dashboard without one", async () => {
    expect(await signInAt("/signin")).toBe("/dashboard");
  });
});
