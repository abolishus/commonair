// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * "Appeal this group" (docs/testing/w2-selectors.md "Analytics"): the state the owner's appeals
 * give a group, the dialog with what an appeal covers and the appeals left this week, the submit,
 * the rate-limit refusal, and the decided result.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GroupAppealAction } from "../src/components/analytics/group-appeal.tsx";
import {
  type Appeal,
  type GroupAppealClient,
  GROUP_APPEAL_WINDOW_MS,
  groupAppealView,
  rateLimitedFor,
} from "../src/components/analytics/group-appeal-data.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const DAY = 86_400_000;
const B1 = "01900000-0000-7000-8000-0000000000b1";
const B2 = "01900000-0000-7000-8000-0000000000b2";
const B3 = "01900000-0000-7000-8000-0000000000b3";
const BODY = "A school network watched together.";

let n = 0;
function appeal(o: Partial<Appeal> = {}): Appeal {
  return {
    id: `01900000-0000-7000-8000-00000000a${String(++n).padStart(3, "0")}`,
    kind: "integrity",
    subjectType: "exclusion_group",
    subjectId: B1,
    exclusionCategory: "datacenter",
    body: BODY,
    status: "open",
    resolution: null,
    createdAt: new Date(NOW - DAY).toISOString(),
    resolvedAt: null,
    ...o,
  };
}

function fakeClient(mine: Appeal[] = [], over: Partial<GroupAppealClient> = {}): GroupAppealClient {
  return {
    mine: vi.fn<GroupAppealClient["mine"]>(async () => mine),
    create: vi.fn<GroupAppealClient["create"]>(async (q) =>
      appeal({ subjectId: q.broadcastId, exclusionCategory: q.category, createdAt: new Date(NOW).toISOString() }),
    ),
    ...over,
  };
}

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const byId = (id: string) => document.querySelectorAll(`[data-testid="${id}"]`);
const openButton = () => byId("group-appeal-open")[0] as HTMLButtonElement | undefined;

describe("groupAppealView", () => {
  const q = { broadcastId: B1, category: "datacenter" as const, now: NOW };

  it("available with three left when nothing was appealed (other subjects ignored)", () => {
    expect(groupAppealView([appeal({ subjectType: "session", exclusionCategory: null })], q)).toEqual({
      state: "available",
      own: null,
      broadcastAppeal: null,
      remaining: 3,
      nextAt: null,
    });
  });

  it("appealed: this group's own appeal, or another group of the broadcast", () => {
    const own = appeal();
    expect(groupAppealView([own], q)).toMatchObject({ state: "appealed", own, broadcastAppeal: own, remaining: 2 });
    const other = appeal({ exclusionCategory: "automation" });
    expect(groupAppealView([other], q)).toMatchObject({ state: "appealed", own: null, broadcastAppeal: other });
  });

  it("limited once the week's three are used, freeing when the oldest leaves the window", () => {
    const old = NOW - 6 * DAY;
    const v = groupAppealView(
      [
        appeal({ subjectId: B2, createdAt: new Date(old).toISOString() }),
        appeal({ subjectId: B3, createdAt: new Date(NOW - DAY).toISOString() }),
        appeal({ subjectId: "01900000-0000-7000-8000-0000000000b4", createdAt: new Date(NOW - 1000).toISOString() }),
      ],
      q,
    );
    expect(v).toEqual({
      state: "limited",
      own: null,
      broadcastAppeal: null,
      remaining: 0,
      nextAt: new Date(old + GROUP_APPEAL_WINDOW_MS).toISOString(),
    });
  });

  it("an appeal exactly 7 days old no longer counts", () => {
    const v = groupAppealView(
      [
        appeal({ subjectId: B2, createdAt: new Date(NOW - 7 * DAY).toISOString() }),
        appeal({ subjectId: B3, createdAt: new Date(NOW - DAY).toISOString() }),
      ],
      q,
    );
    expect(v).toMatchObject({ state: "available", remaining: 2 });
  });
});

