// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Co-op route components with the session and the API stubbed: who gets the not-found page
 * (`/admin/coop` for non-admins, the edit form for anyone but the author) and the proposal page's
 * reaction to a `voting_closed` refusal.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { SessionUser } from "../src/lib/bootstrap-types.ts";
import { ME, OTHER, council, proposal, settings, votingProposal } from "./coop-fixtures.ts";

const session = vi.hoisted(() => ({ me: null as SessionUser | null }));
const calls = vi.hoisted(() => ({
  get: vi.fn<(input: { id: string }) => Promise<unknown>>(),
  vote: vi.fn<(input: { id: string; choice: string }) => Promise<unknown>>(),
  appoint: vi.fn<(input: { username: string; boardMinuteRef: string }) => Promise<unknown>>(),
}));

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
  const page = { items: [], nextCursor: null };
  const client = {
    coop: {
      membership: async () => ({
        memberships: [{ id: "m", class: "viewer", status: "active", basis: "share", joinedAt: "x" }],
        eligibility: [],
        share: null,
      }),
      settings: async () => settings,
      council: async () => council,
      appointWorker: (input: { username: string; boardMinuteRef: string }) => calls.appoint(input),
      proposals: {
        get: (input: { id: string }) => calls.get(input),
        comments: async () => page,
        vote: (input: { id: string; choice: string }) => calls.vote(input),
      },
    },
  };
  return { ...actual, api: () => client };
});

const { Route: AdminCoopRoute } = await import("../src/routes/_admin/admin.coop.tsx");
const { Route: EditRoute } = await import("../src/routes/_app/coop.proposals.$id.edit.tsx");
const { Route: ProposalRoute } = await import("../src/routes/_app/coop.proposals.$id.index.tsx");

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          {/* File routes' components are code-split (lazy) under the router plugin. */}
          <React.Suspense fallback={null}>{node}</React.Suspense>
        </TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

const user = (id: string, role: SessionUser["role"]): SessionUser => ({
  id,
  username: "rivertide",
  displayName: "Rivertide",
  channelSlug: null,
  role,
});

function component(route: { options: { component?: unknown } }): React.ComponentType {
  const c = route.options.component;
  if (typeof c !== "function") throw new Error("route has no component");
  return c as React.ComponentType;
}

beforeAll(async () => {
  // Load the code-split components once, so each test renders them without suspending.
  for (const route of [AdminCoopRoute, EditRoute, ProposalRoute]) {
    const c = route.options.component as { preload?: () => Promise<void> } | undefined;
    await c?.preload?.();
  }
});

beforeEach(() => {
  calls.get.mockReset();
  calls.vote.mockReset();
  calls.appoint.mockReset();
});
afterEach(cleanup);

describe("/admin/coop", () => {
  it.each([["user"], ["treasurer"], ["moderator"], ["legal"]] as const)(
    "a %s gets the not-found page",
    async (role) => {
      session.me = user(ME, role);
      const Page = component(AdminCoopRoute);
      wrap(<Page />);
      expect(await screen.findByText(en["page.notFound"])).toBeTruthy();
      expect(screen.queryByTestId("admin-coop")).toBeNull();
    },
  );

  it("signed out gets the not-found page", async () => {
    session.me = null;
    const Page = component(AdminCoopRoute);
    wrap(<Page />);
    expect(await screen.findByText(en["page.notFound"])).toBeTruthy();
    expect(screen.queryByTestId("admin-coop")).toBeNull();
  });

  it("an admin gets the form; a refusal is shown in words", async () => {
    session.me = user(ME, "admin");
    calls.appoint.mockRejectedValue(Object.assign(new Error("x"), { code: "CONFLICT" }));
    const Page = component(AdminCoopRoute);
    wrap(<Page />);
    expect(await screen.findByTestId("admin-coop")).toBeTruthy();
    fireEvent.change(screen.getByTestId("appoint-worker-username"), { target: { value: "Wren" } });
    fireEvent.change(screen.getByTestId("appoint-worker-minute"), { target: { value: "BM-1" } });
    fireEvent.click(screen.getByTestId("appoint-worker-submit"));
    await waitFor(() => expect(calls.appoint).toHaveBeenCalledWith({ username: "wren", boardMinuteRef: "BM-1" }));
    await waitFor(() => expect(screen.getByText(en["coop.admin.alreadyWorker"])).toBeTruthy());
  });
});

describe("/coop/proposals/$id/edit", () => {
  const useParams = vi.spyOn(EditRoute, "useParams");

  it("only the author gets the form, and only while draft or discussion", async () => {
    useParams.mockReturnValue({ id: "p1" } as never);
    const Page = component(EditRoute);

    session.me = user(OTHER, "user");
    calls.get.mockResolvedValue(proposal());
    wrap(<Page />);
    await waitFor(() => expect(screen.getByText(en["page.notFound"])).toBeTruthy());
    expect(screen.queryByTestId("proposal-form")).toBeNull();
    cleanup();

    session.me = user(ME, "user");
    calls.get.mockResolvedValue(proposal({ status: "voting" }));
    wrap(<Page />);
    await waitFor(() => expect(screen.getByText(en["page.notFound"])).toBeTruthy());
    cleanup();

    calls.get.mockResolvedValue(proposal({ status: "discussion" }));
    wrap(<Page />);
    await waitFor(() => expect(screen.getByTestId("proposal-form")).toBeTruthy());
    expect((screen.getByTestId("proposal-title") as HTMLInputElement).value).toBe("Five spotlight slots");
  });
});

describe("/coop/proposals/$id", () => {
  it("a voting_closed refusal drops the ballot and reloads the proposal", async () => {
    vi.spyOn(ProposalRoute, "useParams").mockReturnValue({ id: "p1" } as never);
    session.me = user(ME, "user");
    const p = votingProposal();
    // The window is open by the client's clock; the database says it closed.
    const open = { ...p, timeline: { ...p.timeline, votingEndsAt: new Date(Date.now() + 60_000).toISOString() } };
    calls.get.mockResolvedValue(open);
    calls.vote.mockRejectedValue(
      Object.assign(new Error("closed"), { code: "CONFLICT", data: { reason: "voting_closed" } }),
    );
    const Page = component(ProposalRoute);
    wrap(<Page />);
    await waitFor(() => expect(screen.getByTestId("vote-panel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("vote-choice-no"));
    fireEvent.click(screen.getByTestId("vote-submit"));
    await waitFor(() => expect(screen.queryByTestId("vote-panel")).toBeNull());
    expect(screen.getByTestId("vote-closed")).toBeTruthy();
    expect(calls.vote).toHaveBeenCalledWith({ id: "p1", choice: "no" });
    expect(calls.get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
