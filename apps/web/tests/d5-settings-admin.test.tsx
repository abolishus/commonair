// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-settings admin slips: integrity flag codes and detail keys read as catalogued labels with the
 * raw code kept small (F34); sizes read "0 B", never "0 byte" (F34); the design-system date and
 * time field replaces `datetime-local` on egress and the legal queue (F33); the treasury's payments
 * are stacked rows at phone width, each with its amount, status and Confirm (F31).
 */
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { IntegrityFlagDto } from "../src/components/admin/client.ts";
import {
  DateTimeField,
  EMPTY_DATE_TIME,
  dateTimeParts,
  dateTimeValue,
  dateTimeYears,
} from "../src/components/admin/date-time-field.tsx";
import { EgressResult } from "../src/components/admin/egress.tsx";
import { FlagList } from "../src/components/admin/integrity.tsx";
import { detailLabel, formatSize, signalLabel } from "../src/components/admin/labels.ts";
import { NARROW_QUERY } from "../src/components/admin/use-narrow.ts";
import { PaymentCards, PaymentsPanel } from "../src/components/money/treasury.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { TreasurerPaymentDto } from "../src/lib/money.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WEB = join(import.meta.dirname, "..");

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <NowProvider now={Date.parse("2026-11-04T12:00:00.000Z")}>
        <TooltipProvider>{node}</TooltipProvider>
      </NowProvider>
    </LocaleProvider>,
  );
}

