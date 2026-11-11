// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 4, d7-admin (README D7.5): the admin home's tiles per queue and role, the audit
 * log (filters, the date range, CSV), a person's standing (the audited email reveal, suspend),
 * claiming and the two bulk actions on the mod queue, the new pages' access, and the admin width
 * rule on every admin route.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { toast } from "@commonair/ui/toast";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { auditCsv, AuditLog, csvCell, inRange } from "../src/components/admin/audit-log.tsx";
import type {
  AdminQueueCountDto,
  AdminUserViewDto,
  AuditEntryDto,
  ConsoleClient,
} from "../src/components/admin/console-client.ts";
import { auditActionLabel, CATALOGUED_ACTIONS, shortId } from "../src/components/admin/console-labels.ts";
import { AdminHome, QueueTile } from "../src/components/admin/overview.tsx";
import { UserStanding } from "../src/components/admin/user-view.tsx";
import { adminPageFor, isStaff, mayOpenAdminPage } from "../src/components/safety/access.ts";
import type { ModerationCaseDetailDto, ModerationCaseDto, ModerationClient } from "../src/components/safety/client.ts";
import { forEachSelected, ModQueue } from "../src/components/safety/mod-queue.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

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
const as = (role: string) => ({ id: ID(1), username: "staff", displayName: "Staff", channelSlug: null, role });

const count = (queue: AdminQueueCountDto["queue"], over: Partial<AdminQueueCountDto> = {}): AdminQueueCountDto => ({
  queue,
  open: 4,
  overdue: 0,
  dueSoon: 0,
  oldestAt: "2026-11-10T12:00:00.000Z",
  unassigned: queue === "moderation" ? 2 : null,
  ...over,
});

const audit = (n: number, over: Partial<AuditEntryDto> = {}): AuditEntryDto => ({
  id: ID(500 + n),
  actorType: "moderator",
  actorId: ID(2),
  action: "moderation.case.assign",
  subjectType: "moderation_case",
  subjectId: ID(600 + n),
  reason: "",
  details: {},
  createdAt: `2026-11-1${n}T10:00:00.000Z`,
  ...over,
});

function consoleStub(over: Partial<ConsoleClient> = {}): ConsoleClient {
  return {
    overview: vi.fn<ConsoleClient["overview"]>(async () => ({ queues: [count("moderation")] })),
    auditLog: vi.fn<ConsoleClient["auditLog"]>(async () => ({ items: [audit(1)], nextCursor: null })),
    user: vi.fn<ConsoleClient["user"]>(),
    revealEmail: vi.fn<ConsoleClient["revealEmail"]>(async () => ({ email: "person@example.test" })),
    suspend: vi.fn<ConsoleClient["suspend"]>(async () => ({ ok: true })),
    assign: vi.fn<ConsoleClient["assign"]>(),
    userNames: vi.fn<ConsoleClient["userNames"]>(async () => new Map([[ID(2), "mara"]])),
    ...over,
  };
}

describe("access to the new pages", () => {
  it("maps /admin, /admin/audit and /admin/users/<name>", () => {
    expect(adminPageFor("/admin")).toBe("home");
    expect(adminPageFor("/admin/")).toBe("home");
    expect(adminPageFor("/admin/audit")).toBe("audit");
    expect(adminPageFor("/admin/users/mara")).toBe("user");
    expect(adminPageFor("/admin/users/mara/x")).toBeNull();
    expect(adminPageFor("/admin/users")).toBeNull();
  });

  it("the home is every staff role's, the audit log the admins', a person's standing safety staff's", () => {
    for (const role of ["moderator", "admin", "legal", "treasurer"]) {
      expect(isStaff(as(role))).toBe(true);
      expect(mayOpenAdminPage("home", as(role))).toBe(true);
    }
    expect(mayOpenAdminPage("home", as("user"))).toBe(false);
    expect(mayOpenAdminPage("home", null)).toBe(false);
    expect(mayOpenAdminPage("audit", as("admin"))).toBe(true);
    for (const role of ["moderator", "legal", "treasurer", "user"])
      expect(mayOpenAdminPage("audit", as(role))).toBe(false);
    for (const role of ["moderator", "admin", "legal"]) expect(mayOpenAdminPage("user", as(role))).toBe(true);
    for (const role of ["treasurer", "user"]) expect(mayOpenAdminPage("user", as(role))).toBe(false);
  });
});

