// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D4 (F19): the co-op overview shows the 5 latest decisions and a "See all decisions" link to the
 * proposals list filtered to decided; the council loads as skeleton rows, busy, not as "Loading".
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CoopOverview, RECENT_DECISIONS, recentDecisions } from "../src/components/coop/overview.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { CoopMonthDto } from "../src/lib/coop.ts";
import { council, month } from "./coop-fixtures.ts";

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

afterEach(cleanup);

type Outcome = CoopMonthDto["governance"][number];
const id = (n: number) => `0192d6f1-0000-7000-8000-${String(n).padStart(12, "0")}`;
function decision(n: number, over: Partial<Outcome> = {}): Outcome {
  return {
    proposalId: id(n),
    title: `Decision ${n}`,
    status: "passed",
    kind: "ordinary",
    passed: true,
    reason: null,
    decidedAt: `2026-10-${String(n).padStart(2, "0")}T12:00:00.000Z`,
    ...over,
  };
}

/** Newest month first, as the API sends them; decisions spread over two months. */
function months(count: number): CoopMonthDto[] {
  const all = Array.from({ length: count }, (_, i) => decision(i + 1));
  return [
    month("2026-10", { governance: all.filter((_, i) => i % 2 === 0) }),
    month("2026-09", { governance: all.filter((_, i) => i % 2 === 1) }),
  ];
}

describe("recentDecisions", () => {
  it("caps at 5, newest decision first, across months", () => {
    const got = recentDecisions(months(12));
    expect(RECENT_DECISIONS).toBe(5);
    expect(got.map((g) => g.title)).toEqual(["Decision 12", "Decision 11", "Decision 10", "Decision 9", "Decision 8"]);
  });

  it("leaves out withdrawn proposals (no tally) and handles empty and loading", () => {
    const withdrawn = month("2026-10", {
      governance: [decision(1, { status: "withdrawn", passed: null }), decision(2)],
    });
    expect(recentDecisions([withdrawn]).map((g) => g.proposalId)).toEqual([id(2)]);
    expect(recentDecisions([])).toEqual([]);
    expect(recentDecisions(null)).toEqual([]);
  });

  it("keeps fewer than 5 as they are, and the API's order when decidedAt ties or is missing", () => {
    const tied = month("2026-10", {
      governance: [decision(1, { decidedAt: null }), decision(2, { decidedAt: null }), decision(3)],
    });
    expect(recentDecisions([tied]).map((g) => g.title)).toEqual(["Decision 3", "Decision 1", "Decision 2"]);
  });
});

describe("CoopOverview decisions", () => {
  it("renders 5 of 12 decisions and links to all decided proposals", () => {
    wrap(<CoopOverview signedIn={false} membership={null} openProposals={[]} council={council} months={months(12)} />);
    const list = screen.getByTestId("coop-recent-decisions");
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    const link = screen.getByTestId("coop-all-decisions");
    expect(link.getAttribute("href")).toBe("/coop/proposals?status=decided");
    expect(link.textContent).toBe("See all decisions");
  });

  it("no decisions: no section and no link", () => {
    wrap(<CoopOverview signedIn={false} membership={null} openProposals={[]} council={council} months={[]} />);
    expect(screen.queryByTestId("coop-recent-decisions")).toBeNull();
    expect(screen.queryByTestId("coop-all-decisions")).toBeNull();
  });
});

describe("CoopOverview loading", () => {
  it("shows skeleton council rows, busy, instead of the word Loading", () => {
    wrap(<CoopOverview signedIn={false} membership={null} openProposals={null} council={null} months={null} />);
    const loading = screen.getByTestId("coop-council-loading");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.querySelectorAll('[data-slot="skeleton-text"]')).toHaveLength(3);
    // The only "Loading" text left is the screen-reader label of each skeleton group.
    for (const p of document.querySelectorAll("p")) expect(p.textContent).not.toBe("Loading");
  });

  it("loaded and empty: the council's empty line, no skeleton", () => {
    wrap(
      <CoopOverview
        signedIn={false}
        membership={null}
        openProposals={[]}
        council={{ ...council, members: [] }}
        months={[]}
      />,
    );
    expect(screen.queryByTestId("coop-council-loading")).toBeNull();
  });
});
