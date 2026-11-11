// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul D4.1, D4.2 (in d2-player-settings), D4.6 and D4.7 on the channel page:
 *
 * - below `lg` (375 px) the page is a sticky player, the compact row, "Chat | About" and then chat
 *   (live) or About (offline); from `lg` (1440 px) both show side by side;
 * - exactly one `follow-button` on the live and the offline page at 375 and 1440 px;
 * - the owner's Stream manager and Edit channel, a moderator's or editor's Mod view, nobody else's;
 * - the neutral trust mark from `Channel.ownerCoop`, and "Verified viewers" with its "How we count"
 *   link to `/transparency#how-we-count`;
 * - the portability switch is no longer on the page (d4-follow puts it in the Following menu).
 *
 * happy-dom has no layout engine, so "visible at a width" reads the responsive classes the page
 * uses (`max-lg:hidden`, `lg:hidden`, `hidden lg:contents`) on the element and its ancestors.
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
import { act, cleanup, configure, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";

configure({ asyncUtilTimeout: 5_000 });

type Me = { id: string; username: string; displayName: string; channelSlug: string | null; role: string };
const fake = vi.hoisted(() => ({
  me: null as null | Me,
  moderates: (async () => []) as () => Promise<unknown[]>,
  moderatesCalls: 0,
}));
vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: fake.me, config: { publicUrl: "https://air.example.test" }, now: Date.now() }),
}));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({
    me: {
      moderates: () => {
        fake.moderatesCalls += 1;
        return fake.moderates();
      },
    },
  }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
vi.mock("../src/lib/use-channel.ts", () => ({ useChannel: (_slug: string, initial: unknown) => initial }));
vi.mock("../src/player/player.tsx", () => ({ Player: () => <div data-testid="player" /> }));
vi.mock("../src/chat/chat-panel.tsx", () => ({
  ChatPanel: ({ className, following }: { className?: string; following?: boolean | null }) => (
    <div data-testid="chat" data-following={String(following)} className={className} />
  ),
}));
vi.mock("../src/components/support/support-dialog.tsx", () => ({
  SupportButton: () => <span data-testid="support-stub">Support</span>,
}));

const { Route } = await import("../src/routes/_app/$channel.tsx");
const { defaultWatchPanel, useModerates, useWatchPanel } =
  await import("../src/components/watch-layout/watch-layout.tsx");
const { parseChannelSearch } = await import("../src/components/channel/channel-data.ts");
type ChannelPage = import("../src/components/channel/panels-loader.ts").ChannelPage;

beforeAll(async () => {
  const c = Route.options.component as { preload?: () => Promise<void> } | undefined;
  await c?.preload?.();
});

afterEach(() => {
  cleanup();
  fake.me = null;
  fake.moderates = async () => [];
  fake.moderatesCalls = 0;
});

const VIEWER: Me = { id: "u1", username: "pine", displayName: "Pine", channelSlug: null, role: "user" };
const OWNER: Me = { id: "u2", username: "fern", displayName: "Fernsby", channelSlug: "fern", role: "user" };
const uuid = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

function page(over: { live?: boolean; viewers?: number; coop?: ChannelPage["ownerCoop"] } = {}): ChannelPage {
  return {
    summary: {
      id: uuid(1),
      slug: "fern",
      displayName: "Fernsby",
      title: "Cozy village",
      avatarUrl: null,
      accent: null,
      mature: false,
      live: over.live
        ? {
            id: uuid(50),
            title: "Building the mill",
            viewerCount: over.viewers ?? 12,
            catchingUpCount: 0,
            startedAt: new Date().toISOString(),
            mature: false,
            restricted: null,
          }
        : null,
      category: { id: uuid(9), slug: "art", name: "Art" },
      tags: [],
      lastLiveAt: "2026-10-29T19:00:00.000Z",
      followerCount: 3,
      following: false,
      portabilityGrant: false,
      movedTo: null,
    },
    extras: { bannerUrl: null, panels: [], suspended: false },
    about: { bio: "I build villages.", socials: [] },
    vods: { items: [], nextCursor: null },
    clips: { items: [], nextCursor: null },
    ownerCoop: over.coop ?? { member: false, council: false },
  };
}

function renderPage(data: ChannelPage, path = "/fern") {
  const root = createRootRoute({ component: () => <Outlet /> });
  const app = createRoute({ getParentRoute: () => root, id: "_app", component: () => <Outlet /> });
  const channel = createRoute({
    getParentRoute: () => app,
    path: "$channel",
    validateSearch: Route.options.validateSearch as typeof parseChannelSearch,
    loader: () => data,
    component: Route.options.component as never,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([channel])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

const classes = (el: Element) => new Set((el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
const SHOWN_FROM_LG = ["lg:contents", "lg:flex", "lg:inline-flex", "lg:block", "lg:grid"];

/** Whether the responsive classes on `el` and its ancestors leave it shown at `width` px. */
function shownAt(el: Element, width: number): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = classes(n);
    if (width < 1024) {
      if (c.has("max-lg:hidden") || (c.has("hidden") && !c.has("max-lg:flex"))) return false;
    } else if (c.has("lg:hidden") || (c.has("hidden") && !SHOWN_FROM_LG.some((k) => c.has(k)))) return false;
  }
  return true;
}

const all = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
const slot = (name: string) => document.querySelector(`[data-watch-slot="${name}"]`) as HTMLElement;
const pageEl = () => screen.getByTestId("channel-page");

/** The page's blocks in document order that are shown at `width`, by what they hold. */
function shownBlocks(width: number): string[] {
  const blocks: [string, Element | null][] = [
    ["player", slot("stage")],
    ["header", pageEl().querySelector("section h1")?.closest("section") ?? null],
    ["switch", screen.queryByTestId("watch-panel-switch")],
    ["about", slot("details")],
    ["chat", slot("chat")],
  ];
  return blocks
    .filter((b): b is [string, Element] => b[1] !== null && shownAt(b[1], width))
    .sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map(([name]) => name);
}

describe("the phone and tablet layout (D4.1)", () => {
  it("live at 375 px: the player, the compact row, the switch, then chat first", async () => {
    renderPage(page({ live: true }));
    await screen.findByTestId("player");
    expect(pageEl().getAttribute("data-watch-panel")).toBe("chat");
    expect(shownBlocks(375)).toEqual(["player", "header", "switch", "chat"]);
    // The chat column fills what the viewport leaves (`chat-column-fill`).
    expect(classes(screen.getByTestId("chat")).has("chat-column-fill")).toBe(true);
    // At 1440 px both panels show beside each other, and there is no switch.
    expect(shownBlocks(1440)).toEqual(["player", "header", "about", "chat"]);
  });

  it("About swaps the panel without remounting chat; the title and the count's note are in it", async () => {
    renderPage(page({ live: true }));
    const chat = await screen.findByTestId("chat");
    expect(shownAt(screen.getByTestId("watch-about-intro"), 375)).toBe(false);
    act(() => {
      fireEvent.click(screen.getByTestId("watch-panel-about"));
    });
    await waitFor(() => expect(pageEl().getAttribute("data-watch-panel")).toBe("about"));
    expect(shownBlocks(375)).toEqual(["player", "header", "switch", "about"]);
    expect(screen.getByTestId("chat")).toBe(chat);
    const intro = screen.getByTestId("watch-about-intro");
    expect(intro.textContent).toContain("Building the mill");
    expect(shownAt(intro, 375)).toBe(true);
    expect(shownAt(intro, 1440)).toBe(false);
    // The header's title is left out below lg, kept from it.
    const title = pageEl().querySelector('[data-slot="channel-header-title"]') as Element;
    expect([shownAt(title, 375), shownAt(title, 1440)]).toEqual([false, true]);
  });

  it("offline, About is the default; another channel tab in the URL opens About while live too", async () => {
    renderPage(page());
    await screen.findByTestId("channel-offline-home");
    expect(pageEl().getAttribute("data-watch-panel")).toBe("about");
    expect(shownBlocks(375)).toEqual(["header", "switch", "about"]);
    expect(defaultWatchPanel(true, "home")).toBe("chat");
    expect(defaultWatchPanel(true, "videos")).toBe("about");
    expect(defaultWatchPanel(false, "home")).toBe("about");
  });

  it("the panel goes back to the default when the channel goes live", () => {
    const { result, rerender } = renderHook(({ live }) => useWatchPanel(live, "home"), {
      initialProps: { live: false },
    });
    expect(result.current[0]).toBe("about");
    act(() => result.current[1]("chat"));
    expect(result.current[0]).toBe("chat");
    rerender({ live: true });
    expect(result.current[0]).toBe("chat");
    act(() => result.current[1]("about"));
    rerender({ live: false });
    expect(result.current[0]).toBe("about");
  });

  it("the CSS: the header scrolls away, the player sticks, the footer is left out with chat", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/components/watch-layout/watch-layout.css"), "utf8");
    const body = /@media \(max-width: 63\.99rem\) \{([\s\S]*)\}\s*$/.exec(css.trim())?.[1] ?? "";
    expect(body).toMatch(/\[data-slot="app-shell-header"\]\s*\{\s*position: relative;/);
    expect(body).toMatch(/\[data-watch-slot="stage"\]\s*\{\s*position: sticky;\s*top: 0;/);
    // The left column steps out of the box tree, so the stage sticks over chat too.
    expect(body).toMatch(/\[data-watch-slot="main"\]\s*\{\s*display: contents;/);
    expect(body).toMatch(/\[data-watch-panel="chat"\]\) \[data-slot="site-footer"\]\s*\{\s*display: none;/);
    expect(body).toMatch(
      /\[data-watch-layout\]\[data-watch-panel="chat"\]\s*\{\s*min-height: calc\(100dvh - 3\.5rem\);/,
    );
  });
});

describe("one Follow button (every breakpoint)", () => {
  const follows = () => all("follow-button");

  it("live: the header row's, at 375 and 1440 px", async () => {
    fake.me = VIEWER;
    renderPage(page({ live: true }));
    await screen.findByTestId("player");
    expect(follows()).toHaveLength(1);
    for (const w of [375, 1440]) expect(follows().filter((f) => shownAt(f, w))).toHaveLength(1);
  });

  it("offline Home: the Follow hero's, not the header's, at 375 and 1440 px", async () => {
    renderPage(page());
    const hero = await screen.findByTestId("channel-offline-follow-hero");
    expect(follows()).toHaveLength(1);
    expect(hero.contains(follows()[0] as Node)).toBe(true);
    for (const w of [375, 1440]) expect(follows().filter((f) => shownAt(f, w))).toHaveLength(1);
  });

  it("offline with Chat picked on a phone, or on another tab: the header's", async () => {
    renderPage(page());
    await screen.findByTestId("channel-offline-follow-hero");
    act(() => {
      fireEvent.click(screen.getByTestId("watch-panel-chat"));
    });
    await waitFor(() => expect(pageEl().getAttribute("data-watch-panel")).toBe("chat"));
    expect(follows()).toHaveLength(1);
    expect(screen.getByTestId("channel-offline-follow-hero").contains(follows()[0] as Node)).toBe(false);
    expect(follows().filter((f) => shownAt(f, 375))).toHaveLength(1);
    cleanup();
    renderPage(page(), "/fern?tab=videos");
    await screen.findByTestId("channel-video-grid");
    expect(follows()).toHaveLength(1);
    for (const w of [375, 1440]) expect(follows().filter((f) => shownAt(f, w))).toHaveLength(1);
  });

  it("the portability switch is not on the page any more", async () => {
    fake.me = VIEWER;
    const data = page({ live: true });
    data.summary.following = true;
    renderPage(data);
    await screen.findByTestId("player");
    expect(screen.queryByTestId("portability-grant-toggle")).toBeNull();
  });

  it("a follower's Following menu carries the move grant and the known alerts; chat knows they follow", async () => {
    fake.me = VIEWER;
    const data = page({ live: true });
    data.summary.following = true;
    data.summary.notify = false;
    renderPage(data);
    await screen.findByTestId("player");
    // The page's `Channel.viewer.notify`, so the bell never reads the follows list.
    expect(screen.getByTestId("follow-bell").dataset.notify).toBe("false");
    expect(screen.getByTestId("chat").dataset.following).toBe("true");
    fireEvent.click(screen.getByTestId("follow-button"));
    await screen.findByTestId("follow-menu");
    expect(screen.getByTestId("follow-menu-move").textContent).toContain("Fernsby");
  });

  it("not following: chat is told so; signed out: unknown", async () => {
    fake.me = VIEWER;
    renderPage(page({ live: true }));
    await screen.findByTestId("player");
    expect(screen.getByTestId("chat").dataset.following).toBe("false");
    cleanup();
    fake.me = null;
    const data = page({ live: true });
    data.summary.following = null;
    renderPage(data);
    await screen.findByTestId("player");
    expect(screen.getByTestId("chat").dataset.following).toBe("null");
  });
});

describe("Share and Report below lg", () => {
  it("are in the More menu, beside Follow and Support from lg", async () => {
    renderPage(page({ live: true }));
    const more = await screen.findByTestId("channel-overflow");
    expect([shownAt(more, 375), shownAt(more, 1440)]).toEqual([true, false]);
    const share = screen.getByTestId("channel-share");
    expect([shownAt(share, 375), shownAt(share, 1440)]).toEqual([false, true]);
    act(() => {
      fireEvent.click(more);
    });
    const item = await screen.findByTestId("channel-overflow-share");
    expect(item.getAttribute("data-url")).toBe("https://air.example.test/fern");
  });
});

describe("owner and moderator shortcuts (D4.6, J5-a)", () => {
  it("the owner gets Stream manager and Edit channel, no Follow and no Mod view", async () => {
    fake.me = OWNER;
    renderPage(page({ live: true }));
    const manager = await screen.findByTestId("channel-owner-stream-manager");
    expect(manager.getAttribute("href")).toBe("/dashboard");
    expect(screen.getByTestId("channel-owner-edit").getAttribute("href")).toBe("/dashboard/settings");
    expect(screen.getByTestId("channel-owner-edit").textContent).toContain("Edit channel");
    expect(screen.queryByTestId("follow-button")).toBeNull();
    expect(screen.queryByTestId("channel-mod-view")).toBeNull();
    // The owner's own channel is never asked about.
    expect(fake.moderatesCalls).toBe(0);
  });

  it("a moderator of this channel gets Mod view", async () => {
    fake.me = VIEWER;
    fake.moderates = async () => [
      {
        channel: { id: uuid(3), slug: "other", displayName: "Other", avatarUrl: null, accent: "teal" },
        role: "moderator",
        live: false,
      },
      {
        channel: { id: uuid(1), slug: "fern", displayName: "Fernsby", avatarUrl: null, accent: "teal" },
        role: "moderator",
        live: true,
      },
    ];
    renderPage(page({ live: true }));
    const mod = await screen.findByTestId("channel-mod-view");
    expect(mod.getAttribute("href")).toBe("/mod/fern");
    expect(mod.textContent).toContain("Mod view");
    expect(screen.queryByTestId("channel-owner-stream-manager")).toBeNull();
  });

  it("an editor gets Mod view too (editors may moderate)", async () => {
    fake.me = VIEWER;
    fake.moderates = async () => [
      {
        channel: { id: uuid(1), slug: "fern", displayName: "F", avatarUrl: null, accent: "teal" },
        role: "editor",
        live: true,
      },
    ];
    renderPage(page({ live: true }));
    const mod = await screen.findByTestId("channel-mod-view");
    expect(mod.getAttribute("href")).toBe("/mod/fern");
    expect(screen.queryByTestId("channel-owner-stream-manager")).toBeNull();
  });

  it("nobody else: another channel's moderator, a visitor, or a failed answer", async () => {
    const answers = [
      async () => [
        {
          channel: { id: uuid(3), slug: "other", displayName: "O", avatarUrl: null, accent: "teal" },
          role: "moderator",
          live: true,
        },
      ],
      async () => {
        throw new Error("501");
      },
    ];
    for (const answer of answers) {
      fake.me = VIEWER;
      fake.moderates = answer;
      renderPage(page({ live: true }));
      await screen.findByTestId("player");
      await waitFor(() => expect(fake.moderatesCalls).toBeGreaterThan(0));
      await act(async () => {});
      expect(screen.queryByTestId("channel-mod-view")).toBeNull();
      cleanup();
      fake.moderatesCalls = 0;
    }
    fake.me = null;
    renderPage(page({ live: true }));
    await screen.findByTestId("player");
    expect(fake.moderatesCalls).toBe(0);
    expect(screen.queryByTestId("channel-mod-view")).toBeNull();
    expect(screen.queryByTestId("channel-owner-edit")).toBeNull();
  });

  it("useModerates answers for the channel it was asked about only", async () => {
    let resolve: (v: unknown[]) => void = () => {};
    const client = { moderates: () => new Promise<never[]>((r) => (resolve = r as never)) };
    const { result, rerender } = renderHook(({ channel }) => useModerates(channel, true, client as never), {
      initialProps: { channel: "fern" },
    });
    expect(result.current).toBe(false);
    await act(async () => resolve([{ channel: { slug: "fern" }, role: "moderator", live: false }]));
    expect(result.current).toBe(true);
    rerender({ channel: "dune" });
    expect(result.current).toBe(false);
  });
});

describe("trust marks (D4.7)", () => {
  it("offline: one neutral mark in the header, and on the About card; council outranks member", async () => {
    renderPage(page({ coop: { member: true, council: true } }));
    const badge = await screen.findByTestId("channel-trust-badge");
    expect(badge.getAttribute("data-kind")).toBe("council");
    const short = badge.querySelector('[data-slot="trust-short"]');
    const long = badge.querySelector('[data-slot="trust-long"]');
    expect(short?.textContent).toBe("Creator council");
    expect(short?.getAttribute("aria-hidden")).toBe("true");
    // The long form is real text for screen readers, not aria-label on a plain span.
    expect(long?.textContent).toBe("Fernsby sits on the creator council");
    expect(long?.className).toContain("sr-only");
    expect(badge.hasAttribute("aria-label")).toBe(false);
    // Neutral: an outline badge, never the brand fill.
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    expect(badge.className).not.toMatch(/bg-primary|bg-brand|channel-accent/);
    expect(screen.getByTestId("channel-about-trust").getAttribute("data-kind")).toBe("council");
  });

  it("a member-owner reads Member-owner; neither shows nothing", async () => {
    renderPage(page({ coop: { member: true, council: false } }));
    const member = await screen.findByTestId("channel-trust-badge");
    expect(member.querySelector('[data-slot="trust-short"]')?.textContent).toBe("Member-owner");
    expect(member.querySelector('[data-slot="trust-long"]')?.textContent).toBe(
      "Fernsby is a member-owner of the co-op",
    );
    cleanup();
    renderPage(page());
    await screen.findByTestId("channel-offline-home");
    expect(screen.queryByTestId("channel-trust-badge")).toBeNull();
    expect(screen.queryByTestId("channel-about-trust")).toBeNull();
  });

  it("live: not in the header; About carries it", async () => {
    renderPage(page({ live: true, coop: { member: true, council: false } }), "/fern?tab=about");
    await screen.findByTestId("channel-about");
    expect(screen.queryByTestId("channel-trust-badge")).toBeNull();
    const about = screen.getByTestId("channel-about-trust");
    expect(about.querySelector('[data-slot="trust-short"]')?.textContent).toBe("Member-owner");
  });
});

describe("verified viewers (D4.7)", () => {
  it("live: Verified viewers, beside the count from lg and in About below it", async () => {
    renderPage(page({ live: true, viewers: 12 }));
    const note = await screen.findByTestId("channel-verified-viewers");
    expect(note.querySelector('[data-slot="verified-label"]')?.textContent).toBe("Verified viewers");
    // "How we count" opens the transparency page's explainer (D6.1), never the verifier.
    const link = note.querySelector("a");
    expect([link?.textContent, link?.getAttribute("href")]).toEqual(["How we count", "/transparency#how-we-count"]);
    expect([shownAt(note, 375), shownAt(note, 1440)]).toEqual([false, true]);
    const mobile = screen.getByTestId("channel-verified-viewers-mobile");
    expect(mobile.querySelector('[data-slot="verified-label"]')?.textContent).toBe("Verified viewers");
    expect(mobile.querySelector("a")?.getAttribute("href")).toBe("/transparency#how-we-count");
  });

  it("just started (no count shown) or offline: no note", async () => {
    renderPage(page({ live: true, viewers: 1 }));
    await screen.findByTestId("channel-just-started");
    expect(screen.queryByTestId("channel-verified-viewers")).toBeNull();
    expect(screen.queryByTestId("channel-verified-viewers-mobile")).toBeNull();
    cleanup();
    renderPage(page());
    await screen.findByTestId("channel-offline-home");
    expect(screen.queryByTestId("channel-verified-viewers")).toBeNull();
  });
});
