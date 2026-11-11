// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d6-studio: the studio co-op card (overhaul wave 4, D6.4). The facts (member-owner status, hours
 * toward the streamer rule, council rank) and the rendered card: an icon and a word for the
 * status, no brand fill, the links to /coop and /coop/membership, the view counter, and the load
 * failure's Retry (the council and the rules only add lines).
 */
import { LocaleProvider, TooltipProvider, formatNumber } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type CoopCardClient, StudioCoopCard } from "../src/components/studio-coop/coop-card.tsx";
import { coopCardFacts, coopCardStatus, councilRank, streamerProgress } from "../src/components/studio-coop/model.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { CouncilDto, MembershipViewDto } from "../src/lib/coop.ts";

const track = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => {
    track.calls.push(`${surface}|${action}|${step}`);
  },
}));

afterEach(() => {
  cleanup();
  track.calls.length = 0;
});

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const wrap = (node: React.ReactNode) =>
  render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );

const ME = "01900000-0000-7000-8000-0000000000a1";
const THEM = "01900000-0000-7000-8000-0000000000a2";

function view(memberships: MembershipViewDto["memberships"], have = 6, need = 10): MembershipViewDto {
  return {
    memberships,
    eligibility: [
      {
        class: "streamer",
        eligible: have >= need,
        basis: have >= need ? "streaming_hours" : null,
        progress: { have, need, unit: "hours" },
        detail: "",
      },
      { class: "viewer", eligible: false, basis: null, progress: { have: 0, need: 2500, unit: "cents" }, detail: "" },
      { class: "worker", eligible: false, basis: null, progress: null, detail: "" },
    ],
    share: null,
  };
}
const membership = (status: "active" | "lapsed" | "exited", cls: "streamer" | "viewer" = "streamer") => ({
  id: "01900000-0000-7000-8000-0000000000m1",
  class: cls,
  status,
  basis: cls === "streamer" ? ("streaming_hours" as const) : ("share" as const),
  joinedAt: "2026-10-01T00:00:00.000Z",
});
const COUNCIL: CouncilDto = {
  termId: "01900000-0000-7000-8000-0000000000c1",
  startsAt: "2026-11-01T00:00:00.000Z",
  endsAt: "2026-12-01T00:00:00.000Z",
  members: [
    { user: { id: THEM, username: "them", displayName: "Them" }, rank: 1, contributionScore: 10 },
    { user: { id: ME, username: "me", displayName: "Me" }, rank: 3, contributionScore: 4 },
  ],
  method: {},
};
const SETTINGS = [
  {
    key: "membership.classes",
    value: {
      streamer: { minStreamingHours: 10, windowDays: 30, minVerifiedViewers: 3 },
      viewer: { shareCents: 2500, shareRefundableOnExit: true },
    },
  },
];

function client(over: Partial<CoopCardClient> = {}): CoopCardClient {
  return {
    membership: vi.fn<CoopCardClient["membership"]>(async () => view([])),
    council: vi.fn<CoopCardClient["council"]>(async () => COUNCIL),
    settings: vi.fn<CoopCardClient["settings"]>(async () => SETTINGS),
    ...over,
  };
}

describe("the card's facts", () => {
  it("status: an active streamer membership is a member-owner; a viewer membership is not", () => {
    expect(coopCardStatus(view([membership("active")]))).toBe("member");
    expect(coopCardStatus(view([membership("lapsed")]))).toBe("lapsed");
    expect(coopCardStatus(view([membership("exited")]))).toBe("notYet");
    expect(coopCardStatus(view([membership("active", "viewer")]))).toBe("notYet");
    expect(coopCardStatus(view([]))).toBe("notYet");
  });

  it("progress: hours toward the rule, capped, with the window from membership.classes", () => {
    expect(streamerProgress(view([], 6, 10), SETTINGS)).toEqual({ have: 6, need: 10, percent: 60, windowDays: 30 });
    expect(streamerProgress(view([], 14, 10), SETTINGS)?.percent).toBe(100);
    expect(streamerProgress(view([], 9.99, 10), SETTINGS)?.percent).toBe(99);
    expect(streamerProgress(view([], -1, 10), null)).toEqual({ have: 0, need: 10, percent: 0, windowDays: null });
    expect(streamerProgress(view([], 0, 0), null)?.percent).toBe(100);
    expect(streamerProgress({ eligibility: [] }, SETTINGS)).toBeNull();
  });

  it("council rank: only the caller's seat", () => {
    expect(councilRank(COUNCIL, ME)).toBe(3);
    expect(councilRank(COUNCIL, "01900000-0000-7000-8000-0000000000ff")).toBeNull();
    expect(councilRank(null, ME)).toBeNull();
  });

  it("puts them together", () => {
    expect(coopCardFacts(view([membership("active")], 12), COUNCIL, SETTINGS, ME)).toEqual({
      status: "member",
      progress: { have: 12, need: 10, percent: 100, windowDays: 30 },
      councilRank: 3,
    });
  });
});

