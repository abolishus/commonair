// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * E7 co-op web: every co-op page and treasury tab shows `coop-load-error` when its load fails and
 * `coop-retry` loads it again in place; the viewer rejoin (`membership-rejoin-viewer`); board
 * elections on `/coop/council` (nominate, a secret approval ballot of at most `seats`); and the
 * pure rules behind them.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CouncilPage } from "../src/components/coop/council.tsx";
import { MembershipPanel } from "../src/components/coop/membership.tsx";
import {
  activeMemberClasses,
  canRejoinViewer,
  electionRefusal,
  electionRefusalText,
  electionRole,
  toggleApproval,
} from "../src/components/coop/rules.ts";
import { CoopPatronageTab, CoopSharesTab } from "../src/components/coop/treasury-tabs.tsx";
import { coopLoads, type CoopRetryable } from "../src/components/coop/use-coop.ts";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { SessionUser } from "../src/lib/bootstrap-types.ts";
import type { ElectionDto, MembershipViewDto } from "../src/lib/coop.ts";
import { ME, OTHER, PERIOD_ID, PROPOSAL_ID, board, council, elections, membershipView } from "./coop-fixtures.ts";

const session = vi.hoisted(() => ({ me: null as SessionUser | null }));
/** API methods that reject (once per name, or every call while `always` has it). */
const failing = vi.hoisted(() => ({ names: new Set<string>(), code: "INTERNAL_SERVER_ERROR" }));
const calls = vi.hoisted(() => ({ counts: new Map<string, number>() }));
/** The status `coop.proposals.get` answers with. */
const fixture = vi.hoisted(() => ({ proposalStatus: "discussion" as "discussion" | "council_review" }));

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
  const f = await import("./coop-fixtures.ts");
  const page = <T,>(items: T[]) => ({ items, nextCursor: null });
  const answer =
    <T,>(name: string, value: () => T) =>
    async () => {
      calls.counts.set(name, (calls.counts.get(name) ?? 0) + 1);
      if (failing.names.has(name)) throw Object.assign(new Error(name), { code: failing.code });
      return value();
    };
  const client = {
    coop: {
      membership: answer("membership", () => f.membershipView()),
      settings: answer("settings", () => f.settings),
      council: answer("council", () => f.council),
      board: answer("board", () => f.board),
      transparency: answer("transparency", () => [f.month("2026-10")]),
      elections: { list: answer("elections", () => f.elections) },
      proposals: {
        list: answer("proposals", () => page([f.proposal({ status: "discussion" })])),
        get: answer("proposal", () => f.proposal({ status: fixture.proposalStatus })),
        comments: answer("comments", () => page(f.comments)),
      },
      patronage: {
        statements: answer("statements", () => [f.statement]),
        statement: answer("statement", () => f.statement),
        periods: answer("periods", () => [f.period("p1", "computed", f.OTHER)]),
      },
      shares: { list: answer("shares", () => page([f.share("s1", "refund_pending")])) },
    },
  };
  return { ...actual, api: () => client };
});

