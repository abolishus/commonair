// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D1 shell in the real chrome: the header's states (signed out with Sign in and Sign up at every
 * width, Sign in moving into the tab bar below md, Sign up as an outline while another filled CTA
 * is on screen; signed in with the brand collapsing to its mark), the account menu's order, the
 * bottom tab bar (sections, current page, the You sheet, hidden while the keyboard is open) and
 * the three-column footer.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { t } from "../src/i18n/index.ts";
import { useLocation } from "@tanstack/react-router";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Theme } from "@commonair/ui";
import { tabBarVisible } from "../src/lib/nav.ts";
import { ThemeContext } from "../src/lib/theme-context.ts";
import { MEMBER, boot, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown, retry: (() => {}) as () => void }));
vi.mock("../src/lib/bootstrap.ts", () => ({
  useBootstrap: () => fake.boot,
  useSessionRetry: () => ({ retry: fake.retry, retrying: false }),
}));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => new Promise(() => {}) } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
// The bell's own 32 px icon button, without its API.
vi.mock("../src/components/notifications/bell.tsx", () => ({
  NotificationBell: () => (
    <button type="button" aria-label="Notifications" data-testid="notification-bell" className="size-8" />
  ),
}));

const { AppFooter, AppHeader } = await import("../src/components/site-chrome.tsx");
const { AppTabBar } = await import("../src/components/shell/tab-bar.tsx");
const { FILLED_CTA_ATTRIBUTE } = await import("../src/components/shell/use-filled-cta.ts");
const { opensKeyboard } = await import("../src/components/shell/use-keyboard-open.ts");
const { resetHomeFeed } = await import("../src/components/discovery/feed.ts");
const { FollowButton } = await import("../src/components/channel-follow.tsx");

/** The header as the `_app` layout renders it: told whether this page has the tab bar. */
function LayoutHeader() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return <AppHeader tabBar={tabBarVisible(pathname)} />;
}

const STREAMER = { ...MEMBER, username: "rivertide", displayName: "Rivertide", channelSlug: "rivertide" };

function themed(node: React.ReactNode, setTheme = vi.fn<(theme: Theme) => void>()) {
  return <ThemeContext.Provider value={{ theme: "dark", setTheme }}>{node}</ThemeContext.Provider>;
}

const authButton = (id: "signIn" | "signUp") =>
  document.querySelector(`header [data-auth-link="${id}"]`) as HTMLElement | null;