describe("rateLimitedFor", () => {
  it("reads retryAfterSeconds of a RATE_LIMITED error only", () => {
    expect(rateLimitedFor({ code: "RATE_LIMITED", data: { retryAfterSeconds: 60 } })).toBe(60);
    expect(rateLimitedFor({ code: "RATE_LIMITED" })).toBe(0);
    expect(rateLimitedFor({ code: "NOT_FOUND" })).toBeNull();
    expect(rateLimitedFor(new Error("x"))).toBeNull();
  });
});

describe("GroupAppealAction", () => {
  it("renders nothing for a hidden group", () => {
    wrap(<GroupAppealAction broadcastId={B1} category="datacenter" sessions={4} client={fakeClient()} now={NOW} />);
    expect(byId("group-appeal-open")).toHaveLength(0);
  });

  it("opens the dialog, explains the cover and the limit, and submits", async () => {
    const client = fakeClient([appeal({ subjectId: B2 })]);
    wrap(<GroupAppealAction broadcastId={B1} category="datacenter" sessions={120} client={client} now={NOW} />);
    await waitFor(() => expect(openButton()?.getAttribute("data-state")).toBe("available"));
    fireEvent.click(openButton()!);
    await waitFor(() => expect(byId("group-appeal-dialog")).toHaveLength(1));
    const dialog = byId("group-appeal-dialog")[0]!;
    expect(dialog.textContent).toContain("120 sessions");
    expect(dialog.textContent).toContain("Data-centre networks");
    expect(byId("group-appeal-limit")[0]?.getAttribute("data-remaining")).toBe("2");
    expect(byId("group-appeal-limit")[0]?.textContent).toContain("2 appeals left this week");
    const submit = byId("group-appeal-submit")[0] as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: BODY } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith({ broadcastId: B1, category: "datacenter", body: BODY }),
    );
    // Sent: the dialog and the row show the open appeal, and the action is now disabled.
    await waitFor(() => expect(byId("group-appeal-status").length).toBeGreaterThan(0));
    expect(byId("group-appeal-status")[0]?.getAttribute("data-status")).toBe("open");
    expect(openButton()?.getAttribute("data-state")).toBe("appealed");
    expect(openButton()?.getAttribute("aria-disabled")).toBe("true");
  });

  it("shares one load between the rows and updates them all on submit", async () => {
    const client = fakeClient();
    wrap(
      <>
        <GroupAppealAction broadcastId={B1} category="datacenter" sessions={6} client={client} now={NOW} />
        <GroupAppealAction broadcastId={B1} category="automation" sessions={7} client={client} now={NOW} />
      </>,
    );
    await waitFor(() =>
      expect([...byId("group-appeal-open")].map((b) => b.getAttribute("data-state"))).toEqual([
        "available",
        "available",
      ]),
    );
    expect(client.mine).toHaveBeenCalledTimes(1);
    fireEvent.click(byId("group-appeal-open")[0]!);
    await waitFor(() => expect(byId("group-appeal-dialog")).toHaveLength(1));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: BODY } });
    fireEvent.click(byId("group-appeal-submit")[0]!);
    await waitFor(() =>
      expect([...byId("group-appeal-open")].map((b) => b.getAttribute("data-state"))).toEqual(["appealed", "appealed"]),
    );
  });

  it("disabled with the reason when the broadcast already has a group appeal", async () => {
    wrap(
      <GroupAppealAction
        broadcastId={B1}
        category="datacenter"
        sessions={6}
        client={fakeClient([appeal({ exclusionCategory: "automation" })])}
        now={NOW}
      />,
    );
    await waitFor(() => expect(openButton()?.getAttribute("data-state")).toBe("appealed"));
    const b = openButton()!;
    expect(b.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(b.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("already has a group appeal");
    // An overturn drops the appealed group's own row, so the others name it and its result.
    const status = byId("group-appeal-status");
    expect(status).toHaveLength(1);
    expect(status[0]?.getAttribute("data-category")).toBe("automation");
    expect(status[0]?.getAttribute("data-status")).toBe("open");
    expect(status[0]?.textContent).toContain("Appeal on");
  });

  it("limited: disabled, saying when the next appeal is possible", async () => {
    const mine = [B2, B3, "01900000-0000-7000-8000-0000000000b4"].map((id) => appeal({ subjectId: id }));
    wrap(<GroupAppealAction broadcastId={B1} category="datacenter" sessions={6} client={fakeClient(mine)} now={NOW} />);
    await waitFor(() => expect(openButton()?.getAttribute("data-state")).toBe("limited"));
    const reason = document.getElementById(openButton()!.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("You have used this week's 3 group appeals");
  });

  it("shows the decided result on the row", async () => {
    wrap(
      <GroupAppealAction
        broadcastId={B1}
        category="datacenter"
        sessions={6}
        client={fakeClient([appeal({ status: "upheld", resolvedAt: new Date(NOW).toISOString() })])}
        now={NOW}
      />,
    );
    await waitFor(() => expect(byId("group-appeal-status")[0]?.getAttribute("data-status")).toBe("upheld"));
    expect(byId("group-appeal-status")[0]?.textContent).toContain("Appeal upheld");
    const reason = document.getElementById(openButton()!.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("the exclusions stand");
  });

  it("an overturn of another group shows on this broadcast's remaining rows", async () => {
    wrap(
      <GroupAppealAction
        broadcastId={B1}
        category="datacenter"
        sessions={6}
        client={fakeClient([appeal({ exclusionCategory: "automation", status: "overturned" })])}
        now={NOW}
      />,
    );
    await waitFor(() => expect(byId("group-appeal-status")[0]?.getAttribute("data-status")).toBe("overturned"));
    expect(byId("group-appeal-status")[0]?.getAttribute("data-category")).toBe("automation");
  });

  it("a page mounted again reloads the list, showing the last one meanwhile", async () => {
    let status: Appeal["status"] = "open";
    const a = appeal();
    const client = fakeClient([], { mine: vi.fn<GroupAppealClient["mine"]>(async () => [{ ...a, status }]) });
    const first = wrap(
      <GroupAppealAction broadcastId={B1} category="datacenter" sessions={6} client={client} now={NOW} />,
    );
    await waitFor(() => expect(byId("group-appeal-status")[0]?.getAttribute("data-status")).toBe("open"));
    first.unmount();
    status = "overturned";
    wrap(<GroupAppealAction broadcastId={B1} category="datacenter" sessions={6} client={client} now={NOW} />);
    // The cached list renders at once, then the reload brings the decision.
    expect(byId("group-appeal-status")[0]?.getAttribute("data-status")).toBe("open");
    await waitFor(() => expect(byId("group-appeal-status")[0]?.getAttribute("data-status")).toBe("overturned"));
    expect(client.mine).toHaveBeenCalledTimes(2);
  });

  it("a rate-limit refusal toasts and reloads the list; the form stays", async () => {
    const err = Object.assign(new Error("Too many requests"), {
      code: "RATE_LIMITED",
      data: { retryAfterSeconds: 60 },
    });
    const client = fakeClient([], { create: vi.fn<GroupAppealClient["create"]>(async () => Promise.reject(err)) });
    wrap(<GroupAppealAction broadcastId={B1} category="datacenter" sessions={6} client={client} now={NOW} />);
    await waitFor(() => expect(openButton()?.getAttribute("data-state")).toBe("available"));
    fireEvent.click(openButton()!);
    await waitFor(() => expect(byId("group-appeal-dialog")).toHaveLength(1));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: BODY } });
    fireEvent.click(byId("group-appeal-submit")[0]!);
    await waitFor(() => expect(client.mine).toHaveBeenCalledTimes(2));
    expect(byId("group-appeal-submit")).toHaveLength(1);
  });

  it("a failed list still offers the appeal (the server decides)", async () => {
    const client = fakeClient([], {
      mine: vi.fn<GroupAppealClient["mine"]>(async () => Promise.reject(new Error("x"))),
    });
    wrap(<GroupAppealAction broadcastId={B1} category="datacenter" sessions={6} client={client} now={NOW} />);
    await waitFor(() => expect(openButton()?.getAttribute("data-state")).toBe("available"));
  });
});