const routes = {
  overview: (await import("../src/routes/_app/coop.index.tsx")).Route,
  membership: (await import("../src/routes/_app/coop.membership.tsx")).Route,
  proposals: (await import("../src/routes/_app/coop.proposals.index.tsx")).Route,
  newProposal: (await import("../src/routes/_app/coop.proposals.new.tsx")).Route,
  proposal: (await import("../src/routes/_app/coop.proposals.$id.index.tsx")).Route,
  edit: (await import("../src/routes/_app/coop.proposals.$id.edit.tsx")).Route,
  council: (await import("../src/routes/_app/coop.council.tsx")).Route,
  settings: (await import("../src/routes/_app/coop.settings.tsx")).Route,
  patronage: (await import("../src/routes/_app/coop.patronage.index.tsx")).Route,
  statement: (await import("../src/routes/_app/coop.patronage.$periodId.tsx")).Route,
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

const me: SessionUser = { id: ME, username: "rivertide", displayName: "Rivertide", channelSlug: null, role: "user" };

beforeAll(async () => {
  for (const route of Object.values(routes)) {
    const c = route.options.component as { preload?: () => Promise<void> } | undefined;
    await c?.preload?.();
  }
  vi.spyOn(routes.proposal, "useParams").mockReturnValue({ id: PROPOSAL_ID } as never);
  vi.spyOn(routes.edit, "useParams").mockReturnValue({ id: PROPOSAL_ID } as never);
  vi.spyOn(routes.statement, "useParams").mockReturnValue({ periodId: PERIOD_ID } as never);
});
beforeEach(() => {
  session.me = me;
  failing.names.clear();
  failing.code = "INTERNAL_SERVER_ERROR";
  calls.counts.clear();
  fixture.proposalStatus = "discussion";
});
afterEach(cleanup);

describe("a failed load shows coop-load-error; coop-retry loads it again in place", () => {
  const cases: [keyof typeof routes, string, string][] = [
    ["overview", "transparency", "coop"],
    ["membership", "membership", "membership"],
    ["membership", "settings", "membership"],
    ["proposals", "proposals", "proposals"],
    ["newProposal", "settings", "proposal-form"],
    ["proposal", "proposal", "proposal"],
    ["edit", "proposal", "proposal-form"],
    ["council", "council", "council"],
    ["council", "elections", "council"],
    ["council", "board", "council"],
    ["settings", "settings", "settings"],
    ["patronage", "statements", "patronage"],
    ["statement", "statement", "statement"],
  ];
  it.each(cases)("%s when %s fails", async (route, failingCall, pageId) => {
    failing.names.add(failingCall);
    const Page = component(routes[route]);
    wrap(<Page />);
    const error = await screen.findByTestId("coop-load-error");
    expect(screen.queryByTestId(pageId)).toBeNull();
    // Never a skeleton that waits forever: the error replaces it.
    expect(screen.queryByLabelText(en["coop.loading"])).toBeNull();
    const before = calls.counts.get(failingCall) ?? 0;
    failing.names.clear();
    fireEvent.click(within(error).getByTestId("coop-retry"));
    expect(await screen.findByTestId(pageId)).toBeTruthy();
    expect(screen.queryByTestId("coop-load-error")).toBeNull();
    expect(calls.counts.get(failingCall)).toBe(before + 1);
  });

  // Loads that feed only part of a public page: the page renders and the retry sits inline.
  const inline: [keyof typeof routes, string, string][] = [
    ["overview", "membership", "coop"],
    ["proposal", "comments", "proposal"],
    ["proposal", "membership", "proposal"],
    ["proposal", "council", "proposal"],
    ["council", "membership", "council"],
  ];
  it.each(inline)("%s when %s fails: the page stays, the retry is inline", async (route, failingCall, pageId) => {
    // The council only matters (and its retry only shows) where it may respond.
    if (failingCall === "council") fixture.proposalStatus = "council_review";
    failing.names.add(failingCall);
    const Page = component(routes[route]);
    wrap(<Page />);
    const error = await screen.findByTestId("coop-load-error");
    const page = await screen.findByTestId(pageId);
    expect(page.contains(error)).toBe(true);
    const before = calls.counts.get(failingCall) ?? 0;
    failing.names.clear();
    fireEvent.click(within(error).getByTestId("coop-retry"));
    await waitFor(() => expect(screen.queryByTestId("coop-load-error")).toBeNull());
    expect(screen.getByTestId(pageId)).toBeTruthy();
    expect(calls.counts.get(failingCall)).toBe(before + 1);
  });

  it("a NOT_FOUND proposal or statement is the not-found page, not a retry", async () => {
    failing.code = "NOT_FOUND";
    for (const [route, call] of [
      ["proposal", "proposal"],
      ["statement", "statement"],
    ] as const) {
      failing.names.add(call);
      const Page = component(routes[route]);
      wrap(<Page />);
      expect(await screen.findByText(en["page.notFound"])).toBeTruthy();
      expect(screen.queryByTestId("coop-load-error")).toBeNull();
      cleanup();
    }
  });

  it("treasury tabs: shares and patronage periods", async () => {
    failing.names.add("shares");
    failing.names.add("periods");
    wrap(
      <>
        <CoopSharesTab />
        <CoopPatronageTab meId={ME} currency="usd" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId("coop-load-error")).toHaveLength(2));
    failing.names.clear();
    for (const retry of screen.getAllByTestId("coop-retry")) fireEvent.click(retry);
    await waitFor(() => expect(screen.queryAllByTestId("coop-load-error")).toHaveLength(0));
    expect(calls.counts.get("shares")).toBe(2);
    expect(calls.counts.get("periods")).toBe(2);
  });
});

