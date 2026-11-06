// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The `/rehearse` and `/move` route components with the session and the API stubbed: signed out
 * goes to sign-in, the own channel gets the owner's header and page, `?channel=` of another
 * channel gets the invitee's watch header naming that channel (the headers live in the routes).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  isRedirect,
  RouterContextProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { SessionUser } from "../src/lib/bootstrap-types.ts";
import { pageTitle } from "../src/lib/page-title.ts";

const session = vi.hoisted(() => ({ me: null as SessionUser | null }));
const calls = vi.hoisted(() => ({ status: [] as string[], watch: [] as string[], links: [] as string[] }));

vi.mock("../src/lib/bootstrap.ts", () => ({
  useBootstrap: () => ({
    me: session.me,
    config: { currency: "usd" },
    instance: { name: "Test Air", sourceUrl: null },
    theme: "dark",
    now: 0,
  }),
  getSessionUser: async () => session.me,
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const never = () => new Promise<never>(() => undefined);
  const client = {
    stream: {
      ingest: async () => ({ activeKeyPrefix: "ca_live_ab12" }),
      rehearsal: {
        status: async ({ channel }: { channel: string }) => {
          calls.status.push(channel);
          return { state: "idle", armId: null, armExpiresAt: null, broadcastId: null, endsAt: null, invitees: [] };
        },
        report: async () => {
          throw Object.assign(new Error("none"), { code: "NOT_FOUND" });
        },
        watch: ({ channel }: { channel: string }) => {
          calls.watch.push(channel);
          return never();
        },
      },
    },
    channels: {
      followers: async () => ({ items: [], nextCursor: null }),
      get: async () => ({ movedTo: null }),
    },
    portability: {
      links: {
        list: async ({ channel }: { channel: string }) => {
          calls.links.push(channel);
          return [];
        },
      },
    },
  };
  return { ...actual, api: () => client };
});

const { Route: RehearseRoute } = await import("../src/routes/_studio/rehearse.tsx");
const { Route: MoveRoute } = await import("../src/routes/_studio/move.tsx");

let router = makeRouter();
function makeRouter() {
  return createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
}

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

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: "01900000-0000-7000-8000-000000000001",
  username: "ada",
  displayName: "Ada",
  channelSlug: "ada",
  role: "user",
  ...over,
});

function component(route: { options: { component?: unknown } }): React.ComponentType {
  const c = route.options.component;
  if (typeof c !== "function") throw new Error("route has no component");
  return c as React.ComponentType;
}

const heading = () => screen.getByRole("heading", { level: 1 });

beforeAll(async () => {
  for (const route of [RehearseRoute, MoveRoute]) {
    const c = route.options.component as { preload?: () => Promise<void> } | undefined;
    await c?.preload?.();
  }
});

beforeEach(() => {
  router = makeRouter();
  calls.status.length = 0;
  calls.watch.length = 0;
  calls.links.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("/rehearse", () => {
  it("signed out goes to sign-in and renders no page", async () => {
    session.me = null;
    vi.spyOn(RehearseRoute, "useSearch").mockReturnValue({} as never);
    const Page = component(RehearseRoute);
    const { container } = wrap(<Page />);
    await waitFor(() => expect(router.history.location.pathname).toBe("/signin"));
    expect(container.querySelector('[data-testid="rehearse-page"]')).toBeNull();
    expect(calls.status).toEqual([]);
  });

  it("own channel (no ?channel=): the owner's header and the rehearse page for that channel", async () => {
    session.me = user();
    vi.spyOn(RehearseRoute, "useSearch").mockReturnValue({} as never);
    const Page = component(RehearseRoute);
    wrap(<Page />);
    expect(await screen.findByTestId("rehearse-page")).toBeTruthy();
    expect(heading().textContent).toBe(t("rehearsal.pageTitle"));
    expect(document.body.textContent).toContain(t("rehearsal.pageIntro"));
    expect(screen.queryByTestId("rehearsal-watch")).toBeNull();
    await waitFor(() => expect(calls.status).toContain("ada"));
  });

  it("?channel= naming the own channel is still the owner's page", async () => {
    // No channel slug: the username is the channel.
    session.me = user({ channelSlug: null, username: "rivertide" });
    vi.spyOn(RehearseRoute, "useSearch").mockReturnValue({ channel: "rivertide" } as never);
    const Page = component(RehearseRoute);
    wrap(<Page />);
    expect(await screen.findByTestId("rehearse-page")).toBeTruthy();
    expect(heading().textContent).toBe(t("rehearsal.pageTitle"));
    await waitFor(() => expect(calls.status).toContain("rivertide"));
  });

  it("another channel: the watch header naming it, and the invitee's view", async () => {
    session.me = user();
    vi.spyOn(RehearseRoute, "useSearch").mockReturnValue({ channel: "grace" } as never);
    const Page = component(RehearseRoute);
    wrap(<Page />);
    expect(await screen.findByTestId("rehearsal-watch")).toBeTruthy();
    expect(heading().textContent).toBe(t("rehearsal.watch.title"));
    const intro = t("rehearsal.watch.intro", { channel: "grace" });
    expect(intro).toContain("grace");
    expect(document.body.textContent).toContain(intro);
    expect(screen.queryByTestId("rehearse-page")).toBeNull();
    await waitFor(() => expect(calls.watch).toEqual(["grace"]));
    expect(calls.status).toEqual([]);
  });
});

describe("/move", () => {
  it("signed out goes to sign-in and renders no page", async () => {
    session.me = null;
    const Page = component(MoveRoute);
    const { container } = wrap(<Page />);
    await waitFor(() => expect(router.history.location.pathname).toBe("/signin"));
    expect(container.querySelector('[data-testid="move-page"]')).toBeNull();
    expect(calls.links).toEqual([]);
  });

  it("signed in: the portability header and the move page for the own channel", async () => {
    session.me = user({ channelSlug: "adas_channel" });
    const Page = component(MoveRoute);
    wrap(<Page />);
    expect(await screen.findByTestId("move-page")).toBeTruthy();
    expect(heading().textContent).toBe(t("portability.pageTitle"));
    expect(document.body.textContent).toContain(t("portability.pageIntro"));
    await waitFor(() => expect(calls.links).toEqual(["adas_channel"]));
  });
});

describe("route options", () => {
  type Options = {
    head?: () => { meta: { title: string }[] };
    beforeLoad?: () => Promise<unknown>;
    validateSearch?: (s: Record<string, unknown>) => unknown;
  };
  const opts = (route: { options: unknown }) => route.options as Options;

  it.each([
    ["/rehearse", RehearseRoute, "pageTitle.studioRehearse"],
    ["/move", MoveRoute, "pageTitle.studioMove"],
  ] as const)("%s: titled, and the server-side guard redirects a visitor to sign-in", async (_path, route, key) => {
    expect(opts(route).head?.()).toEqual({ meta: [{ title: pageTitle(t(key)) }] });
    session.me = null;
    const thrown = await opts(route)
      .beforeLoad?.()
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { to: string } }).options.to).toBe("/signin");
    session.me = user();
    await expect(opts(route).beforeLoad?.()).resolves.toEqual({ me: session.me });
  });

  it("/rehearse keeps a valid ?channel= (normalized) and drops anything else", () => {
    const validate = opts(RehearseRoute).validateSearch;
    expect(validate?.({ channel: " Grace " })).toEqual({ channel: "grace" });
    expect(validate?.({ channel: "x" })).toEqual({});
    expect(validate?.({ channel: 7 })).toEqual({});
  });
});
