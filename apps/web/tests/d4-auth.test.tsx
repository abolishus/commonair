// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D4 (F17): sign-up's date of birth as three locale-ordered selects with the native input's rules,
 * the `?redirect=` allowlist (same-origin paths only: an open redirect is a bug), the
 * "Forgot password?" link and the reset flow it starts, and the two-column layout's co-op pitch.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { BirthDateField } from "../src/components/birth-date-field.tsx";
import { ALTCHA_TOKENS, applyAltchaTokens } from "../src/components/altcha-field.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { authSearch, authTarget, carriedSearch, safeRedirect } from "../src/lib/auth-return.ts";
import {
  EMPTY_DATE,
  birthYears,
  dateFieldOrder,
  daysInMonth,
  isoFromParts,
  partsFromIso,
  validateBirthDate,
  type DateParts,
} from "../src/lib/birth-date.ts";
import { PASSWORD_RESET_ROUTES, RESET_LANDING } from "../src/lib/password-reset.ts";
import { Route as SignInRoute } from "../src/routes/_app/signin.tsx";
import { Route as SignUpRoute } from "../src/routes/_app/signup.tsx";

// The proof of work is not under test: report it solved at once (the tokens stay real).
vi.mock("../src/components/altcha-field.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/altcha-field.tsx")>();
  const R = await import("react");
  return {
    ...actual,
    AltchaField: ({ onChange }: { onChange: (v: string | null) => void }) => {
      R.useEffect(() => onChange("solved"), [onChange]);
      return null;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = new Date("2026-11-03T12:00:00.000Z");
/** `fetch` as the app calls it (a path, or an oRPC `Request`). */
type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const hrefOf = (url: RequestInfo | URL): string => (url instanceof Request ? url.url : url.toString());

function wrap(node: React.ReactNode, at = "/") {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: [at] }) });
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

const SignIn = () => {
  const C = SignInRoute.options.component as React.ComponentType;
  return <C />;
};
const SignUp = () => {
  const C = SignUpRoute.options.component as React.ComponentType;
  return <C />;
};

beforeAll(async () => {
  for (const route of [SignInRoute, SignUpRoute]) {
    const c = route.options.component as { preload?: () => Promise<void> } | undefined;
    await c?.preload?.();
  }
});

describe("validateBirthDate (the native input's rules)", () => {
  const v = (parts: Partial<DateParts>) => validateBirthDate({ ...EMPTY_DATE, ...parts }, NOW);

  it("needs all three parts", () => {
    expect(v({})).toEqual({ error: "required" });
    expect(v({ day: 15, month: 6 })).toEqual({ error: "required" });
    expect(v({ month: 6, year: 1990 })).toEqual({ error: "required" });
    expect(v({ day: 15, year: 1990 })).toEqual({ error: "required" });
  });

  it("refuses dates that do not exist", () => {
    expect(v({ day: 31, month: 4, year: 1990 })).toEqual({ error: "invalid" });
    expect(v({ day: 30, month: 2, year: 2000 })).toEqual({ error: "invalid" });
    expect(v({ day: 29, month: 2, year: 1999 })).toEqual({ error: "invalid" });
  });

  it("accepts leap days and pads the ISO date", () => {
    expect(v({ day: 29, month: 2, year: 2000 })).toEqual({ iso: "2000-02-29" });
    expect(v({ day: 5, month: 5, year: 1990 })).toEqual({ iso: "1990-05-05" });
  });

  it("allows today and refuses tomorrow (the age rule is the API's)", () => {
    expect(v({ day: 3, month: 11, year: 2026 })).toEqual({ iso: "2026-11-03" });
    expect(v({ day: 4, month: 11, year: 2026 })).toEqual({ error: "future" });
    expect(v({ day: 1, month: 1, year: 2027 })).toEqual({ error: "future" });
  });

  it("round-trips the form value", () => {
    expect(partsFromIso("1990-06-15")).toEqual({ year: 1990, month: 6, day: 15 });
    expect(isoFromParts({ year: 1990, month: 6, day: 15 })).toBe("1990-06-15");
    expect(isoFromParts({ year: 1990, month: 6, day: 0 })).toBe("");
    for (const bad of ["", "15/06/1990", "1990-6-15", "x"]) expect(partsFromIso(bad)).toEqual(EMPTY_DATE);
  });

  it("days per month and the year list", () => {
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(1990, 4)).toBe(30);
    expect(daysInMonth(0, 4)).toBe(31);
    const years = birthYears(NOW);
    expect(years[0]).toBe(2026);
    expect(years.at(-1)).toBe(1906);
    expect(years).toHaveLength(121);
  });
});

