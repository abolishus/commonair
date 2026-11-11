// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5 schedule, the web's pure rules (`components/schedule/model.ts`): calendar links,
 * time zones, the editor's draft to and from `channels.schedule.*`, skips, checks, and About's
 * weekly rows in the viewer's zone. Expectations use the same local clock as the code, so they
 * hold in any runner time zone.
 */
import { SCHEDULE_RULES } from "@commonair/contracts/enums";
import { describe, expect, it } from "vite-plus/test";
import {
  browserTimeZone,
  comingUp,
  draftChanged,
  draftErrors,
  draftFromSchedule,
  draftToInput,
  durationOptions,
  fromLocalInput,
  liveSkips,
  localHhmm,
  localIsoWeekday,
  newOneOff,
  newSlot,
  nextStreamIcsPath,
  oneOffRoom,
  scheduleFeedPath,
  timeZoneLabel,
  timeZoneOptions,
  TIME_ZONES,
  toggleSkip,
  toLocalInput,
  upcomingOneOffs,
  webcalUrl,
  weekdayKey,
  weeklyRows,
  type ChannelSchedule,
} from "../src/components/schedule/model.ts";

const uuid = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const cat = { id: uuid(90), slug: "just-chatting", name: "Just Chatting" };

function schedule(over: Partial<ChannelSchedule> = {}): ChannelSchedule {
  return {
    timezone: "America/Toronto",
    slots: [
      { id: uuid(1), weekday: 5, startLocal: "19:30", durationMinutes: 180, title: "Campaign night", category: cat },
      { id: uuid(2), weekday: 2, startLocal: "23:30", durationMinutes: 120, title: null, category: null },
    ],
    oneOffs: [
      {
        id: uuid(10),
        startsAt: "2026-11-18T00:00:00.000Z",
        durationMinutes: 90,
        title: "Charity",
        category: null,
        cancelsSlotId: null,
      },
      {
        id: uuid(11),
        startsAt: "2026-11-21T00:30:00.000Z",
        durationMinutes: 180,
        title: null,
        category: null,
        cancelsSlotId: uuid(1),
      },
    ],
    upcoming: [
      {
        startsAt: "2026-11-14T00:30:00.000Z",
        endsAt: "2026-11-14T03:30:00.000Z",
        title: "Campaign night",
        category: cat,
        slotId: uuid(1),
        oneOffId: null,
      },
      {
        startsAt: "2026-11-18T00:00:00.000Z",
        endsAt: "2026-11-18T01:30:00.000Z",
        title: "Charity",
        category: null,
        slotId: null,
        oneOffId: uuid(10),
      },
      {
        startsAt: "2026-11-18T04:30:00.000Z",
        endsAt: "2026-11-18T06:30:00.000Z",
        title: null,
        category: null,
        slotId: uuid(2),
        oneOffId: null,
      },
    ],
    feedPath: "/api/channels/rivertide/schedule.ics",
    ...over,
  };
}

const NOW = new Date("2026-11-11T12:00:00.000Z");

describe("calendar links", () => {
  it("the feed, the next stream alone, and the webcal: subscription", () => {
    expect(scheduleFeedPath("rivertide")).toBe("/api/channels/rivertide/schedule.ics");
    expect(nextStreamIcsPath("rivertide")).toBe("/api/channels/rivertide/schedule.ics?next=1");
    expect(webcalUrl("https://air.example/", "rivertide")).toBe(
      "webcal://air.example/api/channels/rivertide/schedule.ics",
    );
    expect(webcalUrl("http://localhost:3000", "r_t")).toBe("webcal://localhost:3000/api/channels/r_t/schedule.ics");
  });
});

describe("time zones", () => {
  it("the picker list, with the saved and browser zones added once", () => {
    expect(TIME_ZONES).toContain("UTC");
    expect(new Set(TIME_ZONES).size).toBe(TIME_ZONES.length);
    expect(timeZoneOptions("America/Toronto", null, undefined)).toEqual([...TIME_ZONES]);
    const extra = timeZoneOptions("America/Regina", "Asia/Kathmandu", "Asia/Kathmandu");
    expect(extra.at(-1)).toBe("Asia/Kathmandu");
    expect(extra.filter((z) => z === "Asia/Kathmandu")).toHaveLength(1);
    expect(timeZoneLabel("America/Argentina/Buenos_Aires")).toBe("America / Argentina / Buenos Aires");
  });

  it("the browser's zone: Temporal when there, else a guess from the clock, never empty", () => {
    expect(browserTimeZone({ temporal: { Now: { timeZoneId: () => "Europe/Paris" } } })).toBe("Europe/Paris");
    const guessed = browserTimeZone({
      temporal: {
        Now: {
          timeZoneId: () => {
            throw new Error("no");
          },
        },
      },
    });
    expect(guessed.length).toBeGreaterThan(0);
    expect(browserTimeZone({ temporal: undefined, now: NOW })).toBe(guessed);
  });
});

