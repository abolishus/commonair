// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The one date and time field (F33; merged from the studio's and the admin's): its pure rules
 * (parts, the `YYYY-MM-DDTHH:MM` text, years, minute steps), the parts-controlled field crew uses
 * (5-minute steps, Clear, blur), the text field egress and the legal queue use (every minute,
 * a half-filled date kept), and hours on the locale's own clock (`formatHour`).
 */
import { LocaleProvider, TooltipProvider, formatHour } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DateTimeField, DateTimeTextField } from "../src/components/forms/date-time-field.tsx";
import {
  EMPTY_DATE_TIME,
  HOURS,
  dateTimeIso,
  dateTimeParts,
  dateTimeValue,
  dateTimeYears,
  isEmptyDateTime,
  maxDay,
  minuteOptions,
  upcomingYears,
  withOption,
  withPart,
  type DateTimeParts,
} from "../src/components/forms/date-time.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode, tag: string = locale) {
  return render(
    <LocaleProvider locale={tag} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

async function open(trigger: string): Promise<string[]> {
  fireEvent.click(screen.getByTestId(trigger));
  const options = await screen.findAllByRole("option");
  return options.map((o) => o.textContent ?? "");
}

async function pick(trigger: string, name: string): Promise<void> {
  fireEvent.click(screen.getByTestId(trigger));
  const item = await screen.findByRole("option", { name });
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

const NOW = new Date("2026-11-04T12:00:00.000Z");

// ── The rules ────────────────────────────────────────────────────────────────────────────────

describe("date-time rules", () => {
  it("turns parts into an instant: empty, incomplete, impossible, or ISO", () => {
    expect(dateTimeIso(EMPTY_DATE_TIME)).toEqual({ empty: true });
    expect(dateTimeIso({ ...EMPTY_DATE_TIME, day: 3 })).toEqual({ error: "incomplete" });
    expect(dateTimeIso({ ...EMPTY_DATE_TIME, hour: 3 })).toEqual({ error: "incomplete" });
    expect(dateTimeIso({ day: 31, month: 2, year: 2027, hour: null, minute: null })).toEqual({ error: "invalid" });
    const ok = dateTimeIso({ day: 3, month: 1, year: 2027, hour: 9, minute: 30 });
    expect("iso" in ok && new Date(ok.iso).getHours()).toBe(9);
    expect("iso" in ok && new Date(ok.iso).getMinutes()).toBe(30);
    const midnight = dateTimeIso({ day: 3, month: 1, year: 2027, hour: null, minute: null });
    expect("iso" in midnight && new Date(midnight.iso).getHours()).toBe(0);
    expect(dateTimeIso({ day: 29, month: 2, year: 2028, hour: 0, minute: 0 })).toHaveProperty("iso");
  });

  it("calls a date past the end of the Date range invalid", () => {
    expect(dateTimeIso({ day: 1, month: 1, year: 300_000, hour: 0, minute: 0 })).toEqual({ error: "invalid" });
  });

  it("keeps the day inside the month when the month or year changes", () => {
    const jan31 = { ...EMPTY_DATE_TIME, day: 31, month: 1 };
    // No year yet: February offers 29 (a leap year stands in), so 31 becomes 29.
    expect(withPart(jan31, "month", 2)).toMatchObject({ day: 29, month: 2 });
    expect(withPart({ ...jan31, year: 2027 }, "month", 2)).toMatchObject({ day: 28 });
    expect(withPart({ ...EMPTY_DATE_TIME, day: 29, month: 2, year: 2028 }, "year", 2027)).toMatchObject({ day: 28 });
    expect(withPart(jan31, "month", 3)).toMatchObject({ day: 31 });
    expect(withPart(EMPTY_DATE_TIME, "hour", 7)).toEqual({ ...EMPTY_DATE_TIME, hour: 7 });
    expect(withPart(EMPTY_DATE_TIME, "month", 2)).toEqual({ ...EMPTY_DATE_TIME, month: 2 });
    expect(maxDay(EMPTY_DATE_TIME)).toBe(31);
    expect(maxDay({ year: null, month: 4 })).toBe(30);
    expect(maxDay({ year: null, month: 2 })).toBe(29);
    expect(maxDay({ year: 2027, month: 2 })).toBe(28);
  });

  it("knows an empty field from a started one", () => {
    expect(isEmptyDateTime(EMPTY_DATE_TIME)).toBe(true);
    expect(isEmptyDateTime({ ...EMPTY_DATE_TIME, minute: 0 })).toBe(false);
    expect(isEmptyDateTime({ ...EMPTY_DATE_TIME, hour: 0 })).toBe(false);
  });

  it("parses and writes the datetime-local shape", () => {
    expect(dateTimeParts("2026-10-01T06:30")).toEqual({ year: 2026, month: 10, day: 1, hour: 6, minute: 30 });
    expect(dateTimeParts("2026-10-01T06:30:15")).toEqual({ year: 2026, month: 10, day: 1, hour: 6, minute: 30 });
    expect(dateTimeParts("")).toEqual(EMPTY_DATE_TIME);
    expect(dateTimeParts("yesterday")).toEqual(EMPTY_DATE_TIME);
    expect(dateTimeValue({ year: 2026, month: 3, day: 5, hour: 0, minute: 7 })).toBe("2026-03-05T00:07");
    expect(dateTimeValue({ ...EMPTY_DATE_TIME, year: 2026 })).toBe("");
    expect(dateTimeValue({ year: 2026, month: 1, day: 1, hour: 0, minute: null })).toBe("");
  });

  it("clamps the day to the month in the text (leap years included)", () => {
    expect(dateTimeValue({ year: 2026, month: 2, day: 31, hour: 1, minute: 0 })).toBe("2026-02-28T01:00");
    expect(dateTimeValue({ year: 2028, month: 2, day: 31, hour: 1, minute: 0 })).toBe("2028-02-29T01:00");
    expect(dateTimeValue({ year: 2026, month: 4, day: 31, hour: 23, minute: 59 })).toBe("2026-04-30T23:59");
  });

  it("offers recent years newest first, or upcoming years oldest first", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(dateTimeYears(now)).toEqual([2026, 2025, 2024]);
    expect(dateTimeYears(now, 1, 1)).toEqual([2027, 2026, 2025]);
    expect(upcomingYears(new Date(2026, 5, 1))).toEqual([2026, 2027, 2028, 2029, 2030, 2031]);
  });

  it("adds a value outside the list, keeping the list's own order", () => {
    expect(withOption([2026, 2025, 2024], 2020)).toEqual([2026, 2025, 2024, 2020]);
    expect(withOption([2026, 2025, 2024], 2027)).toEqual([2027, 2026, 2025, 2024]);
    expect(withOption([2026, 2025, 2024], 2025)).toEqual([2026, 2025, 2024]);
    expect(withOption([2026, 2025, 2024], null)).toEqual([2026, 2025, 2024]);
    expect(withOption([2026, 2027, 2028], 2020)).toEqual([2020, 2026, 2027, 2028]);
    expect(withOption([0, 5, 10], 7)).toEqual([0, 5, 7, 10]);
    expect(withOption([], 3)).toEqual([3]);
  });

  it("steps the minutes by a divisor of the hour", () => {
    expect(minuteOptions(1)).toHaveLength(60);
    expect(minuteOptions(5)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(minuteOptions(15)).toEqual([0, 15, 30, 45]);
    expect(minuteOptions(60)).toEqual([0]);
    for (const bad of [0, -5, 7, 1.5, 61, Number.NaN])
      expect(() => minuteOptions(bad), String(bad)).toThrow(RangeError);
    expect(HOURS).toHaveLength(24);
  });
});

// ── The parts field (crew) ───────────────────────────────────────────────────────────────────

function PartsHarness({
  minuteStep,
  onValue,
  initial = EMPTY_DATE_TIME,
}: {
  minuteStep?: number;
  onValue?: (v: DateTimeParts) => void;
  initial?: DateTimeParts;
}) {
  const [value, setValue] = React.useState(initial);
  return (
    <DateTimeField
      data-testid="dt"
      legend="Starts"
      hint="Optional."
      value={value}
      years={[2026, 2027]}
      minuteStep={minuteStep}
      clearable
      onValueChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
    />
  );
}

describe("DateTimeField (parts)", () => {
  it("is design-system selects in the locale's date order, not a native input", () => {
    wrap(<PartsHarness />);
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    const field = screen.getByTestId("dt");
    expect(field.tagName).toBe("FIELDSET");
    expect(field.getAttribute("data-order")).toBe("month,day,year");
    for (const part of ["day", "month", "year", "hour", "minute"])
      expect(screen.getByTestId(`dt-${part}`).getAttribute("role")).toBe("combobox");
    expect(field.textContent).toContain("Optional.");
  });

  it("labels the hours on the locale's own clock", async () => {
    wrap(<PartsHarness />);
    const hours = await open("dt-hour");
    expect(hours).toEqual(HOURS.map((h) => formatHour(h, "en")));
    expect(hours[0]?.replace(/\s/g, " ")).toBe("12 AM");
    expect(hours[15]?.replace(/\s/g, " ")).toBe("3 PM");
  });

  it("in Spanish, a 24-hour clock", async () => {
    wrap(<PartsHarness />, "es");
    const hours = await open("dt-hour");
    expect(hours).toEqual(HOURS.map(String));
  });

  it("offers the step's minutes, and still shows a value off the step", async () => {
    wrap(<PartsHarness minuteStep={5} initial={{ ...EMPTY_DATE_TIME, minute: 7 }} />);
    expect(screen.getByTestId("dt").getAttribute("data-minute-step")).toBe("5");
    expect(screen.getByTestId("dt-minute").textContent).toContain("07");
    const minutes = await open("dt-minute");
    expect(minutes).toEqual(["00", "05", "07", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"]);
  });

  it("every minute by default", async () => {
    wrap(<PartsHarness />);
    expect(await open("dt-minute")).toHaveLength(60);
  });

  it("chooses parts, clears them, and hides Clear while empty", async () => {
    const onValue = vi.fn<(v: DateTimeParts) => void>();
    wrap(<PartsHarness minuteStep={5} onValue={onValue} />);
    expect(screen.queryByTestId("dt-clear")).toBeNull();
    await pick("dt-month", "January");
    await pick("dt-hour", formatHour(9, "en"));
    await pick("dt-minute", "30");
    expect(onValue).toHaveBeenLastCalledWith({ ...EMPTY_DATE_TIME, month: 1, hour: 9, minute: 30 });
    fireEvent.click(screen.getByTestId("dt-clear"));
    expect(onValue).toHaveBeenLastCalledWith(EMPTY_DATE_TIME);
    expect(screen.queryByTestId("dt-clear")).toBeNull();
  });

  it("describes the fieldset by the hint and the error, and marks the selects invalid", () => {
    wrap(
      <DateTimeField
        data-testid="dt"
        legend="Starts"
        hint="Optional."
        error="Choose a day."
        value={EMPTY_DATE_TIME}
        onValueChange={() => undefined}
        years={[2026]}
      />,
    );
    const ids = (screen.getByTestId("dt").getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(["Optional.", "Choose a day."]);
    expect(screen.getByTestId("dt-day").getAttribute("aria-invalid")).toBe("true");
  });

  it("reports a blur when focus leaves the field, not when it moves between its own selects", () => {
    const onBlur = vi.fn<() => void>();
    wrap(
      <>
        <DateTimeField
          data-testid="dt"
          legend="Starts"
          value={EMPTY_DATE_TIME}
          onValueChange={() => undefined}
          onBlur={onBlur}
          years={[2026]}
        />
        <button type="button" data-testid="outside">
          Outside
        </button>
      </>,
    );
    fireEvent.focusOut(screen.getByTestId("dt-day"), { relatedTarget: screen.getByTestId("dt-month") });
    expect(onBlur).not.toHaveBeenCalled();
    fireEvent.focusOut(screen.getByTestId("dt-day"), { relatedTarget: screen.getByTestId("outside") });
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("stays inside while focus is in its own select popup, not another field's", async () => {
    const onBlur = vi.fn<() => void>();
    wrap(
      <>
        <DateTimeField
          data-testid="dt"
          legend="Starts"
          value={EMPTY_DATE_TIME}
          onValueChange={() => undefined}
          onBlur={onBlur}
          years={[2026]}
        />
        <div data-slot="select-content" data-field="someone-else">
          <button type="button" data-testid="foreign">
            Foreign
          </button>
        </div>
      </>,
    );
    fireEvent.click(screen.getByTestId("dt-hour"));
    const own = await screen.findAllByRole("option");
    fireEvent.focusOut(screen.getByTestId("dt-day"), { relatedTarget: own[0] });
    expect(onBlur).not.toHaveBeenCalled();
    fireEvent.focusOut(screen.getByTestId("dt-day"), { relatedTarget: screen.getByTestId("foreign") });
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});

describe("DateTimeField without a test id or a hint", () => {
  it("marks the selects invalid for a range error shown elsewhere, with nothing to describe it", () => {
    wrap(
      <DateTimeField
        legend="From"
        invalid
        clearable
        value={{ year: 2026, month: 1, day: 2, hour: 3, minute: 4 }}
        onValueChange={() => undefined}
        years={[2026]}
      />,
    );
    const field = document.querySelector("fieldset") as HTMLFieldSetElement;
    expect(field.getAttribute("aria-describedby")).toBeNull();
    expect(field.getAttribute("data-testid")).toBeNull();
    expect(field.getAttribute("data-value")).toBe("2026-01-02T03:04");
    const selects = screen.getAllByRole("combobox");
    expect(selects).toHaveLength(5);
    for (const s of selects) {
      expect(s.getAttribute("aria-invalid")).toBe("true");
      expect(s.getAttribute("data-testid")).toBeNull();
    }
    expect(screen.queryByRole("alert")).toBeNull();
    const clear = screen.getByRole("button", { name: t("time.field.clear") });
    expect(clear.getAttribute("data-testid")).toBeNull();
  });

  it("is valid and has no Clear by default", () => {
    wrap(
      <DateTimeField
        legend="From"
        value={{ year: 2026, month: 1, day: 2, hour: 3, minute: 4 }}
        onValueChange={() => undefined}
        years={[2026]}
      />,
    );
    for (const s of screen.getAllByRole("combobox")) expect(s.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("button", { name: t("time.field.clear") })).toBeNull();
  });
});

// ── The text field (egress, legal) ───────────────────────────────────────────────────────────

describe("DateTimeTextField", () => {
  function Harness({ initial, onValue }: { initial: string; onValue: (v: string) => void }) {
    const [value, setValue] = React.useState(initial);
    return (
      <DateTimeTextField
        data-testid="when"
        legend="Filed at"
        hint="In your own time zone."
        value={value}
        now={NOW}
        onValueChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
    );
  }

  it("emits the value only once every part is chosen, and keeps a half-filled date", async () => {
    const onValue = vi.fn<(v: string) => void>();
    wrap(<Harness initial="" onValue={onValue} />);
    expect(screen.queryByTestId("when-clear")).toBeNull();
    await pick("when-year", "2026");
    await pick("when-month", "February");
    await pick("when-day", "28");
    await pick("when-hour", formatHour(9, "en"));
    expect(onValue).toHaveBeenLastCalledWith("");
    expect(screen.getByTestId("when-month").textContent).toContain("February");
    await pick("when-minute", "01");
    expect(onValue).toHaveBeenLastCalledWith("2026-02-28T09:01");
    expect(screen.getByTestId("when").dataset.value).toBe("2026-02-28T09:01");
  });

  it("offers recent years by default, and the year of a value outside them", async () => {
    wrap(<Harness initial="2019-06-15T08:30" onValue={() => {}} />);
    expect(screen.getByTestId("when-year").textContent).toContain("2019");
    expect(screen.getByTestId("when").dataset.value).toBe("2019-06-15T08:30");
    expect(await open("when-year")).toEqual(["2026", "2025", "2024", "2019"]);
  });

  it("shows a value from outside and pulls the day back when the month gets shorter", async () => {
    const onValue = vi.fn<(v: string) => void>();
    wrap(<Harness initial="2026-03-31T23:59" onValue={onValue} />);
    expect(screen.getByTestId("when-day").textContent).toContain("31");
    expect(screen.getByTestId("when-hour").textContent).toContain(formatHour(23, "en"));
    expect(screen.getByTestId("when-minute").textContent).toContain("59");
    await pick("when-month", "April");
    expect(onValue).toHaveBeenLastCalledWith("2026-04-30T23:59");
  });

  it("follows a reset from outside", () => {
    const { rerender } = wrap(
      <DateTimeTextField
        data-testid="when"
        legend="From"
        value="2026-10-01T06:30"
        onValueChange={() => {}}
        now={NOW}
      />,
    );
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <DateTimeTextField
            data-testid="when"
            legend="From"
            value="2025-01-02T03:04"
            onValueChange={() => {}}
            now={NOW}
          />
        </TooltipProvider>
      </LocaleProvider>,
    );
    expect(screen.getByTestId("when").dataset.value).toBe("2025-01-02T03:04");
    expect(screen.getByTestId("when-year").textContent).toContain("2025");
    expect(screen.getByTestId("when-minute").textContent).toContain("04");
  });

  it("keeps its parts when the page passes back the same instant in other words", () => {
    const view = wrap(
      <DateTimeTextField
        data-testid="when"
        legend="From"
        value="2026-10-01T06:30:45"
        onValueChange={() => {}}
        now={NOW}
      />,
    );
    view.rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <DateTimeTextField
            data-testid="when"
            legend="From"
            value="2026-10-01T06:30"
            onValueChange={() => {}}
            now={NOW}
          />
        </TooltipProvider>
      </LocaleProvider>,
    );
    expect(screen.getByTestId("when").dataset.value).toBe("2026-10-01T06:30");
    expect(screen.getByTestId("when-day").textContent).toContain("1");
    expect(screen.getByTestId("when-minute").textContent).toContain("30");
  });
});