describe("the rendered card", () => {
  it("a member-owner on the council: status word, rank, hours, links; counted once", async () => {
    wrap(
      <StudioCoopCard
        userId={ME}
        client={client({
          membership: vi.fn<CoopCardClient["membership"]>(async () => view([membership("active")], 12)),
        })}
      />,
    );
    const card = await screen.findByTestId("studio-coop-card");
    expect(card.getAttribute("data-status")).toBe("member");
    expect(screen.getByTestId("studio-coop-status").textContent).toBe(t("d6Studio.coop.status.member"));
    // An icon beside the word, never colour alone.
    expect(screen.getByTestId("studio-coop-status").querySelector("svg")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("studio-coop-council").textContent).toBe(
        t("d6Studio.coop.council", { rank: formatNumber(3, locale) }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("studio-coop-progress").textContent).toBe(
        t("d6Studio.coop.progress", { have: formatNumber(12, locale), need: 10, days: 30 }),
      ),
    );
    expect(screen.getByTestId("studio-coop-membership").getAttribute("href")).toBe("/coop/membership");
    expect(screen.getByTestId("studio-coop-about").getAttribute("href")).toBe("/coop");
    expect(card.querySelector("[data-filled-cta]")).toBeNull();
    expect(card.querySelector('[data-variant="brand"]')).toBeNull();
    expect(track.calls).toEqual(["studio.coopCard|view|none"]);
  });

  it("not yet a member: the hours so far, rounded down to a tenth, and no council line", async () => {
    wrap(
      <StudioCoopCard
        userId={THEM.replace("a2", "a3")}
        client={client({ membership: vi.fn<CoopCardClient["membership"]>(async () => view([], 9.96)) })}
      />,
    );
    expect((await screen.findByTestId("studio-coop-card")).getAttribute("data-status")).toBe("notYet");
    await waitFor(() =>
      expect(screen.getByTestId("studio-coop-progress").textContent).toBe(
        t("d6Studio.coop.progress", { have: formatNumber(9.9, locale), need: 10, days: 30 }),
      ),
    );
    expect(screen.getByText(t("d6Studio.coop.joinHint"))).toBeTruthy();
    expect(screen.queryByTestId("studio-coop-council")).toBeNull();
  });

  it("the council and the rules failing only drop their lines", async () => {
    wrap(
      <StudioCoopCard
        userId={ME}
        client={client({
          council: vi.fn<CoopCardClient["council"]>(async () => {
            throw new Error("down");
          }),
          settings: vi.fn<CoopCardClient["settings"]>(async () => {
            throw new Error("down");
          }),
        })}
      />,
    );
    await screen.findByTestId("studio-coop-card");
    await waitFor(() =>
      expect(screen.getByTestId("studio-coop-progress").textContent).toBe(
        t("d6Studio.coop.progressNoWindow", { have: formatNumber(6, locale), need: 10 }),
      ),
    );
    expect(screen.queryByTestId("studio-coop-council")).toBeNull();
  });

  it("the membership failing shows the section's Retry", async () => {
    const membershipLoad = vi.fn<CoopCardClient["membership"]>(async () => {
      throw new Error("down");
    });
    wrap(<StudioCoopCard userId={ME} client={client({ membership: membershipLoad })} />);
    expect(await screen.findByTestId("studio-coop-card-error")).toBeTruthy();
    expect(screen.getByTestId("studio-coop-card-retry")).toBeTruthy();
  });

  it("shows a skeleton while loading", () => {
    wrap(<StudioCoopCard userId={ME} client={client({ membership: () => new Promise(() => undefined) })} />);
    expect(screen.getByTestId("studio-coop-card-loading").getAttribute("aria-busy")).toBe("true");
  });
});
