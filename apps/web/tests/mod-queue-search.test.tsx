// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Jury flag → case (batch 8, B8-web; docs/testing/b8-selectors.md): `/admin/moderation`'s
 * `?tab=&case=` round-trip, the queue's tab and selection from them (a case not on the loaded page
 * fetched by id; NOT_FOUND a toast and a cleared selection; a closed case read-only), selecting
 * and switching tabs reported back for the URL, a report the open queue does not hold, the jury
 * flag link's target per subject kind, and the rules axe would flag on the queue with a selection.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { toast } from "@commonair/ui/toast";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { JuryFlags } from "../src/components/jury/jury-page.tsx";
import { flagCaseSearch } from "../src/components/jury/model.ts";
import type { ModerationCaseDetailDto, ModerationCaseDto, ModerationClient } from "../src/components/safety/client.ts";
import {
  locationOf,
  ModQueue,
  moderationSearch,
  parseModerationSearch,
  type ModQueueLocation,
} from "../src/components/safety/mod-queue.tsx";
import { t } from "../src/i18n/index.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

const ID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const OPEN_CASE = ID(10);
const CLOSED_CASE = ID(20);

const summary = (id: string): ModerationCaseDto =>
  ({
    id,
    tier: "t1",
    status: "open",
    origin: "classifier",
    subjectType: "broadcast",
    subjectId: ID(99),
    channel: null,
    user: null,
    category: "sexual",
    priority: 100,
    slaDueAt: null,
    createdAt: "2026-10-21T12:00:00.000Z",
    resolvedAt: null,
  }) as unknown as ModerationCaseDto;

const detail = (id: string, status: ModerationCaseDetailDto["status"]): ModerationCaseDetailDto => ({
  id,
  tier: "t1",
  status,
  origin: "classifier",
  subjectType: "broadcast",
  subjectId: ID(99),
  channel: null,
  user: null,
  category: "sexual",
  priority: 100,
  slaDueAt: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  resolvedAt: status === "open" ? null : "2026-10-21T13:00:00.000Z",
  resolution: null,
  resolutionNote: null,
  assignee: null,
  assignedAt: null,
  flags: [],
  history: [],
  notScored: [],
  label: null,
});

function fakeClient(over: Partial<ModerationClient> = {}): ModerationClient {
  return {
    cases: vi.fn<ModerationClient["cases"]>(async ({ tier }) => ({
      items: tier === "t1" ? [summary(OPEN_CASE)] : [],
      nextCursor: null,
    })),
    case: vi.fn<ModerationClient["case"]>(async (id) => detail(id, id === CLOSED_CASE ? "cleared" : "open")),
    frame: vi.fn<ModerationClient["frame"]>(),
    review: vi.fn<ModerationClient["review"]>(),
    reports: vi.fn<ModerationClient["reports"]>(async () => ({ items: [], nextCursor: null })),
    resolveReport: vi.fn<ModerationClient["resolveReport"]>(),
    ncii: vi.fn<ModerationClient["ncii"]>(async () => ({ items: [], nextCursor: null })),
    decideNcii: vi.fn<ModerationClient["decideNcii"]>(),
    ...over,
  };
}

function a11yViolations(root: ParentNode): string[] {
  const out: string[] = [];
  const nameOf = (el: Element) => (el.getAttribute("aria-label") ?? "").trim() || (el.textContent ?? "").trim();
  for (const el of root.querySelectorAll("a, button, [role='tab']"))
    if (nameOf(el) === "") out.push(`name: ${el.outerHTML.slice(0, 80)}`);
  for (const el of root.querySelectorAll("input, textarea"))
    if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !el.id) out.push("label");
  for (const el of root.querySelectorAll("[aria-labelledby], [aria-describedby], [aria-controls]"))
    for (const attr of ["aria-labelledby", "aria-describedby"])
      for (const id of (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean))
        if (!document.getElementById(id)) out.push(`${attr} points at missing #${id}`);
  const ids = [...root.querySelectorAll("[id]")].map((el) => el.id);
  if (new Set(ids).size !== ids.length) out.push("duplicate-id");
  return out;
}

/** A controlled queue: the location lives here, as the route keeps it in the URL. */
function Controlled({
  initial,
  client,
  onChange,
}: {
  initial: ModQueueLocation;
  client: ModerationClient;
  onChange: (next: ModQueueLocation) => void;
}) {
  return <ModQueue canReports client={client} location={initial} onLocationChange={onChange} />;
}

describe("the search params", () => {
  it("round-trip a tab and a case, leaving the defaults out", () => {
    const loc = { tab: "reports" as const, case: OPEN_CASE };
    expect(moderationSearch(loc)).toEqual({ tab: "reports", case: OPEN_CASE });
    expect(locationOf(parseModerationSearch(moderationSearch(loc)))).toEqual(loc);
    expect(moderationSearch({ tab: "cases", case: null })).toEqual({});
    expect(locationOf(parseModerationSearch({}))).toEqual({ tab: "cases", case: null });
  });

  it("drop an unknown tab and a malformed id", () => {
    expect(parseModerationSearch({ tab: "admin", case: "1 OR 1=1" })).toEqual({});
    expect(parseModerationSearch({ tab: 3, case: 7 })).toEqual({});
    expect(parseModerationSearch({ tab: "ncii", case: OPEN_CASE.toUpperCase() })).toEqual({
      tab: "ncii",
      case: OPEN_CASE,
    });
  });
});

