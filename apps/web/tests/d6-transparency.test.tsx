// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Transparency v2 (overhaul D6.1, coop-trust P3): the numbers strip reads the creator share from
 * `platform.cut` (never a literal) and the fee schedule's last change; the fee promise lists the
 * sourced, dated competitor figures `/creators` keeps; the revenue bar shows the creators' share of
 * revenue, not creators plus costs (F4); spending is its own bar; the deficit note states the gap
 * and the treasurer's note (or the promise to publish one); governance is capped at 10 with "All
 * decisions"; the months stack below `sm`; a failed books load stays local with Retry (F3); and a
 * treasurer's month-note editor saves and removes notes.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { COMPETITOR_RATES, RATES_CHECKED } from "../src/components/creators/rates.ts";
import { PAYMENT_FEES } from "../src/components/money/transparency-split.ts";
import { HOW_WE_COUNT_ID, HowWeCount } from "../src/components/transparency-v2/how-we-count.tsx";
import {
  GOVERNANCE_CAP,
  creatorsPaidCents,
  cutShares,
  deficitOf,
  feeLastChanged,
  latestNote,
  recentDecisions,
} from "../src/components/transparency-v2/model.ts";
import { TransparencyV2, type TransparencyV2Props } from "../src/components/transparency-v2/report.tsx";
import { MonthNoteEditor } from "../src/components/treasury/month-note-editor.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { TransparencyMonthDto } from "../src/lib/money.ts";

configure({ asyncUtilTimeout: 5_000 });
afterEach(cleanup);

const usd = (cents: number) => ({ cents, currency: "usd" });
type Governance = TransparencyMonthDto["governance"][number];

function month(key: string, over: Partial<TransparencyMonthDto> = {}): TransparencyMonthDto {
  return {
    month: key,
    note: null,
    revenue: usd(10_000),
    streamerPayouts: usd(8000),
    coopRetained: usd(1000),
    costs: [
      { category: PAYMENT_FEES, amount: usd(320) },
      { category: "hosting", amount: usd(6000) },
    ],
    surplus: usd(-5320),
    patronageDistributed: usd(0),
    egressBySource: { origin: 0, relay: 0, p2p: 0, cdn: 0 },
    governance: [],
    members: { streamer: 2, viewer: 5, worker: 1 },
    splitSuspense: { released: 0, forfeited: 0, writeOffs: 0, heldAtMonthEnd: usd(0) },
    ...over,
  };
}

const decided = (id: string, decidedAt: string | null): Governance => ({
  proposalId: id,
  title: `Proposal ${id}`,
  status: "applied",
  kind: "ordinary",
  passed: true,
  reason: "passed",
  decidedAt,
});

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/transparency"] }),
});

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

const loaded = (months: TransparencyMonthDto[]): TransparencyV2Props["books"] => ({
  data: months,
  failed: false,
  reload: vi.fn<() => void>(),
});

function page(over: Partial<TransparencyV2Props> = {}) {
  return wrap(
    <TransparencyV2
      books={loaded([month("2026-10"), month("2026-09")])}
      cut={{ creator: 0.9, coop: 0.1 }}
      feeChanged={{ kind: "founding" }}
      currency="usd"
      site="Example Air"
      {...over}
    />,
  );
}

const one = (id: string) => screen.getByTestId(id);
const stat = (id: string) => one("transparency-numbers").querySelector(`[data-stat="${id}"] dd`)?.textContent ?? null;
const splitRows = (card: Element) =>
  [...card.querySelectorAll('[data-testid="transparency-split-row"]')].map((r) => [
    r.getAttribute("data-part"),
    r.getAttribute("data-cents"),
    r.getAttribute("data-share"),
  ]);

