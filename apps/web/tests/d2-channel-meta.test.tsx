// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-channel (F9, F12, F13): the live metadata under the title. The category links into the
 * directory and tags are Badge links (through `lib/category-route.ts`); uptime is a clock from
 * `startedAt` at its boundaries (0 s, 59 s, 1 h, 48 h) that ticks; Share copies the canonical URL
 * and confirms with a toast; below `JUST_STARTED_BELOW` verified viewers the header says "Just
 * started" instead of an eye and a tiny number, and never changes the count. Also the live-aware
 * document title, and the unknown-channel page with its Live now shelf.
 */
import { LocaleProvider, TooltipProvider, formatIsoDuration } from "@commonair/ui";
import { SITE } from "@commonair/config/site";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

// The page renders through the router and its loader; on a busy CI runner the first paint can
// take longer than testing-library's 1 s default.
configure({ asyncUtilTimeout: 5_000 });

const toasts = vi.hoisted(() => ({ success: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() }));
vi.mock("@commonair/ui/toast", () => ({ toast: toasts }));
vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: null, config: { publicUrl: "https://air.example.test/" }, now: Date.now() }),
}));
vi.mock("../src/lib/use-channel.ts", () => ({ useChannel: (_slug: string, initial: unknown) => initial }));
vi.mock("../src/player/player.tsx", () => ({ Player: () => <div data-testid="player" /> }));
vi.mock("../src/chat/chat-panel.tsx", () => ({ ChatPanel: () => <div data-testid="chat" /> }));
vi.mock("../src/components/support/support-dialog.tsx", () => ({ SupportButton: () => null }));
// The not-found state brings no site chrome here (that needs the bootstrap).
vi.mock("../src/components/site-chrome.tsx", () => ({ AppHeader: () => null, AppFooter: () => null }));

const { Route } = await import("../src/routes/_app/$channel.tsx");
const data = await import("../src/components/channel/channel-data.ts");
const { summarize } = await import("../src/lib/channel-summary.ts");
const { ShareButton, Uptime, CategoryLink, ChannelOverflowMenu } =
  await import("../src/components/channel/channel-meta.tsx");
const { ChannelNotFoundPage, LIVE_NOW_COUNT } = await import("../src/components/channel/live-now-shelf.tsx");
type ChannelPage = import("../src/components/channel/panels-loader.ts").ChannelPage;
type StreamCard = import("@commonair/contracts/dto").StreamCard;
type ReportClient = import("../src/components/safety/client.ts").ReportClient;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  toasts.success.mockReset();
  toasts.error.mockReset();
});

const START = "2026-11-04T10:00:00.000Z";
const at = (seconds: number) => Date.parse(START) + seconds * 1000;

function livePage(viewerCount: number, startedAt = new Date(Date.now() - 90_000).toISOString()): ChannelPage {
  return {
    summary: {
      id: "0192f000-0000-7000-8000-000000000001",
      slug: "fern",
      displayName: "Fernsby",
      title: "Cozy",
      avatarUrl: null,
      accent: null,
      mature: false,
      live: {
        id: "0192f000-0000-7000-8000-000000000050",
        title: "Painting live",
        viewerCount,
        catchingUpCount: 0,
        startedAt,
        mature: false,
        restricted: null,
      },
      category: { id: "0192f000-0000-7000-8000-0000000000c1", slug: "art", name: "Art" },
      tags: ["cozy", "watercolor"],
      lastLiveAt: null,
      followerCount: 2,
      following: null,
      portabilityGrant: null,
      movedTo: null,
    },
    extras: { bannerUrl: null, panels: [], suspended: false },
    about: { bio: "", socials: [] },
    vods: { items: [], nextCursor: null },
    clips: { items: [], nextCursor: null },
  };
}

function providers(node: React.ReactNode) {
  return (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>
  );
}

function renderPage(page: ChannelPage) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const app = createRoute({ getParentRoute: () => root, id: "_app", component: () => <Outlet /> });
  const channel = createRoute({
    getParentRoute: () => app,
    path: "$channel",
    loader: () => page,
    component: Route.options.component as never,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([channel])]),
    history: createMemoryHistory({ initialEntries: ["/fern"] }),
  });
  return render(providers(<RouterProvider router={router} />));
}

