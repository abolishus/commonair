// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** Resending a lost verification email: one neutral answer, rate limits shown, a cooldown. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { RESEND_COOLDOWN_MS, ResendVerification } from "../src/components/resend-verification.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { AuthRequestError, resendVerificationEmail } from "../src/lib/auth.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { Route: SignInRoute } = await import("../src/routes/_app/signin.tsx");
// Route components are lazy in the build: load the module before rendering it.
await (SignInRoute.options.component as { preload?: () => Promise<void> } | undefined)?.preload?.();
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <React.Suspense fallback={null}>{node}</React.Suspense>
        </TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const bodyOf = (init: RequestInit | undefined): unknown => JSON.parse(init?.body as string);

const button = () => screen.getByTestId("resend-verification");

describe("resendVerificationEmail", () => {
  it("posts the address and the post-verification landing page to better-auth", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => Response.json({ status: true }));
    vi.stubGlobal("fetch", fetchMock);
    await resendVerificationEmail("a@example.test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(AUTH_ROUTES.sendVerificationEmail);
    expect(AUTH_ROUTES.sendVerificationEmail).toBe("/api/auth/send-verification-email");
    expect(init?.method).toBe("POST");
    expect(bodyOf(init)).toEqual({ email: "a@example.test", callbackURL: "/dashboard" });
  });

  it("surfaces a rate limit as an AuthRequestError with status 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => Response.json({ code: "RATE_LIMITED", message: "Too many" }, { status: 429 })),
    );
    await expect(resendVerificationEmail("a@example.test")).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    });
  });
});

describe("ResendVerification", () => {
  it("sends for the given address and shows the neutral confirmation", async () => {
    const send = vi.fn<(email: string) => Promise<void>>(async () => {});
    wrap(<ResendVerification email="a@example.test" send={send} />);
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("resend-verification-sent")).toBeTruthy());
    expect(send).toHaveBeenCalledWith("a@example.test");
    expect(screen.getByTestId("resend-verification-sent").textContent).toBe(en["verify.resent"]);
  });

  it("shows the same confirmation when the request fails for any reason but a rate limit", async () => {
    // A mail failure for a real, unverified address must look like an unknown address.
    const send = vi.fn<(email: string) => Promise<void>>(async () => {
      throw new AuthRequestError(500, null, "HTTP 500");
    });
    wrap(<ResendVerification email="a@example.test" send={send} />);
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("resend-verification-sent")).toBeTruthy());
    expect(screen.queryByTestId("form-error")).toBeNull();
  });

  it("explains a rate limit instead of claiming a mail was sent", async () => {
    const send = vi.fn<(email: string) => Promise<void>>(async () => {
      throw new AuthRequestError(429, "RATE_LIMITED", "Too many requests");
    });
    wrap(<ResendVerification email="a@example.test" send={send} />);
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("form-error").textContent).toContain(en["error.rateLimited"]));
    expect(screen.queryByTestId("resend-verification-sent")).toBeNull();
  });

  it("stays disabled for the cooldown, then can send again", async () => {
    vi.useFakeTimers();
    const send = vi.fn<(email: string) => Promise<void>>(async () => {});
    wrap(<ResendVerification email="a@example.test" send={send} />);
    await act(async () => {
      fireEvent.click(button());
    });
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button());
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(RESEND_COOLDOWN_MS);
    });
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("resend-verification-sent")).toBeNull();
    await act(async () => {
      fireEvent.click(button());
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("is disabled without an address", () => {
    wrap(<ResendVerification email="" send={vi.fn<(email: string) => Promise<void>>(async () => {})} />);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("sign-in page", () => {
  const SignIn = SignInRoute.options.component as React.ComponentType;
  const submit = async (email: string) => {
    fireEvent.change(await screen.findByTestId("signin-email"), { target: { value: email } });
    fireEvent.change(screen.getByTestId("signin-password"), { target: { value: "correct horse battery" } });
    fireEvent.submit(screen.getByTestId("signin-submit").closest("form") as HTMLFormElement);
  };

  it("offers a new verification link for the address refused as unverified", async () => {
    const fetchMock = vi.fn<FetchFn>(async (url) =>
      url === AUTH_ROUTES.signIn
        ? Response.json({ code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }, { status: 403 })
        : Response.json({ status: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    wrap(<SignIn />);
    expect(screen.queryByTestId("resend-verification")).toBeNull();
    await submit(" a@example.test ");
    await waitFor(() => expect(screen.getByTestId("form-error").textContent).toContain(en["error.emailNotVerified"]));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("resend-verification-sent")).toBeTruthy());
    const resend = fetchMock.mock.calls.find(([url]) => url === AUTH_ROUTES.sendVerificationEmail);
    expect(bodyOf(resend?.[1])).toMatchObject({ email: "a@example.test" });
  });

  it("does not offer it for other sign-in failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () =>
        Response.json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid" }, { status: 401 }),
      ),
    );
    wrap(<SignIn />);
    await submit("a@example.test");
    await waitFor(() => expect(screen.getByTestId("form-error").textContent).toContain(en["error.invalidCredentials"]));
    expect(screen.queryByTestId("resend-verification")).toBeNull();
  });
});