describe("the admin width rule", () => {
  const dir = join(import.meta.dirname, "../src/routes/_admin");
  // `admin.coop.tsx` renders `AdminCoopPage`, whose container lives in components/coop (another
  // unit's file); its switch to AdminPage is a listed follow-up.
  const EXEMPT = new Set(["admin.coop.tsx"]);
  const routes = readdirSync(dir).filter((f) => f.endsWith(".tsx") && !EXEMPT.has(f));

  it("covers every admin route", () => {
    expect(routes.length).toBeGreaterThanOrEqual(14);
  });

  it.each(routes)("%s uses AdminPage with a width, never PageContainer", (file) => {
    const text = readFileSync(join(dir, file), "utf8");
    expect(text).toMatch(/<AdminPage width="(queue|form|full)"/);
    expect(text).not.toContain("PageContainer");
  });
});

describe("the admin home", () => {
  it("a tile per queue, overdue and due-soon in words, linked to its queue", () => {
    wrap(<QueueTile count={count("moderation", { overdue: 1, dueSoon: 2 })} me={as("moderator")} />);
    const tile = screen.getByTestId("admin-home-tile");
    expect(tile.getAttribute("data-queue")).toBe("moderation");
    expect(tile.getAttribute("data-tone")).toBe("destructive");
    expect(tile.textContent).toContain(t("d7Admin.home.overdue", { count: 1 }));
    expect(tile.textContent).toContain(t("d7Admin.home.dueSoon", { count: 2 }));
    expect(tile.textContent).toContain(t("d7Admin.home.unassigned", { count: 2 }));
    expect(within(tile).getByTestId("admin-home-queue-link").getAttribute("href")).toBe("/admin/moderation");
  });

  it("NCII links to its tab; a queue without a clock never shows due counts", () => {
    wrap(
      <>
        <QueueTile count={count("ncii")} me={as("moderator")} />
        <QueueTile count={count("appeals", { dueSoon: 3 })} me={as("moderator")} />
      </>,
    );
    const [ncii, appeals] = screen.getAllByTestId("admin-home-tile");
    expect(
      within(ncii as HTMLElement)
        .getByTestId("admin-home-queue-link")
        .getAttribute("href"),
    ).toBe("/admin/moderation?tab=ncii");
    expect(appeals?.textContent).not.toContain(t("d7Admin.home.dueSoon", { count: 3 }));
  });

  it("an admin sees the payments count without a link (the treasury is the treasurer's page)", () => {
    wrap(<QueueTile count={count("payments")} me={as("admin")} />);
    expect(screen.queryByTestId("admin-home-queue-link")).toBeNull();
    cleanup();
    wrap(<QueueTile count={count("payments")} me={as("treasurer")} />);
    expect(screen.getByTestId("admin-home-queue-link").getAttribute("href")).toBe("/treasury");
  });

  it("admins also get the recent staff actions with names; others never load the audit log", async () => {
    const client = consoleStub();
    wrap(<AdminHome client={client} me={as("admin")} />);
    const row = await screen.findByTestId("admin-home-recent-row");
    expect(row.textContent).toContain(t("d7Admin.action.caseAssign"));
    expect(row.textContent).toContain("moderation.case.assign");
    expect(row.textContent).toContain("mara");
    expect(screen.getByTestId("admin-home-lookup")).toBeTruthy();
    cleanup();
    const otherAudit = vi.fn<ConsoleClient["auditLog"]>();
    const other = consoleStub({ auditLog: otherAudit });
    wrap(<AdminHome client={other} me={as("treasurer")} />);
    await screen.findAllByTestId("admin-home-tile");
    expect(otherAudit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("admin-home-lookup")).toBeNull();
  });
});

