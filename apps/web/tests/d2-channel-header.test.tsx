// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-channel (F4): the channel header holds at 320 px. happy-dom has no layout engine, so this
 * checks the layout contract that decides it: the row wraps, the text column keeps a 12rem basis
 * and may not shrink below it while the actions are a wrapping group that never forces its width
 * (so at 320 px they drop onto their own row), and a long name and title are kept whole in the DOM
 * (truncated or clamped by CSS, never removed). On phones Report lives in the "More" menu
 * (`sm:hidden`), on wider screens it is the visible button (`hidden sm:contents`). The Storybook
 * stories `LongText320` / `LongText375` / `LongText1440` show the rendered result.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { ChannelHeader } from "@commonair/ui/blocks/media";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";

const boot = vi.hoisted(() => ({
  me: null as null | { id: string; username: string; displayName: string; channelSlug: string | null; role: string },
}));
vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: boot.me, config: { publicUrl: "https://air.example.test" }, now: Date.now() }),
}));
vi.mock("../src/lib/use-channel.ts", () => ({ useChannel: (_slug: string, initial: unknown) => initial }));
vi.mock("../src/player/player.tsx", () => ({ Player: () => <div data-testid="player" /> }));
vi.mock("../src/chat/chat-panel.tsx", () => ({ ChatPanel: () => <div data-testid="chat" /> }));
vi.mock("../src/components/support/support-dialog.tsx", () => ({
  SupportButton: () => <span data-testid="support-stub">Support</span>,
}));

const { Route } = await import("../src/routes/_app/$channel.tsx");
type ChannelPage = import("../src/components/channel/panels-loader.ts").ChannelPage;

afterEach(() => {
  cleanup();
  boot.me = null;
});

const LONG_NAME = "Wilhelmina_Featherstonehaugh_Productions_Extra";
const LONG_TITLE =
  "Twelve-hour charity speedrun marathon: every level, every secret, no deaths, all donations to the shelter";

const classes = (el: Element | null | undefined) => new Set((el?.getAttribute("class") ?? "").split(/\s+/));

function page(): ChannelPage {
  return {
    summary: {
      id: "0192f000-0000-7000-8000-000000000001",
      slug: "fern",
      displayName: LONG_NAME,
      title: LONG_TITLE,
      avatarUrl: null,
      accent: null,
      mature: false,
      live: null,
      category: null,
      tags: [],
      lastLiveAt: null,
      followerCount: 1,
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

function renderPage(data: ChannelPage) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const app = createRoute({ getParentRoute: () => root, id: "_app", component: () => <Outlet /> });
  const channel = createRoute({
    getParentRoute: () => app,
    path: "$channel",
    loader: () => data,
    component: Route.options.component as never,
  });
  const signin = createRoute({ getParentRoute: () => app, path: "signin", component: () => <p>sign in</p> });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([channel, signin])]),
    history: createMemoryHistory({ initialEntries: ["/fern"] }),
  });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

