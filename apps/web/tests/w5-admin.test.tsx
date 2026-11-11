// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 5, w5-admin: the audit log's UTC date range (URL search, API range, validation,
 * export name) and the admin home's "Next due" on a queue tile.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  apiRange,
  auditFilters,
  AuditLog,
  csvFilename,
  isUtcDate,
  normalizeActor,
  parseAuditSearch,
  type AuditSearch,
} from "../src/components/admin/audit-log.tsx";
import type {
  AdminQueueCountDto,
  AdminUserViewDto,
  AuditEntryDto,
  ConsoleClient,
} from "../src/components/admin/console-client.ts";
import { QueueTile } from "../src/components/admin/overview.tsx";
import { locale, t } from "../src/i18n/index.ts";
import { uiMessages } from "../src/i18n/index.ts";

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
const entry = (n: number): AuditEntryDto => ({
  id: ID(500 + n),
  actorType: "admin",
  actorId: ID(2),
  action: "moderation.case.assign",
  subjectType: "moderation_case",
  subjectId: ID(600 + n),
  reason: "",
  details: {},
  createdAt: "2026-11-05T10:00:00.000Z",
});

function stub(over: Partial<ConsoleClient> = {}): ConsoleClient {
  return {
    overview: vi.fn<ConsoleClient["overview"]>(async () => ({ queues: [] })),
    auditLog: vi.fn<ConsoleClient["auditLog"]>(async () => ({ items: [entry(1)], nextCursor: null })),
    user: vi.fn<ConsoleClient["user"]>(async () => ({ user: { id: ID(2) } }) as unknown as AdminUserViewDto),
    revealEmail: vi.fn<ConsoleClient["revealEmail"]>(),
    suspend: vi.fn<ConsoleClient["suspend"]>(),
    assign: vi.fn<ConsoleClient["assign"]>(),
    userNames: vi.fn<ConsoleClient["userNames"]>(async () => new Map([[ID(2), "mara"]])),
    ...over,
  };
}