describe("model", () => {
  it("cutShares reads platform.cut; anything else is null (never a guessed 90%)", () => {
    expect(cutShares([{ key: "platform.cut", value: { streamerShare: 0.85, coopShare: 0.15 } }])).toEqual({
      creator: 0.85,
      coop: 0.15,
    });
    expect(cutShares(null)).toBeNull();
    expect(cutShares([])).toBeNull();
    expect(cutShares([{ key: "platform.cut", value: { streamerShare: "0.9", coopShare: 0.1 } }])).toBeNull();
    expect(cutShares([{ key: "platform.cut", value: { streamerShare: 1.2, coopShare: 0.1 } }])).toBeNull();
    expect(cutShares([{ key: "platform.cut", value: { streamerShare: 0, coopShare: 1 } }])).toBeNull();
    expect(cutShares([{ key: "platform.cut", value: null }])).toBeNull();
  });

  it("feeLastChanged: the newest decided change, founding values only, or no schedule", () => {
    expect(
      feeLastChanged([
        { key: "payout.rules", changedAt: "2026-09-01T00:00:00Z" },
        { key: "platform.cut", changedAt: "2026-10-05T00:00:00Z" },
        { key: "platform.cut", changedAt: null },
      ]),
    ).toEqual({ kind: "changed", at: "2026-10-05T00:00:00Z" });
    expect(feeLastChanged([{ key: "platform.cut", changedAt: null }])).toEqual({ kind: "founding" });
    expect(feeLastChanged([])).toBeNull();
    expect(feeLastChanged(null)).toBeNull();
  });

  it("deficitOf: the gap is minus the surplus, with the costs and the co-op's share; none in surplus", () => {
    expect(deficitOf([month("2026-10"), month("2026-09")])).toEqual({
      months: 2,
      costs: 12_640,
      retained: 2000,
      gap: 10_640,
      currency: "usd",
    });
    expect(deficitOf([month("2026-10", { surplus: usd(0) })])).toBeNull();
    expect(deficitOf([month("2026-10", { surplus: usd(1) })])).toBeNull();
    expect(deficitOf([])).toBeNull();
  });

  it("latestNote: the newest month with a note", () => {
    const note = (body: string) => ({ body, updatedAt: "2026-10-20T00:00:00Z" });
    expect(latestNote([month("2026-10"), month("2026-09", { note: note("Sept") })])).toEqual({
      month: "2026-09",
      body: "Sept",
      updatedAt: "2026-10-20T00:00:00Z",
    });
    expect(latestNote([month("2026-08", { note: note("Aug") }), month("2026-09", { note: note("Sep") })])?.month).toBe(
      "2026-09",
    );
    expect(latestNote([month("2026-10")])).toBeNull();
  });

  it("creatorsPaidCents adds the months' payouts", () => {
    expect(creatorsPaidCents([month("2026-10"), month("2026-09")])).toBe(16_000);
    expect(creatorsPaidCents([])).toBe(0);
  });

  it("recentDecisions: newest first across months, undated last, capped with `more`", () => {
    const months = [
      month("2026-10", { governance: [decided("a", "2026-10-02T00:00:00Z"), decided("w", null)] }),
      month("2026-09", { governance: [decided("b", "2026-10-05T00:00:00Z"), decided("c", "2026-09-01T00:00:00Z")] }),
    ];
    expect(recentDecisions(months).items.map((g) => [g.proposalId, g.month])).toEqual([
      ["b", "2026-09"],
      ["a", "2026-10"],
      ["c", "2026-09"],
      ["w", "2026-10"],
    ]);
    expect(recentDecisions(months).more).toBe(false);
    expect(recentDecisions(months, 2)).toMatchObject({ more: true });
    expect(recentDecisions(months, 2).items.map((g) => g.proposalId)).toEqual(["b", "a"]);
    expect(recentDecisions([]).items).toEqual([]);
    expect(GOVERNANCE_CAP).toBe(10);
  });
});