describe("durations and local times", () => {
  it("offers the presets plus a saved odd length within the rules", () => {
    expect(durationOptions()).toContain(120);
    expect(durationOptions(95)).toContain(95);
    expect(durationOptions(5)).not.toContain(5);
    expect(durationOptions(SCHEDULE_RULES.maxDurationMinutes + 1)).not.toContain(SCHEDULE_RULES.maxDurationMinutes + 1);
    const opts = durationOptions(95);
    expect([...opts].sort((a, b) => a - b)).toEqual(opts);
  });

  it("datetime-local round trips in the browser's zone; bad input is null", () => {
    const iso = "2026-11-20T23:15:00.000Z";
    const local = toLocalInput(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).toBe(iso);
    expect(toLocalInput("nope")).toBe("");
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("2026-11-20")).toBeNull();
    expect(fromLocalInput("2026-13-45T99:99")).toBeNull();
    const d = new Date(iso);
    expect(localHhmm(d)).toBe(local.slice(11));
    expect(localIsoWeekday(d)).toBe(d.getDay() === 0 ? 7 : d.getDay());
  });

  it("weekday keys, Monday first", () => {
    expect(weekdayKey(1)).toBe("w5Schedule.weekday.1");
    expect(weekdayKey(7)).toBe("w5Schedule.weekday.7");
    expect(weekdayKey(0)).toBe("w5Schedule.weekday.1");
  });
});

