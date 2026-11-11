// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d2-gate on the auth pages (README D2.2): the sign-up headline names the action that brought the
 * visitor, says the account is free and what it gives, pre-fills a claimed username and checks
 * it, sends the intent, keeps it for the one-tap confirm, and offers "Wrong address? Start over";
 * sign-in keeps the intent too. Also the username check on its own.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PENDING_INTENT_KEY, readPendingIntent } from "../src/components/auth-gate/pending-intent.ts";
import { useUsernameCheck, type UsernameChecker } from "../src/components/auth-gate/username-check.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { resetUiMetricsForTests } from "../src/lib/ui-metrics.ts";
import { Route as SignInRoute } from "../src/routes/_app/signin.tsx";
import { Route as SignUpRoute } from "../src/routes/_app/signup.tsx";

// `solves: false` stands for a widget still working on its challenge.
const altchaWidget = vi.hoisted(() => ({ solves: true }));
vi.mock("../src/components/altcha-field.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/altcha-field.tsx")>();
  const R = await import("react");
  return {
    ...actual,
    AltchaField: ({ onChange }: { onChange: (v: string | null) => void }) => {
      R.useEffect(() => {
        if (altchaWidget.solves) onChange("solved");
      }, [onChange]);
      return null;
    },
  };
});

const answers = vi.hoisted(() => ({
  username: { available: true, reason: null as string | null },
  usernameCalls: [] as string[],
  settings: null as { key: string; value: unknown }[] | null,
}));
vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  return {
    ...actual,
    api: () => ({
      legal: { current: async () => [] },
      users: {
        usernameAvailable: async ({ username }: { username: string }) => {
          answers.usernameCalls.push(username);
          return { username, ...answers.username };
        },
      },
      coop: {
        settings: async () => {
          if (!answers.settings) throw new Error("down");
          return answers.settings;
        },
      },
    }),
  };
});

type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const hrefOf = (url: RequestInfo | URL): string => (url instanceof Request ? url.url : url.toString());
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