describe("uptime", () => {
  it("formats as a clock at the boundaries: 0 s, 59 s, 1 h, 48 h", () => {
    expect(data.formatUptime(0)).toBe("0:00");
    expect(data.formatUptime(59)).toBe("0:59");
    expect(data.formatUptime(60)).toBe("1:00");
    expect(data.formatUptime(3599)).toBe("59:59");
    expect(data.formatUptime(3600)).toBe("1:00:00");
    expect(data.formatUptime(3661)).toBe("1:01:01");
    expect(data.formatUptime(48 * 3600)).toBe("48:00:00");
    expect(data.formatUptime(100 * 3600 + 5)).toBe("100:00:05");
  });

  it("counts whole seconds from startedAt; a future, invalid or missing start is 0", () => {
    expect(data.uptimeSeconds(START, at(0))).toBe(0);
    expect(data.uptimeSeconds(START, at(59.999))).toBe(59);
    expect(data.uptimeSeconds(START, at(3600))).toBe(3600);
    expect(data.uptimeSeconds(START, at(48 * 3600))).toBe(172_800);
    expect(data.uptimeSeconds(START, at(-30))).toBe(0);
    expect(data.uptimeSeconds("nope", at(10))).toBe(0);
    expect(data.uptimeSeconds("", at(10))).toBe(0);
    expect(data.uptimeSeconds(START, Number.NaN)).toBe(0);
  });

  it("<Uptime> renders the request time first, then ticks every second, with a label for screen readers", () => {
    vi.useFakeTimers({ now: at(59) });
    render(providers(<Uptime startedAt={START} now={at(59)} />));
    const el = screen.getByTestId("channel-meta-uptime");
    expect(el.textContent).toBe("Live for 0:59");
    // The shared primitive's elapsed mode, with the ISO duration as the machine value.
    const time = el.querySelector("time");
    expect(time?.getAttribute("data-mode")).toBe("elapsed");
    expect(time?.getAttribute("datetime")).toBe("PT59S");
    expect(time?.getAttribute("datetime")).toBe(formatIsoDuration(59));
    expect(el.closest("[aria-live]")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(el.textContent).toBe("Live for 1:00");
    act(() => {
      vi.advanceTimersByTime(3599_000);
    });
    expect(el.textContent).toBe("Live for 1:00:59");
  });

  it("<Uptime> corrects a stale request time on mount (a client-side navigation hours later)", () => {
    vi.useFakeTimers({ now: at(2 * 3600) });
    // The bootstrap `now` is from before the broadcast started.
    render(providers(<Uptime startedAt={START} now={at(-600)} />));
    expect(screen.getByTestId("channel-meta-uptime").textContent).toBe("Live for 2:00:00");
  });

  it("<Uptime> shows when the broadcast started in its tooltip", async () => {
    vi.useFakeTimers({ now: at(90), shouldAdvanceTime: true });
    render(providers(<Uptime startedAt={START} now={at(90)} />));
    const time = screen.getByTestId("channel-meta-uptime").querySelector("time");
    expect(time).not.toBeNull();
    if (time) fireEvent.focus(time);
    expect(await screen.findByText(/November 4, 2026/)).toBeTruthy();
  });
});

describe("Just started (F12)", () => {
  it("the threshold is a named constant and the count is never padded", () => {
    expect(data.JUST_STARTED_BELOW).toBe(3);
    for (const n of [0, 1, 2]) expect(data.showsJustStarted(n)).toBe(true);
    for (const n of [3, 4, 1000]) expect(data.showsJustStarted(n)).toBe(false);
    expect(data.showsJustStarted(Number.NaN)).toBe(true);
  });

  it("below it: 'Just started' beside the live badge, and no eye and no number", async () => {
    renderPage(livePage(data.JUST_STARTED_BELOW - 1));
    const badge = await screen.findByTestId("channel-just-started");
    expect(badge.textContent).toBe("Just started");
    expect(document.querySelector('[data-slot="live-badge"]')?.nextElementSibling).toBe(badge);
    expect(document.querySelector('[data-slot="viewer-count"]')).toBeNull();
  });

  it("at it: the verified count as it is, and no label", async () => {
    renderPage(livePage(data.JUST_STARTED_BELOW));
    await screen.findByTestId("channel-meta-uptime");
    expect(screen.queryByTestId("channel-just-started")).toBeNull();
    expect(document.querySelector('[data-slot="viewer-count"]')?.textContent).toContain("3");
  });
});

describe("category and tags (F9)", () => {
  it("the live header links the category and each tag into the directory", async () => {
    renderPage(livePage(10));
    // The header's comes first (with no VODs or clips, Home's About card links it too).
    const [category] = await screen.findAllByTestId("channel-meta-category");
    if (!category) throw new Error("no category link");
    expect(category.textContent).toBe("Art");
    expect(category.getAttribute("href")).toBe("/directory/art");
    const tags = screen.getAllByTestId("channel-meta-tag");
    expect(tags.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["cozy", "/directory?tag=cozy"],
      ["watercolor", "/directory?tag=watercolor"],
    ]);
    expect(tags[0]?.closest("ul")?.getAttribute("aria-label")).toBe("Tags");
    // Started 90 s ago (to the ms); the clock reads whole seconds, so it may show 1:29.
    expect(screen.getByTestId("channel-meta-uptime").textContent).toMatch(/^Live for 1:(29|3\d)$/);
  });

  it("CategoryLink encodes the slug", async () => {
    const root = createRootRoute({
      component: () => <CategoryLink category={{ slug: "music & dj", name: "Music" }} />,
    });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(providers(<RouterProvider router={router} />));
    const link = await screen.findByTestId("channel-meta-category");
    expect(link.getAttribute("href")).toBe("/directory/music%20%26%20dj");
  });

  it("summarize prefers the live broadcast's category and dedupes tags", () => {
    const base = {
      id: "c",
      slug: "fern",
      displayName: "Fern",
      title: "",
      avatarUrl: null,
      followerCount: 0,
      theme: {},
      lastLiveAt: null,
    };
    const live = summarize({
      ...base,
      category: { id: "c1", slug: "art", name: "Art" },
      live: {
        id: "b",
        title: "",
        viewerCount: 1,
        startedAt: START,
        category: { id: "c2", slug: "music", name: "Music" },
      },
      tags: ["Cozy", "cozy", " ", "lofi", "LOFI "],
    } as never);
    expect(live.category).toEqual({ id: "c2", slug: "music", name: "Music" });
    expect(live.tags).toEqual(["Cozy", "lofi"]);
    const offline = summarize({
      ...base,
      category: { id: "c1", slug: "art", name: "Art" },
      live: null,
      tags: [],
    } as never);
    expect(offline.category).toEqual({ id: "c1", slug: "art", name: "Art" });
    expect(summarize({ ...base, category: null, live: null, tags: [] } as never).category).toBeNull();
  });
});