describe("the audit log", () => {
  it("helpers: the range, CSV cells (formulas defused) and short ids", () => {
    expect(inRange({ createdAt: "2026-11-11T10:00:00Z" }, null, null)).toBe(true);
    expect(inRange({ createdAt: "2026-11-11T10:00:00Z" }, "2026-11-11T11:00:00Z", null)).toBe(false);
    expect(inRange({ createdAt: "2026-11-11T10:00:00Z" }, null, "2026-11-11T09:00:00Z")).toBe(false);
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=HYPERLINK()")).toBe("'=HYPERLINK()");
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    const csv = auditCsv([audit(1, { reason: "Repeated, spam" })], new Map([[ID(2), "mara"]]));
    expect(csv.split("\r\n")[0]).toBe("time,actor_type,actor,action,subject_type,subject_id,reason");
    expect(csv.split("\r\n")[1]).toContain(",mara,moderation.case.assign,moderation_case,");
    expect(csv.split("\r\n")[1]?.endsWith('"Repeated, spam"')).toBe(true);
    expect(shortId(ID(7))).toBe("0192…0007");
  });

  it("every catalogued action has a label", () => {
    for (const action of CATALOGUED_ACTIONS) expect(auditActionLabel(action)).toBeTruthy();
    expect(auditActionLabel("something.new")).toBeNull();
  });

  it("rows show the label with the raw code, the actor's name and a link to the case", async () => {
    wrap(<AuditLog client={consoleStub()} />);
    const row = await screen.findByTestId("admin-audit-row");
    expect(row.textContent).toContain(t("d7Admin.action.caseAssign"));
    expect(row.textContent).toContain("moderation.case.assign");
    expect(row.textContent).toContain("@mara");
    expect(within(row).getByTestId("admin-audit-subject").getAttribute("href")).toBe(
      `/admin/moderation?case=${ID(601)}`,
    );
  });

  it("the actor filter resolves the username to an id; an unknown name is an error, not a query", async () => {
    const auditLog = vi.fn<ConsoleClient["auditLog"]>(async () => ({ items: [], nextCursor: null }));
    const user = vi.fn<ConsoleClient["user"]>(async (name) => {
      if (name !== "mara") throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
      return { user: { id: ID(2) } } as unknown as AdminUserViewDto;
    });
    wrap(<AuditLog client={consoleStub({ auditLog, user })} />);
    await waitFor(() => expect(auditLog).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("admin-audit-actor"), { target: { value: "@Mara" } });
    fireEvent.change(screen.getByTestId("admin-audit-subject-id"), { target: { value: ID(9) } });
    fireEvent.click(screen.getByTestId("admin-audit-apply"));
    await waitFor(() => expect(auditLog).toHaveBeenLastCalledWith({ actorId: ID(2), subjectId: ID(9) }, undefined));
    fireEvent.change(screen.getByTestId("admin-audit-actor"), { target: { value: "nobody" } });
    fireEvent.click(screen.getByTestId("admin-audit-apply"));
    expect(await screen.findByText(t("d7Admin.audit.actorUnknown"))).toBeTruthy();
    expect(auditLog).toHaveBeenCalledTimes(2);
  });
});

const view = (over: Partial<AdminUserViewDto> = {}): AdminUserViewDto => ({
  user: {
    id: ID(3),
    username: "quietfox",
    displayName: "Quiet Fox",
    role: "user",
    accountType: "human",
    emailVerified: true,
    twoFactorEnabled: false,
    createdAt: "2026-10-01T10:00:00.000Z",
    deletedAt: null,
  },
  channel: null,
  suspensions: [],
  enforcement: [],
  openReports: 2,
  openCases: [],
  legalHolds: [],
  deletion: null,
  recentAudit: [],
  ...over,
});