async function pick(trigger: string, name: string): Promise<void> {
  fireEvent.click(screen.getByTestId(trigger));
  const item = await screen.findByRole("option", { name });
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

// ── F34: integrity labels ────────────────────────────────────────────────────────────────────

const SIGNALS = [
  "datacenter_ip",
  "device_concurrency",
  "account_concurrency",
  "headless",
  "heartbeat_inconsistent",
  "fetch_pattern",
  "privacy_relay",
  "chat_viewer_anomaly",
  "follow_burst",
  "raid_overstated",
  "relay_over_report",
  "relay_suspended",
  "relay_issuance_unknown",
];

const relayFlag: IntegrityFlagDto = {
  id: "0192f000-0000-7000-8000-0000000000f2",
  subjectType: "relay",
  subjectId: "0192f000-0000-7000-8000-0000000000r1",
  signal: "relay_issuance_unknown",
  score: 0,
  details: {
    receiptId: "0192f000-0000-7000-8000-0000000000c1",
    tolerance: 0.05,
    gapMinutes: 12,
    bytesIssued: 0,
    bytesReported: 2_500_000,
    bytesVerified: 512,
    futureKey: "x",
  },
  decision: "pending_review",
  createdAt: "2026-11-04T11:00:00.000Z",
};

describe("integrity labels (F34)", () => {
  it.each(SIGNALS)("%s has a catalogued title and description", (code) => {
    const label = signalLabel(code);
    expect(label?.label).toBeTruthy();
    expect(label?.description).toBeTruthy();
    expect(label?.label).not.toBe(code);
  });

  it("covers every signal code the integrity package writes", () => {
    const types = readFileSync(join(WEB, "../../packages/integrity/src/types.ts"), "utf8");
    const codes = [...types.matchAll(/(?:SESSION|CHANNEL|RELAY)_SIGNALS = \[([^\]]*)\]/g)].flatMap((m) =>
      [...(m[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1]),
    );
    expect(codes.length).toBeGreaterThan(10);
    expect([...codes].sort((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(
      [...SIGNALS].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("an unknown code or key has no label (the raw text shows instead)", () => {
    expect(signalLabel("brand_new_signal")).toBeNull();
    expect(signalLabel("toString")).toBeNull();
    expect(detailLabel("futureKey")).toBeNull();
    expect(detailLabel("constructor")).toBeNull();
    expect(detailLabel("gapMinutes")).toBe(t("settings.integrity.detail.gapMinutes"));
  });

  it("the card shows the label as its title, the code small, labelled keys and formatted bytes", () => {
    wrap(<FlagList flags={[relayFlag]} failed={false} onRetry={() => {}} onDecide={async () => {}} />);
    const card = screen.getByTestId("integrityq-item");
    expect(within(card).getByRole("heading", { level: 2 }).textContent).toContain(
      t("settings.integrity.signal.relayIssuanceUnknown"),
    );
    expect(within(card).getByTestId("integrityq-signal-code").textContent).toBe("relay_issuance_unknown");
    expect(card.textContent).toContain(t("settings.integrity.signal.relayIssuanceUnknown.hint"));
    const keys = within(card).getAllByTestId("integrityq-detail-label");
    const gap = keys.find((k) => k.dataset.key === "gapMinutes");
    expect(gap?.textContent).toContain(t("settings.integrity.detail.gapMinutes"));
    expect(gap?.textContent).toContain("gapMinutes");
    const unknown = keys.find((k) => k.dataset.key === "futureKey");
    expect(unknown?.textContent).toBe("futureKey");
    expect(card.textContent).toContain("2.5 MB");
    expect(card.textContent).toContain("512 B");
    expect(card.textContent).toContain("0 B");
    expect(card.textContent).not.toMatch(/\d byte/);
    // Not bytes: plain numbers.
    expect(card.textContent).toContain("0.05");
  });
});

// ── F34: sizes ───────────────────────────────────────────────────────────────────────────────

describe("formatSize (F34)", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [999, "999 B"],
    [1000, "1 kB"],
    [1500, "1.5 kB"],
    [2_500_000, "2.5 MB"],
    [-5, "0 B"],
    [Number.NaN, "0 B"],
    [Number.POSITIVE_INFINITY, "0 B"],
    [12.6, "13 B"],
  ])("%s → %s", (bytes, text) => {
    expect(formatSize(bytes, "en")).toBe(text);
  });

  it("is locale-aware", () => {
    expect(formatSize(1500, "de")).toBe("1,5 kB");
    expect(formatSize(0, "es")).toBe("0 B");
  });

  it("egress totals use it", () => {
    wrap(
      <EgressResult
        failed={false}
        onRetry={() => {}}
        report={{
          from: "2026-11-03T12:00:00.000Z",
          to: "2026-11-04T12:00:00.000Z",
          totals: { origin: 0, relay: 1500, p2p: 0, cdn: 0 },
          byBroadcast: [],
        }}
      />,
    );
    const totals = screen.getAllByTestId("egress-total").map((e) => e.textContent ?? "");
    expect(totals.some((x) => x.includes("0 B"))).toBe(true);
    expect(totals.some((x) => x.includes("1.5 kB"))).toBe(true);
    expect(totals.join(" ")).not.toContain("byte");
  });
});

// ── F33: the date and time field ─────────────────────────────────────────────────────────────

describe("date-time parts", () => {
  it("parses and writes the datetime-local shape", () => {
    expect(dateTimeParts("2026-10-01T06:30")).toEqual({ year: 2026, month: 10, day: 1, hour: 6, minute: 30 });
    expect(dateTimeParts("2026-10-01T06:30:15")).toEqual({ year: 2026, month: 10, day: 1, hour: 6, minute: 30 });
    expect(dateTimeParts("")).toEqual(EMPTY_DATE_TIME);
    expect(dateTimeParts("yesterday")).toEqual(EMPTY_DATE_TIME);
    expect(dateTimeValue({ year: 2026, month: 3, day: 5, hour: 0, minute: 7 })).toBe("2026-03-05T00:07");
    expect(dateTimeValue({ ...EMPTY_DATE_TIME, year: 2026 })).toBe("");
    expect(dateTimeValue({ year: 2026, month: 1, day: 1, hour: 0, minute: null })).toBe("");
  });

  it("clamps the day to the month (leap years included)", () => {
    expect(dateTimeValue({ year: 2026, month: 2, day: 31, hour: 1, minute: 0 })).toBe("2026-02-28T01:00");
    expect(dateTimeValue({ year: 2028, month: 2, day: 31, hour: 1, minute: 0 })).toBe("2028-02-29T01:00");
    expect(dateTimeValue({ year: 2026, month: 4, day: 31, hour: 23, minute: 59 })).toBe("2026-04-30T23:59");
  });

  it("offers recent years, newest first", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(dateTimeYears(now)).toEqual([2026, 2025, 2024]);
    expect(dateTimeYears(now, 1, 1)).toEqual([2027, 2026, 2025]);
  });
});

describe("DateTimeField (F33)", () => {
  function Harness({ initial, onValue }: { initial: string; onValue: (v: string) => void }) {
    const [value, setValue] = React.useState(initial);
    return (
      <DateTimeField
        data-testid="when"
        label="Filed at"
        description="In your own time zone."
        value={value}
        now={new Date("2026-11-04T12:00:00.000Z")}
        onValueChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
    );
  }

  it("is design-system selects, not a native datetime input", () => {
    wrap(<Harness initial="" onValue={() => {}} />);
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    const field = screen.getByTestId("when");
    expect(field.tagName).toBe("FIELDSET");
    for (const part of ["day", "month", "year", "hour", "minute"])
      expect(screen.getByTestId(`when-${part}`).getAttribute("role")).toBe("combobox");
    expect(field.textContent).toContain("In your own time zone.");
  });

  it("emits the value only once every part is chosen, and keeps a half-filled date", async () => {
    const onValue = vi.fn<(v: string) => void>();
    wrap(<Harness initial="" onValue={onValue} />);
    await pick("when-year", "2026");
    await pick("when-month", "February");
    await pick("when-day", "28");
    await pick("when-hour", "09");
    expect(onValue).toHaveBeenLastCalledWith("");
    expect(screen.getByTestId("when-month").textContent).toContain("February");
    await pick("when-minute", "05");
    expect(onValue).toHaveBeenLastCalledWith("2026-02-28T09:05");
    expect(screen.getByTestId("when").dataset.value).toBe("2026-02-28T09:05");
  });

  it("shows a value from outside and pulls the day back when the month gets shorter", async () => {
    const onValue = vi.fn<(v: string) => void>();
    wrap(<Harness initial="2026-03-31T23:59" onValue={onValue} />);
    expect(screen.getByTestId("when-day").textContent).toContain("31");
    expect(screen.getByTestId("when-hour").textContent).toContain("23");
    await pick("when-month", "April");
    expect(onValue).toHaveBeenLastCalledWith("2026-04-30T23:59");
  });

  it("egress and the legal queue use it, with no native datetime-local left", () => {
    for (const file of ["src/components/admin/egress.tsx", "src/components/safety/legal.tsx"]) {
      const text = readFileSync(join(WEB, file), "utf8");
      expect(text, file).toContain("<DateTimeField");
      expect(text, file).not.toContain('type="datetime-local"');
    }
    // The UTC note stays on egress.
    expect(readFileSync(join(WEB, "src/components/admin/egress.tsx"), "utf8")).toContain('"admin.egress.rangeHint"');
  });
});

// ── F31: the treasury's stacked rows ─────────────────────────────────────────────────────────

const usd = (cents: number) => ({ cents, currency: "usd" });
const payment = (id: string, over: Partial<TreasurerPaymentDto> = {}): TreasurerPaymentDto => ({
  paymentId: `0192f000-0000-7000-8000-${id.padStart(12, "0")}`,
  reference: `CA-${id.toUpperCase().padEnd(8, "0")}`,
  kind: "subscription",
  status: "pending",
  amount: usd(1000),
  refunded: usd(0),
  tier: 2,
  quantity: 1,
  user: null,
  channelSlug: "rivertide",
  createdAt: "2026-11-01T12:00:00.000Z",
  succeededAt: null,
  expiresAt: null,
  ...over,
});

function narrowScreen(narrow: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === NARROW_QUERY ? narrow : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

describe("treasury payments at 375 px (F31)", () => {
  const panel = () => (
    <PaymentsPanel
      payments={[payment("1"), payment("2", { status: "succeeded", amount: usd(2500) })]}
      search=""
      onSearchChange={() => {}}
      onConfirm={async () => {}}
      onDispute={async () => {}}
    />
  );

  it("stacked rows on a phone: amount, status and Confirm on each row, the same row ids", () => {
    narrowScreen(true);
    wrap(panel());
    expect(document.querySelector("table")).toBeNull();
    const rows = screen.getAllByTestId("treasury-payment-row");
    expect(rows.map((r) => r.tagName)).toEqual(["LI", "LI"]);
    expect(rows[0]?.dataset).toMatchObject({ reference: "CA-10000000", status: "pending", cents: "1000" });
    expect(rows[0]?.textContent).toContain("$10.00");
    expect(rows[1]?.textContent).toContain("$25.00");
    expect(within(rows[0] as HTMLElement).getByTestId("treasury-confirm")).toBeTruthy();
    expect(rows[0]?.textContent).toContain(t("treasury.payments.to", { channel: "rivertide" }));
  });

  it("the table from sm up", () => {
    narrowScreen(false);
    wrap(panel());
    expect(document.querySelector("table")).not.toBeNull();
    expect(screen.getAllByTestId("treasury-payment-row").map((r) => r.tagName)).toEqual(["TR", "TR"]);
  });

  it("stacked rows load, empty and page like the table", async () => {
    const more = vi.fn<() => void>();
    const props = { caption: "Pending", onConfirm: async () => {}, onDispute: async () => {}, empty: <p>none</p> };
    const { rerender } = wrap(<PaymentCards payments={null} {...props} />);
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <PaymentCards payments={[]} {...props} />
      </LocaleProvider>,
    );
    expect(screen.getByText("none")).toBeTruthy();
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <PaymentCards
            payments={[payment("3")]}
            {...props}
            footer={
              <button type="button" onClick={more}>
                more
              </button>
            }
          />
        </TooltipProvider>
      </LocaleProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("more"));
    });
    expect(more).toHaveBeenCalled();
    expect(screen.getByTestId("treasury-payment-cards").getAttribute("aria-label")).toBe("Pending");
  });
});