describe("coopLoads", () => {
  const load = (state: CoopRetryable["state"], failed: boolean) => ({ state, failed, reload: vi.fn<() => void>() });

  it("failed when a load has nothing to show; stale when a loaded one's reload failed", () => {
    expect(coopLoads([load("loaded", false), load("loading", false)])).toMatchObject({ failed: false, stale: false });
    expect(coopLoads([load("loaded", false), load("failed", true)])).toMatchObject({ failed: true, stale: false });
    expect(coopLoads([load("loaded", true)])).toMatchObject({ failed: false, stale: true });
    expect(coopLoads([])).toMatchObject({ failed: false, stale: false });
  });

  it("retry reloads only the failing loads", () => {
    const ok = load("loaded", false);
    const bad = load("failed", true);
    const stale = load("loaded", true);
    coopLoads([ok, bad, stale]).retry();
    expect(ok.reload).not.toHaveBeenCalled();
    expect(bad.reload).toHaveBeenCalledTimes(1);
    expect(stale.reload).toHaveBeenCalledTimes(1);
  });
});

// Rejoin ---------------------------------------------------------------------------------------------

function viewerView(
  viewer: { status: "active" | "exited" | "lapsed"; basis: "share" | "subscription" } | null,
  eligibleBasis: "share" | "subscription" | null,
): MembershipViewDto {
  const base = membershipView();
  return {
    ...base,
    memberships: viewer
      ? [
          {
            id: "m-v",
            class: "viewer",
            status: viewer.status,
            basis: viewer.basis,
            joinedAt: "2026-10-02T00:00:00.000Z",
          },
        ]
      : [],
    eligibility: base.eligibility.map((e) =>
      e.class === "viewer" ? { ...e, eligible: eligibleBasis !== null, basis: eligibleBasis } : e,
    ),
    share: null,
  };
}

describe("canRejoinViewer", () => {
  it.each([
    ["exited, a subscription qualifies", viewerView({ status: "exited", basis: "subscription" }, "subscription"), true],
    [
      "exited by share, a subscription qualifies",
      viewerView({ status: "exited", basis: "share" }, "subscription"),
      true,
    ],
    ["active viewer", viewerView({ status: "active", basis: "subscription" }, "subscription"), false],
    ["lapsed (the sync re-enrols)", viewerView({ status: "lapsed", basis: "subscription" }, "subscription"), false],
    ["never a viewer member", viewerView(null, "subscription"), false],
    ["exited, qualifies only by share", viewerView({ status: "exited", basis: "share" }, "share"), false],
    ["exited, nothing qualifies", viewerView({ status: "exited", basis: "subscription" }, null), false],
  ])("%s → %s", (_, view, expected) => {
    expect(canRejoinViewer(view)).toBe(expected);
  });
  it("null view (loading)", () => expect(canRejoinViewer(null)).toBe(false));
});

