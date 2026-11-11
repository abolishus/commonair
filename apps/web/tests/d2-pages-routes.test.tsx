// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d2-pages routes with the session and the API stubbed: `/coop/patronage` and `/coop/jury` show
 * public explainers to visitors (no redirect) and today's pages to members; `/coop` shows the
 * join band to visitors and non-members only.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { SessionUser } from "../src/lib/bootstrap-types.ts";
import { ME, council, statement } from "./coop-fixtures.ts";

const session = vi.hoisted(() => ({ me: null as SessionUser | null, viewer: false }));
const calls = vi.hoisted(() => ({ names: [] as string[] }));

vi.mock("../src/lib/ui-metrics.ts", () => ({ trackUi: () => undefined }));

vi.mock("../src/lib/bootstrap.ts", () => ({
  useBootstrap: () => ({
    me: session.me,
    sessionUnresolved: false,
    config: { currency: "usd", publicUrl: "https://air.example", instanceName: "Test Air" },
    instance: { name: "Test Air", sourceUrl: null },
    theme: "dark",
    now: 0,
  }),
  useSessionRetry: () => ({ retrying: false, gaveUp: false, retry: () => undefined }),
  getSessionUser: async () => session.me,
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const track =
    <T,>(name: string, value: () => T) =>
    async () => {
      calls.names.push(name);
      return value();
    };
  const usd = (cents: number) => ({ cents, currency: "usd" });
  const client = {
    coop: {
      settings: track("settings", () => [
        {
          key: "membership.classes",
          value: {
            streamer: { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2 },
            viewer: { shareCents: 500, shareRefundableOnExit: true, minSubscriptionCents: 300 },
          },
          protected: true,
          description: "",
          updatedAt: "2026-09-01T00:00:00.000Z",
          updatedByProposalId: null,
        },
        {
          key: "patronage.formula",
          value: { weights: { revenue: 0.5, streamingHours: 0.2, relayBandwidth: 0.2, viewerHours: 0.1 } },
          protected: true,
          description: "",
          updatedAt: "2026-09-01T00:00:00.000Z",
          updatedByProposalId: null,
        },
      ]),
      transparency: track("transparency", () => [
        { month: "2026-10", surplus: usd(-4000), patronageDistributed: usd(0), governance: [], members: {} },
      ]),
      membership: track("membership", () => ({
        memberships: session.viewer
          ? [{ id: "m", class: "viewer", status: "active", basis: "share", joinedAt: "2026-01-01T00:00:00.000Z" }]
          : [],
        eligibility: [],
        share: null,
      })),
      council: track("council", () => council),
      proposals: { list: track("proposals", () => ({ items: [], nextCursor: null })) },
      patronage: { statements: track("statements", () => [statement]) },
    },
    jury: {
      status: track("jury.status", () => ({
        enabled: true,
        eligible: true,
        optedIn: false,
        optedInAt: null,
        seat: null,
      })),
    },
  };
  return { ...actual, api: () => client };
});

const routes = {
  overview: (await import("../src/routes/_app/coop.index.tsx")).Route,
  patronage: (await import("../src/routes/_app/coop.patronage.index.tsx")).Route,
  jury: (await import("../src/routes/_app/coop.jury.tsx")).Route,
};

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

function component(route: { options: { component?: unknown } }): React.ComponentType {
  const c = route.options.component;
  if (typeof c !== "function") throw new Error("route has no component");
  return c as React.ComponentType;
}

const member: SessionUser = {
  id: ME,
  username: "rivertide",
  displayName: "Rivertide",
  channelSlug: null,
  role: "user",
};

beforeAll(async () => {
  for (const route of Object.values(routes)) {
    const c = route.options.component as { preload?: () => Promise<void> } | undefined;
    await c?.preload?.();
  }
});
beforeEach(() => {
  session.me = null;
  session.viewer = false;
  calls.names = [];
});
afterEach(cleanup);

describe("guards", () => {
  it.each([["patronage"], ["jury"]] as const)("/coop/%s never redirects a visitor to sign-in", async (name) => {
    const beforeLoad = routes[name].options.beforeLoad as unknown as () => Promise<{ me: SessionUser | null }>;
    await expect(beforeLoad()).resolves.toEqual({ me: null });
    session.me = member;
    await expect(beforeLoad()).resolves.toEqual({ me: member });
  });
});

describe("/coop/patronage", () => {
  it("visitors get the explainer, with the books and weights, and no member call", async () => {
    const Page = component(routes.patronage);
    wrap(<Page />);
    await screen.findByTestId("patronage-explainer");
    await waitFor(() => expect(screen.getByTestId("patronage-weights")).toBeTruthy());
    expect((await screen.findByTestId("patronage-standing-line")).getAttribute("data-surplus")).toBe("no");
    expect(calls.names).not.toContain("statements");
    expect(screen.queryByTestId("patronage")).toBeNull();
  });

  it("members keep their statements page", async () => {
    session.me = member;
    const Page = component(routes.patronage);
    wrap(<Page />);
    await screen.findByTestId("patronage");
    expect(screen.queryByTestId("patronage-explainer")).toBeNull();
    expect(calls.names).toContain("statements");
  });
});

describe("/coop/jury", () => {
  it("visitors get the explainer and no jury call", async () => {
    const Page = component(routes.jury);
    wrap(<Page />);
    await screen.findByTestId("jury-explainer");
    expect(calls.names.filter((n) => n.startsWith("jury."))).toEqual([]);
  });

  it("members keep the jury page", async () => {
    session.me = member;
    session.viewer = true;
    const Page = component(routes.jury);
    wrap(<Page />);
    await screen.findByTestId("jury-optin");
    expect(screen.queryByTestId("jury-explainer")).toBeNull();
    expect(calls.names).toContain("jury.status");
  });
});

describe("/coop join band", () => {
  it("visitors see it with the numbers from the settings", async () => {
    const Page = component(routes.overview);
    wrap(<Page />);
    await waitFor(() =>
      expect(screen.getByTestId("coop-join-band-body").textContent).toContain("A $5.00 share makes you a member"),
    );
    expect(screen.getByTestId("coop-join-band-body").textContent).toContain("at $3.00 or more a month");
  });

  it("an account that isn't a member sees it once its membership loads; a member never does", async () => {
    session.me = member;
    const Page = component(routes.overview);
    wrap(<Page />);
    await screen.findByTestId("coop-join-band");
    cleanup();
    session.viewer = true;
    wrap(<Page />);
    await screen.findByTestId("coop-membership-card");
    expect(screen.queryByTestId("coop-join-band")).toBeNull();
  });
});
