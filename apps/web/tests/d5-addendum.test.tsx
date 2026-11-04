// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-studio, the signed-in pass's findings: F29 (the page header stacks its actions under the
 * title on phones and never breaks a title mid-word), F31 (the revenue ledger and the bot's
 * commands render as stacked rows below `sm`, with the amount or actions on each row), F32 (tier
 * errors after blur or submit, never on mount) and F33 (crew's window is the design-system date
 * and time field, not `datetime-local`).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandsPanel } from "../src/components/bot-studio/commands-panel.tsx";
import type { StudioApi } from "../src/components/interact-studio/shared.tsx";
import { CrewProposeForm } from "../src/components/money/crew.tsx";
import { RevenueLedger, TierEditor } from "../src/components/money/revenue.tsx";
import { EMPTY_DATE_TIME, dateTimeIso, upcomingYears } from "../src/components/studio/date-time.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { BotCommandDto } from "../src/lib/bot-studio.ts";
import type { RevenueLineDto } from "../src/lib/money.ts";

afterEach(cleanup);

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

describe("F29: the page header on a phone", () => {
  it("stacks the actions under the title below sm and puts them beside it from sm", () => {
    const { container } = wrap(
      <PageHeader
        title="Stream manager"
        description="Your stream at a glance."
        actions={
          <>
            <Button size="sm">One</Button>
            <Button size="sm">Two</Button>
            <Button size="sm">Three</Button>
          </>
        }
      />,
    );
    const row = container.querySelector('[data-slot="page-header-row"]');
    expect(classes(row)).toEqual(expect.arrayContaining(["flex-col", "sm:flex-row", "sm:flex-wrap"]));
    expect(classes(row)).not.toContain("flex-wrap");
    // The title column is never squeezed under 16rem beside the actions; the actions follow it.
    const title = container.querySelector('[data-slot="page-header-title"]');
    expect(classes(title)).toEqual(expect.arrayContaining(["sm:basis-64", "sm:flex-1"]));
    const actions = container.querySelector('[data-slot="page-header-actions"]');
    expect(title?.nextElementSibling).toBe(actions);
    expect(classes(actions)).not.toContain("shrink-0");
  });

  it("wraps the title between words: balanced, no hyphenation, never break-all", () => {
    wrap(<PageHeader title="Creator dashboard" description="x" />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(classes(h1)).toEqual(expect.arrayContaining(["text-balance", "hyphens-none"]));
    expect(classes(h1)).not.toContain("break-all");
  });
});

describe("F31: stacked rows below sm", () => {
  const line = (id: string, net: number, paymentId: string | null): RevenueLineDto =>
    ({
      id,
      type: "tip",
      occurredAt: "2026-11-01T10:00:00.000Z",
      from: { displayName: "Pip" },
      tier: null,
      quantity: 1,
      reference: null,
      gross: { cents: net + 100, currency: "usd" },
      deductions: { cents: -100, currency: "usd" },
      net: { cents: net, currency: "usd" },
      paymentId,
    }) as unknown as RevenueLineDto;

  it("the ledger shows a table from sm and stacked rows with the net and the breakdown below it", () => {
    const { container } = wrap(
      <RevenueLedger
        lines={[line("l1", 900, "p1"), line("l2", 400, null)]}
        hasMore
        loadingMore={false}
        onLoadMore={() => undefined}
        downloading={false}
        onDownload={() => undefined}
      />,
    );
    const stacked = container.querySelector('[data-slot="stacked-rows"]');
    expect(classes(stacked)).toContain("sm:hidden");
    const table = container.querySelector("table")?.closest('[class*="hidden"]');
    expect(classes(table ?? null)).toEqual(expect.arrayContaining(["hidden", "sm:block"]));
    const rows = within(stacked as HTMLElement).getAllByTestId("revenue-ledger-stacked-row");
    expect(rows.map((r) => r.getAttribute("data-net"))).toEqual(["900", "400"]);
    expect(rows[0]?.querySelector('[data-slot="money-amount"]')).not.toBeNull();
    expect(rows[0]?.querySelector("button")).not.toBeNull();
    expect(rows[1]?.querySelector("button")).toBeNull();
    // Load more is under the list too, with its own id so the two never collide.
    expect(within(stacked as HTMLElement).getByTestId("revenue-ledger-more-stacked")).toBeTruthy();
    expect(screen.getAllByTestId("revenue-ledger-more")).toHaveLength(1);
    expect(screen.getAllByTestId("revenue-ledger-row")).toHaveLength(2);
  });

  it("an empty or loading ledger is the table alone (one empty state, one skeleton)", () => {
    const { container } = wrap(
      <RevenueLedger
        lines={null}
        hasMore={false}
        loadingMore={false}
        onLoadMore={() => undefined}
        downloading={false}
        onDownload={() => undefined}
      />,
    );
    expect(container.querySelector('[data-slot="stacked-rows"]')).toBeNull();
  });

  it("the bot's commands keep uses, status and the edit and remove actions on each stacked row", () => {
    const command: BotCommandDto = {
      id: "01900000-0000-7000-8000-0000000000c1",
      name: "discord",
      aliases: ["dc"],
      response: "join us",
      userLevel: "everyone",
      cooldownSeconds: 30,
      costPoints: 0,
      enabled: true,
      useCount: 1234,
    };
    const { container } = wrap(
      <CommandsPanel
        channel="aurora"
        initial={[command]}
        client={{ bot: { commands: {} } } as unknown as StudioApi}
        canEdit
      />,
    );
    const row = container.querySelector('[data-testid="command-stacked-row"]');
    expect(row?.closest('[data-slot="stacked-rows"]')).not.toBeNull();
    expect(row?.textContent).toContain("!discord");
    expect(row?.textContent).toContain("1,234");
    expect(row?.textContent).toContain("On");
    expect(row?.querySelector('[data-testid="command-edit-stacked"]')).not.toBeNull();
    expect(row?.querySelector('[data-testid="command-remove-stacked"]')).not.toBeNull();
    expect(screen.getAllByTestId("command-edit")).toHaveLength(1);
  });
});

describe("F32: tier errors wait for blur or submit", () => {
  const usd = (cents: number) => ({ cents, currency: "usd" });
  const blank = [
    { tier: 1 as const, name: "", price: usd(500), benefits: "" },
    { tier: 2 as const, name: "", price: usd(1000), benefits: "" },
    { tier: 3 as const, name: "", price: usd(2500), benefits: "" },
  ];
  const errors = () => document.querySelectorAll('[data-slot="field-error"]');

  it("shows no error on mount, even with every name empty", () => {
    wrap(<TierEditor tiers={blank} currency="usd" onSave={async (t) => t} />);
    expect(errors()).toHaveLength(0);
    expect(screen.getByTestId("revenue-tier-name-1").hasAttribute("aria-invalid")).toBe(false);
  });

  it("shows a field's error once it is left, and only that field's", () => {
    wrap(<TierEditor tiers={blank} currency="usd" onSave={async (t) => t} />);
    fireEvent.blur(screen.getByTestId("revenue-tier-name-2"));
    expect(errors()).toHaveLength(1);
    expect(screen.getByTestId("revenue-tier-name-2").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("revenue-tier-name-1").hasAttribute("aria-invalid")).toBe(false);
  });

  it("submitting shows every error and does not save", async () => {
    const onSave = vi.fn<React.ComponentProps<typeof TierEditor>["onSave"]>(async (t) => t);
    wrap(<TierEditor tiers={blank} currency="usd" onSave={onSave} />);
    // Not disabled: the button is how a newcomer finds out what is missing.
    expect(screen.getByTestId("revenue-tiers-save").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("revenue-tiers-save"));
    await waitFor(() => expect(errors().length).toBeGreaterThanOrEqual(3));
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("F33: crew's window uses the design-system date and time field", () => {
  it("renders selects, not a datetime-local input", () => {
    const { container } = wrap(
      <CrewProposeForm
        currency="usd"
        streamerShare={0.9}
        onPropose={async () => undefined}
        now={Date.parse("2026-11-04T12:00:00.000Z")}
      />,
    );
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
    for (const id of ["crew-starts", "crew-ends"]) {
      const field = screen.getByTestId(id);
      expect(field.tagName).toBe("FIELDSET");
      for (const part of ["day", "month", "year", "hour", "minute"])
        expect(screen.getByTestId(`${id}-${part}`)).toBeTruthy();
      expect(field.getAttribute("data-order")).toBe("month,day,year");
    }
  });

  it("turns parts into an instant: empty, incomplete, impossible, or ISO", () => {
    expect(dateTimeIso(EMPTY_DATE_TIME)).toEqual({ empty: true });
    expect(dateTimeIso({ ...EMPTY_DATE_TIME, day: 3 })).toEqual({ error: "incomplete" });
    expect(dateTimeIso({ day: 31, month: 2, year: 2027, hour: null, minute: null })).toEqual({ error: "invalid" });
    const ok = dateTimeIso({ day: 3, month: 1, year: 2027, hour: 9, minute: 30 });
    expect("iso" in ok && new Date(ok.iso).getHours()).toBe(9);
    expect("iso" in ok && new Date(ok.iso).getMinutes()).toBe(30);
    const midnight = dateTimeIso({ day: 3, month: 1, year: 2027, hour: null, minute: null });
    expect("iso" in midnight && new Date(midnight.iso).getHours()).toBe(0);
    expect(dateTimeIso({ day: 29, month: 2, year: 2028, hour: 0, minute: 0 })).toHaveProperty("iso");
  });

  it("offers this year and the next five", () => {
    expect(upcomingYears(new Date(2026, 5, 1))).toEqual([2026, 2027, 2028, 2029, 2030, 2031]);
  });
});