/** A stand-in IntersectionObserver the test drives: `fire(el, true)` reports `el` on screen. */
class FakeObserver {
  static all: FakeObserver[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
  static fire(el: Element, isIntersecting: boolean) {
    for (const observer of FakeObserver.all)
      if (observer.targets.has(el))
        observer.callback(
          [{ target: el, isIntersecting } as IntersectionObserverEntry],
          observer as unknown as IntersectionObserver,
        );
  }
}

beforeEach(() => {
  fake.boot = boot();
  resetHomeFeed();
  sessionStorage.clear();
  FakeObserver.all = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the header, signed out", () => {
  it("has Sign in and Sign up, both coming back here; Sign up is the zinc fill, never the brand", async () => {
    await renderInRouter(themed(<LayoutHeader />), "/directory/art");
    const signIn = authButton("signIn");
    const signUp = authButton("signUp");
    expect(signIn?.getAttribute("href")).toBe("/signin?redirect=%2Fdirectory%2Fart");
    expect(signUp?.getAttribute("href")).toBe("/signup?redirect=%2Fdirectory%2Fart");
    expect(signUp?.getAttribute("data-cta-style")).toBe("fill");
    expect(signUp?.className).toMatch(/\bbg-primary\b/);
    expect(signUp?.className).not.toMatch(/brand/);
    // Sign in comes first, as in the mockups.
    expect((signIn as Node).compareDocumentPosition(signUp as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("on a browsing page Sign in leaves the bar below md (the tab bar's You carries it) and there is no menu", async () => {
    await renderInRouter(themed(<LayoutHeader />), "/");
    expect(authButton("signIn")?.className).toMatch(/\bmax-md:hidden\b/);
    // Sign up stays at every width.
    expect(authButton("signUp")?.className).not.toMatch(/\bmax-md:hidden\b/);
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
  });

  it.each(["/rivertide", "/signin", "/dmca"])(
    "on %s (no tab bar) Sign in stays in the bar with the menu",
    async (path) => {
      await renderInRouter(themed(<LayoutHeader />), path);
      expect(authButton("signIn")?.className).not.toMatch(/\bmax-md:hidden\b/);
      expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
    },
  );

  it("a shell without the tab bar (an error page's fallback) keeps Sign in and the menu, on any page", async () => {
    await renderInRouter(themed(<AppHeader />), "/");
    expect(authButton("signIn")?.className).not.toMatch(/\bmax-md:hidden\b/);
    expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
  });

  it("in the studio Sign in stays (the studio never has the tab bar)", async () => {
    const { SidebarProvider } = await import("@commonair/ui/components/sidebar");
    await renderInRouter(
      themed(
        <SidebarProvider>
          <AppHeader studio />
        </SidebarProvider>,
      ),
      "/",
    );
    expect(authButton("signIn")?.className).not.toMatch(/\bmax-md:hidden\b/);
    // The sidebar toggle has a 44 px hit area below md.
    expect(document.querySelector('[data-sidebar="trigger"]')?.className).toMatch(/\bmax-md:size-11\b/);
  });

  it("Sign up drops to an outline while a filled CTA is on screen, and back when it leaves", async () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const cta = document.createElement("button");
    cta.setAttribute(FILLED_CTA_ATTRIBUTE, "");
    document.body.append(cta);
    try {
      await renderInRouter(themed(<LayoutHeader />), "/");
      await waitFor(() => expect(FakeObserver.all.some((o) => o.targets.has(cta))).toBe(true));
      expect(authButton("signUp")?.getAttribute("data-cta-style")).toBe("fill");
      act(() => FakeObserver.fire(cta, true));
      await waitFor(() => expect(authButton("signUp")?.getAttribute("data-cta-style")).toBe("outline"));
      expect(authButton("signUp")?.className).not.toMatch(/\bbg-primary\b/);
      act(() => FakeObserver.fire(cta, false));
      await waitFor(() => expect(authButton("signUp")?.getAttribute("data-cta-style")).toBe("fill"));
    } finally {
      cta.remove();
    }
  });

  it("notices a filled CTA that mounts later, and forgets one that is removed", async () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    await renderInRouter(themed(<LayoutHeader />), "/");
    const cta = document.createElement("a");
    cta.setAttribute(FILLED_CTA_ATTRIBUTE, "");
    document.body.append(cta);
    await waitFor(() => expect(FakeObserver.all.some((o) => o.targets.has(cta))).toBe(true));
    act(() => FakeObserver.fire(cta, true));
    await waitFor(() => expect(authButton("signUp")?.getAttribute("data-cta-style")).toBe("outline"));
    cta.remove();
    await waitFor(() => expect(authButton("signUp")?.getAttribute("data-cta-style")).toBe("fill"));
  });

  it("a channel's Follow is a filled CTA: beside it Sign up is the outline", async () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const state = { following: null, count: 0, pending: false, previous: null, settledAt: 0 };
    await renderInRouter(
      themed(
        <>
          <LayoutHeader />
          <FollowButton signedIn={false} state={state} onToggle={() => {}} />
        </>,
      ),
      "/",
    );
    const follow = await screen.findByTestId("follow-button");
    expect(follow.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true);
    await waitFor(() => expect(FakeObserver.all.some((o) => o.targets.has(follow))).toBe(true));
    act(() => FakeObserver.fire(follow, true));
    await waitFor(() => expect(authButton("signUp")?.getAttribute("data-cta-style")).toBe("outline"));
  });

  it("names the brand link 'Test Air, home' and shows the name (not collapsed)", async () => {
    await renderInRouter(themed(<LayoutHeader />), "/");
    const brand = screen.getByRole("link", { name: "Test Air, home" });
    expect(brand.getAttribute("href")).toBe("/");
    expect(brand.querySelector('[data-slot="brand-mark"]')).not.toBeNull();
    const wordmark = brand.querySelector('[data-slot="site-header-wordmark"]') as HTMLElement;
    expect(wordmark.textContent).toBe("Test Air");
    expect(wordmark.className).toContain("@max-sm/site-header:hidden");
    expect(wordmark.className).not.toMatch(/\bmax-md:hidden\b/);
  });
});

describe("the header, signed in", () => {
  it("collapses the brand to the mark below md, keeps its name, and has no Sign in or Sign up", async () => {
    fake.boot = boot({ me: STREAMER });
    await renderInRouter(themed(<LayoutHeader />), "/");
    expect(screen.getByRole("banner").hasAttribute("data-compact-brand")).toBe(true);
    const brand = screen.getByRole("link", { name: "Test Air, home" });
    expect(brand.querySelector('[data-slot="site-header-wordmark"]')?.className).toMatch(/\bmax-md:hidden\b/);
    expect(authButton("signIn")).toBeNull();
    expect(authButton("signUp")).toBeNull();
    expect(screen.getByTestId("nav-user")).toBeTruthy();
  });

  it("makes the bell and the avatar trigger 44 px hit areas below md", async () => {
    fake.boot = boot({ me: STREAMER });
    await renderInRouter(themed(<LayoutHeader />), "/");
    const bell = screen.getByTestId("notification-bell");
    const avatar = screen.getByRole("button", { name: "Account menu for Rivertide" });
    const cluster = bell.closest('[data-slot="site-header-user"]') as HTMLElement;
    expect(cluster).toBeTruthy();
    expect(avatar.closest('[data-slot="site-header-user"]')).toBe(cluster);
    // The rule reaches every button in the cluster: 44 px tall, at least 44 px wide (the
    // username still shows beside the avatar from sm).
    const classes = cluster.className.split(" ");
    expect(classes).toContain("max-md:[&_button]:h-11");
    expect(classes).toContain("max-md:[&_button]:min-w-11");
    expect(bell.tagName).toBe("BUTTON");
    expect(avatar.tagName).toBe("BUTTON");
  });
});

describe("the account menu", () => {
  async function openMenu(me: typeof MEMBER) {
    fake.boot = boot({ me });
    await renderInRouter(themed(<LayoutHeader />), "/");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Account menu for ${me.displayName}` }));
    });
    return screen.findByRole("menu");
  }

  it("is Your channel, Creator studio, Following, Settings, Co-op membership, the theme, then Sign out", async () => {
    const menu = await openMenu(STREAMER);
    const rows = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="separator"]')].map(
      (el) => (el.getAttribute("role") === "separator" ? "---" : (el.textContent ?? "").trim()),
    );
    expect(rows).toEqual([
      "Your channel",
      "Creator studio",
      "Following",
      "Settings",
      "Co-op membership",
      "---",
      "Dark",
      "Light",
      "System",
      "---",
      "Sign out",
    ]);
  });

  it("links each entry to its page; Relays and the settings sub-pages are gone", async () => {
    await openMenu(STREAMER);
    expect(screen.getByTestId("account-channel-link").getAttribute("href")).toBe("/rivertide");
    expect(screen.getByTestId("account-studio-link").getAttribute("href")).toBe("/dashboard");
    expect(screen.getByTestId("account-following-link").getAttribute("href")).toBe("/following");
    expect(screen.getByTestId("account-settings-link").getAttribute("href")).toBe("/settings");
    expect(screen.getByTestId("account-coop-link").getAttribute("href")).toBe("/coop/membership");
    expect(screen.queryByText("Relays")).toBeNull();
    expect(screen.queryByText("Creator dashboard")).toBeNull();
    for (const id of [
      "subscriptions",
      "notifications",
      "appeals",
      "copyright",
      "privacy",
      "connections",
      "preferences",
    ])
      expect(screen.queryByTestId(`account-${id}-link`)).toBeNull();
  });

  it("leaves out Your channel for a member without a channel", async () => {
    const menu = await openMenu(MEMBER);
    expect(within(menu).queryByText("Your channel")).toBeNull();
    expect(within(menu).getAllByRole("menuitem")[0]?.textContent).toBe("Creator studio");
  });
});

describe("the bottom tab bar", () => {
  const bar = () => screen.getByTestId("tab-bar");
  const labels = () => [...bar().querySelectorAll("li")].map((li) => li.textContent);

  it("signed out: Home, Browse, Co-op and Sign in, with the current page marked", async () => {
    await renderInRouter(themed(<AppTabBar />), "/");
    expect(screen.getByRole("navigation", { name: "Sections" })).toBe(bar());
    expect(labels()).toEqual(["Home", "Browse", "Co-op", "Sign in"]);
    expect(screen.getByTestId("tab-home").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("tab-browse").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("tab-coop").getAttribute("href")).toBe("/coop");
  });

  it("signed out: the Sign in tab comes back to this page", async () => {
    await renderInRouter(themed(<AppTabBar />), "/directory/art");
    expect(screen.getByTestId("tab-you").getAttribute("href")).toBe("/signin?redirect=%2Fdirectory%2Fart");
    expect(screen.getByTestId("tab-browse").getAttribute("aria-current")).toBe("page");
  });

  it("session unresolved: You retries the check and never offers Sign in", async () => {
    let retried = 0;
    fake.retry = () => {
      retried++;
    };
    fake.boot = { ...boot(), sessionUnresolved: true };
    await renderInRouter(themed(<AppTabBar />), "/directory/art");
    const you = screen.getByTestId("tab-you");
    expect(you.getAttribute("href")).toBeNull();
    expect(you.textContent).toContain(t("fixSession.session.retry"));
    expect(you.textContent).not.toContain(t("shell.signIn"));
    fireEvent.click(you);
    expect(retried).toBe(1);
  });

  it("signed in: Home, Browse, Following and You; You opens the account sheet in the menu's order", async () => {
    fake.boot = boot({ me: STREAMER });
    const setTheme = vi.fn<(theme: Theme) => void>();
    await renderInRouter(themed(<AppTabBar />, setTheme), "/");
    expect(labels()).toEqual(["Home", "Browse", "Following", "You"]);
    expect(screen.getByTestId("tab-following").getAttribute("href")).toBe("/following");
    const you = screen.getByTestId("tab-you");
    expect(you.tagName).toBe("BUTTON");
    expect(you.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(you);
    });
    const sheet = await screen.findByTestId("you-sheet");
    expect(screen.getByTestId("tab-you").getAttribute("aria-expanded")).toBe("true");
    expect(within(sheet).getByText("Your account")).toBeTruthy();
    const rows = [...sheet.querySelectorAll('[data-testid^="you-"]')].map((el) => el.textContent);
    expect(rows).toEqual(["Your channel", "Creator studio", "Following", "Settings", "Co-op membership", "Sign out"]);
    // The theme sits before Sign out.
    const theme = within(sheet).getByRole("group", { name: "Theme" });
    expect(
      theme.compareDocumentPosition(within(sheet).getByTestId("you-signOut")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Rows are 44 px tap targets.
    expect(within(sheet).getByTestId("you-settings").className).toMatch(/\bmin-h-11\b/);
    expect(within(sheet).getByTestId("you-channel").getAttribute("href")).toBe("/rivertide");
  });

  it("closes the You sheet when one of its links is followed", async () => {
    fake.boot = boot({ me: STREAMER });
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener("click", stop);
    try {
      await renderInRouter(themed(<AppTabBar />), "/");
      await act(async () => {
        fireEvent.click(screen.getByTestId("tab-you"));
      });
      const sheet = await screen.findByTestId("you-sheet");
      await act(async () => {
        fireEvent.click(within(sheet).getByTestId("you-following"));
      });
      await waitFor(() => expect(screen.queryByTestId("you-sheet")).toBeNull());
    } finally {
      document.removeEventListener("click", stop);
    }
  });

  it("hides while a text field has focus (the on-screen keyboard is up), and comes back after", async () => {
    await renderInRouter(
      themed(
        <>
          <input data-testid="field" type="search" />
          <input data-testid="box" type="checkbox" />
          <AppTabBar />
        </>,
      ),
      "/",
    );
    expect(bar().hasAttribute("hidden")).toBe(false);
    act(() => screen.getByTestId("field").focus());
    await waitFor(() => expect(bar().hasAttribute("hidden")).toBe(true));
    act(() => screen.getByTestId("box").focus());
    await waitFor(() => expect(bar().hasAttribute("hidden")).toBe(false));
    act(() => screen.getByTestId("field").focus());
    await waitFor(() => expect(bar().hasAttribute("hidden")).toBe(true));
    act(() => screen.getByTestId("field").blur());
    await waitFor(() => expect(bar().hasAttribute("hidden")).toBe(false));
  });
});

describe("opensKeyboard", () => {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  it.each([
    ["a text input", make("input"), true],
    ["a search input", make("input", { type: "search" }), true],
    ["an email input", make("input", { type: "email" }), true],
    ["a textarea", make("textarea"), true],
    ["a checkbox", make("input", { type: "checkbox" }), false],
    ["a range", make("input", { type: "range" }), false],
    ["a submit button", make("input", { type: "submit" }), false],
    ["a read-only input", make("input", { readonly: "" }), false],
    ["a disabled textarea", make("textarea", { disabled: "" }), false],
    ["a button", make("button"), false],
    ["a link", make("a", { href: "/" }), false],
  ])("%s: %s", (_name, el, expected) => {
    expect(opensKeyboard(el)).toBe(expected);
  });

  it("is false for nothing focused", () => {
    expect(opensKeyboard(null)).toBe(false);
  });
});

describe("the footer", () => {
  it("has Create, Co-op and Legal with their links, in that order", async () => {
    await renderInRouter(themed(<AppFooter />), "/");
    const footer = screen.getByRole("contentinfo");
    const columns = ["Create", "Co-op", "Legal"].map((name) => within(footer).getByRole("navigation", { name }));
    const hrefs = columns.map((nav) => [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href")));
    expect(hrefs).toEqual([
      ["/creators", "/dashboard"],
      ["/coop", "/coop/membership", "/coop/proposals", "/transparency"],
      ["/terms", "/privacy", "/guidelines", "/dmca", "/takedown", "/attestations/verify"],
    ]);
    expect(within(columns[0] as HTMLElement).getByText("Stream on Test Air")).toBeTruthy();
    expect(within(footer).getByTestId("footer-creators-link")).toBeTruthy();
    expect(within(columns[2] as HTMLElement).getByTestId("footer-privacy-link").textContent).toBe("Privacy policy");
    expect(within(footer).getByTestId("footer-terms-link").textContent).toBe("Terms of service");
    expect(within(footer).getByTestId("footer-guidelines-link").textContent).toBe("Community guidelines");
    expect(within(footer).getByTestId("footer-transparency-link")).toBeTruthy();
    expect(within(footer).getByTestId("footer-dmca-link")).toBeTruthy();
    expect(within(footer).getByTestId("footer-takedown-link")).toBeTruthy();
    expect(within(footer).getByTestId("footer-attestations-link")).toBeTruthy();
  });

  it("lists Import from Twitch where the instance offers it", async () => {
    fake.boot = boot({ instance: { ...boot().instance, twitchImport: true } });
    await renderInRouter(themed(<AppFooter />), "/");
    expect(screen.getByTestId("footer-import-link").getAttribute("href")).toBe("/import");
  });

  it("has the theme for visitors only (members have it in the account menu)", async () => {
    await renderInRouter(themed(<AppFooter />), "/");
    expect(screen.getByTestId("footer-theme-switcher")).toBeTruthy();
    cleanup();
    fake.boot = boot({ me: MEMBER });
    await renderInRouter(themed(<AppFooter />), "/");
    expect(screen.queryByTestId("footer-theme-switcher")).toBeNull();
  });

  it("keeps cookie settings, the language and the license in the base row", async () => {
    await renderInRouter(themed(<AppFooter />), "/");
    const base = document.querySelector('[data-slot="site-footer-base"]') as HTMLElement;
    expect(within(base).getByTestId("footer-cookie-settings")).toBeTruthy();
    expect(within(base).getByText("Free software under the AGPL-3.0")).toBeTruthy();
    expect(within(base).getByRole("navigation", { name: "Site settings" })).toBeTruthy();
  });
});
