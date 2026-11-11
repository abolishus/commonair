// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5 schedule: the wall-clock arithmetic (`schedule/zone.ts`), the occurrence
 * expansion (`schedule/expand.ts`), the calendar feed (`schedule/ics.ts`) and the feed path match.
 */
import { describe, expect, test } from "vite-plus/test";
import { SCHEDULE_RULES } from "@commonair/contracts/enums";
import { matchScheduleFeed } from "../src/raw-routes.ts";
import { expandSchedule, isSlotOccurrence, type OneOffRule, type SlotRule } from "../src/schedule/expand.ts";
import { buildFeed, escapeText, foldLine, icsDateTime, occurrenceUid } from "../src/schedule/ics.ts";
import { scheduleFeedPath } from "../src/schedule/service.ts";
import {
  addDays,
  isKnownTimeZone,
  isoWeekday,
  localDateOf,
  localToInstant,
  minutesOf,
  offsetMs,
} from "../src/schedule/zone.ts";

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);
const date = (year: number, month: number, day: number) => ({ year, month, day });

const slot = (over: Partial<SlotRule> & Pick<SlotRule, "weekday" | "startLocal">): SlotRule => ({
  id: over.id ?? `00000000-0000-7000-8000-00000000000${over.weekday}`,
  durationMinutes: 120,
  title: null,
  category: null,
  ...over,
});
const oneOff = (over: Partial<OneOffRule> & Pick<OneOffRule, "id" | "startsAt">): OneOffRule => ({
  durationMinutes: 60,
  title: null,
  category: null,
  cancelsSlotId: null,
  ...over,
});