describe("the queue from the URL", () => {
  it("opens the case in ?case=, read-only when it is closed and not on the loaded page", async () => {
    const byId = vi.fn<ModerationClient["case"]>(async (id) => detail(id, "cleared"));
    const client = fakeClient({ case: byId });
    wrap(<Controlled initial={{ tab: "cases", case: CLOSED_CASE }} client={client} onChange={() => {}} />);
    const d = await screen.findByTestId("modq-detail");
    expect(d.getAttribute("data-case-id")).toBe(CLOSED_CASE);
    expect(d.getAttribute("data-status")).toBe("cleared");
    expect(byId).toHaveBeenCalledWith(CLOSED_CASE);
    expect(screen.queryByTestId("modq-submit")).toBeNull();
  });

  it("opening a case and switching tabs report the new location (the route replaces the URL)", async () => {
    const onChange = vi.fn<(next: ModQueueLocation) => void>();
    wrap(<Controlled initial={{ tab: "cases", case: null }} client={fakeClient()} onChange={onChange} />);
    const open = await screen.findByRole("button", {
      name: t("safety.modq.openCase", { subject: t("safety.modq.unknownSubject") }),
    });
    fireEvent.click(open);
    expect(onChange).toHaveBeenLastCalledWith({ tab: "cases", case: OPEN_CASE });
    fireEvent.click(screen.getByTestId("modq-tab-ncii"));
    expect(onChange).toHaveBeenLastCalledWith({ tab: "ncii", case: null });
  });

  it("a case the API does not know is a toast and a cleared selection", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
    const onChange = vi.fn<(next: ModQueueLocation) => void>();
    const client = fakeClient({
      case: vi.fn<ModerationClient["case"]>(async () => {
        throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
      }),
    });
    wrap(<Controlled initial={{ tab: "cases", case: ID(404) }} client={client} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ tab: "cases", case: null }));
    expect(error).toHaveBeenCalledWith(t("jury.link.caseNotFound"));
  });

  it("a report the open queue does not hold is a toast and a cleared selection", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
    const onChange = vi.fn<(next: ModQueueLocation) => void>();
    wrap(<Controlled initial={{ tab: "reports", case: ID(77) }} client={fakeClient()} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ tab: "reports", case: null }));
    expect(error).toHaveBeenCalledWith(t("jury.link.notInQueue"));
  });

  it("a linked report on a later page loads the next page instead of a toast", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
    const onChange = vi.fn<(next: ModQueueLocation) => void>();
    const reports = vi.fn<ModerationClient["reports"]>(async (cursor) =>
      cursor === undefined ? { items: [], nextCursor: "p2" } : { items: [], nextCursor: null },
    );
    wrap(
      <Controlled initial={{ tab: "reports", case: ID(77) }} client={fakeClient({ reports })} onChange={onChange} />,
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ tab: "reports", case: null }));
    expect(reports).toHaveBeenCalledWith("p2");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("without the reports permission a reports link opens the cases tab with nothing selected", async () => {
    const reports = vi.fn<ModerationClient["reports"]>(async () => ({ items: [], nextCursor: null }));
    wrap(
      <ModQueue
        canReports={false}
        client={fakeClient({ reports })}
        location={{ tab: "reports", case: ID(77) }}
        onLocationChange={() => {}}
      />,
    );
    await screen.findAllByTestId("modq-item");
    expect(screen.queryByTestId("modq-detail")).toBeNull();
    expect(reports).not.toHaveBeenCalled();
  });

  it("uncontrolled, it keeps its own selection", async () => {
    wrap(<ModQueue canReports client={fakeClient()} />);
    fireEvent.click((await screen.findAllByTestId("modq-item"))[0]?.querySelector("button") as HTMLElement);
    const d = await screen.findByTestId("modq-detail");
    expect(d.getAttribute("data-case-id")).toBe(OPEN_CASE);
  });

  it("the queue with a selection passes the accessibility checks", async () => {
    const { container } = wrap(
      <Controlled initial={{ tab: "cases", case: OPEN_CASE }} client={fakeClient()} onChange={() => {}} />,
    );
    await screen.findByTestId("modq-submit");
    expect(a11yViolations(container)).toEqual([]);
  });
});

describe("the jury flag link", () => {
  const flag = (subjectKind: "moderation_case" | "report", subjectId: string) => ({
    id: ID(1),
    caseId: ID(2),
    panelId: ID(3),
    subjectKind,
    subjectId,
    disagree: 5,
    votes: 7,
    createdAt: "2026-11-15T06:11:00.000Z",
    resolvedAt: null,
  });

  it("targets the cases tab for a moderation case and the reports tab for a report", () => {
    expect(flagCaseSearch(flag("moderation_case", OPEN_CASE))).toEqual({ tab: "cases", case: OPEN_CASE });
    expect(flagCaseSearch(flag("report", ID(77)))).toEqual({ tab: "reports" });
  });

  it("renders jury-flag-case-link to /admin/moderation?tab=&case=", () => {
    const { container } = wrap(<JuryFlags flags={[flag("moderation_case", OPEN_CASE), flag("report", ID(77))]} />);
    const links = [...container.querySelectorAll<HTMLAnchorElement>('[data-testid="jury-flag-case-link"]')];
    expect(links.map((a) => a.dataset.caseId)).toEqual([OPEN_CASE, ID(77)]);
    const urls = links.map((a) => new URL(a.getAttribute("href") ?? "", "https://x.test"));
    expect(urls.map((u) => u.pathname)).toEqual(["/admin/moderation", "/admin/moderation"]);
    expect(urls.map((u) => [u.searchParams.get("tab"), u.searchParams.get("case")])).toEqual([
      ["cases", OPEN_CASE],
      ["reports", null],
    ]);
  });
});