describe("dateFieldOrder (the locale's date order)", () => {
  it.each([
    ["en", "November", ["month", "day", "year"]],
    ["en-GB", "November", ["day", "month", "year"]],
    ["es", "noviembre", ["day", "month", "year"]],
    ["de", "November", ["day", "month", "year"]],
    ["ja", "11月", ["year", "month", "day"]],
  ] as const)("%s → %j", (tag, monthName, order) => {
    expect(dateFieldOrder(tag, monthName)).toEqual(order);
  });

  it("falls back to month, day, year when it cannot tell", () => {
    expect(dateFieldOrder("en", "")).toEqual(["month", "day", "year"]);
  });
});

describe("BirthDateField", () => {
  it("renders the three selects in the locale's order with one form value", () => {
    const { container } = wrap(
      <BirthDateField value={{ year: 1990, month: 6, day: 15 }} onValueChange={() => {}} now={NOW} />,
    );
    const set = screen.getByTestId("signup-birthdate");
    expect(set.getAttribute("data-order")).toBe("month,day,year");
    expect(screen.getByTestId("signup-birthdate-month").textContent).toContain("June");
    expect(screen.getByTestId("signup-birthdate-day").textContent).toContain("15");
    expect(screen.getByTestId("signup-birthdate-year").textContent).toContain("1990");
    expect((container.querySelector('[name="birthDate"]') as HTMLInputElement).value).toBe("1990-06-15");
  });

  it("an incomplete date submits no value; an error marks the selects invalid", () => {
    const { container } = wrap(
      <BirthDateField value={{ ...EMPTY_DATE, year: 1990 }} onValueChange={() => {}} now={NOW} error="Enter it." />,
    );
    expect((container.querySelector('[name="birthDate"]') as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("signup-birthdate-day").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter it.")).toBeTruthy();
  });
});

describe("sign-up's date of birth", () => {
  async function fill(birth?: string) {
    const fetch = vi.fn<FetchFn>(async () => new Response("[]"));
    vi.stubGlobal("fetch", fetch);
    const { container } = wrap(<SignUp />);
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    const set = (name: string, value: string) =>
      fireEvent.change(form.querySelector(`[name="${name}"]`) as HTMLInputElement, { target: { value } });
    set("email", "a@example.test");
    set("username", "alice");
    set("password", "correct horse battery staple");
    if (birth !== undefined) set("birthDate", birth);
    await waitFor(() => expect((screen.getByTestId("signup-submit") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.submit(form);
    });
    return () => fetch.mock.calls.filter(([url]) => hrefOf(url).includes("/sign-up/"));
  }

  it("refuses to submit without a date, with the message under the selects", async () => {
    const signUps = await fill();
    expect(screen.getByTestId("signup-birthdate").textContent).toContain("Enter your date of birth.");
    expect(signUps()).toHaveLength(0);
  });

  it.each([
    ["1990-02-30", "That date does not exist."],
    ["2999-01-01", "Your date of birth cannot be in the future."],
  ])("refuses %s", async (value, message) => {
    const signUps = await fill(value);
    expect(screen.getByTestId("signup-birthdate").textContent).toContain(message);
    expect(signUps()).toHaveLength(0);
  });

  it("sends a complete date as one YYYY-MM-DD value", async () => {
    const signUps = await fill("1990-05-05");
    await waitFor(() => expect(signUps()).toHaveLength(1));
    expect(JSON.parse(signUps()[0]?.[1]?.body as string).birthDate).toBe("1990-05-05");
  });
});

describe("the redirect allowlist", () => {
  const REFUSED = [
    "https://evil.example/x",
    "http://evil.example",
    "//evil.example/x",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\\/evil.example",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,x",
    " /dashboard",
    "/with space",
    "/tab\there",
    "relative/path",
    "",
    42,
    null,
    undefined,
    ["/a"],
  ];

  it.each(REFUSED)("refuses %j", (value) => {
    expect(safeRedirect(value)).toBeUndefined();
    expect(authSearch({ redirect: value })).toEqual({});
    expect(authSearch({ returnTo: value })).toEqual({});
  });

  it.each(["/", "/coop", "/aurora?tab=videos", "/coop/proposals?status=decided#top", "/%2F%2Fevil.example"])(
    "keeps the same-origin path %s",
    (value) => {
      expect(safeRedirect(value)).toBe(value);
      expect(authSearch({ redirect: value })).toEqual({ redirect: value });
    },
  );

  it("prefers the guard's returnTo, and carries both between the forms", () => {
    expect(authTarget({ returnTo: "/activate", redirect: "/coop" })).toBe("/activate");
    expect(authTarget({ redirect: "/coop" })).toBe("/coop");
    expect(authTarget({ redirect: "https://evil.example" })).toBeUndefined();
    expect(carriedSearch({ returnTo: "/a", redirect: "//evil" })).toEqual({ returnTo: "/a" });
  });

  it("keeps a reset token and error code, and drops anything else", () => {
    expect(authSearch({ token: "abcDEF123_-xyz", error: "INVALID_TOKEN" })).toEqual({
      token: "abcDEF123_-xyz",
      error: "INVALID_TOKEN",
    });
    expect(authSearch({ token: "<script>", error: "not an error code" })).toEqual({});
  });

  it("sign-in links to sign-up with the redirect, and drops a bad one", () => {
    wrap(<SignIn />, "/signin?redirect=%2Fcoop");
    expect(screen.getByText("Sign up").closest("a")?.getAttribute("href")).toBe("/signup?redirect=%2Fcoop");
    cleanup();
    wrap(<SignIn />, "/signin?redirect=https%3A%2F%2Fevil.example");
    expect(screen.getByText("Sign up").closest("a")?.getAttribute("href")).toBe("/signup");
  });

  it("after signing in, goes to the redirect (and only to a safe one)", async () => {
    const assign = vi.fn<(url: string) => void>();
    vi.stubGlobal("location", { href: window.location.href, origin: window.location.origin, assign });
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => new Response("{}", { status: 200 })),
    );
    const { container } = wrap(<SignIn />, "/signin?redirect=%2Fcoop");
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    fireEvent.change(screen.getByTestId("signin-email"), { target: { value: "a@example.test" } });
    fireEvent.change(screen.getByTestId("signin-password"), { target: { value: "correct horse" } });
    fireEvent.submit(form);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/coop"));
  });
});

describe("forgot password", () => {
  it("sits under the password field and opens the reset request", async () => {
    const fetch = vi.fn<FetchFn>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    wrap(<SignIn />, "/signin");
    const password = screen.getByTestId("signin-password");
    const forgot = screen.getByTestId("signin-forgot-password");
    expect(forgot.textContent).toBe("Forgot password?");
    // After the password input in the document, before the submit button.
    expect(password.compareDocumentPosition(forgot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      forgot.compareDocumentPosition(screen.getByTestId("signin-submit")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(forgot);
    expect(screen.getByTestId("signin-reset-request")).toBeTruthy();
    fireEvent.change(screen.getByTestId("reset-email"), { target: { value: "a@example.test" } });
    const form = screen.getByTestId("reset-email").closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    await screen.findByTestId("signin-reset-sent");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(PASSWORD_RESET_ROUTES.request);
    expect(JSON.parse(init?.body as string)).toEqual({ email: "a@example.test", redirectTo: RESET_LANDING });
  });

  it("the reset link's landing asks for a new password and sends the token", async () => {
    const fetch = vi.fn<FetchFn>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    wrap(<SignIn />, "/signin?token=abcDEF123456");
    expect(screen.getByTestId("signin-reset-new")).toBeTruthy();
    fireEvent.change(screen.getByTestId("reset-password-new"), { target: { value: "a much longer password" } });
    const form = screen.getByTestId("reset-password-new").closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    await screen.findByTestId("signin-notice");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(PASSWORD_RESET_ROUTES.reset);
    expect(JSON.parse(init?.body as string)).toEqual({ token: "abcDEF123456", newPassword: "a much longer password" });
    expect(screen.getByTestId("signin-email")).toBeTruthy();
  });

  it("an expired link lands on the request form with a message", () => {
    wrap(<SignIn />, "/signin?error=INVALID_TOKEN");
    expect(screen.getByTestId("signin-reset-request").textContent).toContain("expired or was already used");
  });
});

describe("the two-column auth pages", () => {
  it.each([
    ["sign-in", () => <SignIn />],
    ["sign-up", () => <SignUp />],
  ])("%s: the form first, then the co-op pitch with a link to the books", (_name, Page) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => new Response("[]")),
    );
    const { container } = wrap(<Page />);
    const form = container.querySelector("form");
    const pitch = screen.getByTestId("auth-coop-pitch");
    expect(form && form.compareDocumentPosition(pitch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pitch.querySelector('a[href="/transparency"]')).toBeTruthy();
    expect(pitch.closest(".lg\\:grid-cols-2")).toBeTruthy();
  });
});

describe("ALTCHA on tokens", () => {
  it("sets only token values on the widget, with no green of its own", () => {
    const el = document.createElement("div");
    applyAltchaTokens(el);
    for (const [name, value] of Object.entries(ALTCHA_TOKENS)) expect(el.style.getPropertyValue(name)).toBe(value);
    expect(el.style.getPropertyValue("--altcha-color-success")).toBe("var(--primary)");
    for (const value of Object.values(ALTCHA_TOKENS))
      expect(value).toMatch(/^(var\(--[a-z-]+\)|0|1px|100%|none|transparent)$/);
  });
});