describe("audit search helpers", () => {
  it("isUtcDate accepts real YYYY-MM-DD dates only", () => {
    expect(isUtcDate("2026-11-01")).toBe(true);
    expect(isUtcDate("2028-02-29")).toBe(true);
    expect(isUtcDate("2026-02-29")).toBe(false);
    expect(isUtcDate("2026-13-01")).toBe(false);
    expect(isUtcDate("2026-1-01")).toBe(false);
    expect(isUtcDate("2026-11-01T00:00")).toBe(false);
    expect(isUtcDate("")).toBe(false);
  });

  it("normalizeActor strips @ and case, and rejects what cannot be a username", () => {
    expect(normalizeActor(" @Mara ")).toBe("mara");
    expect(normalizeActor("ab")).toBeNull();
    expect(normalizeActor("no spaces")).toBeNull();
  });

  it("parseAuditSearch keeps valid filters, drops the rest, and a reversed To", () => {
    expect(
      parseAuditSearch({
        actor: "@Mara",
        type: "moderation_case",
        subject: " abc ",
        from: "2026-11-01",
        to: "2026-11-10",
      }),
    ).toEqual({ actor: "mara", type: "moderation_case", subject: "abc", from: "2026-11-01", to: "2026-11-10" });
    expect(parseAuditSearch({ actor: "x", type: "nope", subject: "a".repeat(201), from: "yesterday" })).toEqual({});
    expect(parseAuditSearch({ from: "2026-11-10", to: "2026-11-01" })).toEqual({ from: "2026-11-10" });
    expect(parseAuditSearch({ from: "2026-11-10", to: "2026-11-10" })).toEqual({
      from: "2026-11-10",
      to: "2026-11-10",
    });
    expect(parseAuditSearch({ from: 5, to: ["2026-11-01"] })).toEqual({});
  });

  it("apiRange: the To day is included (exclusive end is the next midnight UTC)", () => {
    expect(apiRange({})).toEqual({});
    expect(apiRange({ from: "2026-11-01" })).toEqual({ from: "2026-11-01T00:00:00.000Z" });
    expect(apiRange({ to: "2026-11-30" })).toEqual({ to: "2026-12-01T00:00:00.000Z" });
    expect(apiRange({ from: "2026-12-31", to: "2026-12-31" })).toEqual({
      from: "2026-12-31T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    });
  });

  it("auditFilters maps the search and the resolved actor to the API's names", () => {
    expect(auditFilters({ actor: "mara", type: "user", subject: "s", from: "2026-11-01" }, ID(2))).toEqual({
      actorId: ID(2),
      subjectType: "user",
      subjectId: "s",
      from: "2026-11-01T00:00:00.000Z",
    });
    expect(auditFilters({}, undefined)).toEqual({});
  });

  it("csvFilename names the range", () => {
    expect(csvFilename({})).toBe("audit-log.csv");
    expect(csvFilename({ from: "2026-11-01", to: "2026-11-10" })).toBe("audit-log-from-2026-11-01-to-2026-11-10.csv");
    expect(csvFilename({ to: "2026-11-10" })).toBe("audit-log-to-2026-11-10.csv");
  });
});

describe("the audit log's date range", () => {
  it("the URL's range and actor go to the API; the actor is resolved first", async () => {
    const auditLog = vi.fn<ConsoleClient["auditLog"]>(async () => ({ items: [entry(1)], nextCursor: null }));
    const user = vi.fn<ConsoleClient["user"]>(async () => ({ user: { id: ID(2) } }) as unknown as AdminUserViewDto);
    const client = stub({ auditLog, user });
    wrap(<AuditLog client={client} search={{ actor: "mara", from: "2026-11-01", to: "2026-11-10" }} />);
    await waitFor(() =>
      expect(auditLog).toHaveBeenCalledWith(
        { actorId: ID(2), from: "2026-11-01T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" },
        undefined,
      ),
    );
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(user).toHaveBeenCalledWith("mara");
    expect((screen.getByTestId("admin-audit-from") as HTMLInputElement).value).toBe("2026-11-01");
    expect((screen.getByTestId("admin-audit-to") as HTMLInputElement).value).toBe("2026-11-10");
  });

  it("an unknown actor in the URL is an error, never an unfiltered list", async () => {
    const auditLog = vi.fn<ConsoleClient["auditLog"]>(async () => ({ items: [entry(1)], nextCursor: null }));
    const user = vi.fn<ConsoleClient["user"]>(async () => {
      throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
    });
    wrap(<AuditLog client={stub({ auditLog, user })} search={{ actor: "nobody" }} />);
    expect(await screen.findByText(t("d7Admin.audit.actorUnknown"))).toBeTruthy();
    expect(auditLog).not.toHaveBeenCalled();
    expect(screen.queryByTestId("admin-audit-row")).toBeNull();
  });

  it("typed dates are labelled, validated, applied and written back to the URL", async () => {
    const auditLog = vi.fn<ConsoleClient["auditLog"]>(async () => ({ items: [], nextCursor: null }));
    const onSearchChange = vi.fn<(s: AuditSearch) => void>();
    wrap(<AuditLog client={stub({ auditLog })} onSearchChange={onSearchChange} />);
    await waitFor(() => expect(auditLog).toHaveBeenCalledTimes(1));
    const from = screen.getByLabelText(t("w5Admin.audit.from"));
    const to = screen.getByLabelText(t("w5Admin.audit.to"));
    expect(from.getAttribute("aria-describedby")).toBe("admin-audit-range-hint");

    fireEvent.change(from, { target: { value: "2026-11-31" } });
    fireEvent.click(screen.getByTestId("admin-audit-apply"));
    expect(await screen.findByText(t("w5Admin.audit.dateInvalid"))).toBeTruthy();
    expect(from.getAttribute("aria-invalid")).toBe("true");
    expect(from.getAttribute("aria-describedby")).toContain("admin-audit-range-error");

    fireEvent.change(from, { target: { value: "2026-11-10" } });
    fireEvent.change(to, { target: { value: "2026-11-01" } });
    fireEvent.click(screen.getByTestId("admin-audit-apply"));
    expect(await screen.findByText(t("w5Admin.audit.rangeOrder"))).toBeTruthy();
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(onSearchChange).not.toHaveBeenCalled();

    fireEvent.change(to, { target: { value: "2026-11-10" } });
    fireEvent.click(screen.getByTestId("admin-audit-apply"));
    await waitFor(() =>
      expect(auditLog).toHaveBeenLastCalledWith(
        { from: "2026-11-10T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" },
        undefined,
      ),
    );
    expect(onSearchChange).toHaveBeenLastCalledWith({ from: "2026-11-10", to: "2026-11-10" });
    expect(screen.queryByText(t("w5Admin.audit.rangeOrder"))).toBeNull();
  });

  it("a new URL search replaces the applied filters; Clear empties them", async () => {
    const auditLog = vi.fn<ConsoleClient["auditLog"]>(async () => ({ items: [entry(1)], nextCursor: null }));
    const client = stub({ auditLog });
    const onSearchChange = vi.fn<(s: AuditSearch) => void>();
    const view = wrap(<AuditLog client={client} search={{ from: "2026-11-01" }} onSearchChange={onSearchChange} />);
    await waitFor(() => expect(auditLog).toHaveBeenLastCalledWith({ from: "2026-11-01T00:00:00.000Z" }, undefined));
    view.rerender(
      <RouterContextProvider router={router}>
        <LocaleProvider locale={locale} messages={uiMessages}>
          <TooltipProvider>
            <AuditLog client={client} search={{ to: "2026-11-02" }} onSearchChange={onSearchChange} />
          </TooltipProvider>
        </LocaleProvider>
      </RouterContextProvider>,
    );
    await waitFor(() => expect(auditLog).toHaveBeenLastCalledWith({ to: "2026-11-03T00:00:00.000Z" }, undefined));
    expect((screen.getByTestId("admin-audit-from") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByText(t("d7Admin.audit.clear")));
    expect(onSearchChange).toHaveBeenLastCalledWith({});
    await waitFor(() => expect(auditLog).toHaveBeenLastCalledWith({}, undefined));
  });
});

const count = (queue: AdminQueueCountDto["queue"], over: Partial<AdminQueueCountDto> = {}): AdminQueueCountDto => ({
  queue,
  open: 2,
  overdue: 0,
  dueSoon: 0,
  oldestAt: "2026-11-10T12:00:00.000Z",
  nextDueAt: null,
  unassigned: null,
  ...over,
});
const me = { role: "admin" };

describe("the admin home's next deadline", () => {
  it("a queue with a clock shows Next due with the time", () => {
    const at = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    wrap(<QueueTile count={count("ncii", { nextDueAt: at })} me={me} />);
    const tile = screen.getByTestId("admin-home-tile");
    expect(tile.getAttribute("data-next-due")).toBe(at);
    expect(tile.textContent).toContain(t("w5Admin.home.nextDue"));
    expect(tile.querySelector(`time[datetime="${at}"]`)).not.toBeNull();
  });

  it("is absent without a deadline, and on queues without clocks", () => {
    wrap(<QueueTile count={count("payments")} me={me} />);
    expect(screen.getByTestId("admin-home-tile").textContent).not.toContain(t("w5Admin.home.nextDue"));
    cleanup();
    wrap(<QueueTile count={count("appeals", { nextDueAt: "2026-11-12T00:00:00.000Z" })} me={me} />);
    const tile = screen.getByTestId("admin-home-tile");
    expect(tile.textContent).not.toContain(t("w5Admin.home.nextDue"));
  });
});