describe("membership-rejoin-viewer", () => {
  const panel = (view: MembershipViewDto, over: Partial<React.ComponentProps<typeof MembershipPanel>> = {}) =>
    wrap(
      <MembershipPanel
        view={view}
        rules={{ shareCents: 2500, refundableOnExit: true }}
        currency="usd"
        instructions={null}
        buying={false}
        onBuy={() => undefined}
        onExit={async () => undefined}
        onExitError={() => undefined}
        {...over}
      />,
    );

  it("button → confirm dialog → coop.join, shown only when it can work", async () => {
    const onRejoin = vi.fn<() => Promise<void>>(async () => undefined);
    panel(viewerView({ status: "exited", basis: "subscription" }, "subscription"), { onRejoin });
    fireEvent.click(screen.getByTestId("membership-rejoin-viewer"));
    expect(onRejoin).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(onRejoin).toHaveBeenCalledTimes(1));
    cleanup();

    panel(viewerView({ status: "active", basis: "subscription" }, "subscription"), { onRejoin });
    expect(screen.queryByTestId("membership-rejoin-viewer")).toBeNull();
    cleanup();
    panel(viewerView({ status: "exited", basis: "subscription" }, "subscription"));
    expect(screen.queryByTestId("membership-rejoin-viewer")).toBeNull();
  });

  it("a refusal reaches onRejoinError", async () => {
    const err = Object.assign(new Error("no"), { code: "FORBIDDEN" });
    const onRejoinError = vi.fn<(err: unknown) => void>();
    panel(viewerView({ status: "exited", basis: "subscription" }, "subscription"), {
      onRejoin: async () => {
        throw err;
      },
      onRejoinError,
    });
    fireEvent.click(screen.getByTestId("membership-rejoin-viewer"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(onRejoinError).toHaveBeenCalledWith(err));
  });
});

// Elections ------------------------------------------------------------------------------------------

const person = (id: string, username: string) => ({ id, username, displayName: username });
const C1 = "0192d6f1-0000-7000-8000-0000000000d1";
const C2 = "0192d6f1-0000-7000-8000-0000000000d2";
const C3 = "0192d6f1-0000-7000-8000-0000000000d3";
function voting(over: Partial<ElectionDto> = {}): ElectionDto {
  return {
    id: "e2",
    class: "streamer",
    seats: 2,
    status: "voting",
    nominationsCloseAt: "2026-10-19T00:00:00.000Z",
    votingEndsAt: "2026-10-30T00:00:00.000Z",
    candidates: [
      { user: person(C1, "ada"), statement: "", votes: null, elected: false },
      { user: person(C2, "bea"), statement: "Lower fees.", votes: null, elected: false },
      { user: person(C3, "cy"), statement: "", votes: null, elected: false },
    ],
    ...over,
  };
}

