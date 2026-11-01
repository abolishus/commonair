// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Watch-room rules (ADR 0017 decision 3): bands, the order of person checks, trigger mapping. */
import { describe, expect, test } from "vite-plus/test";
import {
  ageBandOn,
  hasPlace,
  personRefusal,
  platformBanOf,
  roomAudience,
  triggerRefusal,
  type PersonFacts,
} from "../src/watch-rooms/rules.ts";

const NOW = new Date("2026-11-01T12:00:00Z");
const ok: PersonFacts = { birthDate: "1990-01-01", matureConfirmed: false, platformBan: "none", channelBanned: false };

describe("ageBandOn", () => {
  test.each([
    ["2008-11-01", "adult"],
    ["2008-11-02", "minor"],
    ["2013-01-01", "minor"],
    ["1900-01-01", "adult"],
  ] as const)("%s → %s", (birth, band) => expect(ageBandOn(birth, NOW)).toBe(band));

  test.each([null, "", "1899-12-31", "2027-01-01", "2026-02-30", "garbage"])("%s fails closed", (birth) =>
    expect(ageBandOn(birth, NOW)).toBeNull(),
  );
});

describe("personRefusal", () => {
  const adultRoom = { band: "adult" as const, mature: false };
  test("an adult in an adult room passes", () => expect(personRefusal(ok, adultRoom, NOW)).toBeNull());
  test("bans come first", () => {
    expect(personRefusal({ ...ok, platformBan: "banned", birthDate: null }, adultRoom, NOW)).toBe("room_banned");
    expect(personRefusal({ ...ok, platformBan: "suspended" }, adultRoom, NOW)).toBe("room_suspended");
    expect(personRefusal({ ...ok, channelBanned: true }, adultRoom, NOW)).toBe("room_banned");
  });
  test("unknown age, then mature for minors, then the band, then confirmation", () => {
    expect(personRefusal({ ...ok, birthDate: null }, adultRoom, NOW)).toBe("room_birth_date_unknown");
    const minor = { ...ok, birthDate: "2012-01-01" };
    expect(personRefusal(minor, { band: "adult", mature: true }, NOW)).toBe("room_mature_minor");
    expect(personRefusal(minor, { band: null, mature: true }, NOW)).toBe("room_mature_minor");
    expect(personRefusal(minor, adultRoom, NOW)).toBe("room_age_band");
    expect(personRefusal(ok, { band: "minor", mature: false }, NOW)).toBe("room_age_band");
    expect(personRefusal(ok, { band: "adult", mature: true }, NOW)).toBe("room_mature_unconfirmed");
    expect(personRefusal({ ...ok, matureConfirmed: true }, { band: "adult", mature: true }, NOW)).toBeNull();
    expect(personRefusal(minor, { band: null, mature: false }, NOW)).toBeNull();
  });
});

describe("platformBanOf", () => {
  test("permanent, timed, lapsed, none", () => {
    expect(platformBanOf(true, null, NOW)).toBe("banned");
    expect(platformBanOf(true, new Date(NOW.getTime() + 1000), NOW)).toBe("suspended");
    expect(platformBanOf(true, new Date(NOW.getTime() - 1000), NOW)).toBe("none");
    expect(platformBanOf(false, null, NOW)).toBe("none");
  });
});

describe("hasPlace", () => {
  test("8 is full", () => {
    expect(hasPlace(0)).toBe(true);
    expect(hasPlace(7)).toBe(true);
    expect(hasPlace(8)).toBe(false);
  });
});

describe("triggerRefusal", () => {
  const wrapped = (message: string) => new Error("Failed query", { cause: new Error(message) });
  test.each([
    ["room_closed: the watch room has ended", "adult", "room_closed"],
    ["room_full: a watch room has at most 8 members", "adult", "room_full"],
    ["room_age_band: no valid birth date", null, "room_birth_date_unknown"],
    ["room_age_band: the member's band differs from the room's", "minor", "room_age_band"],
    ["room_mature: mature content is for adults who confirmed mature viewing", "adult", "room_mature_unconfirmed"],
    ["room_mature: mature content is for adults who confirmed mature viewing", "minor", "room_mature_minor"],
    ["watch room host has no valid birth date", null, "room_birth_date_unknown"],
  ] as const)("%s (%s)", (message, band, code) => expect(triggerRefusal(wrapped(message), band)).toBe(code));
  test("anything else is not a refusal", () => {
    expect(triggerRefusal(new Error("connection reset"), "adult")).toBeNull();
    expect(triggerRefusal(null, "adult")).toBeNull();
  });
});

test("roomAudience", () => expect(roomAudience("r1")).toBe("room:r1"));