describe("TransparencyV2", () => {
  it("the numbers strip: members, creators paid, the share from platform.cut, last vote and fee change", () => {
    page({ cut: { creator: 0.85, coop: 0.15 } });
    expect(stat("members")).toBe("8");
    expect(stat("paid")).toBe("$160.00");
    // The member-voted cut, not a literal and not the books' ratio (which is 90% here).
    expect(stat("share")).toContain("85%");
    expect(stat("vote")).toBe(t("d6Transparency.numbers.noVote"));
    expect(stat("fee")).toBe(t("d6Transparency.numbers.feeFounding"));
  });

  it("figures whose source did not load read Not available, the others stay", () => {
    page({ cut: null, feeChanged: null });
    expect(stat("share")).toBe(t("d6Transparency.numbers.unknown"));
    expect(stat("fee")).toBe(t("d6Transparency.numbers.unknown"));
    expect(stat("members")).toBe("8");
    expect(one("transparency-fee-promise").textContent).toContain(t("d6Transparency.fee.unavailable"));
  });

  it("the fee promise: the cut in words, then every competitor's published share, sourced and dated", () => {
    page();
    const card = one("transparency-fee-promise");
    expect(card.getAttribute("data-creator-share")).toBe("0.9");
    expect(card.textContent).toContain(t("d6Transparency.fee.promise", { creatorShare: "90%", coopShare: "10%" }));
    const rows = within(card).getAllByTestId("transparency-fee-compare-row");
    expect(rows.map((r) => r.getAttribute("data-platform"))).toEqual([
      "commonair",
      ...COMPETITOR_RATES.map((r) => r.id),
    ]);
    expect(rows[0]?.textContent).toContain("Example Air");
    for (const rate of COMPETITOR_RATES) {
      const row = rows.find((r) => r.getAttribute("data-platform") === rate.id);
      expect(row?.querySelector("a")?.getAttribute("href")).toBe(rate.source?.url);
      expect(row?.textContent).toContain(RATES_CHECKED);
    }
    // Kick's 95% is listed with its status gate, so the page never claims the highest share.
    expect(rows.find((r) => r.getAttribute("data-platform") === "kick")?.textContent).toContain("KICK Streamer");
  });

  it("F4: the revenue bar shows the creators' share of revenue, never creators plus costs", () => {
    page();
    const flow = one("transparency-flow");
    expect(flow.textContent).toContain(t("d6Transparency.split.title"));
    expect(flow.getAttribute("data-total")).toBe("20000");
    expect(splitRows(flow)).toEqual([
      ["creators", "18000", "90"],
      ["coop", "1360", "7"],
      ["processing", "640", "3"],
    ]);
    // Costs (12,640 here) are not in the revenue bar; they have their own.
    expect(splitRows(flow).some(([part]) => part === "hosting")).toBe(false);
    const spending = one("transparency-spending");
    expect(spending.textContent).toContain(t("d6Transparency.spend.title"));
    expect(splitRows(spending)).toEqual([
      ["hosting", "12000", "95"],
      [PAYMENT_FEES, "640", "5"],
    ]);
    expect(spending.textContent).toContain(t("fixWeb.transparency.category.hosting"));
  });

  it("the deficit note states the gap and, without a treasurer's note, promises one", () => {
    page();
    const note = one("transparency-deficit");
    expect(note.getAttribute("data-gap")).toBe("10640");
    expect(note.textContent).toContain("$106.40");
    expect(note.textContent).toContain(t("d6Transparency.deficit.fundingMissing"));
    expect(note.textContent).toContain(t("d6Transparency.deficit.commitment"));
    // No claim about who covers the gap, the creators' share included.
    expect(note.textContent).not.toMatch(/never used|creators' 90/i);
  });

  it("with a treasurer's note, the deficit note shows it instead", () => {
    page({
      books: loaded([
        month("2026-10", { note: { body: "Founding shares cover the gap.", updatedAt: "2026-11-01T00:00:00Z" } }),
      ]),
    });
    const quote = one("transparency-deficit-note");
    expect(quote.getAttribute("data-month")).toBe("2026-10");
    expect(quote.textContent).toContain("Founding shares cover the gap.");
    expect(screen.queryByTestId("transparency-deficit-missing")).toBeNull();
  });

  it("in surplus: no deficit note, and a treasurer's note shows on its own", () => {
    page({
      books: loaded([
        month("2026-10", {
          surplus: usd(500),
          note: { body: "A good month.", updatedAt: "2026-11-01T00:00:00Z" },
        }),
      ]),
    });
    expect(screen.queryByTestId("transparency-deficit")).toBeNull();
    expect(one("transparency-treasurer-note").textContent).toContain("A good month.");
  });

  it("lists the commitments", () => {
    page();
    const items = one("transparency-commitments").querySelectorAll("[data-commitment]");
    expect([...items].map((i) => i.getAttribute("data-commitment"))).toEqual(["cut", "books", "trackers", "source"]);
  });

  it("the months: a table from sm with the raw cents, stacked rows below it", () => {
    page({
      books: loaded([
        month("2026-10", { note: { body: "n", updatedAt: "2026-11-01T00:00:00Z" } }),
        month("2026-09", { surplus: usd(250) }),
      ]),
    });
    const rows = screen.getAllByTestId("transparency-month-row");
    expect(rows.map((r) => [r.tagName, r.getAttribute("data-month"), r.getAttribute("data-surplus")])).toEqual([
      ["TR", "2026-10", "-5320"],
      ["TR", "2026-09", "250"],
    ]);
    expect(rows[0]?.getAttribute("data-noted")).toBe("true");
    const cards = screen.getAllByTestId("transparency-month-card");
    expect(cards.map((c) => c.getAttribute("data-month"))).toEqual(["2026-10", "2026-09"]);
    expect(cards[0]?.textContent).toContain(t("d6Transparency.months.net", { sign: "negative" }));
    expect(cards[1]?.textContent).toContain(t("d6Transparency.months.net", { sign: "other" }));
    expect(cards[0]?.closest('[data-slot="stacked-rows"]')?.className).toContain("sm:hidden");
  });

  it("governance: the 10 most recent decisions, then All decisions", () => {
    const governance = Array.from({ length: 12 }, (_, i) =>
      decided(`p${String(i).padStart(2, "0")}`, `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    page({ books: loaded([month("2026-10", { governance })]) });
    const items = screen.getAllByTestId("transparency-governance");
    expect(items).toHaveLength(10);
    expect(items[0]?.getAttribute("data-proposal-id")).toBe("p11");
    expect(items[9]?.getAttribute("data-proposal-id")).toBe("p02");
    expect(one("transparency-all-decisions").getAttribute("href")).toBe("/coop/proposals");
    expect(one("transparency-all-decisions").parentElement?.textContent).toContain(
      t("d6Transparency.governance.capped", { count: 10 }),
    );
    expect(stat("vote")).not.toBe(t("d6Transparency.numbers.noVote"));
  });

  it("F3: a failed books load is local, with Retry; the strip and fee promise still show", () => {
    const reload = vi.fn<() => void>();
    page({ books: { data: null, failed: true, reload, gaveUp: true } });
    const error = one("transparency-load-error");
    expect(screen.getByTestId("transparency-fee-promise")).toBeTruthy();
    expect(stat("members")).toBe(t("d6Transparency.numbers.unknown"));
    expect(stat("share")).toContain("90%");
    fireEvent.click(within(error).getByRole("button"));
    expect(reload).toHaveBeenCalled();
    expect(screen.queryByTestId("transparency-flow")).toBeNull();
  });

  it("F3: a failed settings load shows Retry in the fee promise and the strip; Retry reloads it", () => {
    const reload = vi.fn<() => void>();
    page({ cut: null, settingsLoad: { failed: true, reload, gaveUp: true } });
    const promise = one("transparency-fee-promise");
    expect(promise.textContent).toContain(t("d6Transparency.fee.unavailable"));
    fireEvent.click(within(one("transparency-fee-error")).getByRole("button"));
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(within(one("transparency-numbers-error")).getByRole("button"));
    expect(reload).toHaveBeenCalledTimes(2);
    // The books loaded: their figures stay.
    expect(stat("members")).toBe("8");
  });

  it("F3: a failed fee schedule load shows Retry in the strip only; one Retry reloads every failed load", () => {
    const settingsReload = vi.fn<() => void>();
    const scheduleReload = vi.fn<() => void>();
    page({ feeChanged: null, scheduleLoad: { failed: true, reload: scheduleReload, gaveUp: true } });
    expect(screen.queryByTestId("transparency-fee-error")).toBeNull();
    fireEvent.click(within(one("transparency-numbers-error")).getByRole("button"));
    expect(scheduleReload).toHaveBeenCalledTimes(1);
    cleanup();
    page({
      cut: null,
      feeChanged: null,
      settingsLoad: { failed: true, reload: settingsReload, gaveUp: true },
      scheduleLoad: { failed: true, reload: scheduleReload, gaveUp: true },
    });
    fireEvent.click(within(one("transparency-numbers-error")).getByRole("button"));
    expect(settingsReload).toHaveBeenCalledTimes(1);
    expect(scheduleReload).toHaveBeenCalledTimes(2);
  });

  it("no Retry while the settings and schedule are only loading, or once they loaded", () => {
    page({ cut: null, feeChanged: null, settingsLoad: { failed: false, reload: vi.fn<() => void>() } });
    expect(screen.queryByTestId("transparency-numbers-error")).toBeNull();
    expect(screen.queryByTestId("transparency-fee-error")).toBeNull();
    cleanup();
    page({ settingsLoad: { failed: true, reload: vi.fn<() => void>() } });
    expect(screen.queryByTestId("transparency-numbers-error")).toBeNull();
    expect(screen.queryByTestId("transparency-fee-error")).toBeNull();
  });

  it("no months yet: the empty state and the commitments", () => {
    page({ books: loaded([]) });
    expect(one("transparency-empty")).toBeTruthy();
    expect(one("transparency-commitments")).toBeTruthy();
    expect(screen.queryByTestId("transparency-month-row")).toBeNull();
  });

  it("the note editor shows only when a save handler is given (treasurers)", () => {
    page();
    expect(screen.queryByTestId("transparency-note-editor")).toBeNull();
    cleanup();
    page({ onSaveNote: vi.fn<(month: string, body: string) => Promise<void>>(async () => undefined) });
    expect(one("transparency-note-editor")).toBeTruthy();
  });
});

describe("HowWeCount", () => {
  it("is the #how-we-count anchor: live, settled, the owner's own viewing, and statements", () => {
    wrap(<HowWeCount />);
    const section = one("transparency-how-we-count");
    expect(section.id).toBe(HOW_WE_COUNT_ID);
    expect(HOW_WE_COUNT_ID).toBe("how-we-count");
    expect([...section.querySelectorAll("[data-part]")].map((p) => p.getAttribute("data-part"))).toEqual([
      "live",
      "settled",
      "owner",
      "statements",
    ]);
    expect(one("transparency-how-verify").getAttribute("href")).toBe("/attestations/verify");
  });
});

describe("MonthNoteEditor", () => {
  const months = [
    { month: "2026-10", note: { body: "Shares cover it." } },
    { month: "2026-09", note: null },
  ];

  it("starts on the newest month with its note; Save is off until the text changes", async () => {
    const onSave = vi.fn<(month: string, body: string) => Promise<void>>(async () => undefined);
    wrap(<MonthNoteEditor months={months} onSave={onSave} />);
    const body = one("transparency-note-body") as HTMLTextAreaElement;
    expect(body.value).toBe("Shares cover it.");
    expect((one("transparency-note-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(body, { target: { value: "Reserves cover it." } });
    expect((one("transparency-note-save") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(one("transparency-note-save"));
    });
    expect(onSave).toHaveBeenCalledWith("2026-10", "Reserves cover it.");
  });

  it("Remove note asks first, then saves an empty note", async () => {
    const onSave = vi.fn<(month: string, body: string) => Promise<void>>(async () => undefined);
    wrap(<MonthNoteEditor months={months} onSave={onSave} />);
    fireEvent.click(one("transparency-note-remove"));
    const dialog = await screen.findByTestId("transparency-note-remove-dialog");
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: t("d6Transparency.note.remove") }));
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("2026-10", ""));
  });

  it("a failed save keeps the draft", async () => {
    const onSave = vi.fn<(month: string, body: string) => Promise<void>>(async () => {
      throw new Error("nope");
    });
    wrap(<MonthNoteEditor months={months} onSave={onSave} />);
    const body = one("transparency-note-body") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Draft" } });
    await act(async () => {
      fireEvent.click(one("transparency-note-save"));
    });
    expect(onSave).toHaveBeenCalled();
    expect((one("transparency-note-body") as HTMLTextAreaElement).value).toBe("Draft");
  });

  it("no months: says so, with no form controls", () => {
    wrap(<MonthNoteEditor months={[]} onSave={vi.fn<(m: string, b: string) => Promise<void>>()} />);
    expect(screen.getByText(t("d6Transparency.note.noMonths"))).toBeTruthy();
    expect(screen.queryByTestId("transparency-note-body")).toBeNull();
  });
});