beforeEach(() => {
  resetUiMetricsForTests();
  localStorage.clear();
  answers.username = { available: true, reason: null };
  answers.usernameCalls = [];
  answers.settings = null;
  altchaWidget.solves = true;
  fetchMock = vi.fn<FetchFn>(async () => Response.json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  for (const route of [SignInRoute, SignUpRoute]) {
    const c = route.options.component as { preload?: () => Promise<void> } | undefined;
    await c?.preload?.();
  }
});

function wrap(node: React.ReactNode, at: string) {
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
const SignUp = () => {
  const C = SignUpRoute.options.component as React.ComponentType;
  return <C />;
};
const SignIn = () => {
  const C = SignInRoute.options.component as React.ComponentType;
  return <C />;
};

const counted = () =>
  fetchMock.mock.calls
    .filter(([url]) => hrefOf(url) === "/api/metrics/ui")
    .map(([, init]) => JSON.parse(init?.body as string) as { surface: string; action: string; step: string });

describe("intent-aware sign-up", () => {
  it("names the action and the channel, says it is free, and lists what it gives", async () => {
    wrap(<SignUp />, "/signup?intent=follow&channel=rivertide&redirect=%2Frivertide");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Create a free account to follow rivertide");
    expect(document.body.textContent).toContain("account is free.");
    const perks = screen.getByTestId("signup-perks");
    expect(perks.querySelectorAll("li")).toHaveLength(3);
    expect(perks.textContent).toContain("Follow channels and get go-live alerts");
    expect(screen.getByTestId("signup-context").textContent).toContain("You were watching");
    expect(screen.getByTestId("signup-after").textContent).toContain("back to rivertide to finish following");
    expect(document.body.textContent).toContain("Have an account?");
    expect(document.body.textContent).not.toContain("Already a member?");
    // Sign in keeps the target and the intent.
    const signInLink = screen.getByText("Sign in", { selector: "a" });
    const params = Object.fromEntries(new URL(signInLink.getAttribute("href") ?? "", "https://x.invalid").searchParams);
    expect(params).toEqual({ redirect: "/rivertide", intent: "follow", channel: "rivertide" });
    const submit = screen.getByTestId("signup-submit");
    expect(submit.hasAttribute("data-filled-cta")).toBe(true);
    expect(submit.className).toMatch(/\bbg-brand\b/);
    await waitFor(() => expect(counted()).toContainEqual({ surface: "signup", action: "view", step: "follow" }));
  });

  it("a stale link without a channel falls back to the plain headline", () => {
    wrap(<SignUp />, "/signup?intent=chat");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Create your free account");
    expect(screen.queryByTestId("signup-context")).toBeNull();
  });

  it("stream: the channel-address hint and the studio after-note", () => {
    wrap(<SignUp />, "/signup?intent=stream");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Start streaming on /);
    expect(document.body.textContent).toContain("This is your channel address.");
    expect(screen.getByTestId("signup-after").textContent).toContain("studio");
  });

  it("pre-fills a claimed username and says whether it is free", async () => {
    wrap(<SignUp />, "/signup?intent=stream&username=Neo_1");
    const input = screen.getByTestId("signup-username") as HTMLInputElement;
    expect(input.value).toBe("neo_1");
    await waitFor(() => expect(screen.getByTestId("signup-username-check").textContent).toBe("neo_1 is free."));
  });

  it("says when a name is taken, on leaving the field", async () => {
    answers.username = { available: false, reason: "taken" };
    wrap(<SignUp />, "/signup");
    const input = screen.getByTestId("signup-username");
    fireEvent.change(input, { target: { value: "alice" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId("signup-username-check").getAttribute("data-reason")).toBe("taken"));
    expect(screen.getByTestId("signup-username-check").textContent).toBe("alice is taken. Try another.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("sends the intent, keeps it for the confirm, and offers to start over", async () => {
    const { container } = wrap(<SignUp />, "/signup?intent=follow&channel=rivertide&redirect=%2Frivertide");
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    const set = (name: string, value: string) =>
      fireEvent.change(form.querySelector(`[name="${name}"]`) as HTMLInputElement, { target: { value } });
    set("email", "a@example.test");
    set("username", "alice");
    set("password", "correct horse battery staple");
    set("birthDate", "1990-06-15");
    await waitFor(() => expect((screen.getByTestId("signup-submit") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.submit(form);
    });
    const done = await screen.findByTestId("signup-check-email");
    const call = fetchMock.mock.calls.find(([url]) => hrefOf(url).includes("/sign-up/"));
    const body = JSON.parse(call?.[1]?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ signupIntent: "follow", callbackURL: "/rivertide", username: "alice" });
    expect(readPendingIntent()).toMatchObject({ intent: "follow", path: "/rivertide", channel: "rivertide" });
    expect(done.textContent).toContain("a@example.test");
    expect(done.textContent).toContain("back to rivertide to finish following");
    expect(counted()).toContainEqual({ surface: "signup", action: "submit", step: "follow" });
    // Start over: the spent proof is dropped, so submit waits for a fresh solve.
    altchaWidget.solves = false;
    act(() => {
      fireEvent.click(screen.getByTestId("signup-wrong-address"));
    });
    expect(await screen.findByTestId("signup-email")).toBeTruthy();
    expect((screen.getByTestId("signup-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("join: the share perk states the governed figures, or none when they are unknown", async () => {
    answers.settings = [
      {
        key: "membership.classes",
        value: { viewer: { shareCents: 2000, shareRefundableOnExit: true, minSubscriptionCents: 700 } },
      },
      { key: "payout.rules", value: { currency: "usd" } },
    ];
    wrap(<SignUp />, "/signup?intent=join");
    await waitFor(() =>
      expect(screen.getByTestId("signup-perks").textContent).toContain(
        "A $20.00 share, refunded if you leave, or a $7.00+ monthly subscription",
      ),
    );
    cleanup();
    answers.settings = null;
    wrap(<SignUp />, "/signup?intent=join");
    const perks = screen.getByTestId("signup-perks");
    expect(perks.textContent).toContain("A member share or a monthly subscription");
    expect(perks.textContent).not.toMatch(/\$/);
  });

  it("asks once per name: an unchanged blur, or a blur after the prefill, costs no request", async () => {
    wrap(<SignUp />, "/signup?intent=stream&username=neo_1");
    const input = screen.getByTestId("signup-username");
    await waitFor(() => expect(screen.getByTestId("signup-username-check").textContent).toBe("neo_1 is free."));
    fireEvent.blur(input);
    fireEvent.blur(input);
    expect(answers.usernameCalls).toEqual(["neo_1"]);
    expect(screen.getByTestId("signup-username-check").textContent).toBe("neo_1 is free.");
    fireEvent.change(input, { target: { value: "neo_2" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId("signup-username-check").textContent).toBe("neo_2 is free."));
    fireEvent.change(input, { target: { value: "neo_1" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("signup-username-check").textContent).toBe("neo_1 is free.");
    expect(answers.usernameCalls).toEqual(["neo_1", "neo_2"]);
  });

  it("a creator intent with no target lands on its own page and keeps no confirm", async () => {
    const { container } = wrap(<SignUp />, "/signup?intent=import");
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    const set = (name: string, value: string) =>
      fireEvent.change(form.querySelector(`[name="${name}"]`) as HTMLInputElement, { target: { value } });
    set("email", "b@example.test");
    set("username", "bob_stream");
    set("password", "correct horse battery staple");
    set("birthDate", "1990-06-15");
    await waitFor(() => expect((screen.getByTestId("signup-submit") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.submit(form);
    });
    await screen.findByTestId("signup-check-email");
    const call = fetchMock.mock.calls.find(([url]) => hrefOf(url).includes("/sign-up/"));
    expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({ signupIntent: "import", callbackURL: "/import" });
    expect(localStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
  });

  it("a refused sign-up is counted by its kind, never its message", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (hrefOf(url).includes("/sign-up/")) return Response.json({ code: "RATE" }, { status: 429 });
      return Response.json({});
    });
    const { container } = wrap(<SignUp />, "/signup");
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    const set = (name: string, value: string) =>
      fireEvent.change(form.querySelector(`[name="${name}"]`) as HTMLInputElement, { target: { value } });
    set("email", "c@example.test");
    set("username", "carol");
    set("password", "correct horse battery staple");
    set("birthDate", "1990-06-15");
    await waitFor(() => expect((screen.getByTestId("signup-submit") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(counted()).toContainEqual({ surface: "signup", action: "error", step: "rate_limited" }));
    expect(screen.queryByTestId("signup-check-email")).toBeNull();
  });
});

describe("sign-in from a prompt", () => {
  it("says it brings them back, and keeps the intent for the confirm", async () => {
    const assign = vi.fn<(url: string) => void>();
    vi.stubGlobal("location", { href: window.location.href, origin: window.location.origin, assign });
    const { container } = wrap(<SignIn />, "/signin?redirect=%2Frivertide&intent=follow&channel=rivertide");
    expect(document.body.textContent).toContain("We'll take you back to where you were.");
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    fireEvent.change(screen.getByTestId("signin-email"), { target: { value: "a@example.test" } });
    fireEvent.change(screen.getByTestId("signin-password"), { target: { value: "correct horse" } });
    fireEvent.submit(form);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/rivertide"));
    expect(readPendingIntent()).toMatchObject({ intent: "follow", path: "/rivertide" });
  });
});

describe("useUsernameCheck", () => {
  it("checks the format locally, then asks; the latest answer wins", async () => {
    const answers: Record<string, ReturnType<UsernameChecker>> = {};
    const checker = vi.fn<UsernameChecker>((name) => answers[name] ?? Promise.reject(new Error("down")));
    const { result } = renderHook(() => useUsernameCheck(checker));
    act(() => result.current.run("x"));
    expect(result.current.check).toEqual({ state: "unavailable", username: "x", reason: "invalid" });
    expect(checker).not.toHaveBeenCalled();
    act(() => result.current.run(""));
    expect(result.current.check).toEqual({ state: "idle" });

    let releaseSlow: (v: Awaited<ReturnType<UsernameChecker>>) => void = () => {};
    answers.slow_name = new Promise((r) => {
      releaseSlow = r;
    });
    answers.reserved1 = Promise.resolve({ username: "reserved1", available: false, reason: "reserved" });
    act(() => result.current.run(" Slow_Name "));
    expect(result.current.check).toEqual({ state: "checking", username: "slow_name" });
    act(() => result.current.run("reserved1"));
    await waitFor(() =>
      expect(result.current.check).toEqual({ state: "unavailable", username: "reserved1", reason: "reserved" }),
    );
    // The earlier, slower answer arrives late and is ignored.
    await act(async () => {
      releaseSlow({ username: "slow_name", available: true, reason: null });
    });
    expect(result.current.check).toEqual({ state: "unavailable", username: "reserved1", reason: "reserved" });

    answers.freebie = Promise.resolve({ username: "freebie", available: true, reason: null });
    act(() => result.current.run("freebie"));
    await waitFor(() => expect(result.current.check).toEqual({ state: "free", username: "freebie" }));
    // A failure says nothing.
    act(() => result.current.run("offline_x"));
    await waitFor(() => expect(result.current.check).toEqual({ state: "idle" }));
    // A settled name is not asked again; a failed one is (it was never answered).
    const calls = checker.mock.calls.length;
    act(() => result.current.run("freebie"));
    expect(result.current.check).toEqual({ state: "free", username: "freebie" });
    expect(checker.mock.calls.length).toBe(calls);
    act(() => result.current.run("offline_x"));
    expect(checker.mock.calls.length).toBe(calls + 1);
    await waitFor(() => expect(result.current.check).toEqual({ state: "idle" }));
    // A name still in flight is not asked twice either.
    answers.pending_x = new Promise(() => {});
    act(() => result.current.run("pending_x"));
    act(() => result.current.run("pending_x"));
    expect(checker.mock.calls.filter(([n]) => n === "pending_x")).toHaveLength(1);
    act(() => result.current.reset());
    expect(result.current.check).toEqual({ state: "idle" });
    // After a reset the same name is asked again.
    act(() => result.current.run("freebie"));
    expect(checker.mock.calls.filter(([n]) => n === "freebie")).toHaveLength(2);
  });
});