describe("zone", () => {
  test("known zones", () => {
    expect(isKnownTimeZone("America/Toronto")).toBe(true);
    expect(isKnownTimeZone("Europe/Paris")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    expect(isKnownTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isKnownTimeZone("+01:00")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
  });

  test("offsets either side of DST", () => {
    expect(offsetMs("America/Toronto", at("2026-01-15T12:00:00Z"))).toBe(-5 * HOUR);
    expect(offsetMs("America/Toronto", at("2026-07-15T12:00:00Z"))).toBe(-4 * HOUR);
    expect(offsetMs("Europe/Paris", at("2026-01-15T12:00:00Z"))).toBe(1 * HOUR);
    expect(offsetMs("Europe/Paris", at("2026-07-15T12:00:00Z"))).toBe(2 * HOUR);
    expect(offsetMs("UTC", at("2026-07-15T12:00:00.789Z"))).toBe(0);
  });

  test("local dates, weekdays, day arithmetic and local times", () => {
    // 03:00 UTC on Saturday is still Friday evening in Toronto.
    expect(localDateOf("America/Toronto", at("2026-11-14T03:00:00Z"))).toEqual(date(2026, 11, 13));
    expect(localDateOf("Europe/Paris", at("2026-12-31T23:30:00Z"))).toEqual(date(2027, 1, 1));
    expect(isoWeekday(date(2026, 11, 13))).toBe(5);
    expect(isoWeekday(date(2026, 11, 15))).toBe(7);
    expect(isoWeekday(date(2026, 11, 16))).toBe(1);
    expect(addDays(date(2026, 12, 31), 1)).toEqual(date(2027, 1, 1));
    expect(addDays(date(2028, 3, 1), -1)).toEqual(date(2028, 2, 29));
    expect(minutesOf("19:30")).toBe(1170);
    expect(minutesOf("23:59:00")).toBe(1439);
    expect(() => minutesOf("7:30")).toThrow(RangeError);
  });

  test("Toronto spring forward: a time in the gap moves forward by the gap", () => {
    // 2026-03-08 02:00 EST → 03:00 EDT.
    expect(iso(localToInstant("America/Toronto", date(2026, 3, 8), minutesOf("02:30")))).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(iso(localToInstant("America/Toronto", date(2026, 3, 8), minutesOf("01:59")))).toBe(
      "2026-03-08T06:59:00.000Z",
    );
    expect(iso(localToInstant("America/Toronto", date(2026, 3, 8), minutesOf("03:00")))).toBe(
      "2026-03-08T07:00:00.000Z",
    );
  });

  test("Toronto fall back: an ambiguous time takes the earlier instant", () => {
    // 2026-11-01 02:00 EDT → 01:00 EST; 01:30 happens twice.
    expect(iso(localToInstant("America/Toronto", date(2026, 11, 1), minutesOf("01:30")))).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(iso(localToInstant("America/Toronto", date(2026, 11, 1), minutesOf("02:30")))).toBe(
      "2026-11-01T07:30:00.000Z",
    );
  });

  test("Paris spring forward and fall back", () => {
    // 2026-03-29 02:00 CET → 03:00 CEST; 2026-10-25 03:00 CEST → 02:00 CET.
    expect(iso(localToInstant("Europe/Paris", date(2026, 3, 29), minutesOf("02:30")))).toBe("2026-03-29T01:30:00.000Z");
    expect(iso(localToInstant("Europe/Paris", date(2026, 10, 25), minutesOf("02:30")))).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(iso(localToInstant("Europe/Paris", date(2026, 10, 25), minutesOf("03:30")))).toBe(
      "2026-10-25T02:30:00.000Z",
    );
  });

  test("UTC is the wall clock", () => {
    expect(iso(localToInstant("UTC", date(2026, 11, 16), minutesOf("10:00")))).toBe("2026-11-16T10:00:00.000Z");
  });
});

describe("expandSchedule", () => {
  test("no slots and no one-offs: nothing", () => {
    expect(expandSchedule("UTC", [], [], { now: new Date("2026-11-11T00:00:00Z") })).toEqual([]);
  });

  test("a Friday 19:30 slot in Toronto keeps its wall time across the fall-back change", () => {
    const friday = slot({
      weekday: 5,
      startLocal: "19:30",
      category: { id: "c", slug: "just-chatting", name: "Just Chatting" },
    });
    const out = expandSchedule("America/Toronto", [friday], [], {
      now: new Date("2026-10-25T00:00:00Z"),
      horizonDays: 14,
    });
    expect(out.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-10-30T23:30:00.000Z", // EDT
      "2026-11-07T00:30:00.000Z", // EST
    ]);
    expect(out[0]).toMatchObject({ slotId: friday.id, oneOffId: null, title: null, category: friday.category });
    expect(out[0]?.endsAt.toISOString()).toBe("2026-10-31T01:30:00.000Z");
  });

  test("a Sunday 02:30 slot on Toronto's spring-forward day", () => {
    const sunday = slot({ weekday: 7, startLocal: "02:30" });
    const out = expandSchedule("America/Toronto", [sunday], [], {
      now: new Date("2026-03-01T00:00:00Z"),
      horizonDays: 21,
    });
    expect(out.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-03-01T07:30:00.000Z",
      "2026-03-08T07:30:00.000Z", // 03:30 EDT: the gap pushed it forward
      "2026-03-15T06:30:00.000Z",
    ]);
  });

  test("a Sunday 01:30 slot on Toronto's fall-back day happens once, at the earlier instant", () => {
    const sunday = slot({ weekday: 7, startLocal: "01:30" });
    const out = expandSchedule("America/Toronto", [sunday], [], {
      now: new Date("2026-10-31T00:00:00Z"),
      horizonDays: 9,
    });
    expect(out.map((o) => o.startsAt.toISOString())).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-08T06:30:00.000Z"]);
  });

  test("Paris across both changes", () => {
    const sunday = slot({ weekday: 7, startLocal: "02:30" });
    const spring = expandSchedule("Europe/Paris", [sunday], [], {
      now: new Date("2026-03-22T00:00:00Z"),
      horizonDays: 14,
    });
    expect(spring.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-03-22T01:30:00.000Z",
      "2026-03-29T01:30:00.000Z",
    ]);
    const fall = expandSchedule("Europe/Paris", [sunday], [], {
      now: new Date("2026-10-18T00:00:00Z"),
      horizonDays: 14,
    });
    expect(fall.map((o) => o.startsAt.toISOString())).toEqual(["2026-10-18T00:30:00.000Z", "2026-10-25T00:30:00.000Z"]);
  });

  test("a slot at 23:30 crosses midnight and the UTC date", () => {
    const late = slot({ weekday: 5, startLocal: "23:30", durationMinutes: 180 });
    const [first] = expandSchedule("America/Toronto", [late], [], {
      now: new Date("2026-11-11T00:00:00Z"),
      horizonDays: 7,
    });
    // Friday 23:30 EST is Saturday 04:30 UTC; it ends Saturday 02:30 local.
    expect(first?.startsAt.toISOString()).toBe("2026-11-14T04:30:00.000Z");
    expect(first?.endsAt.toISOString()).toBe("2026-11-14T07:30:00.000Z");
    // Paris Monday 00:30 is Sunday 23:30 UTC.
    const [paris] = expandSchedule("Europe/Paris", [slot({ weekday: 1, startLocal: "00:30" })], [], {
      now: new Date("2026-11-11T00:00:00Z"),
      horizonDays: 7,
    });
    expect(paris?.startsAt.toISOString()).toBe("2026-11-15T23:30:00.000Z");
  });

  test("a skip leaves its occurrence out; one-offs merge in order", () => {
    const friday = slot({ id: "slot-fri", weekday: 5, startLocal: "19:30" });
    const out = expandSchedule(
      "America/Toronto",
      [friday],
      [
        oneOff({ id: "skip", startsAt: new Date("2026-11-14T00:30:00Z"), cancelsSlotId: "slot-fri" }),
        oneOff({ id: "special", startsAt: new Date("2026-11-17T23:00:00Z"), title: "Charity night" }),
        // A skip that names no real occurrence changes nothing.
        oneOff({ id: "stray", startsAt: new Date("2026-11-21T01:00:00Z"), cancelsSlotId: "slot-fri" }),
      ],
      { now: new Date("2026-11-11T00:00:00Z"), horizonDays: 14 },
    );
    expect(out.map((o) => [o.startsAt.toISOString(), o.slotId, o.oneOffId, o.title])).toEqual([
      ["2026-11-17T23:00:00.000Z", null, "special", "Charity night"],
      ["2026-11-21T00:30:00.000Z", "slot-fri", null, null],
    ]);
    expect(out[0]?.endsAt.toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });

  test("the window: from now (a stream that started is no longer upcoming) to the horizon", () => {
    const now = new Date("2026-11-13T19:31:00-05:00");
    const out = expandSchedule(
      "America/Toronto",
      [slot({ weekday: 5, startLocal: "19:30" })],
      [
        oneOff({ id: "past", startsAt: new Date("2026-11-12T00:00:00Z") }),
        oneOff({ id: "edge", startsAt: new Date(now.getTime() + 28 * 86_400_000) }),
        oneOff({ id: "now", startsAt: now }),
      ],
      { now },
    );
    expect(out[0]?.oneOffId).toBe("now");
    expect(out.some((o) => o.oneOffId === "past" || o.oneOffId === "edge")).toBe(false);
    // Fridays from the next one: 20, 27 Nov, 4 and 11 Dec.
    expect(out.filter((o) => o.slotId).map((o) => o.startsAt.toISOString())).toEqual([
      "2026-11-21T00:30:00.000Z",
      "2026-11-28T00:30:00.000Z",
      "2026-12-05T00:30:00.000Z",
      "2026-12-12T00:30:00.000Z",
    ]);
  });

  test("the cap: a slot every day for 28 days is cut at upcomingMax, soonest kept", () => {
    const week = [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
      slot({ id: `s${weekday}`, weekday, startLocal: "12:00", durationMinutes: 60 }),
    );
    const now = new Date("2026-11-11T00:00:00Z");
    const out = expandSchedule("UTC", week, [], { now });
    expect(out).toHaveLength(SCHEDULE_RULES.upcomingMax);
    expect(out[0]?.startsAt.toISOString()).toBe("2026-11-11T12:00:00.000Z");
    expect(out.at(-1)?.startsAt.toISOString()).toBe("2026-11-30T12:00:00.000Z");
    expect(expandSchedule("UTC", week, [], { now, max: 1 })).toHaveLength(1);
  });

  test("ties at one instant sort by id, whatever the input order", () => {
    const now = new Date("2026-11-11T00:00:00Z");
    const startsAt = new Date("2026-11-12T10:00:00Z");
    const a = expandSchedule("UTC", [], [oneOff({ id: "b", startsAt }), oneOff({ id: "a", startsAt })], { now });
    expect(a.map((o) => o.oneOffId)).toEqual(["a", "b"]);
  });

  test("isSlotOccurrence", () => {
    const friday = slot({ weekday: 5, startLocal: "19:30" });
    expect(isSlotOccurrence("America/Toronto", friday, new Date("2026-11-14T00:30:00Z"))).toBe(true);
    expect(isSlotOccurrence("America/Toronto", friday, new Date("2026-10-30T23:30:00Z"))).toBe(true);
    expect(isSlotOccurrence("America/Toronto", friday, new Date("2026-11-14T00:31:00Z"))).toBe(false);
    expect(isSlotOccurrence("America/Toronto", friday, new Date("2026-11-15T00:30:00Z"))).toBe(false);
    expect(isSlotOccurrence("UTC", friday, new Date("2026-11-13T19:30:00Z"))).toBe(true);
    // In the gap, the pushed-forward instant is the occurrence.
    const sunday = slot({ weekday: 7, startLocal: "02:30" });
    expect(isSlotOccurrence("America/Toronto", sunday, new Date("2026-03-08T07:30:00Z"))).toBe(true);
  });
});