describe("ChannelHeader at narrow widths (F4)", () => {
  it("wraps: the text column keeps a 12rem basis and the actions are a group that wraps", () => {
    const { container } = wrap(
      <ChannelHeader
        name={LONG_NAME}
        title={LONG_TITLE}
        live
        actions={
          <>
            <button type="button">Follow</button>
            <button type="button">Support</button>
          </>
        }
      />,
    );
    const section = container.querySelector("section");
    expect(classes(section).has("flex-wrap")).toBe(true);
    const text = container.querySelector('[data-slot="channel-header-text"]');
    for (const c of ["min-w-0", "flex-1", "basis-48"]) expect(classes(text).has(c)).toBe(true);
    const actions = container.querySelector('[data-slot="channel-header-actions"]');
    // `shrink-0` on a group wider than the row is what crushed the name: it must not come back.
    expect(classes(actions).has("shrink-0")).toBe(false);
    for (const c of ["flex-wrap", "max-w-full", "min-w-0"]) expect(classes(actions).has(c)).toBe(true);
    // The actions come after the text, so a wrap puts them on their own row below it.
    expect(text?.compareDocumentPosition(actions as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the whole name and title in the DOM: the name truncates, the title clamps to two lines", () => {
    const { container } = wrap(<ChannelHeader name={LONG_NAME} title={LONG_TITLE} />);
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toBe(LONG_NAME);
    expect(classes(h1).has("truncate")).toBe(true);
    const title = screen.getByText(LONG_TITLE);
    expect(classes(title).has("line-clamp-2")).toBe(true);
    expect(classes(title).has("break-words")).toBe(true);
    expect(classes(title).has("truncate")).toBe(false);
  });

  it("tags are a labelled list of Badge links when tagLink is given, plain chips otherwise", () => {
    const { container, rerender } = wrap(
      <ChannelHeader
        name="Fern"
        tags={["cozy", "art"]}
        tagsLabel="Tags"
        tagLink={(tag) => <a href={`/t/${tag}`} aria-label={tag} />}
      />,
    );
    const list = container.querySelector('ul[aria-label="Tags"]');
    expect([...(list?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual(["/t/cozy", "/t/art"]);
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <ChannelHeader name="Fern" tags={["cozy"]} />
      </LocaleProvider>,
    );
    expect(container.querySelector("ul a")).toBeNull();
    expect(container.querySelector('ul [data-slot="badge"]')?.textContent).toBe("cozy");
  });

  it("puts uptime in the counts row after the viewer count", () => {
    const { container } = wrap(
      <ChannelHeader name="Fern" live viewerCount={12} uptime={<span data-testid="up">1:00:00</span>} />,
    );
    const row = container.querySelector('[data-slot="viewer-count"]')?.parentElement;
    expect(row?.contains(screen.getByTestId("up"))).toBe(true);
  });
});

describe("Report on phones (F4)", () => {
  it("a visitor gets the Report button for wide screens and a More menu for phones", async () => {
    renderPage(page());
    const report = await screen.findByTestId("report-open");
    expect(classes(report.parentElement).has("hidden")).toBe(true);
    expect(classes(report.parentElement).has("sm:contents")).toBe(true);
    const more = screen.getByTestId("channel-overflow");
    expect(more.getAttribute("aria-label")).toBe("More actions");
    expect(classes(more).has("sm:hidden")).toBe(true);
    // Share is always there, and the name is the page's heading.
    expect(screen.getByTestId("channel-share")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(LONG_NAME);
  });

  it("signed out, the menu's Report goes to sign-in", async () => {
    renderPage(page());
    const more = await screen.findByTestId("channel-overflow");
    act(() => {
      fireEvent.click(more);
    });
    const item = await screen.findByTestId("channel-overflow-report");
    expect(item.textContent).toBe("Report");
    expect(item.getAttribute("href")).toBe("/signin");
  });

  it("signed in, the menu's Report opens the report dialog for the channel", async () => {
    boot.me = { id: "u2", username: "viewer1", displayName: "Viewer", channelSlug: "viewer1", role: "user" };
    renderPage(page());
    const more = await screen.findByTestId("channel-overflow");
    act(() => {
      fireEvent.click(more);
    });
    const item = await screen.findByTestId("channel-overflow-report");
    act(() => {
      fireEvent.click(item);
    });
    const dialog = await screen.findByTestId("report-dialog");
    expect(dialog.getAttribute("data-subject-type")).toBe("channel");
    expect(dialog.getAttribute("data-subject-id")).toBe(page().summary.id);
    // Closing it returns focus to "More" (the menu item that opened it is gone).
    act(() => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("report-dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("channel-overflow")));
  });

  it("the owner gets Share but no Report and no More menu", async () => {
    boot.me = { id: "u1", username: "fern", displayName: "Fern", channelSlug: "fern", role: "user" };
    renderPage(page());
    await screen.findByTestId("channel-share");
    expect(screen.queryByTestId("report-open")).toBeNull();
    expect(screen.queryByTestId("channel-overflow")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("support-stub")).toBeNull());
  });
});