describe("Share (F9)", () => {
  it("copies the canonical URL and confirms with a toast", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    render(
      providers(<ShareButton url={data.channelUrl("https://air.example.test/", "fern")} clipboard={{ writeText }} />),
    );
    const button = screen.getByTestId("channel-share");
    expect(button.getAttribute("aria-label")).toBe("Share");
    act(() => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Link copied"));
    expect(writeText).toHaveBeenCalledWith("https://air.example.test/fern");
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("says so when the copy fails or there is no clipboard", async () => {
    render(
      providers(
        <ShareButton
          url="https://air.example.test/fern"
          clipboard={{ writeText: () => Promise.reject(new Error("denied")) }}
        />,
      ),
    );
    act(() => {
      fireEvent.click(screen.getByTestId("channel-share"));
    });
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Could not copy the link"));
    cleanup();
    render(providers(<ShareButton url="https://air.example.test/fern" clipboard={null} />));
    act(() => {
      fireEvent.click(screen.getByTestId("channel-share"));
    });
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(2));
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("the page shares its own canonical URL", async () => {
    renderPage(livePage(10));
    expect((await screen.findByTestId("channel-share")).getAttribute("data-url")).toBe("https://air.example.test/fern");
    expect(data.channelUrl("https://a.test//", "x_y")).toBe("https://a.test/x_y");
  });
});

describe("the phone overflow menu's report (F4)", () => {
  it("files a report about the channel from the dialog, then closes it", async () => {
    const report = vi.fn<ReportClient["report"]>(async () => ({ id: "0192f000-0000-7000-8000-0000000000r1" }) as never);
    render(
      providers(
        <ChannelOverflowMenu
          signedIn
          subjectType="channel"
          subjectId="0192f000-0000-7000-8000-000000000001"
          client={{ report } as unknown as ReportClient}
        />,
      ),
    );
    act(() => {
      fireEvent.click(screen.getByTestId("channel-overflow"));
    });
    const item = await screen.findByTestId("channel-overflow-report");
    act(() => {
      fireEvent.click(item);
    });
    await screen.findByTestId("report-dialog");
    fireEvent.click(screen.getByTestId("report-reason"));
    const spam = await screen.findByTestId("report-reason-spam");
    fireEvent.pointerDown(spam, { pointerType: "mouse" });
    fireEvent.click(spam);
    fireEvent.change(screen.getByTestId("report-details"), { target: { value: "  bot spam  " } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("report-submit"));
    });
    expect(report).toHaveBeenCalledWith({
      subjectType: "channel",
      subjectId: "0192f000-0000-7000-8000-000000000001",
      reason: "spam",
      details: "bot spam",
    });
    await waitFor(() => expect(screen.queryByTestId("report-dialog")).toBeNull());
    expect(toasts.success).toHaveBeenCalledWith(t("safety.report.done"));
  });
});

describe("the document title", () => {
  type Head = (ctx: unknown) => { meta: { title: string }[] };
  const head = Route.options.head as unknown as Head;
  const titleOf = (ctx: unknown) => head(ctx).meta[0]?.title;

  it("says (live) while live, and is the name otherwise", () => {
    expect(titleOf({ params: { channel: "fern" }, loaderData: livePage(1) })).toBe(`Fernsby (live) · ${SITE.name}`);
    const offline = livePage(1);
    offline.summary.live = null;
    expect(titleOf({ params: { channel: "fern" }, loaderData: offline })).toBe(`Fernsby · ${SITE.name}`);
    expect(titleOf({ params: { channel: "fern" } })).toBe(`fern · ${SITE.name}`);
  });
});

describe("an unknown channel (F13)", () => {
  const card = (slug: string): StreamCard => ({
    channel: { id: `id-${slug}`, slug, displayName: slug, avatarUrl: null, accent: "teal" },
    broadcast: {
      id: `b-${slug}`,
      title: "Live",
      category: null,
      startedAt: START,
      mature: false,
      viewerCount: 5,
      thumbnailUrl: null,
    },
    tags: [],
    language: "en",
    reason: "popular",
  });

  function renderNotFound(load: () => Promise<StreamCard[]>) {
    const root = createRootRoute({ component: () => <ChannelNotFoundPage load={load} /> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
    return render(providers(<RouterProvider router={router} />));
  }

  it("explains, offers one Browse live channels action, then a Live now shelf", async () => {
    renderNotFound(async () => [card("aurora"), card("birch")]);
    const state = await screen.findByTestId("channel-not-found");
    expect(state.textContent).toContain("This channel does not exist");
    const shelf = await screen.findByTestId("channel-live-now");
    await waitFor(() => expect(shelf.querySelectorAll('[data-testid="stream-card"]')).toHaveLength(2));
    expect(shelf.textContent).toContain("Live now");
    expect(screen.getAllByTestId("empty-state-action")).toHaveLength(1);
    expect(state.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no shelf when nobody is live or the directory fails", async () => {
    renderNotFound(async () => []);
    await screen.findByTestId("channel-not-found");
    await waitFor(() => expect(screen.queryByTestId("channel-live-now")).toBeNull());
    cleanup();
    renderNotFound(() => Promise.reject(new Error("down")));
    await screen.findByTestId("channel-not-found");
    await waitFor(() => expect(screen.queryByTestId("channel-live-now")).toBeNull());
  });

  it("shows skeletons while loading, then at most LIVE_NOW_COUNT cards", async () => {
    let resolve: (cards: StreamCard[]) => void = () => {};
    renderNotFound(() => new Promise((r) => (resolve = r)));
    const shelf = await screen.findByTestId("channel-live-now");
    expect(shelf.querySelectorAll('[data-testid="stream-card"]')).toHaveLength(0);
    expect(shelf.querySelectorAll('[data-slot="stream-card-skeleton"]')).toHaveLength(3);
    const many = Array.from({ length: LIVE_NOW_COUNT + 3 }, (_, i) => card(`c${i}`));
    await act(async () => resolve(many));
    await waitFor(() => expect(shelf.querySelectorAll('[data-testid="stream-card"]')).toHaveLength(LIVE_NOW_COUNT));
  });

  it("ignores a load that settles after the page is gone", async () => {
    const errors = vi.spyOn(console, "error");
    for (const settle of ["resolve", "reject"] as const) {
      let done: { resolve: (c: StreamCard[]) => void; reject: (e: Error) => void } | null = null;
      const { unmount } = renderNotFound(
        () => new Promise<StreamCard[]>((resolve, reject) => (done = { resolve, reject })),
      );
      await screen.findByTestId("channel-live-now");
      unmount();
      await act(async () => {
        if (settle === "resolve") done?.resolve([card("late")]);
        else done?.reject(new Error("late"));
      });
    }
    expect(screen.queryByTestId("channel-live-now")).toBeNull();
    // No state update on an unmounted component.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("is the route's not-found page", () => {
    expect(Route.options.notFoundComponent).toBeTypeOf("function");
  });
});