describe("ics", () => {
  test("TEXT escaping", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
    expect(escapeText("plain")).toBe("plain");
  });

  test("folding at 75 octets, never inside a UTF-8 sequence", () => {
    expect(foldLine("x".repeat(75))).toBe("x".repeat(75));
    const long = foldLine(`SUMMARY:${"y".repeat(200)}`);
    const parts = long.split("\r\n");
    expect(parts[0]).toHaveLength(75);
    for (const p of parts.slice(1)) expect(p.startsWith(" ")).toBe(true);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(`SUMMARY:${"y".repeat(200)}`);
    const emoji = foldLine(`SUMMARY:${"é".repeat(40)}${"🎮".repeat(20)}`);
    for (const p of emoji.split("\r\n")) {
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
      expect(p).not.toContain("�");
    }
  });

  test("times and UIDs", () => {
    const startsAt = new Date("2026-11-14T00:30:00.000Z");
    expect(icsDateTime(startsAt)).toBe("20261114T003000Z");
    expect(occurrenceUid({ slotId: "s1", oneOffId: null, startsAt }, "example.org")).toBe(
      "slot-s1-20261114T003000Z@example.org",
    );
    expect(occurrenceUid({ slotId: null, oneOffId: "o1", startsAt }, "example.org")).toBe("oneoff-o1@example.org");
  });

  test("the feed: a VEVENT per occurrence, CRLF, title or channel name as SUMMARY", () => {
    const feed = buildFeed({
      instanceName: "Test, Instance",
      publicUrl: "https://example.org",
      channel: { slug: "sly", displayName: "Sly; Kettle" },
      stamp: new Date("2026-11-01T12:00:00Z"),
      occurrences: [
        {
          startsAt: new Date("2026-11-14T00:30:00Z"),
          endsAt: new Date("2026-11-14T02:30:00Z"),
          title: null,
          category: { id: "c", slug: "jc", name: "Just Chatting" },
          slotId: "s1",
          oneOffId: null,
        },
        {
          startsAt: new Date("2026-11-17T23:00:00Z"),
          endsAt: new Date("2026-11-18T00:00:00Z"),
          title: "Charity night, all welcome",
          category: null,
          slotId: null,
          oneOffId: "o1",
        },
      ],
    });
    expect(feed.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(feed.replace(/\r\n/g, "")).not.toMatch(/\n/);
    const lines = feed.split("\r\n");
    expect(lines.slice(0, 3)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test\\, Instance//Channel schedule//EN",
    ]);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines).toContain("UID:slot-s1-20261114T003000Z@example.org");
    expect(lines).toContain("UID:oneoff-o1@example.org");
    expect(lines).toContain("DTSTAMP:20261101T120000Z");
    expect(lines).toContain("DTSTART:20261114T003000Z");
    expect(lines).toContain("DTEND:20261114T023000Z");
    expect(lines).toContain("SUMMARY:Sly\\; Kettle");
    expect(lines).toContain("SUMMARY:Charity night\\, all welcome");
    expect(lines).toContain("CATEGORIES:Just Chatting");
    expect(lines).toContain("URL:https://example.org/sly");
    expect(lines).toContain("X-WR-CALNAME:Sly\\; Kettle");
  });

  test("an empty schedule is a valid calendar with no events", () => {
    const feed = buildFeed({
      instanceName: "T",
      publicUrl: "https://example.org",
      channel: { slug: "sly", displayName: "Sly" },
      stamp: new Date("2026-11-01T12:00:00Z"),
      occurrences: [],
    });
    expect(feed).toMatch(/^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
    expect(feed).not.toContain("VEVENT");
  });
});

describe("feed path", () => {
  test("the path the API answers is the path the DTO names", () => {
    expect(scheduleFeedPath("sly_kettle")).toBe("/api/channels/sly_kettle/schedule.ics");
    expect(matchScheduleFeed(scheduleFeedPath("sly_kettle"))).toBe("sly_kettle");
    expect(matchScheduleFeed("/api/channels/sly_kettle/schedule")).toBeNull();
    expect(matchScheduleFeed("/api/channels/SLY/schedule.ics")).toBeNull();
    expect(matchScheduleFeed("/api/channels/ab/schedule.ics")).toBeNull();
    expect(matchScheduleFeed("/api/channels/a/b/schedule.ics")).toBeNull();
  });
});