describe("the editor's draft", () => {
  it("no schedule, or an empty UTC one, starts in the browser's zone", () => {
    expect(draftFromSchedule(null, "Europe/Paris")).toMatchObject({ timezone: "Europe/Paris", savedTimezone: null });
    const empty = schedule({ timezone: "UTC", slots: [], oneOffs: [], upcoming: [] });
    expect(draftFromSchedule(empty, "Europe/Paris")).toMatchObject({ timezone: "Europe/Paris", savedTimezone: "UTC" });
    const emptyParis = schedule({ timezone: "Asia/Tokyo", slots: [], oneOffs: [], upcoming: [] });
    expect(draftFromSchedule(emptyParis, "Europe/Paris").timezone).toBe("Asia/Tokyo");
  });

  it("reads slots, one-offs and skips apart; the input maps skips to slot indexes", () => {
    const d = draftFromSchedule(schedule(), "UTC");
    expect(d.slots.map((s) => [s.weekday, s.startLocal, s.title, s.categoryId])).toEqual([
      [5, "19:30", "Campaign night", cat.id],
      [2, "23:30", "", null],
    ]);
    expect(d.oneOffs).toHaveLength(1);
    expect(d.oneOffs[0]?.startsAtLocal).toBe(toLocalInput("2026-11-18T00:00:00.000Z"));
    expect(d.skips).toEqual([{ slotId: uuid(1), startsAt: "2026-11-21T00:30:00.000Z", durationMinutes: 180 }]);
    const input = draftToInput(d);
    expect(input.timezone).toBe("America/Toronto");
    expect(input.slots[1]).toEqual({
      weekday: 2,
      startLocal: "23:30",
      durationMinutes: 120,
      title: null,
      categoryId: null,
    });
    expect(input.oneOffs).toEqual([
      {
        startsAt: "2026-11-18T00:00:00.000Z",
        durationMinutes: 90,
        title: "Charity",
        categoryId: null,
        cancelsSlot: null,
      },
      { startsAt: "2026-11-21T00:30:00.000Z", durationMinutes: 180, title: null, categoryId: null, cancelsSlot: 0 },
    ]);
    // Moving the slot to the end keeps the skip on it.
    const moved = { ...d, slots: [d.slots[1], d.slots[0]].filter((s) => s !== undefined) };
    expect(draftToInput(moved).oneOffs.at(-1)?.cancelsSlot).toBe(1);
  });

  it("a skip goes when its slot is removed, moved to another day or time, or the zone changes", () => {
    const d = draftFromSchedule(schedule(), "UTC");
    expect(liveSkips(d)).toHaveLength(1);
    expect(liveSkips({ ...d, slots: d.slots.slice(1) })).toEqual([]);
    const first = d.slots[0];
    if (!first) throw new Error("no slot");
    expect(liveSkips({ ...d, slots: [{ ...first, startLocal: "20:00" }, ...d.slots.slice(1)] })).toEqual([]);
    expect(liveSkips({ ...d, slots: [{ ...first, weekday: 6 }, ...d.slots.slice(1)] })).toEqual([]);
    // A new title or length keeps it.
    expect(
      liveSkips({ ...d, slots: [{ ...first, title: "New", durationMinutes: 60 }, ...d.slots.slice(1)] }),
    ).toHaveLength(1);
    expect(liveSkips({ ...d, timezone: "Europe/Paris" })).toEqual([]);
  });

  it("toggling a skip; the room for one-offs counts skips", () => {
    const d = draftFromSchedule(schedule(), "UTC");
    const skipped = toggleSkip(d, uuid(1), "2026-11-14T00:30:00.000Z", 180);
    expect(skipped.skips).toHaveLength(2);
    expect(oneOffRoom(skipped)).toBe(SCHEDULE_RULES.maxOneOffs - 1 - 2);
    const back = toggleSkip(skipped, uuid(1), "2026-11-14T00:30:00.000Z", 180);
    expect(back.skips).toEqual(d.skips);
  });

  it("checks: zone from the list, a valid start, a future one-off, titles within the limit", () => {
    const d = draftFromSchedule(schedule(), "UTC");
    expect(draftErrors(d, NOW, TIME_ZONES)).toEqual({});
    const slot = { ...newSlot(3), startLocal: "" };
    const past = { ...newOneOff(NOW), startsAtLocal: toLocalInput("2026-11-10T12:00:00.000Z") };
    const blank = { ...newOneOff(NOW), startsAtLocal: "" };
    const long = { ...newSlot(), title: "x".repeat(SCHEDULE_RULES.titleMax + 1) };
    const errors = draftErrors(
      { ...d, timezone: "Mars/Base", slots: [slot, long], oneOffs: [past, blank] },
      NOW,
      TIME_ZONES,
    );
    expect(errors).toEqual({
      timezone: "w5Schedule.error.timezone",
      [`${slot.key}.start`]: "w5Schedule.error.start",
      [`${long.key}.title`]: "w5Schedule.error.title",
      [`${past.key}.startsAt`]: "w5Schedule.error.past",
      [`${blank.key}.startsAt`]: "w5Schedule.error.startsAt",
    });
    // A new one-off is tomorrow at 19:00 and passes.
    expect(draftErrors({ ...d, oneOffs: [newOneOff(NOW)] }, NOW, TIME_ZONES)).toEqual({});
  });

  it("blank titles are null; titles are trimmed", () => {
    const d = draftFromSchedule(null, "UTC");
    const input = draftToInput({
      ...d,
      slots: [
        { ...newSlot(), title: "  Hi  " },
        { ...newSlot(), title: "   " },
      ],
    });
    expect(input.slots.map((s) => s.title)).toEqual(["Hi", null]);
  });

  it("Coming up lists the saved upcoming plus the saved skips, soonest first, marked", () => {
    const saved = schedule();
    const d = draftFromSchedule(saved, "UTC");
    const rows = comingUp(saved, d, NOW);
    expect(rows.map((r) => [r.startsAt, r.skipped])).toEqual([
      ["2026-11-14T00:30:00.000Z", false],
      ["2026-11-18T00:00:00.000Z", false],
      ["2026-11-18T04:30:00.000Z", false],
      ["2026-11-21T00:30:00.000Z", true],
    ]);
    expect(rows.at(-1)).toMatchObject({ title: "Campaign night", endsAt: "2026-11-21T03:30:00.000Z" });
    // A saved skip in the past is not offered.
    expect(comingUp(saved, d, new Date("2026-11-30T00:00:00.000Z")).some((r) => r.skipped)).toBe(false);
  });

  it("knows when the draft differs from what was saved", () => {
    const saved = schedule();
    const d = draftFromSchedule(saved, "UTC");
    expect(draftChanged(saved, d)).toBe(false);
    expect(draftChanged(saved, { ...d, timezone: "Europe/Paris" })).toBe(true);
    expect(draftChanged(saved, toggleSkip(d, uuid(1), "2026-11-14T00:30:00.000Z", 180))).toBe(true);
    expect(draftChanged(saved, { ...d, slots: [...d.slots, newSlot()] })).toBe(true);
  });
});

describe("About's weekly rows", () => {
  it("each slot by its next occurrence in the viewer's zone, Monday first; one-offs apart", () => {
    const rows = weeklyRows(schedule());
    expect(rows).toHaveLength(2);
    const fri = new Date("2026-11-14T00:30:00.000Z");
    const tue = new Date("2026-11-18T04:30:00.000Z");
    const expected = [
      { slotId: uuid(1), weekday: localIsoWeekday(fri), start: localHhmm(fri), title: "Campaign night" },
      { slotId: uuid(2), weekday: localIsoWeekday(tue), start: localHhmm(tue), title: null },
    ].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
    expect(rows.map((r) => ({ slotId: r.slotId, weekday: r.weekday, start: r.start, title: r.title }))).toEqual(
      expected,
    );
    expect(rows.find((r) => r.slotId === uuid(1))?.category).toEqual({ slug: cat.slug, name: cat.name });
    expect(upcomingOneOffs(schedule()).map((o) => o.oneOffId)).toEqual([uuid(10)]);
  });

  it("a slot with nothing upcoming is left out", () => {
    const s = schedule();
    expect(weeklyRows({ ...s, upcoming: s.upcoming.filter((o) => o.slotId !== uuid(2)) }).map((r) => r.slotId)).toEqual(
      [uuid(1)],
    );
  });
});