describe("rules: elections", () => {
  const nominating = elections[0] as ElectionDto;
  it("electionRole", () => {
    expect(electionRole(nominating, null, ["viewer"])).toEqual({ kind: "none" });
    expect(electionRole(nominating, ME, [])).toEqual({ kind: "notMember" });
    expect(electionRole(nominating, ME, ["viewer"])).toEqual({ kind: "canNominate" });
    expect(electionRole(nominating, OTHER, ["viewer"])).toEqual({ kind: "standing" });
    expect(electionRole(voting(), ME, ["streamer"])).toEqual({ kind: "canVote" });
    expect(electionRole(voting(), ME, ["viewer", "worker"])).toEqual({ kind: "notMember" });
    expect(electionRole(voting({ status: "closed" }), ME, ["streamer"])).toEqual({ kind: "none" });
  });

  it("toggleApproval: never more than seats; unchecking always works", () => {
    expect(toggleApproval([], "a", 2)).toEqual(["a"]);
    expect(toggleApproval(["a"], "b", 2)).toEqual(["a", "b"]);
    expect(toggleApproval(["a", "b"], "c", 2)).toEqual(["a", "b"]);
    expect(toggleApproval(["a", "b"], "a", 2)).toEqual(["b"]);
    expect(toggleApproval([], "a", 0)).toEqual([]);
  });

  it("electionRefusal and its text", () => {
    const e = (code: string, message: string) => Object.assign(new Error(message), { code });
    expect(electionRefusal(e("CONFLICT", "Nominations are closed"))).toBe("closed");
    expect(electionRefusal(e("CONFLICT", "Voting is closed"))).toBe("closed");
    expect(electionRefusal(e("CONFLICT", "You are already a candidate"))).toBe("alreadyCandidate");
    expect(electionRefusal(e("CONFLICT", "You already voted in this election"))).toBe("alreadyVoted");
    expect(electionRefusal(e("FORBIDDEN", "Only members of that class can vote"))).toBe("notMember");
    expect(electionRefusal(e("BAD_REQUEST", "Approve at most 2 candidates"))).toBe("tooMany");
    expect(electionRefusal(new Error("network"))).toBe("other");
    expect(electionRefusalText("tooMany", 2)).toBe("Approve at most 2 candidates.");
    expect(electionRefusalText("other", 1)).toBe(en["coop.elections.errorFailed"]);
  });

  it("electionRefusal matches every refusal message the API's nominate and vote handlers throw", async () => {
    // The mapping reads the API's English text, so a reworded message must fail here, not silently
    // turn into "closed" or "other" in the page.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(import.meta.dirname, "../../../services/api/src/coop/council.ts"), "utf8");
    const start = source.indexOf("nominate: os.coop.elections.nominate");
    const voteAt = source.indexOf("vote: os.coop.elections.vote");
    const end = source.indexOf("os.coop.", voteAt + "vote: os.coop.elections.vote".length);
    expect(start).toBeGreaterThan(-1);
    expect(voteAt).toBeGreaterThan(start);
    const thrown = [
      ...source
        .slice(start, end === -1 ? undefined : end)
        .matchAll(/(conflict|forbidden|badRequest)\((["`])(.*?)\2\)/g),
    ].map((m) => `${m[1]}: ${m[3]}`);
    const expected: Record<string, ReturnType<typeof electionRefusal>> = {
      "conflict: Nominations are closed": "closed",
      "conflict: You are already a candidate": "alreadyCandidate",
      "conflict: Voting is closed": "closed",
      "conflict: You already voted in this election": "alreadyVoted",
      "forbidden: Only members of that class can stand": "notMember",
      "forbidden: Only members of that class can vote": "notMember",
      "badRequest: Approve each candidate once": "other",
      "badRequest: Approve at most ${e.seats} candidates": "tooMany",
      "badRequest: Approve only this election's candidates": "other",
    };
    expect(thrown.toSorted()).toEqual(Object.keys(expected).toSorted());
    const codes = { conflict: "CONFLICT", forbidden: "FORBIDDEN", badRequest: "BAD_REQUEST" } as const;
    for (const [key, refusal] of Object.entries(expected)) {
      const [fn, message] = key.split(": ") as [keyof typeof codes, string];
      const err = Object.assign(new Error(message.replace("${e.seats}", "2")), { code: codes[fn] });
      expect([key, electionRefusal(err)]).toEqual([key, refusal]);
    }
  });

  it("electionRole: unknown classes (membership loading or failed) show no role", () => {
    expect(electionRole(nominating, ME, null)).toEqual({ kind: "none" });
    expect(electionRole(voting(), ME, null)).toEqual({ kind: "none" });
  });

  it("activeMemberClasses", () => {
    expect(activeMemberClasses(membershipView())).toEqual(["streamer", "viewer"]);
    expect(activeMemberClasses(null)).toEqual([]);
  });
});

describe("/coop/council elections", () => {
  const page = (over: Partial<React.ComponentProps<typeof CouncilPage>> = {}) =>
    wrap(<CouncilPage council={council} board={board} elections={elections} {...over} />);

  it("candidates carry their id and username", () => {
    page({ elections: [voting()] });
    expect(screen.getAllByTestId("election-candidate").map((c) => [c.dataset.candidateId, c.dataset.username])).toEqual(
      [
        [C1, "ada"],
        [C2, "bea"],
        [C3, "cy"],
      ],
    );
  });

  it("a member of the class stands: statement and submit call nominate", async () => {
    const onNominate = vi.fn<(id: string, statement: string) => Promise<void>>(async () => undefined);
    page({ meId: ME, classes: ["viewer"], onNominate });
    const item = screen.getByTestId("election-item");
    fireEvent.click(within(item).getByTestId("election-nominate"));
    fireEvent.change(within(item).getByTestId("election-nominate-statement"), {
      target: { value: "  I will listen too.  " },
    });
    fireEvent.click(within(item).getByTestId("election-nominate-submit"));
    await waitFor(() => expect(onNominate).toHaveBeenCalledWith("e1", "I will listen too."));
    await waitFor(() => expect(within(item).queryByTestId("election-nominate-statement")).toBeNull());
  });

  it("no nominate for a non-member, a candidate, or signed out", () => {
    page({ meId: ME, classes: ["streamer"] });
    expect(screen.queryByTestId("election-nominate")).toBeNull();
    expect(screen.getByText(en["coop.elections.notMember"].replace("{class}", "Viewer"))).toBeTruthy();
    cleanup();
    page({ meId: OTHER, classes: ["viewer"] });
    expect(screen.queryByTestId("election-nominate")).toBeNull();
    expect(screen.getByText(en["coop.elections.youStand"])).toBeTruthy();
    cleanup();
    page();
    expect(screen.queryByTestId("election-nominate")).toBeNull();
    expect(screen.queryByTestId("election-ballot")).toBeNull();
  });

  it("a nomination refusal shows inline", async () => {
    page({
      meId: ME,
      classes: ["viewer"],
      onNominate: async () => {
        throw Object.assign(new Error("Nominations are closed"), { code: "CONFLICT" });
      },
    });
    fireEvent.click(screen.getByTestId("election-nominate"));
    fireEvent.click(screen.getByTestId("election-nominate-submit"));
    expect(await screen.findByText(en["coop.elections.errorClosed"])).toBeTruthy();
  });

  it("the approval ballot: at most seats, then election-voted; no counts while voting", async () => {
    const onVote = vi.fn<(id: string, candidateIds: string[]) => Promise<void>>(async () => undefined);
    page({ elections: [voting()], meId: ME, classes: ["streamer"], onVote });
    const ballot = screen.getByTestId("election-ballot");
    const box = (id: string) => within(ballot).getByTestId(`election-ballot-${id}`);
    const submit = within(ballot).getByTestId("election-ballot-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(box(C1));
    fireEvent.click(box(C3));
    await waitFor(() =>
      expect(box(C2).hasAttribute("data-disabled") || box(C2).getAttribute("aria-disabled") === "true").toBe(true),
    );
    fireEvent.click(box(C2));
    fireEvent.click(submit);
    await waitFor(() => expect(onVote).toHaveBeenCalledWith("e2", [C1, C3]));
    expect(await screen.findByTestId("election-voted")).toBeTruthy();
    expect(screen.queryByTestId("election-ballot")).toBeNull();
    // Secret: no counts and nothing about anyone's choices while voting.
    expect(screen.queryByText(/votes$/)).toBeNull();
  });

  it("already voted (another tab) counts as cast, with the reason inline; non-members get no ballot", async () => {
    page({
      elections: [voting()],
      meId: ME,
      classes: ["streamer"],
      onVote: async () => {
        throw Object.assign(new Error("You already voted in this election"), { code: "CONFLICT" });
      },
    });
    fireEvent.click(screen.getByTestId(`election-ballot-${C2}`));
    fireEvent.click(screen.getByTestId("election-ballot-submit"));
    expect(await screen.findByTestId("election-voted")).toBeTruthy();
    expect(screen.getByText(en["coop.elections.errorAlreadyVoted"])).toBeTruthy();
    cleanup();
    page({ elections: [voting()], meId: ME, classes: ["viewer"] });
    expect(screen.queryByTestId("election-ballot")).toBeNull();
  });

  it("a closed election shows counts and the elected, and no actions", () => {
    const closed = voting({
      status: "closed",
      candidates: [
        { user: person(C1, "ada"), statement: "", votes: 7, elected: true },
        { user: person(C2, "bea"), statement: "", votes: 3, elected: false },
      ],
    });
    page({ elections: [closed], meId: ME, classes: ["streamer"] });
    expect(screen.getByText("7 votes")).toBeTruthy();
    expect(screen.getAllByText(en["coop.elections.elected"])).toHaveLength(1);
    expect(screen.queryByTestId("election-ballot")).toBeNull();
    expect(screen.queryByTestId("election-nominate")).toBeNull();
  });
});