describe("a person's standing", () => {
  it("the email is never shown until an admin reveals it with a reason", async () => {
    const revealEmail = vi.fn<ConsoleClient["revealEmail"]>(async () => ({ email: "person@example.test" }));
    const client = consoleStub({ revealEmail });
    wrap(<UserStanding view={view()} me={as("admin")} client={client} onChanged={() => {}} names={new Map()} />);
    expect(screen.queryByTestId("admin-user-email")).toBeNull();
    fireEvent.click(screen.getByTestId("admin-user-reveal"));
    fireEvent.change(await screen.findByTestId("admin-user-reveal-reason"), { target: { value: "Legal request 12" } });
    fireEvent.click(screen.getByTestId("admin-user-reveal-submit"));
    expect((await screen.findByTestId("admin-user-email")).textContent).toBe("person@example.test");
    expect(revealEmail).toHaveBeenCalledWith("quietfox", "Legal request 12");
  });

  it("moderators and legal have no reveal; legal cannot suspend", () => {
    wrap(
      <UserStanding view={view()} me={as("moderator")} client={consoleStub()} onChanged={() => {}} names={new Map()} />,
    );
    expect(screen.queryByTestId("admin-user-reveal")).toBeNull();
    expect(screen.getByTestId("admin-user-suspend-form")).toBeTruthy();
    cleanup();
    wrap(<UserStanding view={view()} me={as("legal")} client={consoleStub()} onChanged={() => {}} names={new Map()} />);
    expect(screen.queryByTestId("admin-user-reveal")).toBeNull();
    expect(screen.queryByTestId("admin-user-suspend-form")).toBeNull();
  });

  it("suspending cites a clause and the reason; an active suspension can be lifted", async () => {
    const suspend = vi.fn<ConsoleClient["suspend"]>(async () => ({ ok: true }));
    const client = consoleStub({ suspend });
    const onChanged = vi.fn<() => void>();
    wrap(
      <UserStanding
        view={view({
          suspensions: [{ target: "user", reason: "moderation", since: "2026-11-10T10:00:00.000Z", until: null }],
        })}
        me={as("moderator")}
        client={client}
        onChanged={onChanged}
        names={new Map()}
      />,
    );
    expect(screen.getByTestId("admin-user-suspension").getAttribute("data-target")).toBe("user");
    fireEvent.change(screen.getByTestId("admin-user-suspend-reason"), { target: { value: "Spam waves" } });
    fireEvent.click(screen.getByTestId("admin-user-suspend"));
    fireEvent.click(await screen.findByRole("button", { name: t("d7Admin.user.suspend") }));
    await waitFor(() =>
      expect(suspend).toHaveBeenCalledWith({
        username: "quietfox",
        suspended: true,
        target: "user",
        clauseId: "guidelines.general",
        reason: "Spam waves",
        durationSeconds: 604800,
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("you cannot suspend yourself from your own page", () => {
    wrap(
      <UserStanding
        view={view()}
        me={{ id: ID(3), role: "moderator" }}
        client={consoleStub()}
        onChanged={() => {}}
        names={new Map()}
      />,
    );
    expect(screen.queryByTestId("admin-user-suspend-form")).toBeNull();
  });
});

const summary = (id: string, assignee: ModerationCaseDto["assignee"] = null): ModerationCaseDto =>
  ({
    id,
    tier: "t1",
    status: "open",
    origin: "classifier",
    subjectType: "broadcast",
    subjectId: ID(99),
    channel: { id: ID(98), slug: "lumen", displayName: "Lumen" },
    user: null,
    category: "sexual",
    priority: 100,
    slaDueAt: null,
    createdAt: "2026-10-21T12:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    resolutionNote: null,
    assignee,
    assignedAt: assignee ? "2026-10-21T12:30:00.000Z" : null,
  }) as ModerationCaseDto;

const detail = (c: ModerationCaseDto): ModerationCaseDetailDto => ({
  ...c,
  flags: [],
  history: [],
  notScored: [],
  label: null,
});

function modClient(over: Partial<ModerationClient> = {}): ModerationClient {
  const cases = [summary(ID(10)), summary(ID(11), { id: ID(5), username: "mara" })];
  return {
    cases: vi.fn<ModerationClient["cases"]>(async ({ tier }) => ({
      items: tier === "t1" ? cases : [],
      nextCursor: null,
    })),
    case: vi.fn<ModerationClient["case"]>(async (id) => detail(cases.find((c) => c.id === id) ?? summary(id))),
    assign: vi.fn<NonNullable<ModerationClient["assign"]>>(async (id, assigneeId) =>
      summary(id, assigneeId ? { id: assigneeId, username: "staff" } : null),
    ),
    frame: vi.fn<ModerationClient["frame"]>(),
    review: vi.fn<ModerationClient["review"]>(),
    reports: vi.fn<ModerationClient["reports"]>(async () => ({
      items: [ID(30), ID(31)].map((id) => ({
        id,
        subjectType: "chat_message" as const,
        subjectId: ID(97),
        channelSlug: "lumen",
        reason: "spam" as const,
        details: "",
        evidence: {},
        status: "open" as const,
        priority: 0,
        reporter: null,
        createdAt: "2026-10-21T12:00:00.000Z",
        resolution: null,
      })),
      nextCursor: null,
    })),
    resolveReport: vi.fn<ModerationClient["resolveReport"]>(),
    ncii: vi.fn<ModerationClient["ncii"]>(async () => ({ items: [], nextCursor: null })),
    decideNcii: vi.fn<ModerationClient["decideNcii"]>(),
    ...over,
  };
}

describe("claiming and bulk actions on the mod queue", () => {
  it("forEachSelected counts successes and keeps going past a failure", async () => {
    const done = await forEachSelected(["a", "b", "c"], async (id) => {
      if (id === "b") throw new Error("conflict");
    });
    expect(done).toBe(2);
  });

  it("rows show who holds a case; the open case offers Assign to me", async () => {
    const client = modClient();
    wrap(
      <ModQueue
        canReports
        client={client}
        me={{ id: ID(1), role: "moderator" }}
        location={{ tab: "cases", case: ID(10) }}
        onLocationChange={() => {}}
      />,
    );
    const items = await screen.findAllByTestId("modq-item");
    expect(within(items[1] as HTMLElement).getByTestId("modq-item-assignee").textContent).toBe("@mara");
    fireEvent.click(await screen.findByTestId("modq-claim-me"));
    await waitFor(() => expect(client.assign).toHaveBeenCalledWith(ID(10), ID(1)));
  });

  it("someone else's claim: no Assign to me for a moderator", async () => {
    wrap(
      <ModQueue
        canReports
        client={modClient()}
        me={{ id: ID(1), role: "moderator" }}
        location={{ tab: "cases", case: ID(11) }}
        onLocationChange={() => {}}
      />,
    );
    const claim = await screen.findByTestId("modq-claim");
    expect(claim.textContent).toContain(t("d7Admin.claim.assignedTo", { username: "mara" }));
    expect(screen.queryByTestId("modq-claim-me")).toBeNull();
    expect(screen.queryByTestId("modq-claim-release")).toBeNull();
  });

  it("the claim filter is part of the location and reaches the API", async () => {
    const cases = vi.fn<ModerationClient["cases"]>(async () => ({ items: [summary(ID(10))], nextCursor: null }));
    const client = modClient({ cases });
    const onChange = vi.fn<(next: unknown) => void>();
    wrap(
      <ModQueue
        canReports
        client={client}
        me={{ id: ID(1), role: "moderator" }}
        location={{ tab: "cases", case: null, assignee: "unassigned" }}
        onLocationChange={onChange}
      />,
    );
    await screen.findAllByTestId("modq-item");
    expect(cases).toHaveBeenCalledWith(expect.objectContaining({ tier: "t1", assignee: "unassigned" }));
  });

  it("bulk: select cases and assign them to me", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => 1);
    const client = modClient();
    wrap(<ModQueue canReports client={client} me={{ id: ID(1), role: "moderator" }} />);
    await screen.findAllByTestId("modq-item");
    fireEvent.click(screen.getByTestId("modq-select-all"));
    expect(screen.getByTestId("modq-bulk-count").textContent).toBe(t("d7Admin.bulk.selected", { count: 2 }));
    fireEvent.click(screen.getByTestId("modq-bulk-assign"));
    await waitFor(() => expect(client.assign).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(success).toHaveBeenCalledWith(t("d7Admin.bulk.assigned", { count: 2 })));
    expect(screen.queryByTestId("modq-bulk-count")).toBeNull();
  });

  it("bulk: dismiss reports with one note; NCII has no bulk at all", async () => {
    vi.spyOn(toast, "success").mockImplementation(() => 1);
    const resolveReport = vi.fn<ModerationClient["resolveReport"]>();
    const client = modClient({ resolveReport });
    wrap(
      <ModQueue
        canReports
        client={client}
        me={{ id: ID(1), role: "moderator" }}
        location={{ tab: "reports", case: null }}
        onLocationChange={() => {}}
      />,
    );
    const checks = await screen.findAllByTestId("modq-item-check");
    fireEvent.click(checks[0] as HTMLElement);
    fireEvent.click(checks[1] as HTMLElement);
    fireEvent.click(screen.getByTestId("modq-bulk-dismiss"));
    fireEvent.change(await screen.findByTestId("modq-bulk-dismiss-note"), { target: { value: "Duplicates" } });
    fireEvent.click(screen.getByTestId("modq-bulk-dismiss-submit"));
    await waitFor(() => expect(resolveReport).toHaveBeenCalledTimes(2));
    expect(resolveReport).toHaveBeenCalledWith({ id: ID(30), status: "dismissed", resolution: "Duplicates" });
    cleanup();
    wrap(
      <ModQueue
        canReports
        client={modClient()}
        me={{ id: ID(1), role: "moderator" }}
        location={{ tab: "ncii", case: null }}
        onLocationChange={() => {}}
      />,
    );
    await screen.findByTestId("modq-count");
    expect(screen.queryByTestId("modq-select-all")).toBeNull();
  });

  it("without me (or an assign call) the queue shows claims but offers none", async () => {
    wrap(
      <ModQueue
        canReports
        client={modClient()}
        location={{ tab: "cases", case: ID(10) }}
        onLocationChange={() => {}}
      />,
    );
    await screen.findByTestId("modq-claim");
    expect(screen.queryByTestId("modq-claim-me")).toBeNull();
  });
});
